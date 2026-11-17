/**
 * Data benchmark on Bun: the subjects in `data-model.ts`, each in its own
 * process so JIT state does not leak between them. Times are medians of
 * several runs.
 *
 * The parent fails when a ratio passes its scenario's ceiling. Ratios, not
 * milliseconds, so a slower machine does not fail it.
 *
 * bun bench/data.ts
 */
import { heapStats } from "bun:jsc";
import { bareCeilings, type Host, measure, rows, schemaCeilings, subjects } from "./data-model.ts";

/** Keeps measured values alive until the process exits. */
const kept: Array<unknown> = [];

const collect = () => {
  Bun.gc(true);
  Bun.gc(true);
  return { objects: heapStats().objectCount, bytes: process.memoryUsage().heapUsed };
};

const bun: Host = {
  now: () => performance.now(),
  retained: (make) => {
    const before = collect();
    kept.push(make());
    const after = collect();
    const megabytes = (after.bytes - before.bytes) / 1_048_576;
    const objects = Math.round((after.objects - before.objects) / rows);
    return `${megabytes.toFixed(1)} MB, ${objects} obj/row`;
  },
};

const requested = process.argv[2];

if (requested === undefined) {
  const results = Object.fromEntries(
    Object.keys(subjects).map((name) => {
      const child = Bun.spawnSync([process.execPath, ...process.execArgv, import.meta.path, name]);
      if (child.exitCode !== 0) {
        throw new Error(`${name} failed:\n${child.stderr.toString()}`);
      }
      return [name, JSON.parse(child.stdout.toString()) as Record<string, string>];
    }),
  );
  const header = ["", "MobX", "Pinna, bare", "Pinna, Effect Schema"];
  console.log(`| ${header.join(" | ")} |`);
  console.log(`| ${header.map(() => "---").join(" | ")} |`);
  for (const scenario of Object.keys(Object.values(results)[0] ?? {})) {
    const cells = Object.keys(subjects).map((name) => results[name]?.[scenario]);
    console.log(`| ${scenario} | ${cells.join(" | ")} |`);
  }
  const ratio = (over: string, under: string, scenario: string): number =>
    Number.parseFloat(results[over]?.[scenario] ?? "") /
    Number.parseFloat(results[under]?.[scenario] ?? "");
  for (const [over, under, ceilings] of [
    ["pinna-bare", "mobx", bareCeilings],
    ["pinna-schema", "pinna-bare", schemaCeilings],
  ] as const) {
    for (const [scenario, ceiling] of Object.entries(ceilings)) {
      const measured = ratio(over, under, scenario);
      if (!(measured <= ceiling)) {
        console.error(
          `${scenario}: ${over} takes ${measured.toFixed(2)}× ${under}'s time, past ${ceiling}×`,
        );
        process.exitCode = 1;
      }
    }
  }
} else {
  const subject = subjects[requested as keyof typeof subjects];
  if (subject === undefined) {
    throw new Error(`bench: no subject ${requested}`);
  }
  console.log(JSON.stringify(measure(subject, bun)));
}
