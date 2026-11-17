/**
 * Starting workers: each cell runs in a fresh process of its runtime, so no
 * cell inherits another's heap, inline caches, or JIT state.
 */
import { Data, Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { bundleWorker, hermesScript } from "./bundle.ts";
import type { Request } from "./measure.ts";
import { type ProfileMode, profileName } from "./profile.ts";
import { Response, type RuntimeName } from "./results.ts";

export class BenchError extends Data.TaggedError("BenchError")<{ readonly message: string }> {}

/** Runs a program to its end and returns what it printed; fails on a nonzero exit. */
export const output = (command: string, args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(ChildProcess.make(command, [...args]));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText, Stream.mkString),
          handle.stderr.pipe(Stream.decodeText, Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        return yield* new BenchError({
          message: `${command} ${args.join(" ")} exited with ${exitCode}:\n${stderr}${stdout}`,
        });
      }
      return stdout;
    }),
  ).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new BenchError({ message: `${command}: ${error.message}` })),
    ),
  );

const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(Response));

/** A runtime ready to measure cells. */
export interface Runtime {
  readonly name: RuntimeName;
  readonly version: string;
  readonly measure: (
    request: Request,
  ) => Effect.Effect<Response, BenchError, ChildProcessSpawner.ChildProcessSpawner>;
}

/** The Hermes destroot from the flag or `PINNA_HERMES`, checked for both binaries. */
export const hermesDestroot = (flag: Option.Option<string>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const destroot = Option.getOrUndefined(
      Option.orElse(flag, () => Option.fromNullishOr(process.env["PINNA_HERMES"])),
    );
    if (destroot === undefined) {
      return yield* new BenchError({
        message:
          "Hermes needs --hermes <destroot> or PINNA_HERMES: a hermes-ios release's destroot",
      });
    }
    for (const binary of ["hermesc", "hermes"]) {
      if (
        !(yield* fileSystem
          .exists(path.join(destroot, "bin", binary))
          .pipe(Effect.orElseSucceed(() => false)))
      ) {
        return yield* new BenchError({
          message: `no bin/${binary} in ${destroot}; build bin/hermes from hermes-host.cpp (its header has the command)`,
        });
      }
    }
    return destroot;
  });

/** A profiled run: which profiler, and the directory its files go to. */
export interface Profile {
  readonly mode: ProfileMode;
  readonly directory: string;
}

/**
 * Microseconds between CPU profiler ticks. One sample of a scenario takes 1
 * to 30 ms, too few ticks at Node's default of 1000.
 */
const cpuInterval = 100;

/**
 * Bytes between heap profiler samples, on average, well under the inspector's
 * default of 32 KB: one run of write-sources allocates a few hundred
 * kilobytes, so a run gives a few hundred samples.
 */
const heapInterval = 1024;

/**
 * Bundles the worker for `name` into `directory` and returns how to run a
 * cell on it. A worker prints one JSON line, its `Response`. With a profile,
 * Node's launches write one profile file per cell, `profileName`, into the
 * profile's directory.
 */
export const prepare = (
  name: RuntimeName,
  directory: string,
  destroot: Option.Option<string>,
  profile: Option.Option<Profile> = Option.none(),
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const worker = yield* Effect.tryPromise({
      try: () => bundleWorker(name),
      catch: (error) =>
        new BenchError({ message: `bundling the ${name} worker: ${String(error)}` }),
    });
    const write = (file: string, text: string) =>
      fileSystem
        .writeFileString(file, text)
        .pipe(
          Effect.mapError(
            (error) => new BenchError({ message: `writing ${file}: ${error.message}` }),
          ),
        );
    const parse = (printed: string) => {
      const line = printed.trim().split("\n").at(-1) ?? "";
      return decodeResponse(line).pipe(
        Effect.mapError(
          (error) =>
            new BenchError({ message: `${name} worker printed ${line}: ${error.message}` }),
        ),
      );
    };

    if (name === "hermes") {
      const root = yield* Option.match(destroot, {
        onNone: () => Effect.fail(new BenchError({ message: "Hermes has no destroot" })),
        onSome: Effect.succeed,
      });
      // Each launch of a cell asks the same, so a cell compiles once.
      const compiled = new Map<string, string>();
      let count = 0;
      const bytecodeFor = (request: Request) =>
        Effect.gen(function* () {
          const key = JSON.stringify(request);
          const known = compiled.get(key);
          if (known !== undefined) {
            return known;
          }
          count++;
          const source = path.join(directory, `hermes-${count}.js`);
          const bytecode = path.join(directory, `hermes-${count}.hbc`);
          yield* write(source, hermesScript(worker, request));
          yield* output(path.join(root, "bin", "hermesc"), [
            "-O",
            "-emit-binary",
            "-out",
            bytecode,
            source,
          ]);
          compiled.set(key, bytecode);
          return bytecode;
        });
      const runtime: Runtime = {
        name,
        version: path.basename(path.dirname(root)),
        measure: (request) =>
          Effect.gen(function* () {
            const bytecode = yield* bytecodeFor(request);
            return yield* parse(
              yield* output(path.join(root, "bin", "hermes"), [
                "-Xmicrotask-queue",
                "-Xes6-promise",
                bytecode,
              ]),
            );
          }),
      };
      return runtime;
    }

    // A profile names lines of the bundle, so a profiled run keeps it beside them.
    const file = path.join(
      Option.match(profile, { onNone: () => directory, onSome: (each) => each.directory }),
      "worker-node.mjs",
    );
    yield* write(file, worker);
    const version = (yield* output("node", ["--version"])).trim();
    const countingWarmup = 10;
    const countingSamples = 15;
    const launch = (
      flags: ReadonlyArray<string>,
      request: Request,
      trailing: ReadonlyArray<string> = [],
    ) =>
      Effect.flatMap(
        output("node", ["--expose-gc", ...flags, file, JSON.stringify(request), ...trailing]),
        parse,
      );
    const profiling = (mode: ProfileMode) => Option.filter(profile, (each) => each.mode === mode);
    // Node's flags for the CPU profiler; the worker's own arguments for the
    // heap profiler, since --heap-prof keeps only what survives to the exit.
    const cpuFlags = (request: Request): ReadonlyArray<string> =>
      Option.match(profiling("cpu"), {
        onNone: () => [],
        onSome: (each) => [
          "--cpu-prof",
          "--cpu-prof-dir",
          each.directory,
          "--cpu-prof-name",
          profileName("cpu", request),
          "--cpu-prof-interval",
          String(cpuInterval),
        ],
      });
    const heapArguments = (request: Request): ReadonlyArray<string> =>
      Option.match(profiling("heap"), {
        onNone: () => [],
        onSome: (each) => [
          path.join(each.directory, profileName("heap", request)),
          String(heapInterval),
        ],
      });
    const heapProfiled = Option.isSome(profiling("heap"));
    const runtime: Runtime = {
      name,
      version,
      // Two processes per cell. V8 adds to its allocation count a whole
      // linear allocation area at a time, about 256 KB, so a run that
      // allocates nothing reads 256 KB. With --no-inline-new every allocation
      // goes through the runtime and the count is exact to the object, but
      // code runs slower: the times come from a process without it, the
      // bytes from one with it, and escape analysis still removes what it
      // removes in both. The second warms up longer, since a tier-up in the
      // first samples allocates hundreds of kilobytes, and takes a fixed
      // count of samples, since bytes vary less than times.
      //
      // The CPU profiler goes on the timed launch, whose code is what the
      // times measure. The heap profiler goes on the counting launch, whose
      // byte counts are the ones the results report, and it then samples for
      // as long as the request asks instead of a fixed count.
      measure: (request) =>
        Effect.gen(function* () {
          const timed = yield* launch(cpuFlags(request), request);
          if (timed._tag === "Failed") {
            return timed;
          }
          const counted = yield* launch(
            ["--no-inline-new"],
            {
              ...request,
              warmup: Math.max(request.warmup, countingWarmup),
              ...(heapProfiled ? {} : { minimum: countingSamples, maximum: countingSamples }),
            },
            heapArguments(request),
          );
          if (counted._tag === "Failed") {
            return counted;
          }
          const { bytes: _coarse, ...times } = timed;
          // Drop the extra warm-up, so `warmup` counts the leading bytes too.
          return counted.bytes === undefined
            ? times
            : { ...times, bytes: counted.bytes.slice(counted.warmup - timed.warmup) };
        }),
    };
    return runtime;
  });
