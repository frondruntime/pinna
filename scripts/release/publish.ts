/**
 * Publishes the packages to npm from a terminal. Releases are tagged by
 * release-please in GitHub Actions, and published from here.
 *
 * Signing in comes first and the registry is asked second, so a session that
 * cannot publish, or a version that is already out, stops the release before
 * the minutes of checks rather than after them. Then the workspace checks,
 * then the pack check, and then the upload of the very tarballs the pack
 * check installed: `npm publish` run in a package directory would pack again,
 * and its pack keeps `workspace:` ranges that `bun pm pack` rewrites.
 *
 * Packages already on the registry at their version are skipped, so a
 * release that stopped halfway finishes when run again.
 */
import { Console, Effect, FileSystem, Path, Schema, Stdio } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { packAndSmoke, readJson } from "./pack.ts";
import {
  packageDirectory,
  type ReleasePackage,
  releasePackages,
  scope,
  workspaceRoot,
} from "./packages.ts";
import { attachedOrFail, finished, output, ReleaseError, section } from "./process.ts";

type Services =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Stdio.Stdio;

const Ranges = Schema.Record(Schema.String, Schema.String);

const PackageManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  private: Schema.optionalKey(Schema.Boolean),
  dependencies: Schema.optionalKey(Ranges),
  peerDependencies: Schema.optionalKey(Ranges),
});

type PackageManifest = typeof PackageManifest.Type;

/**
 * `npm whoami`, and `npm login` on this terminal when it fails. Publishing
 * runs from a terminal only, so a session without one stops here; a dry run
 * goes on signed out, and says so.
 */
const signIn = (root: string, dryRun: boolean): Effect.Effect<void, ReleaseError, Services> =>
  Effect.gen(function* () {
    yield* section("sign in");
    const stdio = yield* Stdio.Stdio;
    if (!dryRun && !(yield* stdio.stdinIsTerminal)) {
      return yield* new ReleaseError({
        step: "sign in",
        message: "npm login asks questions; run the publish from a terminal",
      });
    }
    const whoami = yield* finished("sign in", "npm", ["whoami"], root);
    if (whoami.exitCode === 0) {
      yield* Console.log(`signed in as ${whoami.stdout.trim()}`);
      return;
    }
    if (dryRun) {
      yield* Console.log("not signed in to npm; a dry run goes on without it");
      return;
    }
    yield* attachedOrFail("sign in", "npm", ["login"], root);
    const user = yield* output("sign in", "npm", ["whoami"], root);
    yield* Console.log(`signed in as ${user.trim()}`);
  });

const readManifests = (
  root: string,
): Effect.Effect<
  ReadonlyArray<readonly [ReleasePackage, PackageManifest]>,
  ReleaseError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.forEach(
    releasePackages.filter((released) => released.publishes),
    (published) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const directory = yield* packageDirectory(root, published);
        const manifest = yield* readJson(
          `manifest of ${published.name}`,
          PackageManifest,
          path.join(directory, "package.json"),
        );
        return [published, manifest] as const;
      }),
  );

/** The packages packed for a release candidate and never sent to npm. */
const unpublishedNames = new Set(
  releasePackages.filter((released) => !released.publishes).map((released) => released.name),
);

/**
 * The packages are released together at one version, and each names the
 * others at exactly that version, so an install of any of them gets the set
 * it was tested with.
 */
const checkManifests = (
  manifests: ReadonlyArray<readonly [ReleasePackage, PackageManifest]>,
): Effect.Effect<string, ReleaseError> => {
  const [first] = manifests;
  const version = first?.[1].version ?? "";
  const problems = manifests.flatMap(([published, manifest]) => {
    const ranges = Object.entries({ ...manifest.dependencies, ...manifest.peerDependencies });
    return [
      manifest.name === published.name ? [] : [`${published.key} is named ${manifest.name}`],
      manifest.private === true ? [`${manifest.name} is private`] : [],
      manifest.version === version
        ? []
        : [`${manifest.name} is at ${manifest.version}, ${first?.[1].name} at ${version}`],
      // npm would install a published package without the private one it names.
      ranges
        .filter(([name]) => unpublishedNames.has(name))
        .map(([name]) => `${manifest.name} names ${name}, which is not published`),
      ranges
        .filter(([, range]) => range.startsWith("workspace:"))
        .map(([name]) => `${manifest.name} names ${name} with a workspace: range`),
      ranges
        .filter(([name, range]) => name.startsWith(scope) && range !== version)
        .map(([name, range]) => `${manifest.name} names ${name} at ${range}, not ${version}`),
    ].flat();
  });
  return problems.length === 0
    ? Effect.succeed(version)
    : Effect.fail(new ReleaseError({ step: "manifests", message: problems.join("\n") }));
};

/**
 * Whether `name@version` is on the registry. `npm view` prints nothing for a
 * missing version of a package that exists, and fails with E404 for a
 * package that does not.
 */
const isPublished = (
  root: string,
  name: string,
  version: string,
): Effect.Effect<boolean, ReleaseError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const step = `registry ${name}@${version}`;
    const result = yield* finished(step, "npm", ["view", `${name}@${version}`, "version"], root);
    if (result.exitCode === 0) {
      return result.stdout.trim() === version;
    }
    if (result.stderr.includes("E404")) {
      return false;
    }
    return yield* new ReleaseError({ step, message: result.stderr.trim() });
  });

/** The published files come from `packages`, so a change there must be committed first. */
const checkCleanPackages = (
  root: string,
  dryRun: boolean,
): Effect.Effect<void, ReleaseError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const status = yield* output(
      "clean packages",
      "git",
      ["status", "--porcelain", "--", "packages"],
      root,
    );
    if (status.trim() === "") {
      return;
    }
    const message = `packages has uncommitted changes:\n${status.trimEnd()}`;
    if (dryRun) {
      yield* Console.log(`${message}\na publish would stop here`);
      return;
    }
    return yield* new ReleaseError({ step: "clean packages", message });
  });

export const publish = (dryRun: boolean): Effect.Effect<void, ReleaseError, Services> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* workspaceRoot;

    yield* signIn(root, dryRun);

    yield* section("registry");
    const manifests = yield* readManifests(root);
    const version = yield* checkManifests(manifests);
    const pending: Array<ReleasePackage> = [];
    for (const [published] of manifests) {
      if (yield* isPublished(root, published.name, version)) {
        yield* Console.log(`${published.name}@${version} is already published; skipped`);
      } else {
        pending.push(published);
      }
    }
    if (pending.length === 0) {
      return yield* new ReleaseError({
        step: "registry",
        message: `every package is already published at ${version}`,
      });
    }
    yield* Console.log(
      `to publish at ${version}: ${pending.map((published) => published.name).join(", ")}`,
    );
    yield* checkCleanPackages(root, dryRun);

    yield* section("checks");
    for (const [step, args] of [
      ["install", ["install", "--frozen-lockfile"]],
      ["lint", ["run", "lint"]],
      ["typecheck", ["run", "typecheck"]],
      ["test", ["run", "test"]],
    ] as const) {
      yield* attachedOrFail(step, "bun", args, root);
    }

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* section("pack");
        const work = yield* fileSystem
          .makeTempDirectoryScoped({ prefix: "pinna-publish-" })
          .pipe(
            Effect.mapError(
              (error) => new ReleaseError({ step: "work directory", message: error.message }),
            ),
          );
        const tarballs = yield* packAndSmoke(work);

        yield* section(dryRun ? "publish, dry run" : "publish");
        for (const [published, tarball] of tarballs) {
          if (!pending.includes(published)) {
            continue;
          }
          yield* attachedOrFail(
            `publish ${published.name}`,
            "npm",
            ["publish", tarball, "--access", "public", ...(dryRun ? ["--dry-run"] : [])],
            root,
          );
        }
      }),
    );

    yield* Console.log(
      dryRun
        ? `\ndry run done; nothing was published`
        : `\npublished ${pending.map((published) => `${published.name}@${version}`).join(", ")}`,
    );
  });
