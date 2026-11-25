/**
 * Change stream benchmark on Hermes: the scenarios of
 * `change-stream-model.ts`, compiled the way a React Native release build
 * compiles them (`hermes-toolchain.ts`), each scenario in its own Hermes
 * process. Hermes counts every byte it allocates, garbage included, so the
 * table also has bytes per update.
 *
 * bun bench/hermes-changes.ts <hermes-ios destroot>
 */
import { join } from "node:path";
import { type measure, report, type ScenarioName, scenarioNames } from "./change-stream-model.ts";
import { hermesFrom, lowerForHermes, runOnHermes } from "./hermes-toolchain.ts";

const destroot = hermesFrom("bun bench/hermes-changes.ts <hermes-ios destroot>");
const lowered = await lowerForHermes(join(import.meta.dir, "hermes-changes-entry.ts"));

const results = Object.fromEntries(
  scenarioNames.map((name) => [
    name,
    JSON.parse(runOnHermes(destroot, lowered, name)) as ReturnType<typeof measure>,
  ]),
) as Record<ScenarioName, ReturnType<typeof measure>>;

console.log(report(`Hermes (${destroot}): median of 7 rounds`, results));
