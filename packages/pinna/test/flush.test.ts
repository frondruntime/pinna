import { describe, expect, test } from "bun:test";
import { Box, Computed, Realm, Source } from "../src/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * Two realms side by side, hooks added while a computed value links or
 * unlinks, `Source.peek`, and how a realm's `onError` meets a failing flush.
 * The public twin of `packages/pinna-core/test/graph.test.ts`. That file's
 * cases on a renderer's reaction (a pending run, `adopt`, a reaction
 * reactivated mid-flush) have their twins in `pinna-react`, through a render
 * and its commit; the ones on `notify` have theirs in `scheduled.test.ts`.
 */

const get = <Value>(realm: Realm, value: Computed<Value>): Value =>
  Realm.untracked(realm, (read) => read(value));

const set = <Value>(realm: Realm, box: Box<Value>, value: Value): void => {
  Realm.update(realm, (_read, write) => {
    write(box, value);
  });
};

const peek = <Value>(realm: Realm, box: Box<Value>): Value =>
  Realm.untracked(realm, (read) => read(box));

describe("two realms", () => {
  test("an update in one realm does not hold back the other realm's watchers", () => {
    const first = Realm.make();
    const second = Realm.make();
    const a = Box.make(first, 1);
    const b = Box.make(second, 1);
    const seen: Array<string> = [];
    const stopFirst = Realm.watch(
      first,
      (read) => read(a),
      (value) => {
        seen.push(`first ${value}`);
        return undefined;
      },
    );
    const stopSecond = Realm.watch(
      second,
      (read) => read(b),
      (value) => {
        seen.push(`second ${value}`);
        return undefined;
      },
    );

    Realm.update(first, (_read, write) => {
      write(a, 2);
      set(second, b, 2);
      expect(seen).toEqual(["second 2"]);
    });

    expect(seen).toEqual(["second 2", "first 2"]);
    stopFirst();
    stopSecond();
  });

  test("a computed value that reads another realm's box throws pinna/foreign-realm", () => {
    const first = Realm.make();
    const second = Realm.make();
    const a = Box.make(first, 1);
    const b = Box.make(second, 10);
    const sum = Computed.make(first, (read) => read(a) + (read(b as never) as number));
    expect(() => get(first, sum)).toThrow(
      expect.objectContaining({ code: "pinna/foreign-realm" }) as never,
    );
    expect(Realm.isTracking(second)).toBe(false);
    expectRealmAtRest(first);
    expectRealmAtRest(second);
  });

  test("a computed value in one realm can update the other", () => {
    const first = Realm.make();
    const second = Realm.make();
    const b = Box.make(second, 0);
    const a = Computed.make(first, () => {
      set(second, b, 1);
      return peek(second, b);
    });

    expect(get(first, a)).toBe(1);
    expectRealmAtRest(first);
    expectRealmAtRest(second);
  });

  test("a throwing watcher goes to its own realm's onError, and the other realm settles", () => {
    const firstErrors: Array<unknown> = [];
    const secondErrors: Array<unknown> = [];
    const first = Realm.make({ onError: (error) => firstErrors.push(error) });
    const second = Realm.make({ onError: (error) => secondErrors.push(error) });
    const a = Box.make(first, 1);
    const b = Box.make(second, 1);
    const seen: Array<number> = [];
    Realm.watch(
      first,
      (read) => read(a),
      () => {
        throw new Error("boom");
      },
    );
    Realm.watch(
      second,
      (read) => read(b),
      (value) => {
        seen.push(value);
        return undefined;
      },
    );

    Realm.update(first, (_read, write) => {
      write(a, 2);
      set(second, b, 2);
    });

    expect(firstErrors.map((error) => (error as Error).message)).toEqual(["boom"]);
    expect(secondErrors).toEqual([]);
    expect(seen).toEqual([2]);
    expectRealmAtRest(first);
    expectRealmAtRest(second);
  });

  test("a write to another realm's box throws pinna/foreign-realm and changes nothing", () => {
    const first = Realm.make();
    const second = Realm.make();
    const b = Box.make(second, 1);
    expect(() => set(first, b, 2)).toThrow(
      expect.objectContaining({ code: "pinna/foreign-realm" }) as never,
    );
    expect(peek(second, b)).toBe(1);
    expectRealmAtRest(first);
    expectRealmAtRest(second);
  });
});

describe("hooks added while a computed value links or unlinks", () => {
  test("a hook added twice while observed begins once and its cleanup runs once", () => {
    const realm = Realm.make();
    const box = Box.make(realm, 1);
    const stop = Realm.autorun(realm, (read) => {
      read(box);
      return undefined;
    });
    let starts = 0;
    let cleanups = 0;
    const start = () => {
      starts++;
      return () => {
        cleanups++;
      };
    };
    const first = Source.onObserved(box, start);
    const second = Source.onObserved(box, start);
    expect(starts).toBe(1);
    stop();
    expect(cleanups).toBe(1);
    first();
    second();
    expect([starts, cleanups]).toEqual([1, 1]);
    expectRealmAtRest(realm);
  });

  test("a hook added to a computed value while it links starts once", () => {
    const realm = Realm.make();
    const box = Box.make(realm, 1);
    const derived = Computed.make(realm, (read) => read(box) * 2);
    const log: Array<string> = [];
    Source.onObserved(box, () => {
      Source.onObserved(derived, () => {
        log.push("start");
        return () => {
          log.push("cleanup");
        };
      });
      return undefined;
    });

    const stop = Realm.autorun(realm, (read) => {
      read(derived);
      return undefined;
    });
    stop();

    expect(log).toEqual(["start", "cleanup"]);
  });

  // Ruling 28: the cleanup runs once the computed value is unobserved, so the
  // hook it adds goes on a value nothing observes.
  test("a hook a cleanup adds to a computed value it stopped observing does not start", () => {
    const realm = Realm.make();
    const box = Box.make(realm, 1);
    const derived = Computed.make(realm, (read) => read(box) * 2);
    const log: Array<string> = [];
    Source.onObserved(box, () => () => {
      Source.onObserved(derived, () => {
        log.push("start");
        return () => {
          log.push("cleanup");
        };
      });
    });

    const stop = Realm.autorun(realm, (read) => {
      read(derived);
      return undefined;
    });
    stop();

    expect(log).toEqual([]);
  });
});

describe("an untracked read of a computed value", () => {
  test("inside a watch's select computes the current value and subscribes nothing", () => {
    const realm = Realm.make();
    const box = Box.make(realm, 1);
    const other = Box.make(realm, 10);
    const derived = Computed.make(realm, (read) => read(box) * 2);
    const seen: Array<number> = [];
    const stop = Realm.watch(
      realm,
      (read) => read(other) + get(realm, derived),
      (value) => {
        seen.push(value);
        return undefined;
      },
    );

    set(realm, box, 2);
    expect(seen).toEqual([]);
    expect(Source.peek(derived)).toBe(4);
    set(realm, other, 20);
    expect(seen).toEqual([24]);
    stop();
  });

  test("Source.peek throws the error the computed value keeps", () => {
    const realm = Realm.make();
    const derived = Computed.make(realm, (): number => {
      throw new Error("boom");
    });
    expect(() => Source.peek(derived)).toThrow("boom");
    expectRealmAtRest(realm);
  });

  test("Source.peek where reads are tracked throws, so its result never goes stale", () => {
    const realm = Realm.make();
    const derived = Computed.make(realm, () => 1);
    expect(() =>
      Realm.autorun(realm, () => {
        Source.peek(derived);
        return undefined;
      }),
    ).toThrow(expect.objectContaining({ code: "pinna/peek-while-tracking" }) as never);
    expectRealmAtRest(realm);
  });

  test("a read after an untracked read that threw is still tracked", () => {
    const realm = Realm.make();
    const box = Box.make(realm, 1);
    const failing = Computed.make(realm, (): number => {
      throw new Error("boom");
    });
    let runs = 0;
    let caught: unknown;
    const stop = Realm.autorun(realm, (read) => {
      runs++;
      try {
        get(realm, failing);
      } catch (error) {
        caught = error;
      }
      read(box);
      return undefined;
    });

    expect((caught as Error).message).toBe("boom");
    set(realm, box, 2);
    expect(runs).toBe(2);
    stop();
    expectRealmAtRest(realm);
  });
});

describe("a failing flush and onError", () => {
  /** A realm whose onError throws, so the first error it meets is the one a write throws. */
  const rejecting = (): Realm =>
    Realm.make({
      onError: (error) => {
        throw new Error(`onError failed on ${(error as Error).message}`);
      },
    });

  test("an onError that throws leaves no autorun stuck", () => {
    let failing = true;
    const realm = Realm.make({
      onError: () => {
        if (failing) throw new Error("onError failed");
      },
    });
    const box = Box.make(realm, 0);
    const runs: Array<string> = [];
    Realm.autorun(realm, (read) => {
      read(box);
      runs.push("first");
      if (
        get(
          realm,
          Computed.make(realm, (inner) => inner(box)),
        ) === 1
      ) {
        throw new Error("boom");
      }
      return undefined;
    });
    Realm.autorun(realm, (read) => {
      read(box);
      runs.push("second");
      return undefined;
    });
    expect(() => set(realm, box, 1)).toThrow("onError failed");
    failing = false;
    runs.length = 0;

    set(realm, box, 2);

    expect(runs).toEqual(["first", "second"]);
    expectRealmAtRest(realm);
  });

  test("an update throws onError's first error when two watchers throw", () => {
    const realm = rejecting();
    const box = Box.make(realm, 0);
    for (const name of ["first", "second"]) {
      Realm.autorun(realm, (read) => {
        if (read(box) === 1) {
          throw new Error(name);
        }
        return undefined;
      });
    }

    expect(() => set(realm, box, 1)).toThrow("onError failed on first");
    expectRealmAtRest(realm);
  });

  test("an update throws onError's first error when two hooks begun in one pass throw", () => {
    const realm = rejecting();
    const flag = Box.make(realm, false);
    const first = Box.make(realm, 0);
    const second = Box.make(realm, 0);
    Source.onObserved(first, () => {
      throw new Error("first hook");
    });
    Source.onObserved(second, () => {
      throw new Error("second hook");
    });
    Realm.autorun(realm, (read) => {
      if (read(flag)) read(first) + read(second);
      return undefined;
    });

    expect(() => set(realm, flag, true)).toThrow("onError failed on first hook");
    expectRealmAtRest(realm);
  });

  test("an update throws onError's error for the round-limit report", () => {
    const realm = rejecting();
    const loop = Box.make(realm, 0);
    Realm.watch(
      realm,
      (read) => read(loop),
      (value) => {
        if (value > 0) {
          set(realm, loop, value + 1);
        }
        return undefined;
      },
    );

    expect(() => set(realm, loop, 1)).toThrow(
      /onError failed on .*did not settle after 100 rounds/,
    );
    expectRealmAtRest(realm);
  });

  test("after an onError that threw, the round limit still holds", () => {
    let failing = true;
    const reports: Array<unknown> = [];
    const realm = Realm.make({
      onError: (error) => {
        if (failing) throw new Error("onError failed");
        reports.push(error);
      },
    });
    const box = Box.make(realm, 0);
    Realm.autorun(realm, (read) => {
      if (read(box) === 1) {
        throw new Error("boom");
      }
      return undefined;
    });
    expect(() => set(realm, box, 1)).toThrow("onError failed");
    failing = false;
    const loop = Box.make(realm, 0);
    let runs = 0;
    Realm.watch(
      realm,
      (read) => read(loop),
      (value) => {
        runs++;
        if (runs < 1000) {
          set(realm, loop, value + 1);
        }
        return undefined;
      },
    );

    set(realm, loop, 1);

    expect(reports.map((error) => (error as Error).message)).toEqual([
      expect.stringMatching(/did not settle after 100 rounds/),
    ]);
    expect(runs).toBeLessThan(1000);
    expectRealmAtRest(realm);
  });
});
