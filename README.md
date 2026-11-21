# Pinna

Pinna is reactive state for applications: granular reads, granular updates,
cached derived values, and lifecycles driven by observation. A name that
starts with `$` is an observable, a box, a computed value, an atom, or a
collection, and everything else is plain data.

## Packages

| Package | For |
| --- | --- |
| `@frondruntime/pinna` | Boxes, computed values, keyed collections, updates, and watchers. A box checks nothing. No Effect. |
| `@frondruntime/pinna-effect` | Every name of `pinna`, plus boxes and collections that check each write against an Effect schema, models decoded from the wire, and Effect programs that react to state. `effect` is a peer dependency. |
| `@frondruntime/pinna-react` | Hooks that rerender a component when what it reads changes. |
| `@frondruntime/pinna-core` | The graph the other packages build on, with no runtime dependencies. For code that builds on the graph itself. |

## Install

```bash
bun add @frondruntime/pinna
```

With Effect Schema, where `pinna` and `effect` 4.1 or a later 4.x are peer
dependencies:

```bash
bun add @frondruntime/pinna @frondruntime/pinna-effect effect
```

With React, where `pinna` and React 19 or later are peer dependencies:

```bash
bun add @frondruntime/pinna @frondruntime/pinna-react
```

## Quick start

```tsx
import { Schema } from "effect";
import { computed, createRealm, schemaBox, update } from "@frondruntime/pinna-effect";
import { useValue } from "@frondruntime/pinna-react";

const realm = createRealm();
const $count = schemaBox(realm, Schema.Number, 0);
const $double = computed(realm, (read) => read($count) * 2);

const increment = () => {
  update(realm, (read, write) => {
    write($count, read($count) + 1);
  });
};

function Counter() {
  const double = useValue($double);
  return <button onClick={increment}>{double}</button>;
}
```

A call that makes an observable, opens an update, or starts a watcher takes
the realm first; a call about one observable, such as `useValue`, `observe`,
or `inspect`, takes the observable. A box is written only inside `update`,
which hands out `write`. Without Effect, import from `@frondruntime/pinna`
and drop the schema: `box(realm, 0)`. Asynchronous work whose writes must
not show until it succeeds stages them: `openStage`, `stageUpdate`, then
`applyStage` lands them in one update, or `dropStage` discards them; with
Effect, `withStage` does both.

## What it is for

Domain state: models, forms, lists loaded from a server, prices streamed into
existing rows, and totals derived from them. Every read is tracked, and a
`schemaBox` or a `BoxField` checks every write against its schema. That costs
a little on each operation, and it buys correctness, not speed.

Per-frame work fits when what changes each frame is domain state, such as a
chart of streamed prices or a canvas that draws rows. Trusted data written
that often takes a plain `box` or `Model`, which checks nothing;
`docs/performance.md`, "Four stores tuned to one reactive shape", measures
ticks of 50 updates over 10,000 rows on Hermes. A chart or canvas draws from
its own `requestAnimationFrame` loop: a watch sets a flag, and the loop reads
through `untracked` when the flag is set, so it draws at most once a frame.
Per-entity simulation state, such as particles or physics bodies, stays in
plain arrays and objects outside any box, and one `update` a frame writes
what the UI shows. A list that grows one item at a time adds many items in
one update, or is a collection of rows by key: every write to a box reruns
every reader of the box.

## Repository layout

| Path | Holds |
| --- | --- |
| `packages/pinna-core` | The graph, with no runtime dependencies. |
| `packages/pinna` | Boxes, computed values, updates, and the keyed collection, with no Effect; `AGENTS.md` there ships with the package. |
| `packages/pinna-effect` | Pinna on Effect Schema: `schemaBox`, `SchemaModel`, `decode`, and the Effect programs. |
| `packages/pinna-react` | The hooks and `RealmProvider`. |
| `packages/pinna-bench` | Speed and conformance against alien-signals, MobX, and Legend State on Node and Hermes. Private. |
| `apps/playground` | The demo app, and in `src/docs` the samples the site prints. |
| `apps/site` | The documentation site, built from `docs/public`. |
| `apps/desk` | A trading desk built on Pinna. |
| `apps/rn-bench` | A React Native app that measures Pinna against other stores on iOS. |
| `docs` | `public` the site's pages, `api.md` the decision record, `design.md` how it works, `performance.md` the measurements. |
| `scripts/release.ts` | The release command line: build, pack check, and publish. |

## Commands

| Command | Does |
| --- | --- |
| `bun install` | Installs the workspace. |
| `bun run check` | Runs `lint`, `typecheck`, and `test`: the gate for a change. |
| `bun run test` | Runs the tests of the packages, `apps/rn-bench`, and `apps/desk`. |
| `bun run typecheck` | Typechecks the packages and the apps, the site's samples among them. |
| `bun run lint`, `bun run format` | Checks, or formats, the workspace with Biome. |
| `bun run dev` | Starts the playground, `apps/playground`. |
| `bun run site` | Starts the documentation site, `apps/site`. |
| `bun run bench` | Measures Pinna, alien-signals, MobX, and Legend State on Node and Hermes, `packages/pinna-bench`; `bun run bench --help` lists its options. |
| `bun run build` | Writes each published package's `dist`: ES modules and a declaration file per source module. |
| `bun run verify:pack` | Packs the published packages, installs the tarballs into a project outside the workspace, typechecks it with `moduleResolution: "NodeNext"`, and runs it under Bun. Publishes nothing. |
| `bun run publish:npm` | Signs in to npm, asks the registry which packages are missing at their version, runs the checks and the pack check, and publishes the checked tarballs. |
| `bun run publish:npm:dry-run` | Runs every step of `publish:npm` and passes `--dry-run` to `npm publish`. |

Nothing in the workspace reads `dist`: the packages, apps, tests, and benches
resolve each other's `src` through the `source` export condition, so nothing
needs a build first. The older benchmarks stay in `packages/pinna`: the
diamond against Effect's Atom is `bun run --cwd packages/pinna bench`, the
graph alone `bench:graph`, and its Hermes form `bench:hermes-graph`. The
benchmarks that load Effect Schema run from `packages/pinna-effect`, so
`packages/pinna` does not depend on the package built on it, a cycle
release-please refuses: the data benchmark against MobX `bench:data`, its
Hermes form `bench:hermes`, `bench:blackbox` and `bench:hermes-blackbox`, and
`bench:stage`, which measures a stage against the update it replaces: a
refetch staged and replayed, and computed values read through a stage.

Publishing runs from a terminal only. CI tags a release through
release-please and publishes nothing.

## Documentation

- Site: <https://pinna.frondruntime.dev/docs/start>, from `docs/public`.
- `docs/design.md`: how the graph works and its limits.
- `docs/performance.md`: the measurements.
- `docs/api.md`: the settled choices behind the API, with the reason for each.

## Status

Pinna 0.0.1 is a release before 1.0: any release before 1.0 may change the
API, and none promises compatibility with the one before.
