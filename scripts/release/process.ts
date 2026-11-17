/**
 * Starting programs: the checks, `bun pm pack`, `tsc`, `git`, and `npm`.
 */
import { Console, Data, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** A release step that failed, with what it was doing. */
export class ReleaseError extends Data.TaggedError("ReleaseError")<{
  readonly step: string;
  readonly message: string;
}> {}

export interface Finished {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const commandLine = (command: string, args: ReadonlyArray<string>): string =>
  [command, ...args].join(" ");

/** Runs a program to its end with its output captured, whatever its exit code. */
export const finished = (
  step: string,
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
): Effect.Effect<Finished, ReleaseError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(ChildProcess.make(command, [...args], { cwd }));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText, Stream.mkString),
          handle.stderr.pipe(Stream.decodeText, Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { exitCode, stdout, stderr };
    }),
  ).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(
        new ReleaseError({ step, message: `${commandLine(command, args)}: ${error.message}` }),
      ),
    ),
  );

/** Runs a program to its end and returns what it printed; a nonzero exit fails the step. */
export const output = (
  step: string,
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
): Effect.Effect<string, ReleaseError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const result = yield* finished(step, command, args, cwd);
    if (result.exitCode !== 0) {
      return yield* new ReleaseError({
        step,
        message:
          `${commandLine(command, args)} exited with ${result.exitCode}\n${result.stdout.trim()}\n${result.stderr.trim()}`.trim(),
      });
    }
    yield* Console.log(`${step} ok`);
    return result.stdout;
  });

/**
 * Runs a program on this terminal, its input and output the terminal's own,
 * so `npm login` and a publish's one-time password can ask their questions.
 */
export const attached = (
  step: string,
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
): Effect.Effect<number, ReleaseError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make(command, [...args], {
        cwd,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    return exitCode as number;
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(
        new ReleaseError({ step, message: `${commandLine(command, args)}: ${error.message}` }),
      ),
    ),
  );

/** `attached`, where a nonzero exit fails the step. */
export const attachedOrFail = (
  step: string,
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
): Effect.Effect<void, ReleaseError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const exitCode = yield* attached(step, command, args, cwd);
    if (exitCode !== 0) {
      return yield* new ReleaseError({
        step,
        message: `${commandLine(command, args)} exited with ${exitCode}`,
      });
    }
  });

/** Prints a heading between a release's stages. */
export const section = (title: string): Effect.Effect<void> => Console.log(`\n== ${title}`);
