import { expect, test } from "bun:test";
import { type DerivedNode, Graph, readCell, readDerived, writeCell } from "../src/graph.ts";

// The restart budget is per value per outer read only if one bounded driver
// never starts inside another. The driver runs every compute at a compute
// depth of 1 or more, and only a stale read at depth 0 enters it, so a read
// inside the driver nests in place. This test makes the attempt: a compute
// the iterative walk runs, at depth 0, reads a stale value whose compute
// reads a value that makes a chain deeper than the limit on every run.
test("a stale read inside a compute the bounded driver runs nests in place, and the budget holds once per read", () => {
  const graph = new Graph();
  const length = graph.cell(260);
  const armed = graph.cell(false);
  let totalRuns = 0;
  let middleRuns = 0;
  const seen = new Set<number>();
  const total = graph.derived(
    () => {
      totalRuns++;
      // One map of restarts, with the driver's own target alone in it: a
      // second driver would count `total` in a map of its own.
      seen.add(graph.restarts?.size ?? 0);
      let step: DerivedNode<number> = graph.derived(() => 0);
      const count = readCell(length);
      for (let index = 0; index < count; index++) {
        const below = step;
        step = graph.derived(() => readDerived(below) + 1);
      }
      return readDerived(step);
    },
    { label: 'the computed value "total"' },
  );
  const middle = graph.derived(
    () => {
      middleRuns++;
      return readDerived(total);
    },
    { label: 'the computed value "middle"' },
  );
  const outer = graph.derived(() => (readCell(armed) ? readDerived(middle) : 0));
  // A cached value: its next read takes the iterative walk, at depth 0.
  expect(readDerived(outer)).toBe(0);
  writeCell(armed, true);
  let caught: unknown;
  try {
    readDerived(outer);
  } catch (error) {
    caught = error;
  }
  expect((caught as { code?: string } | undefined)?.code).toBe("pinna/depth-rebuilt");
  expect((caught as Error).message).toContain('the computed value "middle"');
  // The first run and 64 restarts of the driver's target, and no more: a
  // nested driver would run `total` 65 times for each run of `middle`.
  expect(middleRuns).toBe(65);
  expect(totalRuns).toBe(65);
  expect([...seen].sort()).toEqual([0, 1]);
  expect(graph.restarts).toBeUndefined();
  // The graph reads on.
  writeCell(length, 3);
  expect(readDerived(outer)).toBe(3);
});
