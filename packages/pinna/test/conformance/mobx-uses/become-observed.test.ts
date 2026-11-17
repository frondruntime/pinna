import { describe, expect, test } from "bun:test";
import {
  type IObservableValue,
  autorun as mobxAutorun,
  computed as mobxComputed,
  observable,
  onBecomeObserved,
  onBecomeUnobserved,
  runInAction,
} from "mobx";
import {
  autorun,
  box,
  computed,
  createRealm,
  onObserved,
  type Realm,
  untracked,
  update,
} from "../../../src/index.ts";

/**
 * Ported from MobX's `packages/mobx/__tests__/base/become-observed.ts` at
 * `mobx@7.1.0`, beside `onObserved`, under MobX's license:
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2015 Michel Weststrate
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Each case runs on MobX and on Pinna; the issue number names the MobX case.
 *
 * One difference runs through the traces, the one `create-atom.test.ts`
 * states: MobX starts a hook inside the read, during the reader's first run,
 * and Pinna once that run's reads are linked, after it. Stops follow the
 * same rule. Where a trace differs only in that order, each side keeps its
 * own and the values seen are shared.
 *
 * Not ported: `keepAlive` (caseC to caseF; `observe` is a different
 * primitive, which starts the held value's own hooks), observable maps and
 * sets, decorators, and the `observers_` internals.
 */

/** A realm whose errors with no caller are kept, to assert on. */
const pinnaRealm = (): { readonly realm: Realm; readonly errors: Array<unknown> } => {
  const errors: Array<unknown> = [];
  return { realm: createRealm({ onError: (error) => errors.push(error) }), errors };
};

/** Logs "<name> observed" and "<name> unobserved" for `source`. */
const mobxHooks = (
  events: Array<string>,
  name: string,
  source: IObservableValue<unknown> | { get(): unknown },
) => {
  onBecomeObserved(source as IObservableValue<unknown>, () => events.push(`${name} observed`));
  onBecomeUnobserved(source as IObservableValue<unknown>, () => events.push(`${name} unobserved`));
};

const pinnaHooks = (
  events: Array<string>,
  name: string,
  source: Parameters<typeof onObserved>[0],
) =>
  onObserved(source, () => {
    events.push(`${name} observed`);
    return () => events.push(`${name} unobserved`);
  });

describe("#2309 an untracked read starts no hook", () => {
  // A read in an action, and a read of a derived value with no reader, start
  // nothing on the source or on the chain of derived values (caseB).
  const trace = ["--"];

  test("MobX: a read in an action", () => {
    const events: Array<string> = [];
    const prop = observable.box(42);
    const doubled = mobxComputed(() => prop.get() * 2);
    const quadrupled = mobxComputed(() => doubled.get() * 2);
    mobxHooks(events, "prop", prop);
    mobxHooks(events, "doubled", doubled);
    runInAction(() => prop.get());
    events.push("--");
    runInAction(() => doubled.get());
    quadrupled.get();
    expect(events).toEqual(trace);
  });

  test("Pinna: a read in an update or untracked", () => {
    const { realm, errors } = pinnaRealm();
    const events: Array<string> = [];
    const $prop = box(realm, 42);
    const doubled = computed(realm, (read) => read($prop) * 2);
    const quadrupled = computed(realm, (read) => read(doubled) * 2);
    pinnaHooks(events, "prop", $prop);
    pinnaHooks(events, "doubled", doubled);
    update(realm, (read) => {
      read($prop);
    });
    events.push("--");
    update(realm, (read) => {
      read(doubled);
    });
    untracked(realm, (read) => read(quadrupled));
    expect({ events, errors }).toEqual({ events: trace, errors: [] });
  });
});

describe("#2309 caseE: a chain of derived values observed by an autorun", () => {
  // Every node in the chain starts once and stops once. MobX goes from the
  // reader down, Pinna from the source up.
  const nodes = ["cb", "ca", "o"];

  test("MobX: from the reader down", () => {
    const events: Array<string> = [];
    const o = observable.box(1);
    const ca = mobxComputed(() => o.get());
    const cb = mobxComputed(() => ca.get() * 2);
    mobxHooks(events, "o", o);
    mobxHooks(events, "ca", ca);
    mobxHooks(events, "cb", cb);
    mobxAutorun(() => cb.get())();
    expect(events).toEqual([
      ...nodes.map((node) => `${node} observed`),
      ...nodes.map((node) => `${node} unobserved`),
    ]);
  });

  test("Pinna: from the source up", () => {
    const { realm, errors } = pinnaRealm();
    const events: Array<string> = [];
    const $o = box(realm, 1);
    const ca = computed(realm, (read) => read($o));
    const cb = computed(realm, (read) => read(ca) * 2);
    pinnaHooks(events, "o", $o);
    pinnaHooks(events, "ca", ca);
    pinnaHooks(events, "cb", cb);
    autorun(realm, (read) => {
      read(cb);
    })();
    const fromSource = [...nodes].reverse();
    expect({ events, errors }).toEqual({
      events: [
        ...fromSource.map((node) => `${node} observed`),
        ...fromSource.map((node) => `${node} unobserved`),
      ],
      errors: [],
    });
  });
});

describe("#2686 a source a derived value reads only after a write", () => {
  // The source starts when the derived value first reads it and stops with
  // the autorun; the autorun sees -Infinity, then -1.
  const seen = ["value: -Infinity", "value: -1"] as const;

  test("MobX: the hook starts inside the recompute", () => {
    const events: Array<string> = [];
    const lowerValue = observable.box(-1);
    let isObserved = false;
    onBecomeObserved(lowerValue, () => {
      events.push("observed");
      isObserved = true;
    });
    onBecomeUnobserved(lowerValue, () => {
      events.push("unobserved");
      isObserved = false;
    });
    const lower = observable.box<IObservableValue<number> | undefined>(undefined, { deep: false });
    const upper = mobxComputed(() => lower.get()?.get() ?? -Infinity);
    const stop = mobxAutorun(() => {
      events.push(`value: ${upper.get()}`);
    });
    runInAction(() => lower.set(lowerValue));
    expect(isObserved).toBe(true);
    stop();
    expect(isObserved).toBe(false);
    expect(events).toEqual([seen[0], "observed", seen[1], "unobserved"]);
  });

  test("Pinna: the hook starts once the autorun's run is linked", () => {
    const { realm, errors } = pinnaRealm();
    const events: Array<string> = [];
    const $lowerValue = box(realm, -1);
    let isObserved = false;
    onObserved($lowerValue, () => {
      events.push("observed");
      isObserved = true;
      return () => {
        events.push("unobserved");
        isObserved = false;
      };
    });
    const $lower = box(realm, undefined as unknown);
    const upper = computed(realm, (read) => {
      const lower = read($lower) as typeof $lowerValue | undefined;
      return lower === undefined ? -Infinity : read(lower);
    });
    const stop = autorun(realm, (read) => {
      events.push(`value: ${read(upper)}`);
    });
    update(realm, (_read, write) => {
      write($lower, $lowerValue);
    });
    expect(isObserved).toBe(true);
    stop();
    expect(isObserved).toBe(false);
    expect({ events, errors }).toEqual({
      events: [seen[0], seen[1], "observed", "unobserved"],
      errors: [],
    });
  });
});

describe("#2686 - 3: a derived value made by a derived value", () => {
  // The values and the recompute count agree: four recomputes, the fourth an
  // equal result that reruns nothing.
  const results = ["result: loading", "result: 1$", "result: 2$", "result: 3$"] as const;

  test("MobX: the hook starts before the first recompute", () => {
    const events: Array<string> = [];
    const first = observable.box(2);
    const model = observable.box<{ readonly suffix: string } | undefined>(undefined, {
      deep: false,
    });
    const load = mobxComputed(() => {
      const current = model.get();
      if (current === undefined) {
        return undefined;
      }
      const half = mobxComputed(() => {
        events.push("recalculating");
        return Math.round(first.get() / 2) + current.suffix;
      });
      onBecomeObserved(half, () => events.push("observing"));
      return half;
    });
    const result = mobxComputed(() => load.get()?.get() ?? "loading");
    mobxAutorun(() => {
      events.push(`result: ${result.get()}`);
    });
    runInAction(() => model.set({ suffix: "$" }));
    for (const value of [3, 4, 5]) {
      runInAction(() => first.set(value));
    }
    expect(events).toEqual([
      results[0],
      "observing",
      "recalculating",
      results[1],
      "recalculating",
      results[2],
      "recalculating",
      "recalculating",
      results[3],
    ]);
  });

  test("Pinna: the hook starts once the run is linked", () => {
    const { realm, errors } = pinnaRealm();
    const events: Array<string> = [];
    const $first = box(realm, 2);
    const $model = box(realm, undefined as unknown);
    const load = computed(realm, (read) => {
      const current = read($model) as { readonly suffix: string } | undefined;
      if (current === undefined) {
        return undefined;
      }
      const half = computed(realm, (read) => {
        events.push("recalculating");
        return Math.round(read($first) / 2) + current.suffix;
      });
      onObserved(half, () => {
        events.push("observing");
        return undefined;
      });
      return half;
    });
    const result = computed(realm, (read) => {
      const loaded = read(load);
      return (loaded === undefined ? undefined : read(loaded)) ?? "loading";
    });
    autorun(realm, (read) => {
      events.push(`result: ${read(result)}`);
    });
    update(realm, (_read, write) => {
      write($model, { suffix: "$" });
    });
    for (const value of [3, 4, 5]) {
      update(realm, (_read, write) => {
        write($first, value);
      });
    }
    expect({ events, errors }).toEqual({
      events: [
        results[0],
        "recalculating",
        results[1],
        "observing",
        "recalculating",
        results[2],
        "recalculating",
        "recalculating",
        results[3],
      ],
      errors: [],
    });
  });
});

describe("#2667 a hook that loads what it guards", () => {
  // A list loads its items when they gain a reader and drops them when they
  // lose it. MobX loads inside the read, so the reader never sees the list
  // empty. Pinna loads after the run, so the reader runs once with no items
  // ("-") and again with them, for each list. The last values agree.

  test("MobX: the reader sees each list loaded", () => {
    const events: Array<unknown> = [];
    const makeList = (name: string, lazy: ReadonlyArray<string>) => {
      const items = observable.box<ReadonlyArray<string> | undefined>(undefined, { deep: false });
      onBecomeObserved(items, () => {
        runInAction(() => items.set(lazy));
        events.push(`observed ${name}`);
      });
      onBecomeUnobserved(items, () => {
        runInAction(() => items.set(undefined));
        events.push(`unobserved ${name}`);
      });
      return { items, name };
    };
    const list = observable.box(makeList("initial", ["a, b, c"]), { deep: false });
    const items = mobxComputed(() => list.get().items.get());
    const name = mobxComputed(() => list.get().name);
    const stop = mobxAutorun(() => {
      events.push(items.get()?.length ?? "-", name.get());
    });
    runInAction(() => list.set(makeList("new", ["b, c, a"])));
    stop();
    expect(events).toEqual([
      "observed initial",
      1,
      "initial",
      "observed new",
      1,
      "new",
      "unobserved initial",
      "unobserved new",
    ]);
  });

  test("Pinna: the reader runs once more for each list, before it loads", () => {
    const { realm, errors } = pinnaRealm();
    const events: Array<unknown> = [];
    const makeList = (name: string, lazy: ReadonlyArray<string>) => {
      const $items = box(realm, undefined as unknown);
      onObserved($items, () => {
        update(realm, (_read, write) => {
          write($items, lazy);
        });
        events.push(`observed ${name}`);
        return () => {
          update(realm, (_read, write) => {
            write($items, undefined);
          });
          events.push(`unobserved ${name}`);
        };
      });
      return { $items, name };
    };
    type List = ReturnType<typeof makeList>;
    const $list = box(realm, makeList("initial", ["a, b, c"]) as unknown);
    const items = computed(
      realm,
      (read) => read((read($list) as List).$items) as ReadonlyArray<string> | undefined,
    );
    const name = computed(realm, (read) => (read($list) as List).name);
    const stop = autorun(realm, (read) => {
      events.push(read(items)?.length ?? "-", read(name));
    });
    update(realm, (_read, write) => {
      write($list, makeList("new", ["b, c, a"]));
    });
    stop();
    expect({ events, errors }).toEqual({
      events: [
        "-",
        "initial",
        "observed initial",
        1,
        "initial",
        "-",
        "new",
        "observed new",
        "unobserved initial",
        1,
        "new",
        "unobserved new",
      ],
      errors: [],
    });
  });
});

describe("#3954 cleanups that each stop the next autorun", () => {
  const length = 10_000;

  test("MobX: the whole chain stops", () => {
    const boxes = Array.from({ length }, () => observable.box(0));
    const stops = boxes.map((box) => mobxAutorun(() => box.get()));
    let stopped = 0;
    boxes.forEach((box, index) => {
      onBecomeUnobserved(box, () => {
        stopped++;
        stops[index + 1]?.();
      });
    });
    stops[0]?.();
    expect(stopped).toBe(length);
  });

  test("Pinna: the whole chain stops", () => {
    const { realm, errors } = pinnaRealm();
    const boxes = Array.from({ length }, () => box(realm, 0));
    const stops = boxes.map(($box) =>
      autorun(realm, (read) => {
        read($box);
      }),
    );
    let stopped = 0;
    boxes.forEach(($box, index) => {
      onObserved($box, () => () => {
        stopped++;
        stops[index + 1]?.();
      });
    });
    stops[0]?.();
    expect({ stopped, errors }).toEqual({ stopped: length, errors: [] });
  });
});

describe("#3954 a cleanup that throws", () => {
  // A later, unrelated stop still runs its cleanup. MobX throws the error to
  // the caller that stopped the autorun; Pinna passes it to `onError`, as
  // `onObserved` documents.

  test("MobX: the error reaches the caller", () => {
    const first = observable.box(0);
    const stopFirst = mobxAutorun(() => first.get());
    onBecomeUnobserved(first, () => {
      throw new Error("boom");
    });
    expect(() => stopFirst()).toThrow("boom");
    const second = observable.box(0);
    const stopSecond = mobxAutorun(() => second.get());
    let stopped = false;
    onBecomeUnobserved(second, () => {
      stopped = true;
    });
    stopSecond();
    expect(stopped).toBe(true);
  });

  test("Pinna: the error reaches onError", () => {
    const { realm, errors } = pinnaRealm();
    const $first = box(realm, 0);
    const stopFirst = autorun(realm, (read) => {
      read($first);
    });
    onObserved($first, () => () => {
      throw new Error("boom");
    });
    expect(() => stopFirst()).not.toThrow();
    const $second = box(realm, 0);
    const stopSecond = autorun(realm, (read) => {
      read($second);
    });
    let stopped = false;
    onObserved($second, () => () => {
      stopped = true;
    });
    stopSecond();
    expect({ stopped, errors: errors.map(String) }).toEqual({
      stopped: true,
      errors: ["Error: boom"],
    });
  });
});

describe("#4547 a cached derived value that gains a reader", () => {
  // A derived value read in an update, then observed by an autorun made in
  // the same update, starts its source's hook, through one level or two.
  const trace = { started: ["BO"], stopped: ["BO", "BUO"] };

  for (const depth of [1, 2]) {
    test(`MobX: through ${depth} derived value${depth === 1 ? "" : "s"}`, () => {
      const events: Array<string> = [];
      const o = observable.box(1);
      onBecomeObserved(o, () => events.push("BO"));
      onBecomeUnobserved(o, () => events.push("BUO"));
      const inner = mobxComputed(() => o.get());
      const outer = depth === 1 ? inner : mobxComputed(() => inner.get());
      let stop: () => void = () => {};
      runInAction(() => {
        outer.get();
        stop = mobxAutorun(() => outer.get());
      });
      const started = [...events];
      stop();
      expect({ started, stopped: events }).toEqual(trace);
    });

    test(`Pinna: through ${depth} derived value${depth === 1 ? "" : "s"}`, () => {
      const { realm, errors } = pinnaRealm();
      const events: Array<string> = [];
      const $o = box(realm, 1);
      onObserved($o, () => {
        events.push("BO");
        return () => events.push("BUO");
      });
      const inner = computed(realm, (read) => read($o));
      const outer = depth === 1 ? inner : computed(realm, (read) => read(inner));
      let stop: () => void = () => {};
      update(realm, (read) => {
        read(outer);
        stop = autorun(realm, (read) => {
          read(outer);
        });
      });
      const started = [...events];
      stop();
      expect({ started, stopped: events, errors }).toEqual({ ...trace, errors: [] });
    });
  }
});

describe("#3674 a source an observed derived value gains in an update", () => {
  const trace = { started: ["BO"], stopped: ["BO", "BUO"] };

  test("MobX", () => {
    const events: Array<string> = [];
    const enabled = observable.box(false);
    const resource = observable.box(1);
    onBecomeObserved(resource, () => events.push("BO"));
    onBecomeUnobserved(resource, () => events.push("BUO"));
    const derived = mobxComputed(() => (enabled.get() ? resource.get() : null));
    const stop = mobxAutorun(() => derived.get());
    runInAction(() => {
      enabled.set(true);
      derived.get();
    });
    const started = [...events];
    stop();
    expect({ started, stopped: events }).toEqual(trace);
  });

  test("Pinna", () => {
    const { realm, errors } = pinnaRealm();
    const events: Array<string> = [];
    const $enabled = box(realm, false);
    const $resource = box(realm, 1);
    onObserved($resource, () => {
      events.push("BO");
      return () => events.push("BUO");
    });
    const derived = computed(realm, (read) => (read($enabled) ? read($resource) : null));
    const stop = autorun(realm, (read) => {
      read(derived);
    });
    update(realm, (read, write) => {
      write($enabled, true);
      read(derived);
    });
    const started = [...events];
    stop();
    expect({ started, stopped: events, errors }).toEqual({ ...trace, errors: [] });
  });
});

describe("a derived value read in an update with no reader starts no hook", () => {
  test("MobX", () => {
    const events: Array<string> = [];
    const enabled = observable.box(false);
    const resource = observable.box(1);
    onBecomeObserved(resource, () => events.push("BO"));
    onBecomeUnobserved(resource, () => events.push("BUO"));
    const inner = mobxComputed(() => (enabled.get() ? resource.get() : null));
    const outer = mobxComputed(() => inner.get());
    runInAction(() => {
      outer.get();
      enabled.set(true);
      inner.get();
    });
    expect(events).toEqual([]);
  });

  test("Pinna", () => {
    const { realm, errors } = pinnaRealm();
    const events: Array<string> = [];
    const $enabled = box(realm, false);
    const $resource = box(realm, 1);
    onObserved($resource, () => {
      events.push("BO");
      return () => events.push("BUO");
    });
    const inner = computed(realm, (read) => (read($enabled) ? read($resource) : null));
    const outer = computed(realm, (read) => read(inner));
    update(realm, (read, write) => {
      read(outer);
      write($enabled, true);
      read(inner);
    });
    expect({ events, errors }).toEqual({ events: [], errors: [] });
  });
});

describe("observers removed and added again, three times", () => {
  // The values agree. Each round starts and stops both nodes once; MobX
  // starts the derived value first, Pinna the box.
  const seen = (round: number) => {
    const base = 1 + round * 3;
    return [2 * base, base, 2 * (base + 1), base + 1, base + 2];
  };
  const rounds = [0, 1, 2];

  test("MobX", () => {
    const events: Array<string> = [];
    const box = observable.box(1);
    const double = mobxComputed(() => box.get() * 2);
    mobxHooks(events, "box", box);
    mobxHooks(events, "double", double);
    for (const round of rounds) {
      const values: Array<number> = [];
      const stopDouble = mobxAutorun(() => values.push(double.get()));
      const stopBox = mobxAutorun(() => values.push(box.get()));
      runInAction(() => box.set(box.get() + 1));
      stopDouble();
      runInAction(() => box.set(box.get() + 1));
      stopBox();
      runInAction(() => box.set(box.get() + 1));
      expect(values).toEqual(seen(round));
    }
    const cycle = ["double observed", "box observed", "double unobserved", "box unobserved"];
    expect(events).toEqual(rounds.flatMap(() => cycle));
  });

  test("Pinna", () => {
    const { realm, errors } = pinnaRealm();
    const events: Array<string> = [];
    const $box = box(realm, 1);
    const double = computed(realm, (read) => read($box) * 2);
    pinnaHooks(events, "box", $box);
    pinnaHooks(events, "double", double);
    const increment = () =>
      update(realm, (read, write) => {
        write($box, read($box) + 1);
      });
    for (const round of rounds) {
      const values: Array<number> = [];
      const stopDouble = autorun(realm, (read) => {
        values.push(read(double));
      });
      const stopBox = autorun(realm, (read) => {
        values.push(read($box));
      });
      increment();
      stopDouble();
      increment();
      stopBox();
      increment();
      expect(values).toEqual(seen(round));
    }
    const cycle = ["box observed", "double observed", "double unobserved", "box unobserved"];
    expect({ events, errors }).toEqual({ events: rounds.flatMap(() => cycle), errors: [] });
  });
});

describe("a branch read, dropped, and read again", () => {
  const trace = {
    seen: ["a1", "b1", "a2", "a3"],
    events: ["a observed", "a unobserved", "a observed", "a unobserved"],
  };

  test("MobX", () => {
    const events: Array<string> = [];
    const condition = observable.box(true);
    const a = observable.box("a1");
    const b = observable.box("b1");
    mobxHooks(events, "a", a);
    const seen: Array<string> = [];
    const stop = mobxAutorun(() => seen.push(condition.get() ? a.get() : b.get()));
    runInAction(() => condition.set(false));
    runInAction(() => a.set("a2"));
    runInAction(() => condition.set(true));
    runInAction(() => a.set("a3"));
    stop();
    expect({ seen, events }).toEqual(trace);
  });

  test("Pinna", () => {
    const { realm, errors } = pinnaRealm();
    const events: Array<string> = [];
    const $condition = box(realm, true);
    const $a = box(realm, "a1");
    const $b = box(realm, "b1");
    pinnaHooks(events, "a", $a);
    const seen: Array<string> = [];
    const stop = autorun(realm, (read) => {
      seen.push(read($condition) ? read($a) : read($b));
    });
    update(realm, (_read, write) => write($condition, false));
    update(realm, (_read, write) => write($a, "a2"));
    update(realm, (_read, write) => write($condition, true));
    update(realm, (_read, write) => write($a, "a3"));
    stop();
    expect({ seen, events, errors }).toEqual({ ...trace, errors: [] });
  });
});
