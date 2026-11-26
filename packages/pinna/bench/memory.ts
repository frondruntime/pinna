/**
 * Memory per node on Bun, and whether it scales linearly. For each kind of
 * node, the bench makes `n` of them in one realm, keeps them alive, collects
 * garbage, and reports the heap it grew by, per node, at two sizes. A ratio
 * near 1 between the two sizes means the cost per node does not grow with
 * the graph; `--check` exits 1 when a ratio passes 1.5, so a quadratic
 * structure fails it.
 *
 * Internals: the numbers are this core's, and a rewrite sets new ones.
 *
 * bun --conditions=source bench/memory.ts [--check]
 *
 * Each kind and size runs in its own process, so one measure's garbage never
 * lands in the next one's heap.
 */
import { Box, Collection, Computed, Realm, View } from "../src/index.ts";

interface Kind {
  readonly name: string;
  /** Makes `count` nodes of the kind and returns what keeps them alive. */
  readonly make: (count: number) => unknown;
}

const kinds: ReadonlyArray<Kind> = [
  {
    name: "box",
    make: (count) => {
      const realm = Realm.make();
      return [realm, Array.from({ length: count }, (_, index) => Box.make(realm, index))];
    },
  },
  {
    name: "computed, read once",
    make: (count) => {
      const realm = Realm.make();
      const source = Box.make(realm, 1);
      const values = Array.from({ length: count }, (_, index) =>
        Computed.make(realm, (read) => read(source) + index),
      );
      Realm.untracked(realm, (read) => {
        for (const value of values) read(value);
      });
      return [realm, source, values];
    },
  },
  {
    name: "box an autorun observes",
    make: (count) => {
      const realm = Realm.make();
      const boxes = Array.from({ length: count }, (_, index) => Box.make(realm, index));
      const stop = Realm.autorun(realm, (read) => {
        for (const box of boxes) read(box);
        return undefined;
      });
      return [realm, boxes, stop];
    },
  },
  {
    name: "collection row",
    make: (count) => {
      const realm = Realm.make();
      const rows = Collection.make(realm, { keyOf: (row: { readonly id: number }) => row.id });
      Realm.update(realm, (_read, write) => {
        write.replaceAll(
          rows,
          Array.from({ length: count }, (_, id) => ({ id })),
        );
      });
      return [realm, rows];
    },
  },
  {
    name: "row in an ordered view",
    make: (count) => {
      const realm = Realm.make();
      const rows = Collection.make(realm, {
        keyOf: (row: { readonly id: number; readonly rank: number }) => row.id,
      });
      Realm.update(realm, (_read, write) => {
        write.replaceAll(
          rows,
          Array.from({ length: count }, (_, id) => ({ id, rank: (id * 7919) % count })),
        );
      });
      const view = View.ordered(rows, { compare: () => (left, right) => left.rank - right.rank });
      Realm.untracked(realm, (read) => read(view.keys));
      return [realm, rows, view];
    },
  },
];

const heap = (): number => {
  Bun.gc(true);
  return process.memoryUsage().heapUsed;
};

/**
 * Heap bytes per node for `count` nodes of `kind`, measured once: a second
 * measure in the same process meets the first one's garbage, which the
 * collector frees during it and so hides its growth.
 */
const bytesPerNode = (kind: Kind, count: number): number => {
  const before = heap();
  const kept = kind.make(count);
  const after = heap();
  // Read `kept` after the measure, so the collector cannot free it early.
  if (kept === undefined) throw new Error("bench: nothing kept");
  return (after - before) / count;
};

const small = 10_000;
const large = 100_000;
const [, , requested, size] = process.argv;

if (requested !== undefined && size !== undefined && requested !== "--check") {
  // A child: one kind at one size, in a fresh heap.
  const kind = kinds.find((candidate) => candidate.name === requested);
  if (kind === undefined) throw new Error(`bench: no kind ${requested}`);
  console.log(JSON.stringify(bytesPerNode(kind, Number(size))));
} else {
  /** The median of three measures, each in a fresh process. */
  const measureIn = (kind: Kind, count: number): number => {
    const samples = [0, 1, 2]
      .map(() => measureOnce(kind, count))
      .sort((left, right) => left - right);
    return samples[1] as number;
  };
  const measureOnce = (kind: Kind, count: number): number => {
    const child = Bun.spawnSync([
      process.execPath,
      ...process.execArgv,
      import.meta.path,
      kind.name,
      String(count),
    ]);
    if (child.exitCode !== 0) {
      throw new Error(`bench: ${kind.name} failed:\n${child.stderr.toString()}`);
    }
    return JSON.parse(child.stdout.toString()) as number;
  };
  const check = process.argv.includes("--check");
  let failed = false;
  console.log(`Bun ${Bun.version}: heap bytes per node, each in its own process`);
  console.log(`| Node | at ${small} | at ${large} | ratio |`);
  console.log("|---|---:|---:|---:|");
  for (const kind of kinds) {
    const atSmall = measureIn(kind, small);
    const atLarge = measureIn(kind, large);
    const ratio = atLarge / atSmall;
    console.log(
      `| ${kind.name} | ${atSmall.toFixed(0)} | ${atLarge.toFixed(0)} | ${ratio.toFixed(2)} |`,
    );
    if (ratio > 1.5) failed = true;
  }
  if (check && failed) {
    console.error("bench: a node's memory grows faster than linearly with the graph");
    process.exit(1);
  }
}
