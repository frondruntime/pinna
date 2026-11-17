import { describe, expect, test } from "bun:test";
import { behaviors, correctness } from "reactive-framework-test-suite";
import { cases, type Miss, probes } from "./expected.ts";
import type { FrameworkName } from "./frameworks.ts";
import type { Results } from "./run.ts";

/**
 * reactive-framework-test-suite (MIT, johnsoncodehk) on Pinna, MobX, and alien-signals.
 * MobX runs through the same interface, so its local run is the oracle for
 * what a case asks. Each library runs in its own process; see `run.ts`.
 */

const script = new URL("./run.ts", import.meta.url).pathname;

/** The cycle cases end on their own guard in both libraries well inside this. */
const cycleLimit = 20_000;

const run = (library: FrameworkName, cycles: boolean): Results => {
  const child = Bun.spawnSync(
    [process.execPath, ...process.execArgv, script, library, ...(cycles ? ["cycles"] : [])],
    cycles ? { timeout: cycleLimit } : {},
  );
  if (child.exitCode !== 0) {
    throw new Error(
      `${library}${cycles ? " cycles" : ""} did not finish (exit ${child.exitCode}, signal ${child.signalCode}):\n${child.stderr.toString().slice(-2000)}`,
    );
  }
  return JSON.parse(child.stdout.toString()) as Results;
};

const libraries: ReadonlyArray<FrameworkName> = ["pinna", "mobx", "alien-signals"];

/** A case result as the expected outcome reads it, with the error when it differs. */
const outcome = (
  result: { readonly status: string; readonly error?: string; readonly reason?: string },
  expected: string,
): string =>
  result.status === expected
    ? expected
    : `${result.status}: ${result.error ?? result.reason ?? ""}`;

for (const library of libraries) {
  describe(`reactive-framework-test-suite on ${library}`, () => {
    const results = run(library, false);
    const cycleResults = run(library, true);
    for (const section of correctness) {
      const found = section.mayNotTerminate === true ? cycleResults : results;
      for (const testCase of section.cases) {
        const expected: Miss | undefined = cases[library][testCase.id];
        test(`${section.name} #${testCase.id}: ${testCase.title}`, () => {
          const result = found.cases[testCase.id];
          expect(result).toBeDefined();
          const status = expected?.status ?? "pass";
          expect(outcome(result as NonNullable<typeof result>, status)).toBe(status);
        });
      }
    }
    for (const probe of behaviors.cases) {
      const expected = probes[library][probe.id];
      test(`probe #${probe.id}: ${probe.title}`, () => {
        const result = results.probes[probe.id];
        expect(result).toBeDefined();
        const found = result as NonNullable<typeof result>;
        if (typeof expected === "string") {
          expect(outcome(found, "variant")).toBe("variant");
          expect(found.status === "variant" ? found.variant : undefined).toBe(expected);
        } else {
          expect(expected).toBeDefined();
          const status = (expected as Miss).status;
          expect(outcome(found, status)).toBe(status);
        }
      });
    }
  });
}
