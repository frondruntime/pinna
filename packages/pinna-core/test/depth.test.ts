import { describe, expect, test } from "bun:test";
import {
  type DerivedNode,
  Graph,
  observerCount,
  readCell,
  readDerived,
  writeCell,
} from "../src/graph.ts";

/**
 * How long a chain the graph walks with no recursion of its own. Bun's stack
 * is deeper than Hermes's: a recursive walk overflows here near this depth,
 * and on Hermes near 1,500.
 */
const depth = 100_000;

/**
 * A cell and a chain of computed values over it, each read once as it is
 * made, so no compute runs deeper than one value.
 */
const chain = (graph: Graph) => {
  const base = graph.cell(0);
  let top: DerivedNode<number> = graph.derived(() => readCell(base) + 1);
  readDerived(top);
  for (let index = 1; index < depth; index++) {
    const below = top;
    top = graph.derived(() => readDerived(below) + 1);
    readDerived(top);
  }
  return { base, top };
};

describe("a deep chain built from the bottom", () => {
  test("a value nothing observes reads a write to the bottom", () => {
    const graph = new Graph();
    const { base, top } = chain(graph);
    expect(readDerived(top)).toBe(depth);
    writeCell(base, 1);
    expect(readDerived(top)).toBe(depth + 1);
  });

  test("a watch on the top links the whole chain, and lets go of it", () => {
    const graph = new Graph();
    const { base, top } = chain(graph);
    const stop = graph.watch(() => readDerived(top));
    expect(observerCount(base)).toBe(1);
    stop();
    expect(observerCount(base)).toBe(0);
    expect(observerCount(top)).toBe(0);
  });

  test("a watch on the top sees a write to the bottom", () => {
    const graph = new Graph();
    const { base, top } = chain(graph);
    const seen: Array<number> = [];
    const stop = graph.watch(
      () => readDerived(top),
      (value) => seen.push(value),
    );
    writeCell(base, 1);
    writeCell(base, 2);
    expect(seen).toEqual([depth + 1, depth + 2]);
    stop();
  });
});

/**
 * A chain no value has read, read first from the top: each compute reads
 * the one below it for the first time, so the computes nest through user
 * code. Past the graph's limit a read waits, and the value it stopped at
 * computes first from a shallow stack.
 */
const unread = (graph: Graph, length: number, counted?: { computes: number }) => {
  const base = graph.cell(0);
  let top: DerivedNode<number> = graph.derived(() => readCell(base) + 1);
  for (let index = 1; index < length; index++) {
    const below = top;
    top = graph.derived(() => {
      if (counted !== undefined) {
        counted.computes++;
      }
      return readDerived(below) + 1;
    });
  }
  return { base, top };
};

describe("a deep chain read first from the top", () => {
  test("computes, and reads a write to the bottom", () => {
    const graph = new Graph();
    const { base, top } = unread(graph, depth);
    expect(readDerived(top)).toBe(depth);
    writeCell(base, 1);
    expect(readDerived(top)).toBe(depth + 1);
  });

  test("a watch on the top links the whole chain, sees a write, and lets go", () => {
    const graph = new Graph();
    const { base, top } = unread(graph, depth);
    const seen: Array<number> = [];
    const stop = graph.watch(
      () => readDerived(top),
      (value) => seen.push(value),
    );
    expect(observerCount(base)).toBe(1);
    writeCell(base, 1);
    expect(seen).toEqual([depth + 1]);
    stop();
    expect(observerCount(base)).toBe(0);
    expect(observerCount(top)).toBe(0);
  });

  test("a chain within the limit computes each value once", () => {
    const graph = new Graph();
    const counted = { computes: 0 };
    const { top } = unread(graph, 200, counted);
    expect(readDerived(top)).toBe(200);
    expect(counted.computes).toBe(199);
  });

  test("a chain past the limit computes the values above each wait once more", () => {
    const graph = new Graph();
    const counted = { computes: 0 };
    const { top } = unread(graph, 1000, counted);
    expect(readDerived(top)).toBe(1000);
    // Fewer than twice the chain: each value above a wait starts once more.
    expect(counted.computes).toBeGreaterThan(999);
    expect(counted.computes).toBeLessThan(2 * 999);
  });

  test("an error at the bottom reaches the top", () => {
    const graph = new Graph();
    const failing = graph.cell(false);
    const bottom = graph.derived(() => {
      if (readCell(failing)) {
        throw new Error("bottom");
      }
      return 0;
    });
    let top: DerivedNode<number> = bottom;
    for (let index = 1; index < 2000; index++) {
      const below = top;
      top = graph.derived(() => readDerived(below) + 1);
    }
    writeCell(failing, true);
    expect(() => readDerived(top)).toThrow("bottom");
    writeCell(failing, false);
    expect(readDerived(top)).toBe(1999);
  });

  test("a compute that catches what it reads still ends current", () => {
    const graph = new Graph();
    const base = graph.cell(0);
    let top: DerivedNode<number> = graph.derived(() => readCell(base));
    for (let index = 1; index < 2000; index++) {
      const below = top;
      top = graph.derived(() => {
        try {
          return readDerived(below) + 1;
        } catch {
          return -1;
        }
      });
    }
    expect(readDerived(top)).toBe(1999);
    writeCell(base, 1);
    expect(readDerived(top)).toBe(2000);
  });

  test("a cycle longer than the limit meets itself", () => {
    const graph = new Graph();
    const length = 1000;
    const values: Array<DerivedNode<number>> = [];
    for (let index = 0; index < length; index++) {
      values.push(
        graph.derived(() => readDerived(values[(index + 1) % length] as DerivedNode<number>) + 1),
      );
    }
    expect(() => readDerived(values[0] as DerivedNode<number>)).toThrow(/cycle/);
  });
});
