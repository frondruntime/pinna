/**
 * Builds the published packages into each package's `dist`: the JavaScript as
 * ES modules, and a declaration file for each source module.
 *
 * The declarations stay one file per module rather than one rolled-up file
 * per entry. A rollup gives each entry its own copy of a type the entries
 * share, and Pinna's brands are `unique symbol`s, so the `Realm` that
 * `@frondruntime/pinna/testing` returns would not be the `Realm` the main
 * entry takes. Their maps point into `src`, which ships beside them.
 */
import { Console, Effect, FileSystem, Path } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { packageDirectory, type ReleasePackage, workspaceRoot } from "./packages.ts";
import { output, ReleaseError } from "./process.ts";

/**
 * One module per entry, with what the entries share split into chunks, so a
 * class the entries share is one class at run time. `Bun.build` has no
 * command-line equivalent for every option here, so it runs in this process.
 */
const buildJavaScript = (
  published: ReleasePackage,
  directory: string,
): Effect.Effect<void, ReleaseError, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const step = `${published.name} javascript`;
    const result = yield* Effect.tryPromise({
      try: () =>
        Bun.build({
          entrypoints: published.entries.map((entry) =>
            path.join(directory, "src", `${entry}${published.extension}`),
          ),
          format: "esm",
          outdir: path.join(directory, "dist"),
          packages: "external",
          root: path.join(directory, "src"),
          splitting: true,
          sourcemap: "external",
          target: "browser",
          tsconfig: path.join(directory, "tsconfig.build.json"),
        }),
      catch: (error) => new ReleaseError({ step, message: String(error) }),
    });
    if (!result.success) {
      return yield* new ReleaseError({ step, message: result.logs.map(String).join("\n") });
    }
    yield* Console.log(`${step} ok`);
  });

const emitDeclarations = (
  published: ReleasePackage,
  directory: string,
): Effect.Effect<void, ReleaseError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.asVoid(
    output(
      `${published.name} declarations`,
      "bunx",
      ["tsc", "-p", "tsconfig.build.json"],
      directory,
    ),
  );

/** Builds the packages in the order given, each package's two halves at once. */
export const buildPackages = (
  packages: ReadonlyArray<ReleasePackage>,
): Effect.Effect<
  void,
  ReleaseError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* workspaceRoot;
    for (const published of packages) {
      const directory = yield* packageDirectory(root, published);
      yield* fileSystem
        .remove(path.join(directory, "dist"), { recursive: true, force: true })
        .pipe(
          Effect.mapError(
            (error) =>
              new ReleaseError({ step: `${published.name} clean`, message: error.message }),
          ),
        );
      yield* Effect.all(
        [buildJavaScript(published, directory), emitDeclarations(published, directory)],
        { concurrency: "unbounded", discard: true },
      );
    }
  });
