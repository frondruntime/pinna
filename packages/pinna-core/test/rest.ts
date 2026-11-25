import { expect } from "bun:test";
import type { Graph } from "../src/graph.ts";
import { expectGraphSound, madeNodes, recordNodes } from "./checker.ts";

// Every graph a test file that checks rest makes keeps its nodes, so the
// check below can walk them.
recordNodes();

/**
 * Asserts no run, walk, batch, open `beginBatch`, schedule, or hook start is
 * left open in `graph`, and that its nodes keep the invariants the graph
 * checker checks (`checker.ts`).
 */
export const expectAtRest = (graph: Graph): void => {
  expect({
    active: graph.active,
    shadowed: graph.shadowed,
    place: graph.place,
    computeDepth: graph.computeDepth,
    suspended: graph.suspended,
    depth: graph.depth,
    openBatches: graph.openBatches,
    walkDepth: graph.walkDepth,
    scheduled: graph.dueHead,
    hooksDue: graph.hooksDue.length,
  }).toEqual({
    active: undefined,
    shadowed: undefined,
    place: 0,
    computeDepth: 0,
    suspended: undefined,
    depth: 0,
    openBatches: 0,
    walkDepth: 0,
    scheduled: undefined,
    hooksDue: 0,
  });
  expectGraphSound(madeNodes(graph));
};
