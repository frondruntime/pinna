/**
 * Runs reactive-framework-test-suite for one library and prints the results
 * as JSON: `bun run.ts <library>` for every section but the cycles and the
 * probes, `bun run.ts <library> cycles` for the cycle section, whose cases
 * may not end in a library that does not bound them. Each run is its own
 * process, so MobX's global state and its console output stay out of the
 * test process.
 */
import { behaviors, correctness, runCase, runProbe } from "reactive-framework-test-suite";
import { type FrameworkName, frameworks } from "./frameworks.ts";

export interface Results {
  readonly cases: Readonly<Record<number, ReturnType<typeof runCase>>>;
  readonly probes: Readonly<Record<number, ReturnType<typeof runProbe>>>;
}

const library = process.argv[2] as FrameworkName;
const cycles = process.argv[3] === "cycles";
const framework = frameworks[library]();

const cases: Record<number, ReturnType<typeof runCase>> = {};
for (const section of correctness) {
  if ((section.mayNotTerminate === true) === cycles) {
    for (const testCase of section.cases) {
      cases[testCase.id] = runCase(framework, testCase);
    }
  }
}

const probes: Record<number, ReturnType<typeof runProbe>> = {};
if (!cycles) {
  for (const probe of behaviors.cases) {
    probes[probe.id] = runProbe(framework, probe);
  }
}

const results: Results = { cases, probes };
process.stdout.write(JSON.stringify(results));
