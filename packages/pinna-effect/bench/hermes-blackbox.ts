/**
 * The black-box scenarios on Hermes, each in its own process, compiled the
 * way a React Native release build compiles them (`hermes-toolchain.ts`).
 * Pass scenario names after the destroot to run only those.
 *
 * bun bench/hermes-blackbox.ts <hermes-ios destroot> [scenario ...]
 */
import { join } from "node:path";
import { hermesFrom, lowerForHermes, runOnHermes } from "../../pinna/bench/hermes-toolchain.ts";
import type { Result } from "./blackbox/harness.ts";
import { report } from "./blackbox/report.ts";
import { scenarios } from "./blackbox/scenarios.ts";

const destroot = hermesFrom("bun bench/hermes-blackbox.ts <hermes-ios destroot> [scenario ...]");
const only = process.argv.slice(3);
const lowered = await lowerForHermes(join(import.meta.dir, "blackbox", "hermes-entry.ts"));

const results: Array<Result> = [];
const failures: Array<string> = [];
for (const scenario of scenarios) {
  if (only.length > 0 && !only.some((part) => scenario.name.includes(part))) {
    continue;
  }
  const result = JSON.parse(runOnHermes(destroot, lowered, scenario.name)) as
    | Result
    | { readonly error: string };
  if ("error" in result) {
    failures.push(`${scenario.name}: ${result.error}`);
    console.error(`failed: ${scenario.name}: ${result.error}`);
    continue;
  }
  results.push(result);
  console.error(`done: ${scenario.name}`);
}

console.log(report(results, `Hermes (${destroot})`));
if (failures.length > 0) {
  console.log(["", "Failed:", "", ...failures.map((failure) => `- ${failure}`)].join("\n"));
  process.exitCode = 1;
}
