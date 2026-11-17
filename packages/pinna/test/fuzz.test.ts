import { describe, expect, test } from "bun:test";
import * as api from "../src/index.ts";
import { execute } from "./fuzz/interpret.ts";
import { generate } from "./fuzz/program.ts";

/**
 * The differential fuzz's smoke check. With `PINNA_REFERENCE` unset it runs a
 * few seeds against this checkout twice: traces must be equal (the program
 * generator and the implementation are deterministic) and not empty. The
 * comparison against another checkout is `bun run fuzz`.
 */

const seeds = 60;

describe("differential fuzz harness", () => {
  test("a seed gives the same program every time", () => {
    for (let seed = 1; seed <= seeds; seed++) {
      expect(generate(seed)).toEqual(generate(seed));
    }
    expect(generate(1)).not.toEqual(generate(2));
  });

  test("a program's trace is the same twice, and not empty", () => {
    let entries = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const program = generate(seed);
      const first = execute(program, api);
      const second = execute(program, api);
      expect(first.length).toBeGreaterThan(0);
      expect(first).toEqual(second);
      expect(first.filter((entry) => entry.startsWith("crash"))).toEqual([]);
      entries += first.length;
    }
    expect(entries).toBeGreaterThan(seeds * 20);
  });
});
