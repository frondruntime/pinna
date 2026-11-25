# The contract and the internals

The tests fall in two buckets. The contract bucket is what a rewrite of the
core must pass unchanged; the internals bucket tests how the current core
does it, and a rewrite may replace it. Nothing is deleted to make the split:
a behaviour a user sees that an internals test covers has a public twin in
the contract bucket, and the internals test stays.

- **Contract.** Every test file in `packages/pinna/test`,
  `packages/pinna-effect/test`, and `packages/pinna-react/test`, outside a
  `test/internal/` folder. These import only the package's public entries
  (`src/index.ts`, `src/testing`) and test helpers that do the same.
  `test/contract.test.ts` fails on a contract test that imports
  `@frondruntime/pinna-core`, `src/internal`, or any other `src` file. Two
  helpers bridge to internals, and only for `openParts`: `test/rest.ts` in
  `pinna` and in `pinna-effect`, whose `expectRealmAtRest` checks that a
  realm has nothing left open.
- **Internals.** `packages/pinna-core/test`, every `test/internal/` folder,
  the fuzz tooling in `packages/pinna/test/fuzz`, the benches in
  `packages/pinna/bench` (`bun run bench:memory` checks that memory per
  node stays linear), and `packages/pinna-bench`. These may import anything.

`bun run test` runs both buckets.

## Where each behaviour is tested

| Behaviour | Contract | Internals |
|---|---|---|
| A write reaches its readers: diamonds, equality cutoff, nested updates | `propagation`, `observable`, `verbs`, `reads` | `pinna-core/test/core`, `reads` |
| Watches and autoruns: order, rounds, the round limit, stops during a flush | `propagation`, `linking`, `autorun`, `scheduled` | `pinna-core/test/core`, `internal/scheduled` |
| Linking and unlinking: observer counts, dropped sources, reads twice | `linking`, `settle`, `reads`, `inspect` | `pinna-core/test/core`, `internal/links-first` |
| `Source.onObserved` hooks: start and stop order, hooks that write, throw, or stop a reader | `propagation`, `linking`, `settle`, `observation`, `flush` | `pinna-core/test/core`, `graph`, `internal/links-first` |
| A read outside an update settles once it is over; `equals` is part of a compute | `settle` | `internal/links-first` |
| A write back within one update, and rollback | `write-back`, `observable`, `autorun` | `pinna-core/test/core` ("restore") |
| Computed values over an atom | `write-back`, `settle`, `autorun` | `pinna-core/test/core`, `internal/links-first` |
| Cycles | `cycles`, `settle` | `pinna-core/test/cycles` |
| Chains 10,000 deep: read, write, stop, dispose, rollback | `depth` | `pinna-core/test/depth` |
| Errors: kept errors, non-Error throws, `onError`, teardown errors, usage errors | `errors`, `usage-errors`, `flush`, `linking` | `internal/errors`, `pinna-core/test/core` |
| A computed value that writes, observes, or stops a reader | `linking`, `settle`, `usage-errors` | `pinna-core/test/core`, `internal/links-first` |
| Two realms, and two loaded copies of pinna | `flush`, `two-copies` | `pinna-core/test/graph` |
| Realm disposal | `dispose`, `errors` | |
| Collections, row listeners, reconcile, prototype-named keys | `collection`, `row-change`, `reconcile` | |
| Stages | `stage*` | `internal/stage`, `internal/stage-reads`, `internal/stage-replay` |
| Visible stages: the window, the stack, stopping, collections and views under a guess, `Stage.scoped`'s `visible` and `guess`; a differential fuzz against hidden stages | `stage-visible`, `stage-visible-rows`, `stage-visible-fuzz`, `pinna-effect/test/stage-visible` | `internal/stage-visible` (`baseOf`) |
| `Computed.fn` | `computed-function`, `settle` | |
| Views: order, groups, totals, work per row write, random-write oracles calibrated against planted bugs | `view` | |
| Snapshot and restore: shapes, isolation, one rerun per restore, prototype-named keys | `snapshot`, `pinna-effect/test/snapshot` | |
| `Computed.fromPromise` | `from-promise` | |
| `pinna/testing` | `testing` | |
| The exact export list | `exports` in each package, `pinna-effect/test/entries` | |
| Schema boxes, `Model`, decode, Effect programs | `pinna-effect/test/*` | `pinna-effect/test/internal/box`, `equality` |
| React hooks: render and commit, leaks, Strict Mode | `pinna-react/test/*` (`render-commit` twins the core's pending-run cases) | `pinna-core/test/graph` (`trackPending`, `adopt`) |
| A write during a React render, as it behaves today (open question) | | `pinna-react/test/internal/render-write` |
| Behaviour against MobX and the shared reactive suite | `conformance/*` | |
| Random programs against an oracle | `fuzz` | `test/fuzz/*` |

## Core cases with no public twin

A core test whose primitive has no public form stays in the internals bucket
alone. Each twin file's header names the ones it leaves out.

- `beginBatch` and `endBatch` without a matching call: `Realm.update` always
  pairs them.
- A `Reaction` activated apart from its track: a cleanup that reactivates it,
  a reaction told of a change and not tracked again, an activate that throws
  after a link. An autorun always tracks and links in one call.
- `onObservedNow`, a hook that begins inside a compute: the public
  `Source.onObserved` waits for the read to end.
- `forgetValue` on a computed value: collections use it for released rows,
  which `retainedKeys` covers.
- Exact restart and edge-walk counts: no public probe.
