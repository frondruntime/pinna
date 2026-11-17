/**
 * Differential fuzz: this checkout's `@frondruntime/pinna` against another
 * checkout's, on programs a seed generates.
 *
 *   PINNA_REFERENCE=/path/to/other/checkout bun run fuzz
 *
 * `PINNA_FUZZ_SEEDS` how many seeds (default 1000), `PINNA_FUZZ_SEED` the
 * first (default 1). `PINNA_FUZZ_IGNORE_RUNS=1` ignores how often computed
 * values ran. `PINNA_FUZZ_IGNORE_ORDER=1` ignores the order of the entries
 * within one top-level operation, and makes every watch effect log only
 * (`compare.ts`). Exits 1 on the first mismatch, after printing it shrunk.
 */
import * as ours from "../../src/index.ts";
import { checkSeed, report } from "./compare.ts";
import type { Api } from "./interpret.ts";

const referenceRoot = process.env["PINNA_REFERENCE"];
if (referenceRoot === undefined || referenceRoot === "") {
  console.error("fuzz: set PINNA_REFERENCE to the root of the checkout to compare against");
  process.exit(2);
}
const count = Number(process.env["PINNA_FUZZ_SEEDS"] ?? 1000);
const first = Number(process.env["PINNA_FUZZ_SEED"] ?? 1);

const reference = (await import(`${referenceRoot}/packages/pinna/src/index.ts`)) as Api;

const started = performance.now();
for (let seed = first; seed < first + count; seed++) {
  const mismatch = checkSeed(seed, ours, reference);
  if (mismatch !== undefined) {
    console.log(report(mismatch));
    console.log(`caught after ${seed - first + 1} seeds`);
    process.exit(1);
  }
}
const seconds = (performance.now() - started) / 1000;
console.log(
  `fuzz: ${count} seeds from ${first}, no mismatch, ${seconds.toFixed(1)}s, ${(count / seconds).toFixed(0)} seeds/s`,
);
