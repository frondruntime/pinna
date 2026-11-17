/**
 * The release command line: building, the pack check, publishing to npm, and
 * the steps of the release workflow. `bun scripts/release.ts --help` lists
 * them; the root `package.json` names each one as a script.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Data, Effect, FileSystem, Runtime } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { buildPackages } from "./release/build.ts";
import { releasePullRequestBranch, updateLockfile } from "./release/github.ts";
import { packAndSmoke } from "./release/pack.ts";
import { packageKeys, selectPackages } from "./release/packages.ts";
import { ReleaseError } from "./release/process.ts";
import { publish } from "./release/publish.ts";

const build = Command.make(
  "build",
  {
    packages: Argument.String("package").pipe(
      Argument.variadic(),
      Argument.withDescription(`from ${packageKeys.join(", ")}; every package when none is named`),
    ),
  },
  ({ packages }) => Effect.flatMap(selectPackages(packages), buildPackages),
).pipe(
  Command.withDescription("Build the packages into each package's dist, in dependency order."),
);

const pack = Command.make(
  "pack",
  {
    keep: Flag.Boolean("keep").pipe(
      Flag.withDefault(false),
      Flag.withDescription("keep the work directory to look at, and print where it is"),
    ),
  },
  ({ keep }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const failure = (error: { readonly message: string }) =>
        new ReleaseError({ step: "work directory", message: error.message });
      if (keep) {
        const work = yield* fileSystem
          .makeTempDirectory({ prefix: "pinna-pack-" })
          .pipe(Effect.mapError(failure));
        yield* packAndSmoke(work);
        yield* Console.log(`kept ${work}`);
        return;
      }
      yield* Effect.scoped(
        Effect.flatMap(
          fileSystem
            .makeTempDirectoryScoped({ prefix: "pinna-pack-" })
            .pipe(Effect.mapError(failure)),
          packAndSmoke,
        ),
      );
    }),
).pipe(
  Command.withDescription(
    "Pack every package and install the tarballs into a project outside the workspace, then typecheck and run code against them. Publishes nothing.",
  ),
);

const publishCommand = Command.make(
  "publish",
  {
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDefault(false),
      Flag.withDescription("run every step, and pass --dry-run to npm publish"),
    ),
  },
  ({ dryRun }) => publish(dryRun),
).pipe(
  Command.withDescription(
    "Sign in to npm, check the registry, run the checks and the pack check, then publish the checked tarballs in dependency order.",
  ),
);

const releasePullRequest = Command.make(
  "release-pr-branch",
  {},
  () => releasePullRequestBranch,
).pipe(
  Command.withDescription(
    "In the release workflow: write release-please's pull request branch to GITHUB_OUTPUT as head_branch.",
  ),
);

const lockfile = Command.make(
  "lockfile",
  {
    branch: Flag.String("branch").pipe(Flag.withDescription("the branch to push the lockfile to")),
  },
  ({ branch }) => updateLockfile(branch),
).pipe(
  Command.withDescription(
    "In the release workflow: update bun.lock to the bumped versions and push it to the release branch.",
  ),
);

const release = Command.make("release").pipe(
  Command.withDescription("Build, check, and publish the Pinna packages."),
  Command.withSubcommands([build, pack, publishCommand, releasePullRequest, lockfile]),
);

/** A failed step prints its name and its message, not a stack, and exits with 1. */
const reportFailure = (error: ReleaseError) =>
  Console.error(`\n${error.step} failed: ${error.message}`).pipe(
    Effect.andThen(Effect.fail(new ReportedFailure())),
  );

/** A failure already printed; the runtime only sets the exit code. */
class ReportedFailure extends Data.TaggedError("ReportedFailure") {
  override readonly [Runtime.errorReported] = false;
}

Command.run(release, { version: "0.0.0" }).pipe(
  Effect.catchTag("ReleaseError", reportFailure),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
