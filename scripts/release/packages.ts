/**
 * The release's packages, in dependency order: what the build compiles, what
 * the pack check expects in each tarball, and the order publishing follows.
 * One list, so the three cannot disagree. Every package is built and packed;
 * only those with `publishes` go to npm.
 */
import { Effect, Path } from "effect";
import { ReleaseError } from "./process.ts";

export interface ReleasePackage {
  /** The directory under `packages`, and the name the command line takes. */
  readonly key: string;
  readonly name: string;
  /** Each entry's module under `src`, without the extension. */
  readonly entries: ReadonlyArray<string>;
  /** The entries' source extension: `.tsx` for a package written in JSX. */
  readonly extension: ".ts" | ".tsx";
  /** Paths the tarball holds, relative to the package. */
  readonly expectedFiles: ReadonlyArray<string>;
  /**
   * Whether `publish` sends it to npm. A package that does not keeps
   * `"private": true` in its manifest and is packed for a release candidate
   * alone (ruling 71, "What ships"; decision B7 of ruling 71 of `docs/api.md`).
   */
  readonly publishes: boolean;
}

export const scope = "@frondruntime/";

/** Each entry's module, as a source and as what the build makes of it. */
const entryFiles = (
  entries: ReadonlyArray<string>,
  extension: ReleasePackage["extension"],
): ReadonlyArray<string> =>
  entries.flatMap((entry) => [
    `src/${entry}${extension}`,
    `dist/${entry}.js`,
    `dist/${entry}.d.ts`,
  ]);

const releasePackage = (
  key: string,
  publishes: boolean,
  entries: ReadonlyArray<string>,
  extraFiles: ReadonlyArray<string> = [],
  extension: ReleasePackage["extension"] = ".ts",
): ReleasePackage => ({
  key,
  name: `${scope}${key}`,
  entries,
  extension,
  publishes,
  expectedFiles: [
    "package.json",
    "LICENSE",
    "README.md",
    ...entryFiles(entries, extension),
    ...extraFiles,
  ],
});

/**
 * In dependency order: a package comes after every package it depends on, so
 * an install made while a release is half published never asks the registry
 * for a version that is not there yet.
 */
export const releasePackages: ReadonlyArray<ReleasePackage> = [
  releasePackage("pinna-core", true, ["index"]),
  releasePackage("pinna", true, ["index", "internal/index", "testing/index"], ["AGENTS.md"]),
  releasePackage("pinna-effect", true, ["index"]),
  releasePackage("pinna-react", true, ["index"]),
];

export const packageKeys = releasePackages.map((published) => published.key);

/**
 * The workspace root, two directories above this file, so every command
 * finds it whatever directory it starts in: a package's `build` script runs
 * in the package.
 */
export const workspaceRoot: Effect.Effect<string, ReleaseError, Path.Path> = Effect.gen(
  function* () {
    const path = yield* Path.Path;
    return yield* path.fromFileUrl(new URL("../..", import.meta.url));
  },
).pipe(
  Effect.map((root) => root.replace(/\/$/, "")),
  Effect.mapError((error) => new ReleaseError({ step: "workspace root", message: String(error) })),
);

/** A package's directory. */
export const packageDirectory = (
  root: string,
  published: ReleasePackage,
): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(root, "packages", published.key);
  });

/** The packages the names select, in dependency order; every package when none is named. */
export const selectPackages = (
  names: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<ReleasePackage>, ReleaseError> => {
  const unknown = names.filter((name) => !packageKeys.includes(name));
  if (unknown.length > 0) {
    return Effect.fail(
      new ReleaseError({
        step: "packages",
        message: `unknown packages: ${unknown.join(", ")}; known: ${packageKeys.join(", ")}`,
      }),
    );
  }
  return Effect.succeed(
    names.length === 0
      ? releasePackages
      : releasePackages.filter((published) => names.includes(published.key)),
  );
};
