# Pinna decisions

What the owner decided about Pinna's API, and why. The API as it stands is on
the site, whose source is `docs/public`; this page holds the reasons. Ruling
numbers are stable, because tests, `design.md`, and `performance.md` cite
them: a replaced ruling keeps its number and names what replaced it. Each
ruling carries the date it was first written down, and uses today's names.

## Settled

- A realm per instance, with no module state. Every observable keeps the
  realm that made it, and batches, tracking, pending watchers, and errors
  belong to one realm. Module state is shared by everything that imports
  the module, so tests, server rendering, and two hosts in one page could
  not be isolated. There is no default realm.
- Each realm makes its own `read` and `write`, and each throws for an
  observable of another realm. One module-level pair could not tell which
  realm called it, so a derived value of one realm read another realm's box
  untracked, and went stale.
- Pinna keeps its own graph. alien-signals and MobX are test references,
  not dependencies.
- Effect is pinned exactly, at the version the host applications use: 4.1.0.
- Observability is explicit: `$` names, and `read($x)` with the `read` a
  place hands out. Plain reads of live objects were rejected, and so were
  methods on an observable: a method can be called anywhere, a handed-out
  `read` only while a place is open.
- `update` is the one write scope, with no marked actions, and it is atomic:
  a recipe that throws is rolled back.
- A write to a schema box is checked against the schema where it lands.
- A read outside a place does not type-check, and a `read` kept past its
  place throws, so no lint rule is needed for reads in render.
- Hooks settle after links, never in the middle of linking (ruling 28).
- One behavior in every build: no development mode, no freezing.
- React reads state through hooks only: no `observer`, and no components in
  the style of `Memo`, `Show`, `For`, or `Reactive`. An `observer` wrapper
  or hook-free tracking needs React internals or hides the subscription
  from the React Compiler.
- No hook of Pinna's own takes part in transitions (2026-11-15): one would
  let two components of a render see different values. A slow render after
  a write takes `useDeferredValue`.
- No speculative API, and what is asked for is built complete (ruling 55,
  `AGENTS.md` rule 7 and "Done"). What each part was asked for: isolated tests and
  server rendering for the realm; a live list of thousands of priced rows,
  refetched without losing row identity, for the keyed collection and
  `reconcile`; derived values that take arguments, MobX's `computedFn`, for
  `computedFunction`; a service that reacts to state as a stream for the
  Effect programs; view-only logic and components that read several values
  for `useSelect` and `useValues`; finding why a value recomputed for
  `inspect`; Frond's asynchronous programs over a realm, for stages.

## Rulings

1. **Realm, not graph** (2026-11-02). The public name is realm; the
   dependency graph in `packages/pinna-core` keeps the name graph, since
   Frond is a graph too. The provider is `RealmProvider` and the hook
   `useRealm`.
2. **`useValues` shape** (2026-11-02). An array in, a typed array out: an
   object is harder to keep stable across renders.
3. **No `fireImmediately` on `watch`** (2026-11-02). Code that needs the
   first value calls the effect once through `untracked`.
4. **Where errors go** (2026-11-02). To `globalThis.reportError`. Replaced
   by 13.
5. **Keyed collection** (2026-11-02). `reconcile` only. Replaced by 20.
6. **`isTracking` scope** (2026-11-02). A realm method. Replaced by 10.
7. **`autorun`** (2026-11-02). Dropped. Replaced by 24.
8. **Brand `SchemaModel` instances** (2026-11-02), so a draft cannot write
   their fields. Built in slice 5.
9. **Encoded type** (2026-11-02). It listed `$name` keys and `realm`.
   Replaced by 40.
10. **`isTracking` dropped** (2026-11-03). Replaced by 23.
11. **Effect programs** (2026-11-03). The scoped watch lets the latest value
    win, interrupting a running effect; `changes` keeps the newest value for
    a slow consumer; both read the realm from `RealmService`.
12. **Introspection** (2026-11-03). Names and recompute reasons are kept only
    for named values; no development warnings; `inspect` reports the
    observer count; a devtools transport is out of 1.0.
13. **Error sink** (2026-11-03). A realm takes `onError` for a watch
    effect's error, a reaction's error, and watchers that never settle;
    without one, the host's `reportError` takes them. A sink that throws does
    not stop the other watchers; its first error throws to the writer once
    the watchers have run. The Effect programs log a defect with
    `Effect.logError`, through the program's logger. Replaces 4; amended by
    14 and 32.
14. **A recipe's error wins** (2026-11-03). When a recipe throws, the
    watchers still settle after the rollback, and the writer gets the
    recipe's error.
15. **A hidden sink error is reported** (2026-11-03). A sink's error that a
    failed recipe's error hides goes to the host's `reportError`.
16. **A sink's first error only** (2026-11-03). Of several sink errors in
    one flush, only the first reaches the writer, or `reportError` when a
    failed recipe hides it; the sink has seen every error.
17. **A sink's own runaway goes unreported** (2026-11-03). Watchers that a
    sink's writes set going and that never settle stop after 100 rounds
    without a second report, so the round limit stays a bound.
18. **Pinna is v0** (2026-11-03). Built for Frond's own apps, which already
    ship Effect. Any API may change without a deprecation, and the public
    surface and the bundle size are not audited or gated; a standalone
    package revisits both.
19. **Decode context** (2026-11-04). A plain object, held in one variable
    for the decode, so a field costs a property read. Its plain object and
    its variable are replaced by 50.
20. **Keyed collection** (2026-11-04). `CollectionField(schema, { keyOf })`:
    one box per key and one for the order, a plain array on the wire. The
    use is the live list of priced rows: a write to one row reruns that
    row's reader, not the 10,000 readers of a box of the array. `reconcile`
    stays for a plain box of an array. Replaces 5.
21. **Hooks settle at the end of an update** (2026-11-04). Inside an update
    or the flush of watchers, a hook starts or stops once the watchers are
    done, and only if being observed differs from when it last ran, so an
    observer lost and gained within one update fires nothing. Hooks and
    watchers loop under one limit of 100 rounds; at the limit the hooks due
    still settle, without the watchers. Amended by 28.
22. **`observe`** (2026-11-04). Holds a box, a computed value, or an atom
    observed and returns the release. It replaces MobX's
    `computed({ keepAlive })`, and works outside render and inside an
    effect. Releasing twice does nothing.
23. **`isTracking`** (2026-11-04). True while a computed value or a watch's
    select runs; false in an update, `untracked`, a watch's effect, and a
    hook. Frond's internals use it where MobX's `_isComputingDerivation`
    was. Replaces 10.
24. **`autorun`** (2026-11-04). Runs at once, tracked, and again after each
    update that changes what its last run read; returns the stop function.
    A first-run error is thrown to the caller and nothing is watched; a
    later one goes to `onError`. Replaces 7; its write rule is replaced by
    46.
25. **A hook that throws** (2026-11-04). Every hook and cleanup on one
    observable runs even when an earlier one throws. Its rule for the first
    error is replaced by 27.
26. **An observe or watch whose hook throws** (2026-11-04). The observation
    was unwound. Replaced by 27.
27. **A hook's error goes to `onError`** (2026-11-04). Every error from a
    hook or its cleanup goes to `onError`, outside an update as inside one,
    and to `reportError` when `onError` throws, except at an update's
    settle, where 13 holds. It is never thrown to the caller, and nothing is
    unlinked because of it: the caller always gets its release. A hook that
    threw counts as begun. Frond needs every observation it makes to be
    releasable, and a release it always gets meets that without an unwind.
    Replaces 26.
28. **Links first, then hooks** (2026-11-04). An observing call links or
    unlinks everything first, then settles the hooks before it returns, by
    comparing, so a source lost and gained within one call fires nothing. A
    read outside an update that runs a computed value settles once the
    outermost read is over, never in the middle of the compute. A hook that
    wrote while links were still changing could leave a computed value
    linked to a source it no longer reads. Amends 21.
29. **A computed value cannot observe or release** (2026-11-04). `observe`,
    `watch`, `autorun`, a release, or a `useValue` subscription inside a
    compute or its `equals` throws `pinna: <name> cannot observe or release
    while it computes`. The test is that a computed value is computing, not
    `isTracking`, so `observe` in a select or a render stays allowed. An
    observation made mid-compute would change links during another
    observer's relink, which 28 rules out.
30. **Only `computedFunction` runs a hook at once** (2026-11-04). The graph's
    `onObservedNow` begins its hook at once, so an entry is cached from the
    moment it is made; the realm does not expose it.
31. **A hook added inside an update** (2026-11-04). `onObserved` called
    inside an update, a flush, a compute, or an observing call begins the
    hook at the settle if the observable is observed then; outside all of
    them it begins at once. Removing a hook runs its cleanup at once, except
    mid-compute, where it runs at the settle: once the outermost read is
    over, or when the update or flush ends.
32. **A mounted `useValue` throws a later error in its render**
    (2026-11-04). The store rerenders, and the render throws to the nearest
    error boundary, not to `onError`: sent there, the error left the
    component showing the value from before it. Amends 13.
33. **A cycle is kept where it began** (2026-11-04). The computed value read
    while it computes keeps the cycle error with every read made on the way,
    and recomputes once one of them changes. Every value whose run met the
    cycle ends volatile, so no cycle of links keeps a source observed.
34. **An autorun's cleanup** (2026-11-04). A function the effect returns runs
    untracked before the next run and once on stop; its error goes to
    `onError`. An autorun made inside another is not its child.
35. **A key a failed update added** (2026-11-04). Its cell is emptied with a
    new version before the key is dropped, so a reader that read it inside
    the failed update follows the key when it is added again.
36. **No clock** (2026-11-04). `realm.now` is removed, and realms take no
    clock or scheduler option: the flush is synchronous, so nothing in Pinna
    reads time. A clock is an atom, a computed value that reads
    `Date.now()`, and an `onObserved` hook that runs a timer;
    `apps/playground/src/clock.tsx` builds one. MobX keeps its clock out of
    its core too, in mobx-utils.
37. **The conformance run's defaults are kept** (2026-11-04). Hooks left due
    wait for the next flush; the hook limit cuts a chain of hooks longer
    than 100; the probe answers that differ from MobX (#29, #167, #30, #62,
    #86, #107, #88, #172, #173, #174, #176, #241, #244, #132, #147) are
    Pinna's behavior, as `design.md` lists them; hooks start from the source
    up; `observe` covers `keepAlive`, which is not added.
38. **Hooks left due are reported as hooks** (2026-11-04), not as watchers.
    Amends 37.
39. **The function form of `useValue` is its own hook** (2026-11-05).
    `useValue` and `useValues` know what they read before the render,
    subscribe when React subscribes, and read no context; the function form
    keeps the layout effect a function needs. Renamed `useSelect` by 41.
40. **One name per action** (2026-11-07). The encoded type of a
    `SchemaModel` names a `$name` field `name` and leaves out `realm`, as
    the wire does. Its methods per action are replaced by 43. Replaces 9.
41. **Additions from the playground and the API review** (2026-11-07).
    `useSelect` names the function form; `upsert` takes
    `{ at: "start" | "end" }`, first by default; `$items.rows`; the scoped
    watch passes `previous`; `Equals` and `UpsertOptions` are exported.
42. **A value from a stream** (2026-11-07). `fromStream(stream, initial)` is
    read-only, so nothing writes what the stream would overwrite. Its
    stream's error type is `never`, and a defect is logged. It restarts each
    time the value is observed again, and needs a scope, so a stream never
    outlives its program. `changes` over a function, an Effect `update`, and
    a `SubscriptionRef` bridge stay out: each is one line over what exists.
43. **Read and write only through the verbs** (2026-11-13). An observable has
    no methods: every place hands out `read`, and `update` alone hands out
    `write`. A `read` kept past every open place of its realm throws, and so
    does a `write` kept past its update. Tests read through `untracked`;
    there is no test-only reader. Replaces the methods of 40.
44. **Functions, and the schema in its own package** (2026-11-14). Each
    operation is a function that takes the realm first, or the observable
    when it carries its realm. The schema layer moves to
    `@frondruntime/pinna-effect`; `pinna` imports nothing from `effect`, and
    `pinna-effect` re-exports every function of `pinna`. A recipe and a
    watch effect return nothing.
45. **One flat surface, no namespace** (2026-11-14). No `Pinna` namespace,
    which collided with `import * as Pinna`.
46. **An autorun's body may update** (2026-11-14). The recipe runs
    untracked; a run that never settles stops at 100 rounds and reports to
    `onError`. An update still throws in a derivation. MobX lets an autorun
    write, and 15 cases of reactive-framework-test-suite write there.
    Replaces the write rule of 24.
47. **A name says when it uses a schema** (2026-11-15). `pinna-effect`'s
    `box`, `collection`, `reconcile`, and `Model` check nothing, and `box`
    given a schema throws and names `schemaBox`. The schema names are
    `schemaBox`, `SchemaModel`, `BoxField`, `CollectionField`, and
    `reconcileSchema`. `make` takes each `$` field's value, never a box, so
    a box is never shared with another instance; `extend`, `mapFields`,
    `makeOption`, and `makeEffect` throw. `pinna` adds `Model`. Amends 44
    and 45.
48. **`read.row` looks a row up without a cell** (2026-11-15). In a
    tracked place it is `read(collection.row(key))`; where nothing tracks, it reads the held
    row and makes no computed value and no cell. The use is a write by key: in the React
    Native app's 60 ticks, 3,000 lookups over 2,159 keys allocated 1.01 MB
    on Hermes 0.14.1 for `row(key)` alone and 1.84 MB with the read; through
    `read.row`, the whole 60 ticks allocate 0.81 MB from the command line,
    as alien-signals' do. In the app, the ticks went from 41.6 to 29.2 ms
    and from 3.0 to 0.9 MB. Amends 43: `read.row` is a property of the one
    `read`.
49. **The Effect programs in the root** (2026-11-15). The
    `pinna-effect/programs` entry is gone; `watchScoped`, `changes`,
    `observeScoped`, `fromStream`, and `RealmService` come from the root.
    The scoped `watch` and `observe` are renamed at the source with Effect's
    `Scoped` suffix, not aliased on export, so `pinna`'s keep their names.
    Amends 44.
50. **The decode context in an Effect program** (2026-11-15). A
    `FromContext(tag)` field holds the service of an Effect
    `Context.Service` tag, a requirement of the schema, and
    `decode(realm, schema, context)` takes an Effect `Context`; the
    innermost provider wins. The cost: decoding 10,000 plain struct rows
    with one context field each takes 6.8 ms through the Effect context,
    against 1.5 ms through a variable read first, on Bun. The variable was
    wrong in one case: an Effect decode nested inside a `decode`, which
    provided a tag the outer one also held, got the outer value, with no
    error. Amends 19.
51. **A refetched `SchemaModel` merges into the held instance**
    (2026-11-16). Under a held key, an instance of the same class and realm
    whose plain fields are equal, or which its class's own `[Equal.symbol]`
    finds equal, is merged: the held instance stays, and its boxes take the
    refetched values. Before it, every refetch replaced a row with a box and
    reran every reader of the row. The merge hook of the keyed collection
    stays internal: no application has needed it. Amends 47.
52. **A testing entry** (2026-11-16). `@frondruntime/pinna/testing` exports
    `record`, `held`, and `testRealm`, and imports no test runner and no
    Effect. The test realm counts watches by wrapping `watch` on its own
    graph alone, so an application's realms pay nothing. Stop functions stay
    plain functions: a dispose property on each made creating and stopping
    watches 28% slower (2.43 ms to 3.1 ms, rough tier, Node,
    `make-and-dispose`). `retainedKeys` joined the entry on 2026-11-17.
53. **Stages** (2026-11-20, completed 2026-11-21). `openStage(realm or
    stage, { name, conflicts })` makes a stage; `stageUpdate`, `stageRead`,
    `realmRead`, `applyStage`, `dropStage`, `stageStatus`, and
    `inspectStage` take it first, from the root of `@frondruntime/pinna`
    (45), with `StageClosedError`, `StageConflictError`, and the `Recipe`
    type. Frond asked for it: a host that runs asynchronous programs over a
    realm, whose writes must appear together when a program succeeds and
    never when it fails or is interrupted. The desk's orders write
    optimistically, which a stage does not.
    - Explicit, like `update(realm, recipe)`: the realm keeps no current
      stage, and `update` and `readIn` gain no field read and no branch.
    - A stage is an overlay and a journal. The overlay holds each box it
      wrote, and the rows and key order of each collection it wrote, copied
      on its first write so the two agree; the journal holds its recipes in
      order. Nothing copies the realm, a stage makes no graph node, and its
      values are not observable: Frond's pending state comes from the
      call's status, so no second graph.
    - Reads see the stage's writes everywhere. A collection's `keys`,
      `rows`, `row`, and `read.row` read the staged rows. A computed value
      runs its own function against the stage's `read`, outside the graph,
      Recoil's `Snapshot.map` model, so it starts no `onObserved` source; the
      result is cached on the stage until the stage, a parent, or the realm
      changes (the core's clock). Without it, a body that staged "add an
      item" and read `$total` got the realm's total, wrong and silent.
    - Writes cover boxes, collections, and atoms. A collection write runs
      the collection's own check, equality, `SchemaModel` merge, and
      `onRowChange` listeners over the staged rows, with the stage's `read`
      and `write`; an atom's `changed` is kept for the replay. Frond's
      results hold lists, refetched by a `replaceAll` of 1,000 to 10,000
      rows inside an operation. A merge and `reconcileSchema` read and write
      through the running recipe's place, which the realm exposes to those
      slow paths alone.
    - A recipe runs twice, staged and applied, so it is a function of its
      `read`. While a recipe or a `stageRead` function runs, the core's
      `deriving` slot holds a stage marker: a realm write, `watch`,
      `autorun`, and `observe` already refuse there, and the stage-specific
      messages live in the throw paths. Clearing `openDepth` for the run
      makes a realm `read` kept from another place throw. Making an
      observable, `untracked`, `onObserved`, `onRowChange`, and every stage
      call check the marker. Without the guard, an `update` inside a recipe,
      reached through a result method, wrote the realm at once and survived
      a drop, and a box made in a recipe split in two on replay. Frond's
      proposal, `core.active` set to a marker, was not taken: `readCell`
      links into whatever `active` holds.
    - `applyStage` over a realm replays the journal in one `update`, each
      recipe in a nested update, nested in an update already open: a recipe
      that throws on replay, or a write a check refuses, undoes the stage's
      writes alone and reaches the caller, so Frond catches it inside its
      settle update and records the call's failure there. Several stages in
      one update land in apply order, and two stages that write one box
      build on each other.
    - Conflicts replay by default. `{ conflicts: "fail" }` records the
      version of each box and collection the stage, or a child, read from
      the realm, underneath computed values too, and `applyStage` throws a
      `StageConflictError` naming what changed, landing nothing. A box
      written without reading is the last writer's. Nothing retries on its
      own: a retry reruns requests, and only the author knows whether one is
      safe to repeat.
    - A child stage, `openStage(stage)`, is a savepoint. It reads through
      its parent; `applyStage` replays its recipes into the parent as one
      `stageUpdate` and merges what it read into the parent's record; a
      throw leaves the parent as it was. A parent with an open child does
      not apply, and dropping a parent drops its children. Without it, a
      section an Effect program catches or retries left its writes in the
      stage, the opposite of a nested `update`.
    - A stage closes once, `"applied"` or `"dropped"` (a replay that throws
      ends `"dropped"`). Every later call throws a `StageClosedError`, a
      bug, except `dropStage`, which does nothing, so a cleanup drops
      whether or not the work applied. A `read` or a `write` kept past its
      recipe throws (43).
    - A schema box checks a staged write at `stageUpdate`, where the work
      wrote it, and again at `applyStage`, where it lands.
    - `inspectStage` reports a stage's name, parent, status, the boxes and
      collections it wrote, and, under `{ conflicts: "fail" }`, what it
      read. A collection takes `{ name }` (`collection`, `schemaCollection`,
      `CollectionField`), so a conflict names it: without one, every
      collection read "a collection". `bun run --cwd packages/pinna
      bench:stage` measures a refetch staged and replayed, and computed
      values read through a stage.
    - A stage left open is reported by a test realm's dispose by its name,
      through the hook `onRowChange` already uses, so an application's
      realm keeps no record of its stages.
    - `pinna-effect`'s `withStage(realm or stage, section, options)` applies
      the stage when the section succeeds and drops it otherwise; a conflict
      fails with the tagged `StageConflict`, and a replay that throws is a
      defect. Frond wraps the plain calls itself, since it applies inside its
      own update and only when the call is still current; `withStage` is for
      authors' savepoints and for applications such as the desk.
54. **No program requires `RealmService`** (2026-11-20, completed
    2026-11-21). `changes($box)` reads the realm with `realmOf($box)`, as
    `observeScoped` and `whileObserved` do, and `watchScoped(realm, ...)`
    and `fromStream(realm, ...)` take the realm first, as `watch` does. A
    Frond operation body, and a node's acquire, refuse every requirement
    but `Scope`, and both watch selectors and build values fed by streams;
    authors already close over the realm to make boxes. `RealmService`
    stays for a `SchemaModel` decoded inside an Effect program. Amends 11.
55. **Rules by purpose** (2026-11-21). `AGENTS.md` states each rule with
    what it protects, and the owner's instruction overrides every default:
    a feature the owner asks for needs no use case, and is built to the
    "Done" list in `AGENTS.md`. "No API is added until a use needs it" read
    as a gate: the stage plan named the desk as a use it does not have, and
    the first build deferred parts as unasked. It is replaced by "no
    speculative API; what is asked for is built complete". Security and
    actions beyond the working tree are absolute rules, read as written:
    pushing and publishing, destructive git and registry actions, secrets,
    the supply chain, and who may authorize them. An agent they block asks
    the owner, escalates, or proposes a change, and never acts on its own
    reading. Invariants that break for users are marked hard. Replaces the
    gate wording of the settled point on new API.

53. **A collection row cannot be `undefined`** (2026-11-18).
    `write.upsert` and `write.replaceAll` reject an `undefined` row in every
    collection before changing any row, with
    `pinna: a collection row cannot be undefined`; an uncaught rejection
    rolls back the update. A `CollectionField` rejects it on decode too,
    even when the row schema accepts it. `row(key)` and `read.row` return
    `undefined` for a missing key, so readers cannot distinguish a present
    `undefined` row from a missing key. The internal absence marker let a
    row cell skip the schema check; rejecting it at entry keeps that marker
    internal and checks incoming rows whether or not a cell exists.

54. **A box's value is a tree** (2026-11-19). Every key that reaches an
    object in `write.modify` gets its own draft, whether the base held the
    object or the recipe assigned it; an assigned object is copied on its
    first write and never written itself. A draft the recipe wrote and left
    at a second key, inside itself, or inside an object the recipe placed at
    two keys, throws
    `pinna: write.modify left an object it wrote under two keys` at
    finalize; an unwritten draft at two keys finalizes to the one object the
    box held. Before it, an assigned object shared one draft per
    call and the next call split it, and `draft.right = draft.left` held one
    object at two keys for one call only, so one recipe gave two results
    depending on whether its write landed in the same call. Joining keys
    across calls needs a scan of the value per call: 12.5 ms at 100,000
    rows, against 0.057 ms. Identity that outlives a call is a key, a
    collection row, or a box.

55. **An unobserved `rows` or `row(key)` lets go of the rows it returned**
    (2026-11-21). A write that changes a collection's rows empties `rows`,
    and a write that changes a key's row empties that key's `row(key)`,
    when nothing observes it, through pinna-core's `forgetValue`; the next
    read runs it again. A key that leaves empties its `row(key)`, which a
    caller may still hold, and a rolled-back update empties both, which
    would otherwise keep the rows it discarded until the next read. Both
    stay the same computed values. A `row(key)` taken while the key was
    missing, or kept by a caller across the key's removal and return, is
    not the key's current row computed, so nothing empties it: it keeps the
    last row it returned until its next read, one row for each such handle
    the caller holds, and its reads stay correct. Emptying it would need a
    row computed per key kept after the key leaves, and a rule for dropping
    it once nothing holds it. Before it, each
    kept its last unobserved result, so a `write.replaceAll` left the
    replaced generation reachable: in the React Native bench store, whose
    `merge` reads `rows` before `write.replaceAll`, 3,498 boxes stayed
    reachable after a full replacement where 1,998 are current, and the
    store's Hermes retained heap was 9,465,280 bytes; with it, 1,998 boxes
    and 5,027,168 bytes. A Node probe with `--expose-gc` kept 500 of 500
    replaced rows read through `rows`, and 500 of 500 read through
    `row(key)` under the same keys; with it, 0 of 500 in each. An observed
    value keeps what it holds: its observers are due the change. The cost:
    a read of an unobserved `rows` or `row(key)` after an update that rolled
    back runs again and returns a new array, or the same row, where it
    returned the kept value before; a write that changes no row empties
    nothing.

## Build slices

Built in order, each with its tests: 0, housekeeping (Effect 4.1.0, the
`check` script); 1, a realm per instance; 2, the conformance suite against
the shared reactivity cases and MobX's; 3, differential property tests
against alien-signals and MobX, and benchmarks with thresholds; 3b, a reader,
replaced by ruling 43; 4, React; 5, equality and keyed data; 6,
`computedFunction`; 6b, a clock, removed by ruling 36; 7, the Effect
programs; 8, introspection; then a value from a stream, a testing entry, and
packaging.

## Out of 1.0

A locale box, a MobX bridge, and a form kit. From MobX: `flow`, `when`
outside the Effect programs, `intercept`, `spy`, `configure`, deep
observables, and the `is*` predicates.

## Planned for 1.x

- **A `scheduler` option on `watch` and `autorun` in `pinna`**, as MobX's
  `reaction` and `autorun` take one. A scheduler is a plain function,
  `(run: () => void) => void`, that the application writes. Pinna ships
  none and names no timing such as "frame" or "immediate":
  `requestAnimationFrame` and `setImmediate` exist on some hosts and not
  others, and a server or a test has no frame at all, so the application
  picks what its host has and its own fallback. Ruling 36 holds: Pinna
  still reads no time and schedules no work of its own.
  - A change marks the reaction at once and calls the scheduler with one
    `run`. Changes before `run` is called join it, and `run` reads the values
    current when it starts, so it never sees a mixed state.
  - A `run` called after the reaction stopped does nothing. A scheduler that
    never calls `run` leaves the reaction pending; no later change schedules
    it again.
  - The first run stays synchronous, so its error is still thrown from
    `watch` or `autorun`. MobX defers a scheduled `autorun`'s first run but
    not a `reaction`'s.
  - A reaction without a scheduler runs before `update` returns, as today.
  - MobX's `delay: ms` is left out: it is the scheduler
    `(run) => setTimeout(run, ms)`, one line in the application.
  - Open before it lands: where an error from a deferred run goes, and the
    order between deferred and synchronous reactions (`design.md`,
    "Scheduling").
