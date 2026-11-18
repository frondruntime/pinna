/**
 * The graph benchmark: the reactive graph alone, Pinna against alien-signals
 * (the fastest of the family), MobX (what Pinna replaces), and Legend State
 * (an observable store React Native teams pick today). Hosts run it:
 * `graph.ts` on Bun, `hermes-graph.ts` on Hermes.
 *
 * The first six scenarios follow js-reactivity-benchmark's shapes; the last
 * three are borrowed from rere-benchmark's (`docs/performance.md`). Every
 * library is driven through the same small interface, so each pays the same
 * wrapper calls.
 *
 * Pinna's boxes have no schema and every update keeps its
 * rollback journal: the graph as an application gets it.
 */
import {
  batch as legendBatch,
  observable as legendObservable,
  observe as legendObserve,
} from "@legendapp/state";
import {
  computed as alienComputed,
  effect as alienEffect,
  signal as alienSignal,
  endBatch,
  setActiveSub,
  startBatch,
} from "alien-signals";
import {
  computed as mobxComputed,
  observable as mobxObservable,
  reaction,
  runInAction,
} from "mobx";
import { box, computed, createRealm, untracked, update, type Write, watch } from "../src/index.ts";

const runs = 9;

interface Source<Value> {
  readonly get: () => Value;
  readonly set: (value: Value) => void;
}

/** What a scenario needs of a library. */
export interface Library {
  readonly source: <Value>(initial: Value) => Source<Value>;
  readonly computed: <Value>(compute: () => Value) => () => Value;
  /**
   * Watches `read`; `changed` sees each new value. Returns the stop.
   * `changed` is required, so every library runs the same reaction: an
   * optional one let a library skip the comparison and the call.
   */
  readonly watch: <Value>(read: () => Value, changed: (value: Value) => undefined) => () => void;
  /** Runs `write` as one update. */
  readonly batch: (write: () => void) => void;
}

/**
 * Pinna through the verbs a place hands out, `read` and `write`. The
 * interface reads through `get` with no verb in hand, so the adapter keeps
 * the read `untracked` hands out and the write an update hands out: a verb
 * checks, when called, that a place of its realm is open, not which place
 * handed it out. test/kept.ts holds the same helpers for the tests.
 */
const pinna = (): Library => {
  const realm = createRealm();
  const read = untracked(realm, (read) => read);
  const kept: { write?: Write } = {};
  update(realm, (_read, write) => {
    kept.write = write;
  });
  const write = kept.write;
  if (write === undefined) {
    throw new Error("pinna bench: update did not run its recipe");
  }
  return {
    source: (initial) => {
      const $box = box<unknown>(realm, initial);
      return {
        get: () => read($box) as never,
        set: (value) => {
          write($box, value);
        },
      };
    },
    computed: (compute) => {
      const value = computed(realm, compute);
      return () => read(value);
    },
    watch: (select, changed) => watch(realm, select, changed),
    batch: (run) =>
      update(realm, () => {
        run();
      }),
  };
};

const alien = (): Library => ({
  source: (initial) => {
    const signal = alienSignal(initial);
    return { get: () => signal(), set: (value) => signal(value) };
  },
  // `compute` goes to alien-signals as its getter, with no wrapper closure:
  // it ignores the previous value the getter receives.
  computed: (compute) => alienComputed(compute),
  // alien-signals has no reaction: an effect runs at once. The first run
  // only records the value, and later runs call `changed` untracked when the
  // value changed, as Pinna's `watch` and MobX's `reaction` do. The active
  // subscriber is cleared and restored inline, so a notification makes no
  // closure.
  watch: <Value>(read: () => Value, changed: (value: Value) => undefined) => {
    let started = false;
    let previous: Value | undefined;
    return alienEffect(() => {
      const value = read();
      if (!started) {
        started = true;
        previous = value;
        return;
      }
      if (!Object.is(value, previous)) {
        previous = value;
        const outer = setActiveSub(undefined);
        try {
          changed(value);
        } finally {
          setActiveSub(outer);
        }
      }
    });
  },
  batch: (write) => {
    startBatch();
    try {
      write();
    } finally {
      endBatch();
    }
  },
});

const mobx = (): Library => ({
  source: (initial) => {
    const box = mobxObservable.box(initial, { deep: false });
    return { get: () => box.get(), set: (value) => box.set(value) };
  },
  computed: (compute) => {
    const value = mobxComputed(compute);
    return () => value.get();
  },
  watch: (read, changed) => reaction(read, changed),
  batch: (write) => runInAction(write),
});

/**
 * The Hermes command line has no timers; React Native has them. Legend's
 * batch arms a timer on entry and clears it on exit, a guard against a batch
 * left open. The stand-in does that bookkeeping and never fires, so a timer
 * costs a map entry here where React Native makes a native call: Legend's
 * Hermes numbers leave that call out. Installed only when Legend runs, so the
 * other libraries' processes, and Effect's scheduler in them, see the host
 * as it is.
 */
const timers = (): void => {
  if (typeof globalThis.setTimeout === "function") {
    return;
  }
  const pending = new Map<number, () => void>();
  let last = 0;
  globalThis.setTimeout = ((run: () => void) => {
    last++;
    pending.set(last, run);
    return last;
  }) as never;
  globalThis.clearTimeout = ((id: number) => {
    pending.delete(id);
  }) as never;
};

/**
 * Legend's `observe` runs at once; the adapter skips that run and calls
 * `changed` only when the value changed, as MobX's `reaction` and Pinna's
 * `watch` do.
 */
const legend = (): Library => {
  timers();
  return {
    // The scenarios' sources hold numbers and booleans; the cast picks
    // Legend's primitive typing over its object one.
    source: <Value>(initial: Value) => {
      const value = legendObservable<number>(initial as never);
      return { get: () => value.get() as Value, set: (next) => value.set(next as never) };
    },
    computed: <Value>(compute: () => Value) => {
      const value = legendObservable(compute);
      return () => value.get() as Value;
    },
    watch: <Value>(read: () => Value, changed: (value: Value) => undefined) => {
      let started = false;
      let previous: Value | undefined;
      return legendObserve(() => {
        const value = read();
        if (!started) {
          started = true;
          previous = value;
          return;
        }
        if (!Object.is(value, previous)) {
          previous = value;
          changed(value);
        }
      });
    },
    batch: (write) => legendBatch(write),
  };
};

export const libraries = {
  pinna,
  "alien-signals": alien,
  mobx,
  legend,
} as const;

export type LibraryName = keyof typeof libraries;

/** What a benchmark needs of the engine it runs on. */
export interface Host {
  /** Milliseconds, as precise as the engine allows. */
  readonly now: () => number;
  /** Bytes allocated since the engine started, garbage included, where the engine counts them. */
  readonly allocated?: () => number;
  /** A full collection, so one run's garbage is not collected in the next. */
  readonly collect: () => void;
}

/** One scenario's numbers for one library. */
export interface Measured {
  readonly minimum: number;
  readonly median: number;
  /** Median bytes allocated by one run, where the host counts them. */
  readonly bytes?: number;
}

const middle = (values: Array<number>): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] as number;
};

/** True when `error` is the engine running out of stack. */
const overflowed = (error: unknown): boolean =>
  error instanceof RangeError && error.message.includes("call stack");

/**
 * A scenario's numbers, or `undefined` when the library ran out of stack: a
 * deep chain recomputes recursively in some libraries, and Hermes's stack is
 * short. Any other error stops the bench.
 */
const measureOne = (host: Host, setup: () => () => void): Measured | undefined => {
  const times: Array<number> = [];
  const bytes: Array<number> = [];
  for (let run = 0; run < runs; run++) {
    try {
      const measured = setup();
      host.collect();
      const allocatedBefore = host.allocated?.() ?? 0;
      const start = host.now();
      measured();
      const end = host.now();
      // Read before either array grows, so the count leaves out the push.
      const allocatedAfter = host.allocated?.() ?? 0;
      times.push(end - start);
      bytes.push(allocatedAfter - allocatedBefore);
    } catch (error) {
      if (overflowed(error)) {
        return undefined;
      }
      throw error;
    }
  }
  return {
    minimum: Math.min(...times),
    median: middle(times),
    ...(host.allocated === undefined ? {} : { bytes: middle(bytes) }),
  };
};

/** Throws when a watcher saw something other than what was written. */
const expect = (actual: unknown, expected: unknown, scenario: string): void => {
  if (actual !== expected) {
    throw new Error(`bench: ${scenario} saw ${String(actual)}, expected ${String(expected)}`);
  }
};

/**
 * What one process measured: the scenarios from `from` on, up to the first
 * that ran out of stack, if one did. A library can be left broken by running
 * out of stack (Legend keeps its tracking in module state), so the scenarios
 * after it run in a fresh process, from `next`.
 */
export interface Measurement {
  readonly results: Record<string, Measured>;
  readonly overflowed?: string;
  readonly next?: number;
}

/** Runs `measureFrom` until every scenario is measured or has run out of stack. */
export const measureAll = (
  measureFrom: (from: number) => Measurement,
): Record<string, Measured> => {
  const results: Record<string, Measured> = {};
  let from: number | undefined = 0;
  while (from !== undefined) {
    const measurement = measureFrom(from);
    Object.assign(results, measurement.results);
    from = measurement.next;
  }
  return results;
};

export const measure = (make: () => Library, host: Host, from = 0): Measurement => {
  const result: Record<string, Measured> = {};
  let index = 0;
  let overflowed: string | undefined;
  let next: number | undefined;
  const scenario = (name: string, setup: () => () => void): void => {
    const position = index++;
    if (position < from || overflowed !== undefined) {
      return;
    }
    const measured = measureOne(host, setup);
    if (measured === undefined) {
      overflowed = name;
      next = position + 1;
    } else {
      result[name] = measured;
    }
  };

  scenario("deep chain 1000, write ×100", () => {
    const library = make();
    const head = library.source(0);
    let last: () => number = head.get;
    for (let index = 0; index < 1000; index++) {
      const previous = last;
      last = library.computed(() => previous() + 1);
    }
    let seen = 0;
    library.watch(last, (value) => {
      seen = value;
    });
    return () => {
      for (let write = 1; write <= 100; write++) {
        library.batch(() => head.set(write));
      }
      expect(seen, 1100, "deep chain");
    };
  });

  scenario("fan-out 1000 watched, write ×100", () => {
    const library = make();
    const head = library.source(0);
    let runs = 0;
    const count = (): undefined => {
      runs++;
    };
    for (let index = 0; index < 1000; index++) {
      const derived = library.computed(() => head.get() + index);
      library.watch(derived, count);
    }
    return () => {
      runs = 0;
      for (let write = 1; write <= 100; write++) {
        library.batch(() => head.set(write));
      }
      expect(runs, 100 * 1000, "fan-out");
    };
  });

  scenario("diamond 1000 into a sum, write ×100", () => {
    const library = make();
    const head = library.source(0);
    const branches = Array.from({ length: 1000 }, (_, index) =>
      library.computed(() => head.get() * index),
    );
    const sum = library.computed(() => {
      let total = 0;
      for (let index = 0; index < branches.length; index++) {
        total += (branches[index] as () => number)();
      }
      return total;
    });
    let seen = 0;
    library.watch(sum, (value) => {
      seen = value;
    });
    return () => {
      for (let write = 1; write <= 100; write++) {
        library.batch(() => head.set(write));
      }
      expect(seen, 100 * 499_500, "diamond");
    };
  });

  scenario("conditional reads 1000, flip ×100", () => {
    const library = make();
    const flag = library.source(true);
    const left = library.source(1);
    const right = library.source(2);
    let runs = 0;
    const count = (): undefined => {
      runs++;
    };
    for (let index = 0; index < 1000; index++) {
      const derived = library.computed(() => (flag.get() ? left.get() : right.get()));
      library.watch(derived, count);
    }
    return () => {
      runs = 0;
      for (let write = 0; write < 100; write++) {
        library.batch(() => flag.set(write % 2 === 1));
        library.batch(() => (write % 2 === 0 ? right : left).set(write));
      }
      // Each flip changes every value, and so does each write but the first
      // to `left`, which writes the 1 it already holds: 199 changes a watcher.
      expect(runs, 199 * 1000, "conditional reads");
    };
  });

  scenario("make and dispose 1000 watched computeds ×10", () => {
    const library = make();
    const head = library.source(0);
    let runs = 0;
    const count = (): undefined => {
      runs++;
    };
    return () => {
      runs = 0;
      for (let round = 0; round < 10; round++) {
        const stops: Array<() => void> = [];
        for (let index = 0; index < 1000; index++) {
          const derived = library.computed(() => head.get() + index);
          stops.push(library.watch(derived, count));
        }
        for (let index = 0; index < stops.length; index++) {
          (stops[index] as () => void)();
        }
      }
      // Nothing is written, so no watcher sees a change.
      expect(runs, 0, "make and dispose");
    };
  });

  scenario("write 1000 sources in one update ×100", () => {
    const library = make();
    const sources = Array.from({ length: 1000 }, () => library.source(0));
    let runs = 0;
    const count = (): undefined => {
      runs++;
    };
    for (const source of sources) {
      library.watch(source.get, count);
    }
    return () => {
      runs = 0;
      for (let write = 1; write <= 100; write++) {
        library.batch(() => {
          for (let index = 0; index < sources.length; index++) {
            (sources[index] as Source<number>).set(write);
          }
        });
      }
      expect(runs, 100 * 1000, "write sources");
    };
  });

  // From rere-benchmark

  scenario("bursty fan-out: 1000 watched, 100 writes per update ×100", () => {
    const library = make();
    const head = library.source(0);
    let runsSeen = 0;
    for (let index = 0; index < 1000; index++) {
      const derived = library.computed(() => head.get() + index);
      library.watch(derived, () => {
        runsSeen++;
      });
    }
    return () => {
      runsSeen = 0;
      for (let burst = 1; burst <= 100; burst++) {
        library.batch(() => {
          for (let write = 1; write <= 100; write++) {
            head.set(burst * 100 + write);
          }
        });
      }
      expect(runsSeen, 100 * 1000, "bursty fan-out");
    };
  });

  scenario("increment ×100k, each value checked", () => {
    const library = make();
    const count = library.source(0);
    const doubled = library.computed(() => count.get() * 2);
    let seen = 0;
    library.watch(doubled, (value) => {
      seen = value;
    });
    return () => {
      for (let value = 1; value <= 100_000; value++) {
        library.batch(() => count.set(value));
        expect(seen, value * 2, "increment");
      }
    };
  });

  scenario("one write among 10k watched rows ×1000", () => {
    const library = make();
    const sources = Array.from({ length: 10_000 }, () => library.source(0));
    let runs = 0;
    const count = (): undefined => {
      runs++;
    };
    for (const source of sources) {
      const label = library.computed(() => `row ${source.get()}`);
      library.watch(label, count);
    }
    return () => {
      runs = 0;
      for (let write = 1; write <= 1000; write++) {
        const source = sources[(write * 7919) % sources.length] as Source<number>;
        library.batch(() => source.set(write));
      }
      // 7919 is prime to 10,000, so each write lands on a different row.
      expect(runs, 1000, "one write among 10k");
    };
  });

  return {
    results: result,
    ...(overflowed === undefined ? {} : { overflowed }),
    ...(next === undefined || next >= index ? {} : { next }),
  };
};

const ratio = (over: Measured | undefined, under: Measured | undefined): string =>
  over === undefined || under === undefined || under.minimum === 0
    ? ""
    : `${(over.minimum / under.minimum).toFixed(2)}×`;

/** Markdown tables: times, then allocation where the host counted it. */
export const report = (
  results: Record<LibraryName, Record<string, Measured>>,
  runtime: string,
): string => {
  const names = Object.keys(libraries) as Array<LibraryName>;
  const scenarios = Object.keys(results.pinna);
  const lines: Array<string> = [];
  const header = ["", ...names, "Pinna ÷ alien-signals", "Pinna ÷ MobX"];
  lines.push(`${runtime}: minimum / median ms of ${runs} runs`, "");
  lines.push(`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`);
  for (const scenario of scenarios) {
    const cells = names.map((name) => {
      const measured = results[name][scenario];
      // `measureAll` leaves out only a scenario that ran out of stack.
      return measured === undefined
        ? "stack overflow"
        : `${measured.minimum.toFixed(2)} / ${measured.median.toFixed(2)}`;
    });
    const pinnaMeasured = results.pinna[scenario];
    cells.push(
      ratio(pinnaMeasured, results["alien-signals"][scenario]),
      ratio(pinnaMeasured, results.mobx[scenario]),
    );
    lines.push(`| ${scenario} | ${cells.join(" | ")} |`);
  }
  if (results.pinna[scenarios[0] as string]?.bytes !== undefined) {
    lines.push("", `${runtime}: KB allocated by one run, median`, "");
    const allocationHeader = ["", ...names];
    lines.push(
      `| ${allocationHeader.join(" | ")} |`,
      `| ${allocationHeader.map(() => "---").join(" | ")} |`,
    );
    for (const scenario of scenarios) {
      const cells = names.map((name) => {
        const bytes = results[name][scenario]?.bytes;
        return bytes === undefined ? "" : (bytes / 1024).toFixed(0);
      });
      lines.push(`| ${scenario} | ${cells.join(" | ")} |`);
    }
  }
  return lines.join("\n");
};
