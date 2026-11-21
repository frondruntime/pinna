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
- `apps/desk`: a trading desk built on Pinna.
- `design/brief.md`: the site's design brief, where it departs from the Frond
  family's look (`frond-look`, the family's house style, which is not
  published) and why.
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

## How to read these rules

The owner decides. An instruction from the owner overrides every default on
this page, and a feature the owner asks for is needed: do not ask for a use
case, require proof, or argue scope. Each rule below states what it protects;
apply that purpose, not the wording. Where the wording and the purpose
disagree, follow the purpose and say so in one line. Raise a conflict with a
rule or a settled decision once, with the evidence, then do what was asked.

Rules marked **hard** protect something that breaks for users or cannot be
taken back. Bend one only on the owner's explicit word for that case.

## Rules

1. **Nothing leaves the machine unasked.** (hard) Pushing, opening a pull
   request, creating a remote, and publishing are visible to others, and a
   published version cannot be taken back. Commit locally and stop unless
   the owner asks. An ask for a pull request includes pushing its branch.
   Publishing to npm happens only when the owner asks for that publish
   (`bun run publish:npm`); nothing in CI publishes.
2. **Bun is the toolchain.** The workspace resolves through `bun.lock` and
   reads `src` through the `source` export condition, which npm, pnpm, Yarn,
   and Node do not reproduce. Do not add another package manager's lockfile
   or a Node-only tool. Report checks through the `package.json` scripts
   (`bun run check`, or the part that applies), so the owner reruns exactly
   what was reported; any other command whose result a commit or pull request
   relies on is named in it. The bench command line starts `node` and Hermes
   as runtimes it measures, and the release command line runs `npm` for the
   registry alone.
3. **Conventional Commits, staged by path.** release-please reads the commit
   type to choose the next version and write the changelog, so the type is
   what the change does: `feat`, `fix`, `docs`, `perf`, `refactor`, `test`,
   `build`, `ci`, `chore`, with the package as the scope. Stage files by
   path, so a stray file never rides along.
4. **Each package imports only what it promises.** (hard) `pinna-core` has no
   runtime dependency, so it can be ported. `pinna` and `pinna-react` import
   nothing from `effect` in `src`, so an application without Effect pays
   nothing for it; only `pinna-effect` does. In `pinna-bench`, only the
   command line imports Effect, because the workers it bundles measure the
   libraries alone. Tests and benches elsewhere may import anything.
   `packages/pinna-effect/test/entries.test.ts` and
   `packages/pinna-bench/test/bundle.test.ts` check this.
5. **Names are whole words, in American English.** A reader, person or
   agent, looks a name up once: `options`, not `opts`; `previous`, not
   `prev`; `color`, not `colour`.
6. **Pinna does not know Frond.** Frond is built on Pinna, never the reverse,
   so Pinna's API and docs make sense without it. Frond's terms (node,
   driver, lane, commit, facade) stay out of names and docs, where they
   would carry Frond's meaning into Pinna's: a stage is applied, not
   committed. A node of `pinna-core`'s dependency graph is the graph's own
   term and stays.
7. **No speculative API; what is asked for is built complete.** Do not add
   what nobody asked for: a helper for one call site, an option for an
   imagined caller, a second way to do one thing. A small surface is what
   keeps the library learnable. What the owner asks for is built to "Done"
   below, and its companions (lifecycle, errors, inspection, the Effect form,
   tests, docs) are part of it, not additions that need a reason.
8. **A schema box's check and its tracking are not traded for speed.**
   (hard) A `schemaBox` or `BoxField` holds a value its schema accepts, and
   every read is tracked; that is what Pinna sells. Make the checked path
   faster, or point data that needs no check at a plain `box` or `Model`.
   What Pinna is for, and what stays in plain code, is in `README.md`, "What
   it is for".
9. **Code in the docs compiles.** Every sample is a region of a file under
   `apps/playground/src/docs` that `bun run typecheck` compiles, and the site
   prints the region's imports above it (`apps/site/src/lib/sampleImports.ts`),
   so a sample never drifts from the API and always shows its imports. Write
   the imports once, at the top of the file; `sync-docs` fails on a region
   that does not exist.
10. **Docs are exact, because agents act on them literally.** A person
    reviews what an agent did from them, so the house style is:
    - The conclusion first, in a paragraph and in a rule; each rule with its
      reason or what breaks without it.
    - Name the call, the error, or the number. A sentence that names nothing
      checkable says nothing an agent can act on.
    - One term per concept, the same on every page.
    - No hedges ("generally", "should usually") and no filler ("simply",
      "just", "it is worth noting", a sentence announcing the next one).
    - Impersonal: no "you", "we", or "I"; the subject of a sentence is the
      thing. An imperative is fine for a rule.
    - A rewrite keeps every fact, and a reason it adds is checked against the
      code first.
    - `docs/public` is reference: short, impersonal, each rule with its
      reason. A page that explains why, such as `docs/design.md`, opens on
      the claim, names the mechanism, states the cost, and ends on the
      decision.
11. **Settled decisions stay settled until the owner reopens them.** A plan's
    settled points and the rulings in `docs/api.md` are not relitigated
    during a build. An agent that finds one wrong says so once, with the
    evidence, and builds as settled unless the owner changes it. An open
    choice the owner left unanswered takes the complete option, not the
    smallest one.

## Done

A feature is done when it is complete, not when it is the smallest thing that
passes:

- The calls in `pinna`; the Effect form in `pinna-effect` (a combinator or a
  scoped form, tagged errors, and no service requirement the feature does not
  need); a hook in `pinna-react` when it has state a UI shows.
- Every read and write the rest of the API supports works through it, or
  throws a message naming the limit, and the docs list each limit with its
  reason.
- Its lifecycle is defined: its state can be asked, closing twice is
  defined, and a release a cleanup calls is idempotent.
- Every message it throws is in `docs/public/reference/errors.md`; `inspect`
  and `testRealm` cover it.
- Tests cover it alone and against nested updates, autoruns, derivations,
  other realms, and schema boxes.
- A ruling in `docs/api.md`, a section in `docs/design.md`, the reference in
  `docs/public`, and the rules in `packages/pinna/AGENTS.md`.
- `bun run check` passes, and the hot paths (`update`, `read`, `write`) are
  unchanged or the bench is attached.
