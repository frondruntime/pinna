/**
 * The speed scenarios: the reactive graph alone. The first six follow
 * js-reactivity-benchmark's shapes, the last three rere-benchmark's
 * (`docs/performance.md`). A scenario builds its graph in `setup`, outside
 * the timing, and returns the run that is timed. `setup` runs once per
 * sample, on the one instance the cell keeps, so it builds a new graph each
 * time and leaves the previous one to the collector. A run checks what its
 * watchers saw, a value or a count of effect runs, so a library that skips
 * work fails instead of winning. Every watcher has an effect, so every
 * library runs the same compare-and-call on each change.
 *
 * Plain code, bundled into the workers: no `effect`.
 */
import type { Adapter, Source } from "./adapter.ts";

export interface Scenario {
  /** Stable, for the command line and the results file. */
  readonly id: string;
  /** What a table prints. */
  readonly name: string;
  readonly setup: (library: Adapter) => () => void;
}

/** Throws when a watcher saw something other than what was written. */
const expect = (actual: unknown, expected: unknown, scenario: string): void => {
  if (actual !== expected) {
    throw new Error(`pinna-bench: ${scenario} saw ${String(actual)}, expected ${String(expected)}`);
  }
};

/**
 * The effect of every scenario whose watchers only count runs, made once per
 * process rather than in `setup`. V8 compiles Pinna's effect call for the one
 * function it has seen and discards that code when a sample's function is
 * collected; with `count` made in `setup`, fan-out on Node measured 10.7 to
 * 11.7 ms and 224 to 281 KB a run, against 8.6 ms and 10 KB with one
 * function (`docs/performance.md`). Every library gets the same function.
 */
let runs = 0;
const count = (): void => {
  runs++;
};

/**
 * Bursty fan-out's update, made once per process for the same reason as
 * `count`. Made per burst, V8 compiled it with Maglev on every other sample
 * and discarded the code, and that compilation counted 119 to 964 KB on
 * each of those samples for Pinna, and alien-signals paid it too
 * (`docs/performance.md`). It writes to the sample's `head`, set before the
 * run's first burst.
 */
const burst: { head: Source<number> | undefined; number: number } = {
  head: undefined,
  number: 0,
};
const writeBurst = (): void => {
  const head = burst.head as Source<number>;
  for (let write = 1; write <= 100; write++) {
    head.set(burst.number * 100 + write);
  }
};

export const scenarios: ReadonlyArray<Scenario> = [
  {
    id: "deep-chain",
    name: "deep chain 1000, write ×100",
    setup: (library) => {
      const head = library.box(0);
      let last: () => number = head.get;
      for (let index = 0; index < 1000; index++) {
        const previous = last;
        last = library.computed(() => previous() + 1).get;
      }
      let seen = 0;
      library.watch(last, (value) => {
        seen = value;
      });
      return () => {
        for (let write = 1; write <= 100; write++) {
          library.update(() => head.set(write));
        }
        expect(seen, 1100, "deep chain");
      };
    },
  },
  {
    id: "fan-out",
    name: "fan-out 1000 watched, write ×100",
    setup: (library) => {
      const head = library.box(0);
      for (let index = 0; index < 1000; index++) {
        library.watch(library.computed(() => head.get() + index).get, count);
      }
      return () => {
        runs = 0;
        for (let write = 1; write <= 100; write++) {
          library.update(() => head.set(write));
        }
        expect(runs, 100 * 1000, "fan-out");
      };
    },
  },
  {
    id: "diamond",
    name: "diamond 1000 into a sum, write ×100",
    setup: (library) => {
      const head = library.box(0);
      const branches = Array.from(
        { length: 1000 },
        (_, index) => library.computed(() => head.get() * index).get,
      );
      const sum = library.computed(() => {
        let total = 0;
        for (let index = 0; index < branches.length; index++) {
          total += (branches[index] as () => number)();
        }
        return total;
      });
      let seen = 0;
      library.watch(sum.get, (value) => {
        seen = value;
      });
      return () => {
        for (let write = 1; write <= 100; write++) {
          library.update(() => head.set(write));
        }
        expect(seen, 100 * 499_500, "diamond");
      };
    },
  },
  {
    id: "conditional-reads",
    name: "conditional reads 1000, flip ×100",
    setup: (library) => {
      const flag = library.box(true);
      const left = library.box(1);
      const right = library.box(2);
      for (let index = 0; index < 1000; index++) {
        library.watch(library.computed(() => (flag.get() ? left.get() : right.get())).get, count);
      }
      return () => {
        runs = 0;
        for (let write = 0; write < 100; write++) {
          library.update(() => flag.set(write % 2 === 1));
          library.update(() => (write % 2 === 0 ? right : left).set(write));
        }
        // Each flip and each write changes the value, except the first write
        // to `left`, which writes the 1 it already holds: 199 per watcher.
        expect(runs, 199 * 1000, "conditional reads");
      };
    },
  },
  {
    id: "make-and-dispose",
    name: "make and dispose 1000 watched computeds ×10",
    setup: (library) => {
      const head = library.box(0);
      return () => {
        runs = 0;
        // Nothing is written, so `count` never runs; it is passed so that each
        // watch is made as in every other scenario.
        for (let round = 0; round < 10; round++) {
          const stops: Array<() => void> = [];
          for (let index = 0; index < 1000; index++) {
            stops.push(library.watch(library.computed(() => head.get() + index).get, count));
          }
          for (let index = 0; index < stops.length; index++) {
            (stops[index] as () => void)();
          }
        }
        expect(runs, 0, "make and dispose");
      };
    },
  },
  {
    id: "write-sources",
    name: "write 1000 sources in one update ×100",
    setup: (library) => {
      const sources = Array.from({ length: 1000 }, () => library.box(0));
      for (const source of sources) {
        library.watch(source.get, count);
      }
      return () => {
        runs = 0;
        for (let write = 1; write <= 100; write++) {
          library.update(() => {
            for (let index = 0; index < sources.length; index++) {
              (sources[index] as Source<number>).set(write);
            }
          });
        }
        expect(runs, 100 * 1000, "write sources");
      };
    },
  },
  {
    id: "bursty-fan-out",
    name: "bursty fan-out: 1000 watched, 100 writes per update ×100",
    setup: (library) => {
      const head = library.box(0);
      for (let index = 0; index < 1000; index++) {
        library.watch(library.computed(() => head.get() + index).get, count);
      }
      return () => {
        runs = 0;
        burst.head = head;
        for (let number = 1; number <= 100; number++) {
          burst.number = number;
          library.update(writeBurst);
        }
        expect(runs, 100 * 1000, "bursty fan-out");
      };
    },
  },
  {
    id: "increment",
    name: "increment ×100k, each value checked",
    setup: (library) => {
      const count = library.box(0);
      const doubled = library.computed(() => count.get() * 2);
      let seen = 0;
      library.watch(doubled.get, (value) => {
        seen = value;
      });
      return () => {
        for (let value = 1; value <= 100_000; value++) {
          library.update(() => count.set(value));
          expect(seen, value * 2, "increment");
        }
      };
    },
  },
  {
    id: "one-write-among-many",
    name: "one write among 10k watched rows ×1000",
    setup: (library) => {
      const sources = Array.from({ length: 10_000 }, () => library.box(0));
      for (const source of sources) {
        library.watch(library.computed(() => `row ${source.get()}`).get, count);
      }
      return () => {
        runs = 0;
        // 7919 is prime to 10,000, so the thousand writes hit a thousand
        // different rows, each from 0 to a new value.
        for (let write = 1; write <= 1000; write++) {
          const source = sources[(write * 7919) % sources.length] as Source<number>;
          library.update(() => source.set(write));
        }
        expect(runs, 1000, "one write among many");
      };
    },
  },
];
