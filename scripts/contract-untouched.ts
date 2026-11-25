/**
 * Fails when this branch edits, renames, or deletes a contract test relative
 * to a base, `origin/next` unless one is named:
 *
 *   bun scripts/contract-untouched.ts [base]
 *
 * The contract bucket is `packages/pinna/test/CONTRACT.md`'s: every file
 * under `test` in `pinna`, `pinna-effect`, and `pinna-react`, outside a
 * `test/internal` folder and `pinna`'s fuzz tooling in `test/fuzz`. Adding a
 * contract test is allowed; editing one means behavior changed, which is a
 * question for the owner, not part of a rewrite. Compares the working tree,
 * uncommitted changes included, with the merge base of the base and `HEAD`.
 */

const base = process.argv[2] ?? "origin/next";

const git = (...args: ReadonlyArray<string>): string => {
  const result = Bun.spawnSync(["git", ...args], { stderr: "pipe" });
  if (result.exitCode !== 0) {
    console.error(`contract-untouched: git ${args.join(" ")} failed\n${result.stderr.toString()}`);
    process.exit(2);
  }
  return result.stdout.toString().trim();
};

const contractPackages = ["pinna", "pinna-effect", "pinna-react"];

/** Whether `path`, relative to the repository root, is a contract test or helper. */
const isContract = (path: string): boolean => {
  const match = /^packages\/([^/]+)\/test\/(.*)$/.exec(path);
  if (match === null || !contractPackages.includes(match[1] as string)) {
    return false;
  }
  const inside = match[2] as string;
  if (inside.startsWith("internal/") || inside.includes("/internal/")) {
    return false;
  }
  return !(match[1] === "pinna" && inside.startsWith("fuzz/"));
};

const mergeBase = git("merge-base", base, "HEAD");
const changes = git("diff", "--name-status", "--find-renames", mergeBase)
  .split("\n")
  .filter((line) => line !== "")
  .map((line) => line.split("\t"));
// Untracked files are additions, which are allowed.

const offending: Array<string> = [];
for (const [status, ...paths] of changes) {
  if (status === "A") {
    continue;
  }
  const touched = paths.filter(isContract);
  if (touched.length > 0) {
    offending.push(`${status} ${paths.join(" -> ")}`);
  }
}

if (offending.length > 0) {
  console.error(
    `contract-untouched: ${offending.length} contract test file(s) changed since ${base} (${mergeBase.slice(0, 7)}):`,
  );
  for (const line of offending) {
    console.error(`  ${line}`);
  }
  process.exit(1);
}
console.log(
  `contract-untouched: no contract test changed since ${base} (${mergeBase.slice(0, 7)}); ${changes.length} file(s) changed in all`,
);
