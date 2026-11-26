/**
 * `bun run bench`: measures the scenarios on each library and runtime and
 * writes a results file.
 *
 * Every cell, one library on one scenario on one runtime, runs in a process
 * of its own. Launches repeat the whole grid, and each launch shuffles the
 * libraries within a scenario, so drift over the run (heat, a background
 * job) lands on every library instead of on whichever ran last. The rough
 * tier gives numbers in minutes for a change in progress; the publish tier
 * is what a table on the site prints.
 */
import { arch, cpus, loadavg, platform, totalmem } from "node:os";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Option, Path, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import type { LibraryName } from "./adapter.ts";
import { libraries, libraryNames } from "./libraries/index.ts";
import type { Request } from "./measure.ts";
import {
  type CpuProfile,
  type HeapProfile,
  printCpu,
  printHeap,
  profileName,
  summarizeCpu,
  summarizeHeap,
} from "./profile.ts";
import { type Cell, type Launch, Results, type RuntimeName, type Tier } from "./results.ts";
import {
  BenchError,
  hermesDestroot,
  output,
  type Profile,
  prepare,
  type Runtime,
} from "./runtimes.ts";
import { scenarios } from "./scenarios.ts";
import { summarize } from "./statistics.ts";

/**
 * What each tier asks of a cell. Warm-up is for a JIT: Hermes runs bytecode
 * and has none, so it takes one sample to settle its heap and no more.
 */
const tiers: Readonly<
  Record<
    Tier,
    Omit<Request, "library" | "scenario" | "warmup"> & {
      readonly launches: number;
      readonly warmup: number;
    }
  >
> = {
  rough: { launches: 1, warmup: 3, minimum: 5, maximum: 50, budget: 1000, precision: 0.02 },
  publish: { launches: 5, warmup: 5, minimum: 10, maximum: 200, budget: 5000, precision: 0.01 },
};

/**
 * What a profiled cell asks instead of its tier's stopping rule: about two
 * and a half seconds of samples, whatever their spread, so the profile holds
 * thousands of ticks.
 */
const profiling = { minimum: 5, maximum: 1_000_000, budget: 2500, precision: 0 } as const;

/** Rows each profile summary prints, and callers shown for each allocation site. */
const profileRows = 25;
const profileCallers = 4;

const runtimeNames: ReadonlyArray<RuntimeName> = ["node", "hermes"];
const scenarioIds = scenarios.map((scenario) => scenario.id);

/** A comma-separated flag, each name checked against `known`. */
const names = <Name extends string>(kind: string, given: string, known: ReadonlyArray<Name>) => {
  const written = given
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const isKnown = (name: string): name is Name => (known as ReadonlyArray<string>).includes(name);
  const picked = written.filter(isKnown);
  return picked.length === 0 || picked.length < written.length
    ? Effect.fail(
        new BenchError({ message: `${kind}: pick from ${known.join(", ")}; got ${given}` }),
      )
    : Effect.succeed(picked);
};

const shuffled = <Value>(values: ReadonlyArray<Value>): Array<Value> => {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other] as Value, copy[index] as Value];
  }
  return copy;
};

const milliseconds = (value: number): string => `${value.toFixed(value < 10 ? 3 : 2)} ms`;

/** The version of each library, from the package.json the bundle resolved. */
const libraryVersions = (picked: ReadonlyArray<LibraryName>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.dirname(path.dirname(new URL(import.meta.url).pathname));
    const versions: Record<string, string> = {};
    for (const name of picked) {
      const file = path.join(directory, "node_modules", libraries[name].package, "package.json");
      const text = yield* fileSystem
        .readFileString(file)
        .pipe(
          Effect.mapError(
            (error) => new BenchError({ message: `reading ${file}: ${error.message}` }),
          ),
        );
      versions[name] = (JSON.parse(text) as { readonly version: string }).version;
    }
    return versions;
  });

/**
 * What a profiled cell's profile says, read from its file, beside how much of
 * it the timed runs account for: the profile also holds each sample's setup
 * and collection, and the worker's own loop.
 */
const profileSummary = (profile: Profile, response: Launch, scenario: string, library: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(profile.directory, profileName(profile.mode, { scenario, library }));
    const text = yield* fileSystem
      .readFileString(file)
      .pipe(
        Effect.mapError(
          (error) => new BenchError({ message: `reading ${file}: ${error.message}` }),
        ),
      );
    const sum = (values: ReadonlyArray<number>) => values.reduce((total, each) => total + each, 0);
    if (profile.mode === "cpu") {
      return (
        `${file}\ntimed runs: ${sum(response.times).toFixed(1)} ms of ${response.times.length} samples; ` +
        printCpu(summarizeCpu(JSON.parse(text) as CpuProfile, profileRows))
      );
    }
    const counted = response.bytes ?? [];
    return (
      `${file}\ncounted runs: ${(sum(counted) / 1024).toFixed(1)} KiB in ${counted.length} samples; ` +
      printHeap(summarizeHeap(JSON.parse(text) as HeapProfile, profileRows, profileCallers))
    );
  });

const bench = Command.make(
  "bench",
  {
    tier: Flag.Literals("tier", ["rough", "publish"]).pipe(
      Flag.withDefault("rough"),
      Flag.withDescription(
        "rough: one launch, about a second a cell; publish: five launches, about five seconds a cell",
      ),
    ),
    runtime: Flag.String("runtime").pipe(
      Flag.withDefault("node,hermes"),
      Flag.withDescription(`comma-separated, from ${runtimeNames.join(", ")}`),
    ),
    library: Flag.String("library").pipe(
      Flag.withDefault(libraryNames.join(",")),
      Flag.withDescription(`comma-separated, from ${libraryNames.join(", ")}`),
    ),
    scenario: Flag.String("scenario").pipe(
      Flag.withDefault(scenarioIds.join(",")),
      Flag.withDescription(`comma-separated, from ${scenarioIds.join(", ")}`),
    ),
    hermes: Flag.String("hermes").pipe(
      Flag.optional,
      Flag.withDescription(
        "a hermes-ios release's destroot with bin/hermesc and bin/hermes; or PINNA_HERMES",
      ),
    ),
    out: Flag.String("out").pipe(
      Flag.optional,
      Flag.withDescription("the results file; results/<tier>-<date>.json by default"),
    ),
    profile: Flag.Literals("profile", ["cpu", "heap"]).pipe(
      Flag.optional,
      Flag.withDescription(
        "for diagnosis, Node only, rough tier only, needs --out: cpu profiles the timed launch, " +
          "heap the byte-counting launch, each cell for about 2.5 s; the profiles and the worker " +
          "bundle go to profiles/ beside --out, and a summary of each prints after its cell",
      ),
    ),
  },
  (flags) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tier = Option.isSome(flags.profile)
          ? { ...tiers[flags.tier], ...profiling }
          : tiers[flags.tier];
        const pickedRuntimes = yield* names("--runtime", flags.runtime, runtimeNames);
        const pickedLibraries = yield* names("--library", flags.library, libraryNames);
        const pickedScenarios = yield* names("--scenario", flags.scenario, scenarioIds);
        const profile = yield* Option.match(flags.profile, {
          onNone: () => Effect.succeed(Option.none<Profile>()),
          onSome: (mode) =>
            flags.tier === "publish"
              ? Effect.fail(new BenchError({ message: "--profile: not with --tier publish" }))
              : pickedRuntimes.includes("hermes")
                ? Effect.fail(
                    new BenchError({ message: "--profile: Node only; pass --runtime node" }),
                  )
                : Option.match(flags.out, {
                    onNone: () =>
                      Effect.fail(
                        new BenchError({
                          message:
                            "--profile: needs --out, outside the repository; the profiles go to profiles/ beside it",
                        }),
                      ),
                    onSome: (out) =>
                      Effect.succeed(
                        Option.some<Profile>({
                          mode,
                          directory: path.resolve(path.dirname(out), "profiles"),
                        }),
                      ),
                  }),
        });
        if (Option.isSome(profile)) {
          yield* fileSystem
            .makeDirectory(profile.value.directory, { recursive: true })
            .pipe(Effect.mapError((error) => new BenchError({ message: error.message })));
        }
        const destroot = pickedRuntimes.includes("hermes")
          ? Option.some(yield* hermesDestroot(flags.hermes))
          : Option.none<string>();

        const started = new Date();
        const loadBefore = loadavg()[0] as number;
        yield* warnOnLoad("before the run", loadBefore);
        const commit = (yield* output("git", ["rev-parse", "HEAD"])).trim();
        // Only what a cell runs counts: the packages and the lockfile. An
        // untracked note or worktree elsewhere does not mark a run dirty.
        const dirty =
          (yield* output("git", [
            "status",
            "--porcelain",
            "--",
            ":/packages",
            ":/package.json",
            ":/bun.lock",
          ])).trim() !== "";
        const directory = yield* fileSystem
          .makeTempDirectoryScoped({ prefix: "pinna-bench-" })
          .pipe(Effect.mapError((error) => new BenchError({ message: error.message })));

        const runtimes: Array<Runtime> = [];
        for (const name of pickedRuntimes) {
          yield* Console.error(`bundling the ${name} worker`);
          runtimes.push(yield* prepare(name, directory, destroot, profile));
        }

        const launches = new Map<string, Array<Launch>>();
        const failures = new Map<string, string>();
        const key = (runtime: RuntimeName, scenario: string, library: LibraryName) =>
          `${runtime}\u0000${scenario}\u0000${library}`;

        for (let launch = 1; launch <= tier.launches; launch++) {
          for (const runtime of runtimes) {
            for (const scenario of pickedScenarios) {
              for (const library of shuffled(pickedLibraries)) {
                const cell = key(runtime.name, scenario, library);
                if (failures.has(cell)) {
                  continue;
                }
                const response = yield* runtime.measure({
                  library,
                  scenario,
                  warmup: runtime.name === "hermes" ? 1 : tier.warmup,
                  minimum: tier.minimum,
                  maximum: tier.maximum,
                  budget: tier.budget,
                  precision: tier.precision,
                });
                const label = `[${launch}/${tier.launches}] ${runtime.name} ${scenario} ${library}`;
                if (response._tag === "Failed") {
                  failures.set(cell, response.failure);
                  yield* Console.error(`${label}: ${response.failure}`);
                  continue;
                }
                const seen = [...(launches.get(cell) ?? []), response];
                launches.set(cell, seen);
                const summary = summarize([response]);
                yield* Console.error(
                  `${label}: ${milliseconds(summary.median)} median of ${summary.samples}, ` +
                    `${milliseconds(summary.low)}–${milliseconds(summary.high)}`,
                );
                if (Option.isSome(profile)) {
                  yield* Console.error(
                    yield* profileSummary(profile.value, response, scenario, library),
                  );
                }
              }
            }
          }
        }

        const cells: Array<Cell> = [];
        for (const runtime of runtimes) {
          for (const scenario of pickedScenarios) {
            for (const library of pickedLibraries) {
              const cell = key(runtime.name, scenario, library);
              const failure = failures.get(cell);
              const measured = launches.get(cell) ?? [];
              cells.push({
                runtime: runtime.name,
                library,
                scenario,
                outcome:
                  failure !== undefined
                    ? { _tag: "Failed", failure }
                    : { _tag: "Measured", launches: measured, summary: summarize(measured) },
              });
            }
          }
        }

        const seconds = (Date.now() - started.getTime()) / 1000;
        const loadAfter = loadavg()[0] as number;
        yield* warnOnLoad("after the run", loadAfter);
        const results = yield* Schema.encodeEffect(Results)({
          commit,
          dirty,
          date: started.toISOString(),
          tier: flags.tier,
          ...Option.match(flags.profile, {
            onNone: () => ({}),
            onSome: (mode) => ({ profile: mode }),
          }),
          parameters: {
            launches: tier.launches,
            minimum: tier.minimum,
            maximum: tier.maximum,
            budget: tier.budget,
            precision: tier.precision,
          },
          machine: {
            platform: platform(),
            architecture: arch(),
            cpu: cpus()[0]?.model ?? "unknown",
            cores: cpus().length,
            memory: totalmem(),
          },
          load: { before: loadBefore, after: loadAfter },
          runtimes: Object.fromEntries(runtimes.map((runtime) => [runtime.name, runtime.version])),
          libraries: yield* libraryVersions(pickedLibraries),
          seconds,
          cells,
        }).pipe(
          Effect.mapError((error) => new BenchError({ message: `results: ${error.message}` })),
        );

        const out = Option.getOrElse(flags.out, () =>
          path.join("results", `${flags.tier}-${started.toISOString().replace(/[:.]/g, "-")}.json`),
        );
        yield* fileSystem.makeDirectory(path.dirname(out), { recursive: true }).pipe(
          Effect.flatMap(() =>
            fileSystem.writeFileString(out, `${JSON.stringify(results, null, 2)}\n`),
          ),
          Effect.mapError(
            (error) => new BenchError({ message: `writing ${out}: ${error.message}` }),
          ),
        );

        yield* Console.error(`\n${flags.tier}, ${seconds.toFixed(1)} s, ${out}`);
        for (const cell of cells) {
          const line = `${cell.runtime.padEnd(7)}${cell.scenario.padEnd(22)}${cell.library.padEnd(15)}`;
          yield* Console.error(
            cell.outcome._tag === "Failed"
              ? `${line}${cell.outcome.failure}`
              : `${line}${milliseconds(cell.outcome.summary.median).padStart(12)}  ` +
                  `${milliseconds(cell.outcome.summary.low)}–${milliseconds(cell.outcome.summary.high)} ` +
                  `(${cell.outcome.summary.interval})` +
                  (cell.outcome.summary.bytes === undefined
                    ? ""
                    : `  ${(cell.outcome.summary.bytes / 1024 / 1024).toFixed(2)} MiB`),
          );
        }
      }),
    ),
);

/**
 * The share of the cores the one-minute load average may hold before a
 * warning. Each cell runs on one core, but past this share the cores it runs
 * beside are busy, and a run of 2026-11-25 at a load of 10 on 10 cores could
 * not tell a 5% change from noise.
 */
const loadPerCoreLimit = 0.5;

/** Warns when the machine is too busy for differences of a few percent to show. */
const warnOnLoad = (when: string, load: number) =>
  load / cpus().length > loadPerCoreLimit
    ? Console.error(
        `warning: one-minute load ${load.toFixed(1)} on ${cpus().length} cores ${when}; ` +
          "results on a busy machine cannot resolve differences of a few percent",
      )
    : Effect.void;

Command.run(bench, { version: "0.0.0" }).pipe(
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
