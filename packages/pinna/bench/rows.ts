/**
 * What one row operation costs as a collection grows, on Bun: the probes of
 * the core rewrite (ruling 73 of `docs/api.md`, "What gets faster"). Each probe
 * runs one operation per `Realm.update` (or per stage) on a collection of
 * 1,000, 10,000, and 100,000 rows with nothing observing it, and reports
 * the median time of one operation over `runs` runs, in microseconds.
 *
 * Internals: the numbers are this core's, and a rewrite sets new ones.
 *
 * bun --conditions=source bench/rows.ts [--check] [--json <path>]
 *
 * `--check` exits 1 when a probe breaks its goal: the cost at 100,000 rows at
 * most 3 times the cost at 1,000, except adding at the start and removing,
 * which move the order array and are held to their ceiling at 100,000
 * instead. Until the rewrite's order and visible-stack stages land, the
 * probes report and `bench:rows` runs without `--check`.
 */
import { Collection, Realm, Stage } from "../src/index.ts";

interface Row {
  readonly id: number;
  readonly price: number;
}

const sizes = [1_000, 10_000, 100_000] as const;
const runs = 7;

const median = (samples: ReadonlyArray<number>): number => {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] as number;
};

const filled = (size: number) => {
  const realm = Realm.make();
  const rows = Collection.make<number, Row>(realm, { keyOf: (row) => row.id, name: "rows" });
  Realm.update(realm, (_read, write) => {
    write.replaceAll(
      rows,
      Array.from({ length: size }, (_, id) => ({ id, price: id })),
    );
  });
  return { realm, rows };
};

interface Probe {
  readonly name: string;
  /** Operations a run times; a stage costs more, so it runs fewer. */
  readonly operations: number;
  /** The goal at 100,000 rows in microseconds, from the design. */
  readonly goal: number | undefined;
  /** Held to its slope by `--check`, or, `false`, to its goal at 100,000. */
  readonly slope: boolean;
  /** Builds a collection of `size` rows and returns one run of `operations` operations. */
  readonly prepare: (size: number, operations: number) => () => void;
}

const probes: ReadonlyArray<Probe> = [
  {
    name: "add a key at the end",
    operations: 1_000,
    goal: 5,
    slope: true,
    prepare: (size, operations) => {
      const { realm, rows } = filled(size);
      return () => {
        for (let index = 0; index < operations; index++) {
          Realm.update(realm, (_read, write) => {
            write.upsert(rows, { id: size + index, price: 0 }, { at: "end" });
          });
        }
      };
    },
  },
  {
    name: "add a key at the start",
    operations: 1_000,
    goal: 40,
    slope: false,
    prepare: (size, operations) => {
      const { realm, rows } = filled(size);
      return () => {
        for (let index = 0; index < operations; index++) {
          Realm.update(realm, (_read, write) => {
            write.upsert(rows, { id: size + index, price: 0 }, { at: "start" });
          });
        }
      };
    },
  },
  {
    name: "remove a key",
    operations: 1_000,
    goal: 60,
    slope: false,
    prepare: (size, operations) => {
      const { realm, rows } = filled(size);
      // Keys spread over the order, so a removal is not always at one end.
      const step = Math.floor(size / operations);
      return () => {
        for (let index = 0; index < operations; index++) {
          Realm.update(realm, (_read, write) => {
            write.remove(rows, index * step);
          });
        }
      };
    },
  },
  {
    name: "one row through a hidden stage, applied",
    operations: 100,
    goal: 50,
    slope: true,
    prepare: (size, operations) => {
      const { realm, rows } = filled(size);
      return () => {
        for (let index = 0; index < operations; index++) {
          const stage = Stage.make(realm);
          Stage.update(stage, (_read, write) => {
            write.upsert(rows, { id: index, price: -index });
          });
          Stage.apply(stage);
        }
      };
    },
  },
  {
    // Not held to a slope: the landing copies the key order (ruling 73 of `docs/api.md`, OrderPatch).
    name: "a new key through a hidden stage, applied",
    operations: 100,
    goal: undefined,
    slope: false,
    prepare: (size, operations) => {
      const { realm, rows } = filled(size);
      return () => {
        for (let index = 0; index < operations; index++) {
          const stage = Stage.make(realm);
          Stage.update(stage, (_read, write) => {
            write.upsert(rows, { id: size + index, price: -index }, { at: "end" });
          });
          Stage.apply(stage);
        }
      };
    },
  },
  {
    name: "a base row write under one single-row guess",
    operations: 100,
    goal: 50,
    slope: true,
    prepare: (size, operations) => {
      const { realm, rows } = filled(size);
      const guess = Stage.make(realm, { visible: true });
      Stage.update(guess, (_read, write) => {
        write.upsert(rows, { id: 0, price: -1 });
      });
      return () => {
        for (let index = 0; index < operations; index++) {
          Realm.update(realm, (_read, write) => {
            write.upsert(rows, { id: 1 + (index % (size - 1)), price: -index });
          });
        }
      };
    },
  },
  {
    name: "replace a held row (no listener)",
    operations: 1_000,
    goal: undefined,
    slope: true,
    prepare: (size, operations) => {
      const { realm, rows } = filled(size);
      return () => {
        for (let index = 0; index < operations; index++) {
          Realm.update(realm, (_read, write) => {
            write.upsert(rows, { id: index % size, price: -index });
          });
        }
      };
    },
  },
];

/** The median microseconds of one operation of `probe` at `size` rows. */
const measure = (probe: Probe, size: number): number => {
  const samples: Array<number> = [];
  // Two warm-up runs, each on a fresh collection.
  for (let run = 0; run < runs + 2; run++) {
    const once = probe.prepare(size, probe.operations);
    Bun.gc(true);
    const start = performance.now();
    once();
    const elapsed = performance.now() - start;
    if (run >= 2) {
      samples.push((elapsed * 1000) / probe.operations);
    }
  }
  return median(samples);
};

const format = (microseconds: number): string =>
  microseconds >= 1000
    ? `${(microseconds / 1000).toFixed(2)} ms`
    : `${microseconds.toFixed(microseconds < 10 ? 2 : 1)} µs`;

const check = process.argv.includes("--check");
const jsonIndex = process.argv.indexOf("--json");
const jsonPath = jsonIndex === -1 ? undefined : process.argv[jsonIndex + 1];

const results: Array<{
  readonly probe: string;
  readonly microseconds: Record<number, number>;
  readonly slope: number;
  readonly goal: number | undefined;
  readonly passes: boolean;
}> = [];
let failed = false;
console.log(`rows: one operation, median of ${runs} runs, Bun ${Bun.version}`);
console.log(
  `${"probe".padEnd(46)}${sizes.map((size) => `${size.toLocaleString("en-US")} rows`.padStart(14)).join("")}   slope  goal`,
);
for (const probe of probes) {
  const microseconds: Record<number, number> = {};
  for (const size of sizes) {
    microseconds[size] = measure(probe, size);
  }
  const first = microseconds[sizes[0]] as number;
  const last = microseconds[sizes[sizes.length - 1] as number] as number;
  const slope = last / first;
  const passes = probe.slope ? slope <= 3 : probe.goal === undefined || last <= probe.goal;
  if (!passes) {
    failed = true;
  }
  results.push({ probe: probe.name, microseconds, slope, goal: probe.goal, passes });
  console.log(
    `${probe.name.padEnd(46)}${sizes.map((size) => format(microseconds[size] as number).padStart(14)).join("")}${`${slope.toFixed(1)}x`.padStart(8)}  ${probe.goal === undefined ? "no worse" : format(probe.goal)}${passes ? "" : "  FAILS"}`,
  );
}
if (jsonPath !== undefined) {
  await Bun.write(jsonPath, `${JSON.stringify({ bun: Bun.version, runs, results }, null, 2)}\n`);
}
if (check && failed) {
  console.log("rows: a probe breaks its goal");
  process.exit(1);
}
