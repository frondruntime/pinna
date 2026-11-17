/**
 * The collector: serves one job at a time to the app on the booted iOS
 * simulator, relaunching the app for every job, and prints the medians.
 *
 *   bun run bench [--mode rough|full] [--rounds N] [--sizes 1000,10000]
 *                 [--variants pinna,mobx,alien,legend]
 *
 * The app must be built and installed in Release first (`bun run ios`).
 * Rough mode, the default, runs one round of the load, merge, replace, and
 * tick, to check a change in minutes; full mode runs three rounds of every
 * scenario, for the published tables. Each round runs every variant on every
 * size, in an order that rotates from round to round. A job that fails or
 * times out is recorded and the run goes on. The raw measures go to
 * `results/raw.json` after every job, so a stopped run keeps what it measured.
 */
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { Job, Measure, Memory } from "../src/harness/scenarios.ts";

const bundle = "dev.pinna.rnbench";
const port = 8799;
const jobTimeout = 10 * 60_000;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    mode: { type: "string", default: "rough" },
    rounds: { type: "string" },
    sizes: { type: "string", default: "1000,10000" },
    variants: { type: "string", default: "pinna,mobx,alien,legend" },
    device: { type: "string", default: "booted" },
  },
});
const modes = {
  rough: { rounds: 1, scenarios: ["merge", "replace", "tick"] },
  full: { rounds: 3, scenarios: undefined },
} as const;
if (values.mode !== "rough" && values.mode !== "full") {
  throw new Error(`--mode is rough or full, not ${values.mode}`);
}
const mode = modes[values.mode];
const rounds = values.rounds === undefined ? mode.rounds : Number(values.rounds);
const sizes = values.sizes.split(",").map(Number);
const variantNames = values.variants.split(",");

interface Result extends Job {
  readonly measures: ReadonlyArray<Measure>;
  /** Why the job produced no measures. */
  readonly error?: string;
  /** Resident memory of the app process once the first load settled, in kilobytes. */
  rss?: number | undefined;
  loadedHeap?: Record<string, number> | undefined;
  /** The heap after a full collection, with the store empty and then loaded. */
  memory?: Memory | undefined;
  heap?: Record<string, number> | undefined;
}

let current: Job | null = null;
let memory: { rss?: number | undefined; heap?: Record<string, number> | undefined } = {};
let finish: ((result: Result) => void) | undefined;
let fail: ((error: Error) => void) | undefined;

const run = async (command: ReadonlyArray<string>): Promise<string> => {
  const process = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(process.stdout).text();
  await process.exited;
  return output.trim();
};

const rssOfApp = async (): Promise<number | undefined> => {
  const pid = (await run(["pgrep", "-f", "rnbench.app/rnbench"])).split("\n")[0];
  if (pid === undefined || pid === "") {
    return undefined;
  }
  const rss = Number(await run(["ps", "-o", "rss=", "-p", pid]));
  return Number.isFinite(rss) ? rss : undefined;
};

Bun.serve({
  port,
  fetch: async (request) => {
    const path = new URL(request.url).pathname;
    console.error(`${request.method} ${path}`);
    if (path === "/job") {
      return Response.json(current);
    }
    if (path === "/memory") {
      const body = (await request.json()) as { heap?: Record<string, number> };
      memory = { rss: await rssOfApp(), heap: body.heap };
      return Response.json(memory);
    }
    if (path === "/result") {
      const result = (await request.json()) as Result;
      finish?.({ ...result, rss: memory.rss, loadedHeap: memory.heap });
      return new Response("ok");
    }
    if (path === "/error") {
      const body = (await request.json()) as { message: string; stack?: string };
      console.error(body.message, body.stack);
      fail?.(new Error(`${body.message}\n${body.stack ?? ""}`));
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  },
});

const runJob = async (job: Job): Promise<Result> => {
  current = job;
  memory = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<Result>((resolve, reject) => {
    finish = resolve;
    fail = reject;
    timer = setTimeout(() => reject(new Error("timed out")), jobTimeout);
  });
  await run(["xcrun", "simctl", "terminate", values.device, bundle]);
  await run(["xcrun", "simctl", "launch", values.device, bundle]);
  try {
    return await done;
  } catch (error) {
    return { ...job, measures: [], error: (error as Error).message };
  } finally {
    clearTimeout(timer);
    current = null;
    finish = undefined;
    fail = undefined;
    await run(["xcrun", "simctl", "terminate", values.device, bundle]);
  }
};

const raw = `${import.meta.dir}/../results/raw.json`;
await mkdir(`${import.meta.dir}/../results`, { recursive: true });

const results: Array<Result> = [];
for (let round = 1; round <= rounds; round++) {
  for (const size of sizes) {
    const shift = (round - 1) % variantNames.length;
    const order = [...variantNames.slice(shift), ...variantNames.slice(0, shift)];
    for (const variant of order) {
      const started = performance.now();
      const job: Job =
        mode.scenarios === undefined
          ? { variant, size, round }
          : { variant, size, round, scenarios: mode.scenarios };
      const result = await runJob(job);
      results.push(result);
      await Bun.write(raw, JSON.stringify({ mode: values.mode, rounds, results }, null, 2));
      console.error(
        `round ${round} ${variant} ${size}: ${((performance.now() - started) / 1000).toFixed(1)}s${result.error === undefined ? "" : ` failed: ${result.error.split("\n")[0]}`}`,
      );
    }
  }
}

const median = (numbers: ReadonlyArray<number>): number => {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};
const ms = (value: number): string => value.toFixed(1);

/**
 * What the Hermes heap retains for the rows, in bytes: allocated bytes after
 * a full collection with the store loaded, minus the same with it empty.
 * Only when both readings followed a forced collection; never a figure read
 * without one.
 */
const retainedAfterCollection = (result: Result): number | undefined => {
  const memory = result.memory;
  if (memory === undefined || !memory.empty.collected || !memory.loaded.collected) {
    return undefined;
  }
  const empty = memory.empty.stats?.["js_allocatedBytes"];
  const loaded = memory.loaded.stats?.["js_allocatedBytes"];
  return empty === undefined || loaded === undefined ? undefined : loaded - empty;
};

console.log(`\n${values.mode} mode, ${rounds} round${rounds === 1 ? "" : "s"}`);
for (const failed of results.filter((result) => result.error !== undefined)) {
  console.log(`- failed: round ${failed.round} ${failed.variant} ${failed.size}: ${failed.error}`);
}
for (const size of sizes) {
  console.log(`\n### ${size} rows\n`);
  console.log(
    "| Scenario | Variant | Parse ms | Convert ms | Store ms | Settle ms (median) | Settle ms (min) | Renders | Longest frame ms |",
  );
  console.log("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  // In the order they ran: the longest run lists the scenarios a store lacks.
  const byLength = [...results].sort((a, b) => b.measures.length - a.measures.length);
  const scenarios = [
    ...new Set(byLength.flatMap((result) => result.measures.map((measure) => measure.scenario))),
  ];
  for (const scenario of scenarios) {
    for (const variant of variantNames) {
      const measures = results
        .filter((result) => result.size === size && result.variant === variant)
        .flatMap((result) => result.measures.filter((measure) => measure.scenario === scenario));
      if (measures.length === 0) {
        continue;
      }
      const frames = measures.flatMap((measure) =>
        measure.longestFrame === undefined ? [] : [measure.longestFrame],
      );
      console.log(
        `| ${scenario} | ${variant} | ${ms(median(measures.map((measure) => measure.parse)))} | ${ms(median(measures.map((measure) => measure.convert)))} | ${ms(median(measures.map((measure) => measure.store)))} | ${ms(median(measures.map((measure) => measure.settle)))} | ${ms(Math.min(...measures.map((measure) => measure.settle)))} | ${median(measures.map((measure) => measure.renders))} | ${frames.length === 0 ? "" : ms(median(frames))} |`,
      );
    }
  }
  // What Hermes counted across the store's writes alone: bytes allocated,
  // collections run, and the time its collector reports; whether that time
  // counts the collector's work off the JS thread is not checked. Ticks sum
  // their sixty writes, and count the frames that came late.
  console.log(
    "\n| Scenario | Variant | Allocated MB (median) | Collections (median) | Collection ms (median) | Late frames (median) |",
  );
  console.log("| --- | --- | ---: | ---: | ---: | ---: |");
  for (const scenario of scenarios) {
    for (const variant of variantNames) {
      const measures = results
        .filter((result) => result.size === size && result.variant === variant)
        .flatMap((result) => result.measures.filter((measure) => measure.scenario === scenario));
      const heaps = measures.flatMap((measure) =>
        measure.storeHeap === undefined ? [] : [measure.storeHeap],
      );
      if (heaps.length === 0) {
        continue;
      }
      const late = measures.flatMap((measure) =>
        measure.lateFrames === undefined ? [] : [measure.lateFrames],
      );
      console.log(
        `| ${scenario} | ${variant} | ${ms(median(heaps.map((heap) => heap.allocated / 1024 / 1024)))} | ${median(heaps.map((heap) => heap.collections))} | ${ms(median(heaps.map((heap) => heap.collectionTime)))} | ${late.length === 0 ? "" : median(late)} |`,
      );
    }
  }
  // Allocated bytes after a forced full collection are what the heap holds
  // live; the empty store's reading is subtracted per job, then the median
  // taken. A blank cell means no reading followed a forced collection.
  const collectedJobs = results.filter(
    (result) => result.size === size && retainedAfterCollection(result) !== undefined,
  ).length;
  const sizedJobs = results.filter(
    (result) => result.size === size && result.error === undefined,
  ).length;
  console.log(
    "\n| Variant | RSS after load MB (median) | Hermes retained after collection MB (median, loaded minus empty store) |",
  );
  console.log("| --- | ---: | ---: |");
  for (const variant of variantNames) {
    const held = results.filter((result) => result.size === size && result.variant === variant);
    const rss = held.flatMap((result) => (result.rss === undefined ? [] : [result.rss / 1024]));
    const retained = held.flatMap((result) => {
      const bytes = retainedAfterCollection(result);
      return bytes === undefined ? [] : [bytes / 1024 / 1024];
    });
    console.log(
      `| ${variant} | ${rss.length === 0 ? "" : ms(median(rss))} | ${retained.length === 0 ? "" : ms(median(retained))} |`,
    );
  }
  if (collectedJobs < sizedJobs) {
    console.log(
      `\n${sizedJobs - collectedJobs} of ${sizedJobs} jobs read memory with no forced collection: Hermes's global \`gc\` was missing or did not run.`,
    );
  }
}
process.exit(0);
