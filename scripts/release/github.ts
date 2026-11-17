/**
 * The steps of the release workflow that are more than a call to an action:
 * reading release-please's pull request, and keeping that pull request's
 * `bun.lock` in step with the versions it bumps.
 */
import { Config, Console, Effect, FileSystem, Option, type Path, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { workspaceRoot } from "./packages.ts";
import { output, ReleaseError } from "./process.ts";

const ReleasePullRequests = Schema.Array(Schema.Struct({ headBranchName: Schema.String }));

const required = (name: string): Effect.Effect<string, ReleaseError> =>
  Config.String(name).pipe(
    Effect.mapError(
      (error) => new ReleaseError({ step: "environment", message: `${name}: ${String(error)}` }),
    ),
  );

/** These steps commit and push, which only a workflow does. */
const requireGitHubActions: Effect.Effect<void, ReleaseError> = Config.option(
  Config.String("GITHUB_ACTIONS"),
).pipe(
  Effect.mapError((error) => new ReleaseError({ step: "environment", message: String(error) })),
  Effect.flatMap((value) =>
    Option.isSome(value)
      ? Effect.void
      : Effect.fail(
          new ReleaseError({
            step: "environment",
            message: "this step runs in GitHub Actions only",
          }),
        ),
  ),
);

/**
 * Reads release-please's `prs` output from `RELEASE_PLEASE_PRS` and appends
 * `head_branch=<branch>` to the step's `GITHUB_OUTPUT`. The packages release
 * together, so there is exactly one pull request.
 */
export const releasePullRequestBranch: Effect.Effect<void, ReleaseError, FileSystem.FileSystem> =
  Effect.gen(function* () {
    yield* requireGitHubActions;
    const fileSystem = yield* FileSystem.FileSystem;
    const text = yield* required("RELEASE_PLEASE_PRS");
    const outputFile = yield* required("GITHUB_OUTPUT");
    const pullRequests = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(ReleasePullRequests),
    )(text).pipe(
      Effect.mapError(
        (error) => new ReleaseError({ step: "release pull request", message: error.message }),
      ),
    );
    const [pullRequest] = pullRequests;
    if (pullRequests.length !== 1 || pullRequest === undefined) {
      return yield* new ReleaseError({
        step: "release pull request",
        message: `expected one release pull request, found ${pullRequests.length}`,
      });
    }
    yield* fileSystem
      .writeFileString(outputFile, `head_branch=${pullRequest.headBranchName}\n`, { flag: "a" })
      .pipe(
        Effect.mapError(
          (error) => new ReleaseError({ step: "release pull request", message: error.message }),
        ),
      );
    yield* Console.log(`release pull request branch: ${pullRequest.headBranchName}`);
  });

/**
 * Installs, so `bun.lock` takes the versions release-please wrote into the
 * manifests, and commits and pushes the lockfile to `branch` when it moved.
 * Without it the release pull request fails CI's frozen install.
 */
export const updateLockfile = (
  branch: string,
): Effect.Effect<void, ReleaseError, ChildProcessSpawner.ChildProcessSpawner | Path.Path> =>
  Effect.gen(function* () {
    yield* requireGitHubActions;
    const root = yield* workspaceRoot;
    const git = (step: string, args: ReadonlyArray<string>) => output(step, "git", args, root);
    yield* output("install", "bun", ["install"], root);
    const status = yield* git("lockfile status", ["status", "--porcelain", "--", "bun.lock"]);
    if (status.trim() === "") {
      yield* Console.log("bun.lock is current");
      return;
    }
    yield* git("author", ["config", "user.name", "github-actions[bot]"]);
    yield* git("author email", [
      "config",
      "user.email",
      "41898282+github-actions[bot]@users.noreply.github.com",
    ]);
    yield* git("stage", ["add", "bun.lock"]);
    yield* git("commit", ["commit", "-m", "chore: update Bun lockfile for release"]);
    yield* git("push", ["push", "origin", `HEAD:${branch}`]);
  });
