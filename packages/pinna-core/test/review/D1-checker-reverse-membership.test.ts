import { expect, test } from "bun:test";
import { Graph, readCell, readDerived } from "../../src/index.ts";
import { checkGraph } from "../checker.ts";

// Not a listed finding: a gap in the test-only graph checker, closed by checking each listed edge against its observer.
test("the graph checker detects a source edge absent from its observer", () => {
  const graph = new Graph();
  const cell = graph.cell(1);
  const derived = graph.derived(() => readCell(cell));
  const stop = graph.watch(() => readDerived(derived));
  const dependency = derived.dependenciesHead;
  try {
    // Plant the converse of checker.test.ts's "linked and not listed" case.
    derived.dependenciesHead = undefined;
    expect(checkGraph([cell, derived]).length).toBeGreaterThan(0);
  } finally {
    derived.dependenciesHead = dependency;
    stop();
  }
});
