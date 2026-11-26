/**
 * What the change stream costs on Bun: the scenarios of
 * `change-stream-model.ts`, the median time per update over seven rounds.
 * `bun run bench:changes`; `bun run bench:hermes-changes` runs them on
 * Hermes.
 */
import { measure, report, type ScenarioName, scenarioNames } from "./change-stream-model.ts";

const host = { now: () => performance.now(), collect: () => Bun.gc(true) };
const results = Object.fromEntries(
  scenarioNames.map((name) => [name, measure(name, host)]),
) as Record<ScenarioName, ReturnType<typeof measure>>;

console.log(report(`Bun ${Bun.version}: median of 7 rounds`, results));
