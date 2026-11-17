# AGENTS

Pinna is glitch-free reactive state, with Effect Schema classes for checked
data, meant to replace MobX for applications, and later for Frond. Its first
release is 0.0.1, before 1.0, so its API may still change. It is not tied to
Frond and imports nothing from it.

- `README.md`: what it is, the packages, and the commands. The API is on
  the site, whose source is `docs/public`.
- `docs/public`: the site's pages, the API reference and guides. Their
  samples are regions of `apps/playground/src/docs`.
- `docs/api.md`: the decision record, the settled choices and the numbered
  rulings behind the API, with the reason for each.
- `docs/design.md`: how it works, its limits, benchmarks, open questions.
- `docs/performance.md`: where performance work goes next (Effect out of
  the core, alien-signals as the target, Hermes first), and the numbers
  behind it.
- `packages/pinna-core`: the graph, with no runtime dependencies.
- `packages/pinna`: the functions on boxes without a schema, with no
  Effect. `src/observable.ts` the realm, boxes, computed values, and
  updates, `src/collection.ts` the keyed collection, `src/internal` what
  sibling packages use, `src/testing` the testing entry (`record`,
  `held`, `testRealm`, `retainedKeys`).
- `packages/pinna/AGENTS.md`: the rules for agents writing applications on
  Pinna, shipped with the package.
- `packages/pinna-effect`: Pinna on Effect Schema. `src/box.ts` `schemaBox`,
  a box that checks a schema, `src/class.ts` `SchemaModel`, `BoxField`, and
  `CollectionField`, `src/reconcile.ts` `reconcileSchema`, `src/decode.ts`
  `decode` and `RealmService`, `src/programs.ts` the Effect programs
  (`watchScoped`, `changes`, `observeScoped`, `fromStream`,
  `whileObserved`).
- `packages/pinna-react`: `useValue`, `useValues`, `useSelect`, `useRealm`,
  and `RealmProvider`.
- `packages/pinna-bench`: speed and conformance of Pinna against
  alien-signals, MobX, and Legend State on Node and Hermes;
  `bun run bench --help`. `src/cli.ts` the command line, `src/workers` what
  each runtime runs, `src/scenarios.ts` the speed scenarios,
  `test/conformance` the conformance cases. Private, never published.
- `apps/playground`: the demo app, `bun run dev`, and in `src/docs` the
  samples the site prints.
- `apps/site`: the site, built from `docs/public`, `bun run site`.
- `apps/desk`: a trading desk built on Pinna; `FINDINGS.md` records the
  friction met while building it.
- `design/brief.md`: the site's design brief, where it departs from the Frond
  family's look (the `frond-look` skill) and why.
- `apps/rn-bench`: a React Native app that measures Pinna against MobX on
  iOS; `bun run --cwd apps/rn-bench ios`, then `bench`
  (`docs/performance.md`, "A React Native app against MobX").
- `scripts/release.ts`: the release command line, on Effect's CLI;
  `bun scripts/release.ts --help`. `build` writes the published packages'
  `dist` (`bun run build`), `pack` checks the tarballs in a project outside
  the workspace (`bun run verify:pack`), and `publish` signs in to npm, then
  checks and publishes (`bun run publish:npm`). Its steps live in
  `scripts/release`. Inside the workspace everything reads `src` through the
  `source` export condition, so nothing needs a build first.
- `.github/workflows`: `ci.yml` runs the checks, the build, and the pack
  check; `release.yml` runs release-please and keeps its pull request's
  `bun.lock` current. Publishing is local only: nothing in CI publishes.

## Rules

1. Never push, create a remote, or publish unless the user asks for that exact
   action. Commit locally and stop.
2. Bun only. Run only scripts that exist in `package.json`. The bench command
   line may start `node` and Hermes, as runtimes it measures, not as tools.
   The release command line runs `npm` for the registry alone: signing in,
   asking for a version, and publishing.
3. Conventional Commits: `type(scope): subject`. Stage files by path.
4. `packages/pinna-core` imports nothing at runtime. In `src`, `packages/pinna`
   and `packages/pinna-react` import nothing from `effect`; only
   `packages/pinna-effect` does. Tests and benches may, but in
   `packages/pinna-bench` only the command line does: the workers it bundles
   measure the libraries alone, and a test checks it.
5. American English; no abbreviated names.
6. Frond vocabulary (node, driver, lane, commit, facade) stays out of this
   repository. Frond layers on top of Pinna, not the other way around.
   A node of pinna-core's dependency graph is the graph's own term, not
   Frond's, and stays.
7. No API is added until a use needs it.
8. Pinna is for domain state, not per-frame work such as games, drawing, or
   animation (`README.md`, "What it is for"). Do not weaken a schema box's
   check or its tracking for speed. Trusted data that is written often takes
   a plain `box` or `Model`, which checks nothing; per-frame work opts out
   with plain code and writes once.
9. Every code sample shows the imports it uses. A sample is a region of a file
   that `bun run typecheck` compiles; the site prints the region's imports
   above it through `apps/site/src/lib/sampleImports.ts`, so write them once,
   at the top of that file.
10. Documentation follows the `documentation-voice` skill: the pages under
    `docs/public` take its reference register, and a page that explains why
    takes its explanation register.
