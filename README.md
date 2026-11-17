# Pinna

Pinna is reactive state for applications: granular reads, granular updates,
cached derived values, and lifecycles driven by observation. A name that
starts with `$` is an observable, a box, a computed value, an atom, or a
collection, and everything else is plain data.

Pinna 0.0.1 is a release before 1.0: any release before 1.0 may change the
API, and none promises compatibility with the one before.

The documentation is at <https://pinna.frondruntime.dev/docs/start>, and
`docs/public` is its source.

## Packages

| Package | For |
| --- | --- |
| `@frondruntime/pinna` | Boxes, computed values, keyed collections, updates, and watchers. A box checks nothing. No Effect. |
| `@frondruntime/pinna-effect` | Every name of `pinna`, plus boxes and collections that check each write against an Effect schema, models decoded from the wire, and Effect programs that react to state. `effect` is a peer dependency. |
| `@frondruntime/pinna-react` | Hooks that rerender a component when what it reads changes. |

## Example

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

Every call takes the realm first. A box is written only inside `update`,
which hands out `write`. Without Effect, import from `@frondruntime/pinna`
and drop the schema: `box(realm, 0)`.

## What it is for

Domain state: models, forms, lists loaded from a server, prices streamed into
existing rows, and totals derived from them. Every read is tracked, and a
`schemaBox` or a `BoxField` checks every write against its schema. That costs
a little on each operation, and it buys correctness, not speed.

It is not for per-frame work: a game loop, canvas or WebGL drawing,
animation, physics. Code on a hot path opts out. It computes with plain arrays
and objects outside any box, then writes the result once, in one `update`. A
list that grows one item at a time adds many items in one update, or is a
collection of rows by key: every write to a box reruns every reader of the
box.

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
data benchmark against MobX `bench:data`, the graph alone `bench:graph`, and
their Hermes forms `bench:hermes` and `bench:hermes-graph`.

Publishing runs from a terminal only. CI tags a release through
release-please and publishes nothing.

`docs/design.md` describes how the graph works and its limits, and
`docs/performance.md` holds the measurements.
