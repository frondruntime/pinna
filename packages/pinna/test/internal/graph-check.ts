/**
 * The graph checker of `pinna-core` over a fuzz program's nodes: throws,
 * naming each broken invariant, so the program's trace ends in a crash and
 * the run fails.
 */
import { checkGraph } from "../../../pinna-core/test/checker.ts";
import { nodeOf } from "../../src/internal/index.ts";
import type { Check } from "../fuzz/interpret.ts";

export const graphCheck: Check = (observables) => {
  const problems = checkGraph(observables.map((observable) => nodeOf(observable)));
  if (problems.length > 0) {
    throw new Error(`graph checker: ${problems.join("; ")}`);
  }
};
