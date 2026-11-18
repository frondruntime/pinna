import { describe, expect, test } from "bun:test";
import {
  type DerivedNode,
  Graph,
  observerCount,
  readAtom,
  readCell,
  readDerived,
  writeCell,
} from "../src/graph.ts";
import { expectAtRest } from "./rest.ts";

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
  for (const length of [200, 600, 2000]) {
    test(`keeps equality cutoff while refreshing ${length} cached levels`, () => {
      const graph = new Graph();
      const shared = graph.cell(0);
      const base = graph.cell(1);
      const levels: Array<DerivedNode<{ value: number }>> = [];
      let computes = 0;
      let comparisons = 0;
      for (let index = 0; index < length; index++) {
        const below = levels[index - 1];
        levels.push(
          graph.derived(
            () => {
              computes++;
              readCell(shared);
              return { value: below === undefined ? readCell(base) : readDerived(below).value };
            },
            {
              equals: (left, right) => {
                comparisons++;
                return left.value === right.value;
              },
            },
          ),
        );
      }
      const top = levels[length - 1] as DerivedNode<{ value: number }>;
      let effects = 0;
      let selections = 0;
      const stops = [
        graph.watch(
          () => readDerived(top),
          () => effects++,
        ),
      ];
      for (let index = 20; index < length - 1; index += 40) {
        const level = levels[index] as DerivedNode<{ value: number }>;
        stops.push(
          graph.watch(
            () => {
              selections++;
              return readDerived(level);
            },
            () => effects++,
          ),
        );
      }
      const previous = readDerived(top);
      const versions = levels.map((level) => level.version);
      computes = comparisons = selections = 0;

      writeCell(shared, 1);

      expect(effects).toBe(0);
      expect(selections).toBe(0);
      expect(readDerived(top)).toBe(previous);
      expect(levels.map((level) => level.version)).toEqual(versions);
      // Each suspended block restarts; equality runs only on finished results.
      expect(computes).toBe(length + 256 * Math.floor((length - 2) / 256));
      expect(comparisons).toBe(length);
      for (const stop of stops) stop();
      expectAtRest(graph);
    });
  }

  test("a suspended cached compute finishes when its lower value stays equal", () => {
    const graph = new Graph();
    const shared = graph.cell(0);
    const levels: Array<DerivedNode<number>> = [];
    let top = graph.derived(() => 0);
    for (let index = 0; index < 600; index++) {
      const below = top;
      top = graph.derived(() => {
        const current = readCell(shared);
        readDerived(below);
        return index % 2 === 0 ? 0 : current;
      });
      levels.push(top);
    }
    const seen: Array<number> = [];
    const stop = graph.watch(
      () => readDerived(top),
      (value) => seen.push(value),
    );
    writeCell(shared, 1);
    expect(readDerived(top)).toBe(1);
    expect(seen).toEqual([1]);
    expect(levels.map((level) => readDerived(level))).toEqual(levels.map((_, index) => index % 2));
    stop();
    expectAtRest(graph);
  });

  test("a cached value suspended on two branches compares its finished result once", () => {
    const graph = new Graph();
    const shared = graph.cell(0);
    const branch = () => {
      let top = graph.derived(() => 1);
      for (let index = 0; index < 600; index++) {
        const below = top;
        top = graph.derived(() => {
          readCell(shared);
          return readDerived(below);
        });
      }
      return top;
    };
    const left = branch();
    const right = branch();
    let computes = 0;
    let comparisons = 0;
    const middle = graph.derived(
      () => {
        computes++;
        readCell(shared);
        return { value: readDerived(left) + readDerived(right) };
      },
      {
        equals: (previous, current) => {
          comparisons++;
          return previous.value === current.value;
        },
      },
    );
    const top = graph.derived(() => {
      readCell(shared);
      return readDerived(middle);
    });
    let effects = 0;
    const stop = graph.watch(
      () => readDerived(top),
      () => effects++,
    );
    const previous = readDerived(middle);
    const version = middle.version;
    computes = comparisons = 0;

    writeCell(shared, 1);

    expect(computes).toBe(3);
    expect(comparisons).toBe(1);
    expect(effects).toBe(0);
    expect(readDerived(middle)).toBe(previous);
    expect(middle.version).toBe(version);
    stop();
    expectAtRest(graph);
  });

  test("suspended cached errors recover without passing an error to equals", () => {
    const graph = new Graph();
    const shared = graph.cell(0);
    const failure = new Error("bottom failed");
    let comparisons = 0;
    let top = graph.derived(() => {
      if (readCell(shared) % 2 === 0) throw failure;
      return { value: 1 };
    });
    for (let index = 0; index < 600; index++) {
      const below = top;
      top = graph.derived(
        () => {
          readCell(shared);
          return { value: readDerived(below).value };
        },
        {
          equals: (previous, current) => {
            comparisons++;
            expect(previous).not.toBeInstanceOf(Error);
            return previous.value === current.value;
          },
        },
      );
    }
    expect(() => readDerived(top)).toThrow(failure);
    for (const value of [1, 2, 3]) {
      writeCell(shared, value);
      if (value % 2 === 0) {
        expect(() => readDerived(top)).toThrow(failure);
      } else {
        expect(readDerived(top)).toEqual({ value: 1 });
      }
      expectAtRest(graph);
    }
    expect(comparisons).toBe(0);
  });

  test("a suspended volatile compute is not treated as checked in the same walk", () => {
    const graph = new Graph();
    const atom = graph.atom();
    let outside = 1;
    let top = graph.derived(() => 0);
    for (let index = 0; index < 600; index++) {
      const below = top;
      top = graph.derived(() => {
        readAtom(atom);
        return readDerived(below) + outside;
      });
    }
    expect(readDerived(top)).toBe(600);
    outside = 2;
    expect(readDerived(top)).toBe(1200);
    expectAtRest(graph);
  });

  test("a cached cycle longer than the depth limit throws and recovers", () => {
    const graph = new Graph();
    const closes = graph.cell(false);
    const length = 1000;
    const values: Array<DerivedNode<number>> = [];
    for (let index = 0; index < length; index++) {
      values.push(
        graph.derived(() => {
          const closing = readCell(closes);
          if (index === length - 1 && !closing) return 0;
          return readDerived(values[(index + 1) % length] as DerivedNode<number>);
        }),
      );
    }
    const top = values[0] as DerivedNode<number>;
    expect(readDerived(top)).toBe(0);
    writeCell(closes, true);
    expect(() => readDerived(top)).toThrow("cycle");
    expectAtRest(graph);
    writeCell(closes, false);
    expect(readDerived(top)).toBe(0);
    expectAtRest(graph);
  });

  for (const length of [15_000, 30_000]) {
    test(`refreshes ${length} cached levels that read a changed shared source first`, () => {
      const graph = new Graph();
      const shared = graph.cell(0);
      let top = graph.derived(() => 0);
      for (let index = 0; index < length; index++) {
        const previous = top;
        top = graph.derived(() => readCell(shared) + readDerived(previous));
      }
      expect(readDerived(top)).toBe(0);
      writeCell(shared, 1);
      expect(readDerived(top)).toBe(length);
      writeCell(shared, 2);
      expect(readDerived(top)).toBe(2 * length);
      expectAtRest(graph);
    });
  }

  test("a refresh leaves a stale branch unread when the new compute drops it", () => {
    const graph = new Graph();
    const shared = graph.cell(0);
    let bottomRuns = 0;
    let top = graph.derived(() => {
      bottomRuns++;
      return readCell(shared);
    });
    for (let index = 0; index < 1000; index++) {
      const previous = top;
      top = graph.derived(() => {
        const current = readCell(shared);
        return current === 0 ? readDerived(previous) : current;
      });
    }
    expect(readDerived(top)).toBe(0);
    expect(bottomRuns).toBe(1);
    writeCell(shared, 1);
    expect(readDerived(top)).toBe(1);
    expect(bottomRuns).toBe(1);
  });

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
