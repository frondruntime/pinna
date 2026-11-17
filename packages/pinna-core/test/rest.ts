import { expect } from "bun:test";
import type { Graph } from "../src/graph.ts";

/** Asserts no run, walk, batch, open `beginBatch`, schedule, or hook start is left open in `graph`. */
export const expectAtRest = (graph: Graph): void => {
  expect({
    active: graph.active,
    deriving: graph.deriving,
    depth: graph.depth,
    openBatches: graph.openBatches,
    walkDepth: graph.walkDepth,
    scheduled: graph.dueHead,
    hooksDue: graph.hooksDue.length,
  }).toEqual({
    active: undefined,
    deriving: undefined,
    depth: 0,
    openBatches: 0,
    walkDepth: 0,
    scheduled: undefined,
    hooksDue: 0,
  });
};
