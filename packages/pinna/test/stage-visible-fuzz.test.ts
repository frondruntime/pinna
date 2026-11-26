import { describe, expect, test } from "bun:test";
import {
  generate,
  handlerOf,
  keys,
  keyToken,
  type RecipeSpec,
  run,
  seeds,
} from "./fuzz/stage-script.ts";

/**
 * The differential fuzz of visible stages (ruling 68), over the scripts of
 * `fuzz/stage-script.ts`: the same script ends with the same base visible
 * and hidden, and at every rest point the realm shows what applying every
 * showing stage, bottom first, lands in a scratch realm. The install rule's
 * count of application functions runs in `internal/stage-install.test.ts`.
 */

describe("visible stages: the differential fuzz", () => {
  test("a script ends with the same base with its stages visible and hidden", () => {
    const differing: Array<string> = [];
    for (let seed = 1; seed <= seeds; seed++) {
      const steps = generate(seed);
      const shown = run(steps, true, false, "none");
      const hidden = run(steps, false, false, "none");
      if (shown.finalBase !== hidden.finalBase) {
        differing.push(`seed ${seed}: visible ${shown.finalBase}, hidden ${hidden.finalBase}`);
      }
    }
    expect(differing).toEqual([]);
  });

  test("at every rest point the realm shows what applying every showing stage would land", () => {
    const failing: Array<string> = [];
    for (let seed = 1; seed <= seeds; seed++) {
      const { failures } = run(generate(seed), true, true, handlerOf(seed));
      if (failures.length > 0) failing.push(`seed ${seed}: ${failures[0]}`);
    }
    expect(failing).toEqual([]);
  });

  test("the scripts reach stops, stacks, settles, conditions, marks, odd keys, and rollbacks", () => {
    const counts = new Map<string, number>();
    const count = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1);
    const visit = (spec: RecipeSpec): void => {
      count(spec.kind);
      if (spec.kind === "throwAbove") visit(spec.otherwise);
      if (spec.kind === "when") {
        visit(spec.holds);
        if (spec.otherwise !== undefined) visit(spec.otherwise);
      }
      if ("key" in spec) count(`key ${keyToken(keys[spec.key])}`);
    };
    for (let seed = 1; seed <= 100; seed++) {
      for (const step of generate(seed)) {
        count(step.kind);
        if (step.kind === "stage") visit(step.recipe);
        if (step.kind === "open" && step.fail) count("fail");
      }
    }
    for (const name of [
      "settle",
      "throwAbove",
      "when",
      "mark",
      "readAtom",
      "pairAdd",
      "fail",
      "rollbackApply",
      "baseMark",
      "key NaN",
      "key -0",
      "key 0",
      "key a",
    ]) {
      expect({ name, reached: (counts.get(name) ?? 0) > 10 }).toEqual({ name, reached: true });
    }
  });
});
