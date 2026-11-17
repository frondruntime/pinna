/**
 * The black-box scenarios on Bun, each in its own process. Bun counts no
 * garbage, so there is no allocation column; live bytes are the heap after
 * a full collection. Pass scenario names to run only those.
 *
 * bun bench/blackbox.ts [scenario ...]
 */
import { heapStats } from "bun:jsc";
import { type Host, type Result, run } from "./blackbox/harness.ts";
import { report } from "./blackbox/report.ts";
import { scenarioNamed, scenarios } from "./blackbox/scenarios.ts";

const bun: Host = {
  now: () => performance.now(),
  live: () => {
    Bun.gc(true);
    return heapStats().heapSize;
  },
};

const { BLACKBOX_SCENARIO: subject } = process.env;
if (subject !== undefined) {
  console.log(JSON.stringify(await run(scenarioNamed(subject), bun)));
} else {
  const only = process.argv.slice(2);
  const results: Array<Result> = [];
  for (const scenario of scenarios) {
    if (only.length > 0 && !only.some((part) => scenario.name.includes(part))) {
      continue;
    }
    const child = Bun.spawnSync([process.execPath, "--conditions=source", import.meta.path], {
      env: { ...process.env, BLACKBOX_SCENARIO: scenario.name },
    });
    if (child.exitCode !== 0) {
      throw new Error(`${scenario.name} failed:\n${child.stdout}${child.stderr}`);
    }
    results.push(JSON.parse(child.stdout.toString()) as Result);
    console.error(`done: ${scenario.name}`);
  }
  console.log(report(results, `Bun ${Bun.version}`));
}
