/**
 * The conformance cases, written in this repository's own words. They cover
 * what reactive libraries commonly agree on, and MobX's behavior that
 * applications rely on: diamonds and glitches, batching, observed and
 * unobserved timing, errors in derived values, and nested updates.
 *
 * Each case runs against one fresh adapter. A library that misses a case
 * lists it in `gaps.ts` with the reason.
 */
import { expect } from "bun:test";
import type { CheckedAdapter as Adapter } from "../../src/adapter.ts";

export interface Case {
  readonly group: string;
  readonly name: string;
  readonly run: (adapter: Adapter) => void;
}

/** Watches `select` and returns every value its effect received. */
const record = <Value>(
  adapter: Adapter,
  select: () => Value,
): { readonly seen: Array<Value>; readonly stop: () => void } => {
  const seen: Array<Value> = [];
  const stop = adapter.watch(select, (value) => seen.push(value));
  return { seen, stop };
};

export const cases: ReadonlyArray<Case> = [
  // Basics
  {
    group: "basics",
    name: "a derived value follows its source",
    run: (adapter) => {
      const a = adapter.box(1);
      const double = adapter.computed(() => a.get() * 2);
      expect(adapter.untracked(() => double.get())).toBe(2);
      adapter.update(() => a.set(5));
      expect(adapter.untracked(() => double.get())).toBe(10);
    },
  },
  {
    group: "basics",
    name: "a chain of derived values follows its source",
    run: (adapter) => {
      const a = adapter.box(1);
      const b = adapter.computed(() => a.get() + 1);
      const c = adapter.computed(() => b.get() + 1);
      const d = adapter.computed(() => c.get() + 1);
      const { seen, stop } = record(adapter, () => d.get());
      adapter.update(() => a.set(10));
      expect(seen).toEqual([13]);
      stop();
    },
  },
  {
    group: "basics",
    name: "a watch runs on a change, not when it starts",
    run: (adapter) => {
      const a = adapter.box(1);
      const { seen, stop } = record(adapter, () => a.get());
      expect(seen).toEqual([]);
      adapter.update(() => a.set(2));
      expect(seen).toEqual([2]);
      stop();
    },
  },
  {
    group: "basics",
    name: "writing an equal value runs nothing",
    run: (adapter) => {
      const a = adapter.box(1);
      let computations = 0;
      const b = adapter.computed(() => {
        computations++;
        return a.get();
      });
      const { seen, stop } = record(adapter, () => b.get());
      computations = 0;
      adapter.update(() => a.set(1));
      expect(computations).toBe(0);
      expect(seen).toEqual([]);
      stop();
    },
  },
  {
    group: "basics",
    name: "a stopped watch runs no more",
    run: (adapter) => {
      const a = adapter.box(1);
      const { seen, stop } = record(adapter, () => a.get());
      adapter.update(() => a.set(2));
      stop();
      adapter.update(() => a.set(3));
      expect(seen).toEqual([2]);
    },
  },

  // Diamonds and glitches
  {
    group: "diamonds",
    name: "a diamond computes its bottom once per write, with no mixed value",
    run: (adapter) => {
      const a = adapter.box(1);
      const b = adapter.computed(() => a.get() * 2);
      const c = adapter.computed(() => a.get() * 3);
      const computed: Array<string> = [];
      const d = adapter.computed(() => {
        const value = `${b.get()}+${c.get()}`;
        computed.push(value);
        return value;
      });
      const { seen, stop } = record(adapter, () => d.get());
      computed.length = 0;
      adapter.update(() => a.set(2));
      expect(computed).toEqual(["4+6"]);
      expect(seen).toEqual(["4+6"]);
      stop();
    },
  },
  {
    group: "diamonds",
    name: "a diamond with uneven sides computes its bottom once, with no mixed value",
    run: (adapter) => {
      const a = adapter.box(1);
      const short = adapter.computed(() => a.get());
      const long1 = adapter.computed(() => a.get());
      const long2 = adapter.computed(() => long1.get());
      const long3 = adapter.computed(() => long2.get());
      const computed: Array<string> = [];
      const bottom = adapter.computed(() => {
        const value = `${short.get()}/${long3.get()}`;
        computed.push(value);
        return value;
      });
      const { seen, stop } = record(adapter, () => bottom.get());
      computed.length = 0;
      adapter.update(() => a.set(2));
      expect(computed).toEqual(["2/2"]);
      expect(seen).toEqual(["2/2"]);
      stop();
    },
  },
  {
    group: "diamonds",
    name: "a watch over two derived values of one source sees them agree",
    run: (adapter) => {
      const a = adapter.box(1);
      const b = adapter.computed(() => a.get() + 1);
      const c = adapter.computed(() => a.get() - 1);
      const { seen, stop } = record(adapter, () => b.get() - c.get());
      for (const value of [2, 3, 4]) {
        adapter.update(() => a.set(value));
      }
      expect(seen).toEqual([]);
      stop();
    },
  },
  {
    group: "diamonds",
    name: "a derived value that returns an equal result stops the change",
    run: (adapter) => {
      const a = adapter.box(1);
      const parity = adapter.computed(() => a.get() % 2);
      let computations = 0;
      const label = adapter.computed(() => {
        computations++;
        return parity.get() === 0 ? "even" : "odd";
      });
      const { seen, stop } = record(adapter, () => label.get());
      computations = 0;
      adapter.update(() => a.set(3));
      expect(computations).toBe(0);
      expect(seen).toEqual([]);
      stop();
    },
  },

  // Dynamic dependencies
  {
    group: "dependencies",
    name: "a branch not taken is not a dependency",
    run: (adapter) => {
      const useLeft = adapter.box(true);
      const left = adapter.box("left");
      const right = adapter.box("right");
      let computations = 0;
      const chosen = adapter.computed(() => {
        computations++;
        return useLeft.get() ? left.get() : right.get();
      });
      const { seen, stop } = record(adapter, () => chosen.get());
      computations = 0;
      adapter.update(() => right.set("right 2"));
      expect(computations).toBe(0);
      adapter.update(() => useLeft.set(false));
      expect(seen).toEqual(["right 2"]);
      computations = 0;
      adapter.update(() => left.set("left 2"));
      expect(computations).toBe(0);
      expect(seen).toEqual(["right 2"]);
      stop();
    },
  },
  {
    group: "dependencies",
    name: "an untracked read is not a dependency",
    run: (adapter) => {
      const a = adapter.box(1);
      const hidden = adapter.box(10);
      const sum = adapter.computed(() => a.get() + adapter.untracked(() => hidden.get()));
      const { seen, stop } = record(adapter, () => sum.get());
      adapter.update(() => hidden.set(20));
      expect(seen).toEqual([]);
      adapter.update(() => a.set(2));
      expect(seen).toEqual([22]);
      stop();
    },
  },

  // Batching and nested updates
  {
    group: "updates",
    name: "two writes in one update run a watch once, with the end state",
    run: (adapter) => {
      const a = adapter.box(1);
      const b = adapter.box(1);
      const { seen, stop } = record(adapter, () => a.get() + b.get());
      adapter.update(() => {
        a.set(2);
        b.set(3);
      });
      expect(seen).toEqual([5]);
      stop();
    },
  },
  {
    group: "updates",
    name: "a nested update runs watches when the outermost one ends",
    run: (adapter) => {
      const a = adapter.box(1);
      const { seen, stop } = record(adapter, () => a.get());
      adapter.update(() => {
        adapter.update(() => a.set(2));
        expect(seen).toEqual([]);
        a.set(3);
      });
      expect(seen).toEqual([3]);
      stop();
    },
  },
  {
    group: "updates",
    name: "a derived value read inside an update sees the update's writes",
    run: (adapter) => {
      const a = adapter.box(1);
      const double = adapter.computed(() => a.get() * 2);
      const { stop } = record(adapter, () => double.get());
      let inside = 0;
      adapter.update(() => {
        a.set(4);
        inside = double.get();
      });
      expect(inside).toBe(8);
      stop();
    },
  },
  {
    group: "updates",
    name: "a write and its undo in one update run no watch",
    run: (adapter) => {
      const a = adapter.box(1);
      const { seen, stop } = record(adapter, () => a.get());
      adapter.update(() => {
        a.set(2);
        a.set(1);
      });
      expect(seen).toEqual([]);
      stop();
    },
  },
  {
    group: "updates",
    name: "a watch effect that writes runs the watches of what it wrote",
    run: (adapter) => {
      const a = adapter.box(1);
      const b = adapter.box(0);
      const stopCopy = adapter.watch(
        () => a.get(),
        (value) => adapter.update(() => b.set(value * 10)),
      );
      const { seen, stop } = record(adapter, () => b.get());
      adapter.update(() => a.set(2));
      expect(seen).toEqual([20]);
      stop();
      stopCopy();
    },
  },

  // Errors in derived values
  {
    group: "errors",
    name: "a derived value that throws rethrows on read and recovers",
    run: (adapter) => {
      const a = adapter.box(1);
      const checked = adapter.computed(() => {
        if (a.get() < 0) {
          throw new Error("negative");
        }
        return a.get();
      });
      adapter.update(() => a.set(-1));
      expect(() => adapter.untracked(() => checked.get())).toThrow("negative");
      adapter.update(() => a.set(2));
      expect(adapter.untracked(() => checked.get())).toBe(2);
    },
  },
  {
    group: "errors",
    name: "a derived value that threw still tracks what it read before throwing",
    run: (adapter) => {
      const a = adapter.box(-1);
      let computations = 0;
      const checked = adapter.computed(() => {
        computations++;
        if (a.get() < 0) {
          throw new Error("negative");
        }
        return a.get();
      });
      const result = adapter.computed(() => {
        try {
          return checked.get();
        } catch {
          return "failed";
        }
      });
      const { seen, stop } = record(adapter, () => result.get());
      computations = 0;
      adapter.update(() => a.set(3));
      expect(computations).toBe(1);
      expect(seen).toEqual([3]);
      stop();
    },
  },

  // Observed and unobserved
  {
    group: "observed",
    name: "a derived value with no observer does not recompute on writes",
    run: (adapter) => {
      const a = adapter.box(1);
      let computations = 0;
      const double = adapter.computed(() => {
        computations++;
        return a.get() * 2;
      });
      const { stop } = record(adapter, () => double.get());
      stop();
      computations = 0;
      adapter.update(() => a.set(2));
      adapter.update(() => a.set(3));
      expect(computations).toBe(0);
    },
  },
  {
    group: "observed",
    name: "an observed hook starts with the first observer and cleans up after the last",
    run: (adapter) => {
      const onObserved = adapter.onObserved;
      if (onObserved === undefined) {
        throw new Error("conformance: this library has no observed hook");
      }
      const a = adapter.box(1);
      const double = adapter.computed(() => a.get() * 2);
      const events: Array<string> = [];
      const remove = onObserved(a, () => {
        events.push("start");
        return () => events.push("stop");
      });
      adapter.untracked(() => double.get());
      expect(events).toEqual([]);
      const first = adapter.watch(
        () => double.get(),
        () => {},
      );
      const second = adapter.watch(
        () => a.get(),
        () => {},
      );
      expect(events).toEqual(["start"]);
      first();
      expect(events).toEqual(["start"]);
      second();
      expect(events).toEqual(["start", "stop"]);
      remove();
    },
  },
];
