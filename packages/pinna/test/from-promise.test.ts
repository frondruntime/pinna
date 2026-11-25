import { describe, expect, test } from "bun:test";
import {
  Box,
  Computed,
  isPinnaError,
  type PinnaUsageError,
  Realm,
  Source,
  Stage,
  StageConflictError,
} from "../src/index.ts";
import { held, record, testRealm } from "../src/testing/index.ts";

/**
 * `Computed.fromPromise`: a read-only value fed by a promise while something
 * observes it (`docs/api.md`, ruling 65).
 */

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (reason: unknown) => void;
}

const deferred = <Value>(): Deferred<Value> => {
  let resolve: (value: Value) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

/** Lets every settled promise run its callbacks. */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

/** A `load` that hands out a new deferred per call and keeps its signal. */
const loader = <Value>() => {
  const calls: Array<Deferred<Value> & { readonly signal: AbortSignal }> = [];
  const load = (signal: AbortSignal): Promise<Value> => {
    const call = { ...deferred<Value>(), signal };
    calls.push(call);
    return call.promise;
  };
  return { calls, load };
};

const currentOf = <Value>(realm: Realm, $value: Computed<Value>): Value =>
  Realm.untracked(realm, (read) => read($value));

describe("Computed.fromPromise alone", () => {
  test("is initial until observed, and load does not run", () => {
    using realm = testRealm();
    const { calls, load } = loader<number>();
    const $value = Computed.fromPromise(realm, load, 0);
    expect(currentOf(realm, $value)).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("runs load on the first observer and holds what it resolves to", async () => {
    using realm = testRealm();
    const { calls, load } = loader<number>();
    const $value = Computed.fromPromise(realm, load, 0);
    using values = record(realm, (read) => read($value));
    expect(calls).toHaveLength(1);
    expect(currentOf(realm, $value)).toBe(0);
    calls[0]?.resolve(7);
    await settle();
    expect(currentOf(realm, $value)).toBe(7);
    expect(values.values).toEqual([7]);
  });

  test("a second observer starts nothing", () => {
    using realm = testRealm();
    const { calls, load } = loader<number>();
    const $value = Computed.fromPromise(realm, load, 0);
    using _first = held(Source.observe($value));
    using _second = held(Source.observe($value));
    expect(calls).toHaveLength(1);
  });

  test("the last observer leaving aborts the signal and resets to initial", async () => {
    using realm = testRealm();
    const { calls, load } = loader<number>();
    const $value = Computed.fromPromise(realm, load, 0);
    const release = Source.observe($value);
    calls[0]?.resolve(7);
    await settle();
    expect(currentOf(realm, $value)).toBe(7);
    release();
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(currentOf(realm, $value)).toBe(0);
  });

  test("observed again, load runs from the start", async () => {
    using realm = testRealm();
    const { calls, load } = loader<number>();
    const $value = Computed.fromPromise(realm, load, 0);
    Source.observe($value)();
    using _observed = held(Source.observe($value));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(calls[1]?.signal.aborted).toBe(false);
    calls[1]?.resolve(3);
    await settle();
    expect(currentOf(realm, $value)).toBe(3);
  });

  test("a result from an earlier observation is dropped", async () => {
    using realm = testRealm();
    const { calls, load } = loader<number>();
    const $value = Computed.fromPromise(realm, load, 0);
    Source.observe($value)();
    using _observed = held(Source.observe($value));
    calls[0]?.resolve(1);
    await settle();
    expect(currentOf(realm, $value)).toBe(0);
    calls[1]?.resolve(2);
    await settle();
    expect(currentOf(realm, $value)).toBe(2);
  });

  test("a result after the last observer left is dropped", async () => {
    using realm = testRealm();
    const { calls, load } = loader<number>();
    const $value = Computed.fromPromise(realm, load, 0);
    Source.observe($value)();
    calls[0]?.resolve(1);
    await settle();
    expect(currentOf(realm, $value)).toBe(0);
  });

  test("an equal result notifies nobody", async () => {
    using realm = testRealm();
    const { calls, load } = loader<{ readonly id: number }>();
    const first = { id: 1 };
    const $value = Computed.fromPromise(realm, load, first, {
      equals: (previous, next) => previous.id === next.id,
    });
    using values = record(realm, (read) => read($value));
    calls[0]?.resolve({ id: 1 });
    await settle();
    expect(values.values).toEqual([]);
    expect(currentOf(realm, $value)).toBe(first);
  });

  test("the name names it for Source.inspect", () => {
    using realm = testRealm();
    const { load } = loader<number>();
    const $value = Computed.fromPromise(realm, load, 0, { name: "profile" });
    using _observed = held(Source.observe($value));
    const inspection = Source.inspect($value);
    expect(inspection.name).toBe("profile");
    expect(inspection.observers).toBe(1);
  });

  test("load may return any thenable", async () => {
    using realm = testRealm();
    const thenable = {
      // biome-ignore lint/suspicious/noThenProperty: a thenable is what this test passes.
      then: (onResolve: (value: number) => void) => onResolve(5),
    } as unknown as PromiseLike<number>;
    const $value = Computed.fromPromise(realm, () => thenable, 0);
    using _observed = held(Source.observe($value));
    await settle();
    expect(currentOf(realm, $value)).toBe(5);
  });
});

describe("Computed.fromPromise failure", () => {
  test("a rejection goes to onError as it is, and the value keeps what it held", async () => {
    const errors: Array<unknown> = [];
    using realm = testRealm({ onError: (error) => errors.push(error) });
    const { calls, load } = loader<number>();
    const $value = Computed.fromPromise(realm, load, 0);
    using _observed = held(Source.observe($value));
    const reason = new Error("offline");
    calls[0]?.reject(reason);
    await settle();
    expect(errors).toEqual([reason]);
    expect(currentOf(realm, $value)).toBe(0);
  });

  test("a throw from load goes to onError", () => {
    const errors: Array<unknown> = [];
    using realm = testRealm({ onError: (error) => errors.push(error) });
    const reason = new Error("no request");
    const $value = Computed.fromPromise<number>(
      realm,
      () => {
        throw reason;
      },
      0,
    );
    using _observed = held(Source.observe($value));
    expect(errors).toEqual([reason]);
    expect(currentOf(realm, $value)).toBe(0);
  });

  test("a rejection after the last observer left, such as the abort's, is dropped", async () => {
    const errors: Array<unknown> = [];
    using realm = testRealm({ onError: (error) => errors.push(error) });
    const $value = Computed.fromPromise<number>(
      realm,
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
      0,
    );
    Source.observe($value)();
    await settle();
    expect(errors).toEqual([]);
  });

  test("a throw from equals goes to onError and writes nothing", async () => {
    const errors: Array<unknown> = [];
    using realm = testRealm({ onError: (error) => errors.push(error) });
    const { calls, load } = loader<number>();
    const reason = new Error("equals");
    const $value = Computed.fromPromise(realm, load, 0, {
      equals: () => {
        throw reason;
      },
    });
    using _observed = held(Source.observe($value));
    calls[0]?.resolve(1);
    await settle();
    expect(errors).toEqual([reason]);
    expect(currentOf(realm, $value)).toBe(0);
  });
  test("an equals that ends the observation writes nothing", async () => {
    using realm = testRealm();
    const { calls, load } = loader<number>();
    let release: () => void = () => undefined;
    const $value = Computed.fromPromise(realm, load, 0, {
      equals: () => {
        release();
        return false;
      },
    });
    release = Source.observe($value);
    calls[0]?.resolve(1);
    await settle();
    expect(currentOf(realm, $value)).toBe(0);
  });
});

describe("Computed.fromPromise and disposal", () => {
  test("Realm.dispose aborts the signal, and a late result writes nothing and throws nothing", async () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const { calls, load } = loader<number>();
    const $value = Computed.fromPromise(realm, load, 0);
    Source.observe($value);
    Realm.dispose(realm);
    expect(calls[0]?.signal.aborted).toBe(true);
    calls[0]?.resolve(1);
    await settle();
    expect(errors).toEqual([]);
    expect(currentOf(realm, $value)).toBe(0);
  });

  test("a disposed realm refuses it", () => {
    const realm = Realm.make();
    Realm.dispose(realm);
    let code: string | undefined;
    let message: string | undefined;
    try {
      Computed.fromPromise(realm, () => Promise.resolve(1), 0);
    } catch (error) {
      expect(isPinnaError(error)).toBe(true);
      code = (error as PinnaUsageError).code;
      message = (error as Error).message;
    }
    expect(code).toBe("pinna/realm-disposed");
    expect(message).toBe(
      "pinna: Computed.fromPromise cannot start in the disposed realm; make a new realm",
    );
  });

  test("testRealm reports an observation left running", () => {
    const realm = testRealm();
    const $value = Computed.fromPromise(realm, () => new Promise<number>(() => undefined), 0);
    Realm.autorun(realm, (read) => {
      read($value);
    });
    expect(() => realm[Symbol.dispose]()).toThrow("The test realm is not at rest");
  });
});

describe("Computed.fromPromise with the rest of the API", () => {
  test("a computed value over it recomputes when it resolves", async () => {
    using realm = testRealm();
    const { calls, load } = loader<number>();
    const $value = Computed.fromPromise(realm, load, 1);
    const $double = Computed.make(realm, (read) => read($value) * 2);
    using doubles = record(realm, (read) => read($double));
    calls[0]?.resolve(4);
    await settle();
    expect(doubles.values).toEqual([8]);
  });

  test("an autorun that reads it starts it and stops it", async () => {
    using realm = testRealm();
    const { calls, load } = loader<number>();
    const $value = Computed.fromPromise(realm, load, 0);
    const seen: Array<number> = [];
    const stop = Realm.autorun(realm, (read) => {
      seen.push(read($value));
    });
    calls[0]?.resolve(2);
    await settle();
    stop();
    expect(seen).toEqual([0, 2]);
    expect(calls[0]?.signal.aborted).toBe(true);
  });

  test("an observation that begins inside an update starts load once the update lands", () => {
    using realm = testRealm();
    const { calls, load } = loader<number>();
    const $value = Computed.fromPromise(realm, load, 0);
    const $count = Box.make(realm, 0);
    let release: () => void = () => undefined;
    Realm.update(realm, (_read, write) => {
      write($count, 1);
      Realm.update(realm, (_innerRead, innerWrite) => innerWrite($count, 2));
      release = Source.observe($value);
    });
    expect(calls).toHaveLength(1);
    release();
  });

  test("an update that throws after the observation ended keeps the reset", async () => {
    using realm = testRealm();
    const { calls, load } = loader<number>();
    const $value = Computed.fromPromise(realm, load, 0);
    const release = Source.observe($value);
    calls[0]?.resolve(9);
    await settle();
    expect(() =>
      Realm.update(realm, () => {
        release();
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(currentOf(realm, $value)).toBe(0);
  });

  test("a value of another realm read through it throws", () => {
    using realm = testRealm();
    using other = testRealm();
    const $value = Computed.fromPromise(realm, () => Promise.resolve(1), 0);
    expect(() => Realm.untracked(other, (read) => read($value))).toThrow();
  });

  test("a stage reads it unobserved as initial and starts nothing", () => {
    using realm = testRealm();
    const { calls, load } = loader<number>();
    const $value = Computed.fromPromise(realm, load, 5);
    const stage = Stage.make(realm);
    expect(Stage.read(stage, (read) => read($value))).toBe(5);
    expect(calls).toHaveLength(0);
    Stage.drop(stage);
  });

  test("a stage that fails on conflicts conflicts when it resolved since the stage read it", async () => {
    using realm = testRealm();
    const { calls, load } = loader<number>();
    const $value = Computed.fromPromise(realm, load, 0, { name: "quote" });
    const $total = Box.make(realm, 0);
    using _observed = held(Source.observe($value));
    const stage = Stage.make(realm, { conflicts: "fail" });
    Stage.update(stage, (read, write) => write($total, read($value) + 1));
    calls[0]?.resolve(41);
    await settle();
    let conflict: unknown;
    try {
      Stage.apply(stage);
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(StageConflictError);
    expect((conflict as StageConflictError).changed).toEqual(["quote"]);
    expect(currentOf(realm, $total)).toBe(0);
  });

  test("a stage that replays lands over the resolved value", async () => {
    using realm = testRealm();
    const { calls, load } = loader<number>();
    const $value = Computed.fromPromise(realm, load, 0);
    const $total = Box.make(realm, 0);
    using _observed = held(Source.observe($value));
    const stage = Stage.make(realm);
    Stage.update(stage, (read, write) => write($total, read($value) + 1));
    calls[0]?.resolve(41);
    await settle();
    Stage.apply(stage);
    expect(currentOf(realm, $total)).toBe(42);
  });

  test("a scheduled watch takes the resolved value when its scheduler runs", async () => {
    using realm = testRealm();
    const { calls, load } = loader<number>();
    const $value = Computed.fromPromise(realm, load, 0);
    const runs: Array<() => void> = [];
    const seen: Array<number> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($value),
      (value) => {
        seen.push(value);
      },
      { scheduler: (run) => runs.push(run) },
    );
    calls[0]?.resolve(3);
    await settle();
    expect(seen).toEqual([]);
    for (const run of runs.splice(0)) run();
    expect(seen).toEqual([3]);
    stop();
  });
});
