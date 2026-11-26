import { describe, expect, test } from "bun:test";
import * as api from "../../src/index.ts";
import { execute } from "../fuzz/interpret.ts";
import { generate } from "../fuzz/program.ts";
import { graphCheck } from "./graph-check.ts";

/**
 * The graph checker of `pinna-core` after every top-level operation of the
 * differential fuzz's programs: a broken invariant throws, the trace ends in
 * a crash, and the test names it. `bun run fuzz` runs the same check on
 * every seed it compares.
 */

const seeds = Number(process.env["PINNA_FUZZ_GRAPH_SEEDS"] ?? 300);

describe("fuzz programs keep the graph's invariants", () => {
  test(`${seeds} seeds`, () => {
    for (let seed = 1; seed <= seeds; seed++) {
      const trace = execute(generate(seed), api, graphCheck);
      const crashes = trace.filter((entry) => entry.startsWith("crash"));
      if (crashes.length > 0) {
        throw new Error(`seed ${seed}: ${crashes.join("\n")}`);
      }
      expect(crashes).toEqual([]);
    }
  });
});
