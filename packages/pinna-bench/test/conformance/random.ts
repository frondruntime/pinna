/**
 * Random graphs for the differential test: one seed makes one script of
 * boxes, derived values, writes, subscribes, and unsubscribes, and `play`
 * runs that script on one library and returns what it observed.
 *
 * Values are small non-negative integers, so equality by `Object.is` and by
 * `===` agree and a difference is a real one.
 */
import type { CheckedAdapter as Adapter, Derived, Source } from "../../src/adapter.ts";

/** mulberry32: a small seeded generator, so a failing seed replays exactly. */
const generator = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** A derived value: the sum of the nodes it reads, modulo `modulo`. */
interface DerivedSpec {
  readonly reads: ReadonlyArray<number>;
  readonly modulo: number;
}

type Operation =
  | { readonly kind: "write"; readonly writes: ReadonlyArray<readonly [number, number]> }
  | {
      readonly kind: "nested";
      readonly outer: readonly [number, number];
      readonly inner: readonly [number, number];
    }
  | { readonly kind: "subscribe"; readonly node: number }
  | { readonly kind: "unsubscribe"; readonly watch: number };

export interface Script {
  readonly sources: number;
  /** Node `sources + index` is `derived[index]`; it reads only lower nodes. */
  readonly derived: ReadonlyArray<DerivedSpec>;
  readonly operations: ReadonlyArray<Operation>;
}

export const script = (seed: number): Script => {
  const random = generator(seed);
  const integer = (below: number): number => Math.floor(random() * below);
  const sources = 2 + integer(4);
  const derived: Array<DerivedSpec> = [];
  const derivedCount = 2 + integer(9);
  for (let index = 0; index < derivedCount; index++) {
    const below = sources + index;
    const reads = Array.from({ length: 1 + integer(3) }, () => integer(below));
    derived.push({ reads: [...new Set(reads)], modulo: 2 + integer(5) });
  }
  const nodes = sources + derivedCount;
  const write = (): readonly [number, number] => [integer(sources), integer(5)];
  const operations: Array<Operation> = [];
  let watches = 0;
  for (let step = 0; step < 30; step++) {
    const roll = random();
    if (roll < 0.25 || watches === 0) {
      operations.push({ kind: "subscribe", node: integer(nodes) });
      watches++;
    } else if (roll < 0.35) {
      operations.push({ kind: "unsubscribe", watch: integer(watches) });
    } else if (roll < 0.45) {
      operations.push({ kind: "nested", outer: write(), inner: write() });
    } else {
      operations.push({ kind: "write", writes: Array.from({ length: 1 + integer(3) }, write) });
    }
  }
  return { sources, derived, operations };
};

export interface Observation {
  /** Per write operation, how many times each derived value computed. */
  readonly computations: ReadonlyArray<ReadonlyArray<number>>;
  /** Per watch, in subscribe order, every value its effect received. */
  readonly seen: ReadonlyArray<ReadonlyArray<number>>;
  /** Every node's value after the script, read untracked. */
  readonly values: ReadonlyArray<number>;
}

export const play = (adapter: Adapter, { sources, derived, operations }: Script): Observation => {
  const boxes: Array<Source<number>> = Array.from({ length: sources }, () => adapter.box(0));
  const nodes: Array<Source<number> | Derived<number>> = [...boxes];
  const counts = derived.map(() => 0);
  derived.forEach((spec, index) => {
    nodes.push(
      adapter.computed(() => {
        counts[index] = (counts[index] ?? 0) + 1;
        let sum = 0;
        for (const read of spec.reads) {
          sum += (nodes[read] as Derived<number>).get();
        }
        return sum % spec.modulo;
      }),
    );
  });
  const set = ([box, value]: readonly [number, number]): void => {
    (boxes[box] as Source<number>).set(value);
  };
  const computations: Array<ReadonlyArray<number>> = [];
  const seen: Array<Array<number>> = [];
  const stops: Array<(() => void) | undefined> = [];
  for (const operation of operations) {
    switch (operation.kind) {
      case "subscribe": {
        const values: Array<number> = [];
        seen.push(values);
        const node = nodes[operation.node] as Derived<number>;
        stops.push(
          adapter.watch(
            () => node.get(),
            (value) => values.push(value),
          ),
        );
        break;
      }
      case "unsubscribe": {
        stops[operation.watch]?.();
        stops[operation.watch] = undefined;
        break;
      }
      case "write": {
        adapter.update(() => {
          for (const write of operation.writes) {
            set(write);
          }
        });
        break;
      }
      case "nested": {
        adapter.update(() => {
          set(operation.outer);
          adapter.update(() => set(operation.inner));
        });
        break;
      }
    }
    // Subscribing and unsubscribing compute differently by design: MobX
    // drops a computed value's cache with its last observer, alien-signals
    // and Pinna keep it. Only writes are compared, so the counts restart
    // after every operation and are kept only for writes.
    if (operation.kind === "write" || operation.kind === "nested") {
      computations.push([...counts]);
    }
    counts.fill(0);
  }
  for (const stop of stops) {
    stop?.();
  }
  const values = adapter.untracked(() => nodes.map((node) => node.get()));
  return { computations, seen, values };
};
