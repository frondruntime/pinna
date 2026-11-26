# Pinna decisions

What the owner decided about Pinna's API, and why. The API as it stands is on
the site, whose source is `docs/public`; this page holds the reasons. Ruling
numbers are stable, because tests, `design.md`, and `performance.md` cite
them: a replaced ruling keeps its number and names what replaced it. Each
ruling carries the date it was first written down, and uses today's names.
A ruling that names a design note states its decision and its reasons in
full; the note, kept in the private repository, is the record of how it
was reached. The rulings of the unpublished packages, 66 and 70, are kept
there too.

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
- `Realm.update` is the one write scope, with no marked actions, and it is atomic:
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
  `Collection.reconcile`; derived values that take arguments, MobX's `computedFn`, for
  `Computed.fn`; a service that reacts to state as a stream for the
  Effect programs; view-only logic and components that read several values
  for `useSelect` and `useValues`; finding why a value recomputed for
  `Source.inspect`; Frond's asynchronous programs over a realm, for stages.

## Rulings

1. **Realm, not graph** (2026-11-02). The public name is realm; the
   dependency graph in `packages/pinna-core` keeps the name graph, since
   Frond is a graph too. The provider is `RealmProvider` and the hook
   `useRealm`.
2. **`useValues` shape** (2026-11-02). An array in, a typed array out: an
   object is harder to keep stable across renders.
3. **No `fireImmediately` on `Realm.watch`** (2026-11-02). Code that needs the
   first value calls the effect once through `Realm.untracked`.
4. **Where errors go** (2026-11-02). To `globalThis.reportError`. Replaced
   by 13.
5. **Keyed collection** (2026-11-02). `Collection.reconcile` only. Replaced by 20.
6. **`Realm.isTracking` scope** (2026-11-02). A realm method. Replaced by 10.
7. **`Realm.autorun`** (2026-11-02). Dropped. Replaced by 24.
8. **Brand `Model.Schema` instances** (2026-11-02), so a draft cannot write
   their fields. Built in slice 5.
9. **Encoded type** (2026-11-02). It listed `$name` keys and `realm`.
   Replaced by 40.
10. **`Realm.isTracking` dropped** (2026-11-03). Replaced by 23.
11. **Effect programs** (2026-11-03). The scoped watch lets the latest value
    win, interrupting a running effect; `Program.changes` keeps the newest value for
    a slow consumer; both read the realm from `RealmService`.
12. **Introspection** (2026-11-03). Names and recompute reasons are kept only
    for named values; no development warnings; `Source.inspect` reports the
    observer count; a devtools transport is out of 1.0. Amended by 70:
    devtools is a package an application attaches by a call, and `pinna`
    holds no transport and no hook.
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
20. **Keyed collection** (2026-11-04). `Model.collectionField(schema, { keyOf })`:
    one box per key and one for the order, a plain array on the wire. The
    use is the live list of priced rows: a write to one row reruns that
    row's reader, not the 10,000 readers of a box of the array. `Collection.reconcile`
    stays for a plain box of an array. Replaces 5.
21. **Hooks settle at the end of an update** (2026-11-04). Inside an update
    or the flush of watchers, a hook starts or stops once the watchers are
    done, and only if being observed differs from when it last ran, so an
    observer lost and gained within one update fires nothing. Hooks and
    watchers loop under one limit of 100 rounds; at the limit the hooks due
    still settle, without the watchers. Amended by 28.
22. **`Source.observe`** (2026-11-04). Holds a box, a computed value, or an atom
    observed and returns the release. It replaces MobX's
    `Computed.make({ keepAlive })`, and works outside render and inside an
    effect. Releasing twice does nothing.
23. **`Realm.isTracking`** (2026-11-04). True while a computed value or a watch's
    select runs; false in an update, `Realm.untracked`, a watch's effect, and a
    hook. Frond's internals use it where MobX's `_isComputingDerivation`
    was. Replaces 10.
24. **`Realm.autorun`** (2026-11-04). Runs at once, tracked, and again after each
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
29. **A computed value cannot observe or release** (2026-11-04). `Source.observe`,
    `Realm.watch`, `Realm.autorun`, a release, or a `useValue` subscription inside a
    compute or its `equals` throws `pinna: <name> cannot observe or release
    while it computes`. The test is that a computed value is computing, not
    `Realm.isTracking`, so `Source.observe` in a select or a render stays allowed. An
    observation made mid-compute would change links during another
    observer's relink, which 28 rules out.
30. **Only `Computed.fn` runs a hook at once** (2026-11-04). The graph's
    `onObservedNow` begins its hook at once, so an entry is cached from the
    moment it is made; the realm does not expose it.
31. **A hook added inside an update** (2026-11-04). `Source.onObserved` called
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
    `Date.now()`, and a `Source.onObserved` hook that runs a timer;
    `apps/playground/src/clock.tsx` builds one. MobX keeps its clock out of
    its core too, in mobx-utils.
37. **The conformance run's defaults are kept** (2026-11-04). Hooks left due
    wait for the next flush; the hook limit cuts a chain of hooks longer
    than 100; the probe answers that differ from MobX (#29, #167, #30, #62,
    #86, #107, #88, #172, #173, #174, #176, #241, #244, #132, #147) are
    Pinna's behavior, as `design.md` lists them; hooks start from the source
    up; `Source.observe` covers `keepAlive`, which is not added.
38. **Hooks left due are reported as hooks** (2026-11-04), not as watchers.
    Amends 37.
39. **The function form of `useValue` is its own hook** (2026-11-05).
    `useValue` and `useValues` know what they read before the render,
    subscribe when React subscribes, and read no context; the function form
    keeps the layout effect a function needs. Renamed `useSelect` by 41;
    amended by 75.
40. **One name per action** (2026-11-07). The encoded type of a
    `Model.Schema` names a `$name` field `name` and leaves out `realm`, as
    the wire does. Its methods per action are replaced by 43. Replaces 9.
41. **Additions from the playground and the API review** (2026-11-07).
    `useSelect` names the function form; `upsert` takes
    `{ at: "start" | "end" }`, first by default; `$items.rows`; the scoped
    watch passes `previous`; `Equals` and `UpsertOptions` are exported.
42. **A value from a stream** (2026-11-07). `Program.fromStream(stream, initial)` is
    read-only, so nothing writes what the stream would overwrite. Its
    stream's error type is `never`, and a defect is logged. It restarts each
    time the value is observed again, and needs a scope, so a stream never
    outlives its program. `Program.changes` over a function, an Effect `Realm.update`, and
    a `SubscriptionRef` bridge stay out: each is one line over what exists.
43. **Read and write only through the verbs** (2026-11-13). An observable has
    no methods: every place hands out `read`, and `Realm.update` alone hands out
    `write`. A `read` kept past every open place of its realm throws, and so
    does a `write` kept past its update. Tests read through `Realm.untracked`;
    there is no test-only reader. Replaces the methods of 40. Amended by
    62: `Source.peek` reads one value outside every place, for a test or a
    handler; `Realm.untracked` reads several.
44. **Functions, and the schema in its own package** (2026-11-14). Each
    operation is a function that takes the realm first, or the observable
    when it carries its realm. The schema layer moves to
    `@frondruntime/pinna-effect`; `pinna` imports nothing from `effect`, and
    `pinna-effect` re-exports every function of `pinna`. A recipe and a
    watch effect return nothing. Amended by 62: each function is a member
    of its type's module, and the realm or the observable still comes first.
45. **One flat surface, no namespace** (2026-11-14). No `Pinna` namespace,
    which collided with `import * as Pinna`. Replaced by 62: a module per
    type, and still no `Pinna` object inside the package.
46. **An autorun's body may update** (2026-11-14). The recipe runs
    untracked; a run that never settles stops at 100 rounds and reports to
    `onError`. An update still throws in a derivation. MobX lets an autorun
    write, and 15 cases of reactive-framework-test-suite write there.
    Replaces the write rule of 24.
47. **A name says when it uses a schema** (2026-11-15). `pinna-effect`'s
    `Box.make`, `Collection.make`, and `Model.Class` check nothing, and
    `Box.make` given a schema throws and names `Box.schema`. The schema
    forms are `Box.schema`, `Collection.schema`, `Model.Schema`,
    `Model.boxField`, and `Model.collectionField`, and pinna-effect's
    `Collection.reconcile` works out `equals` from the schema when it is
    left out. `make` takes each `$` field's value, never a box, so a box is
    never shared with another instance; `extend`, `mapFields`, `makeOption`,
    and `makeEffect` throw. `pinna` adds `Model`. Amends 44 and 45. Amended
    by 62, which made the schema forms module members.
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
    `pinna-effect/programs` entry is gone; `Program.watchScoped`, `Program.changes`,
    `Source.observeScoped`, `Program.fromStream`, and `RealmService` come from the root.
    The scoped `Realm.watch` and `Source.observe` are renamed at the source with Effect's
    `Scoped` suffix, not aliased on export, so `pinna`'s keep their names.
    Amends 44. Amended by 62: the stream programs are on `Program`, and
    each scoped form sits beside its plain twin (`Realm.scoped`,
    `Source.observeScoped`, `Stage.scoped`). Amended by 72: `watchScoped`
    is `Program.watchScoped`, since on `Realm` its queue and fiber code
    went into every bundle that made a realm.
50. **The decode context in an Effect program** (2026-11-15). A
    `Model.context(tag)` field holds the service of an Effect
    `Context.Service` tag, a requirement of the schema, and
    `Model.decode(realm, schema, context)` takes an Effect `Context`; the
    innermost provider wins. The cost: decoding 10,000 plain struct rows
    with one context field each takes 6.8 ms through the Effect context,
    against 1.5 ms through a variable read first, on Bun. The variable was
    wrong in one case: an Effect decode nested inside a `Model.decode`, which
    provided a tag the outer one also held, got the outer value, with no
    error. Amends 19.
51. **A refetched `Model.Schema` merges into the held instance**
    (2026-11-16). Under a held key, an instance of the same class and realm
    whose plain fields are equal, or which its class's own `[Equal.symbol]`
    finds equal, is merged: the held instance stays, and its boxes take the
    refetched values. Before it, every refetch replaced a row with a box and
    reran every reader of the row. The merge hook of the keyed collection
    stays internal: no application has needed it. Amends 47.
52. **A testing entry** (2026-11-16). `@frondruntime/pinna/testing` exports
    `record`, `held`, and `testRealm`, and imports no test runner and no
    Effect. The test realm counts watches by wrapping `Realm.watch` on its own
    graph alone, so an application's realms pay nothing. Stop functions stay
    plain functions: a dispose property on each made creating and stopping
    watches 28% slower (2.43 ms to 3.1 ms, rough tier, Node,
    `make-and-dispose`). `retainedKeys` joined the entry on 2026-11-17.
53. **Stages** (2026-11-20, completed 2026-11-21). `Stage.make(realm or
    stage, { name, conflicts })` makes a stage; `Stage.update`, `Stage.read`,
    `Stage.realmRead`, `Stage.apply`, `Stage.drop`, `Stage.status`, and
    `Stage.inspect` take it first, from the root of `@frondruntime/pinna`
    (45; members of `Stage` since 62, with the scoped form `Stage.scoped`),
    with `StageClosedError`, `StageConflictError`, and the `UpdateRecipe`
    type. Frond asked for it: a host that runs asynchronous programs over a
    realm, whose writes must appear together when a program succeeds and
    never when it fails or is interrupted. The desk's orders write
    optimistically, which a stage does not.
    - Explicit, like `Realm.update(realm, recipe)`: the realm keeps no current
      stage, and `Realm.update` and `readIn` gain no field read and no branch.
    - A stage is an overlay and a journal. The overlay holds each box it
      wrote, and the rows and key order of each collection it wrote, copied
      on its first write so the two agree; the journal holds its recipes in
      order. Nothing copies the realm, a stage makes no graph node, and its
      values are not observable: Frond's pending state comes from the
      call's status, so no second graph. A visible stage shows its values
      in the realm's own cells instead (ruling 68).
    - Reads see the stage's writes everywhere. A collection's `keys`,
      `rows`, `row`, and `read.row` read the staged rows. A computed value
      runs its own function against the stage's `read`, outside the graph,
      Recoil's `Snapshot.map` model, so it starts no `Source.onObserved` source; the
      result is cached on the stage until the stage, a parent, or the realm
      changes (the core's clock). Without it, a body that staged "add an
      item" and read `$total` got the realm's total, wrong and silent.
    - Writes cover boxes, collections, and atoms. A collection write runs
      the collection's own check, equality, `Model.Schema` merge, and
      `Collection.onRowChange` listeners over the staged rows, with the stage's `read`
      and `write`; an atom's `changed` is kept for the replay. Frond's
      results hold lists, refetched by a `replaceAll` of 1,000 to 10,000
      rows inside an operation. A merge and `Collection.reconcile` read and write
      through the running recipe's place, which the realm exposes to those
      slow paths alone.
    - A recipe runs once when staged and once per `Stage.apply` through its
      parents to the realm, so it is a function of its `read`. Row listeners
      run for each change on each run. While a recipe or a `Stage.read`
      function runs, the core's
      `deriving` slot holds a stage marker: a realm write, `Realm.watch`,
      `Realm.autorun`, and `Source.observe` already refuse there, and the stage-specific
      messages live in the throw paths. Clearing `openDepth` for the run
      makes a realm `read` kept from another place throw. Making an
      observable, `Realm.untracked`, `Source.onObserved`, `Collection.onRowChange`, and every stage
      call check the marker. Without the guard, a `Realm.update` inside a recipe,
      reached through a result method, wrote the realm at once and survived
      a drop, and a box made in a recipe split in two on replay. Frond's
      proposal, `core.active` set to a marker, was not taken: `readCell`
      links into whatever `active` holds.
    - `Stage.apply` over a realm replays the journal into a fresh overlay over
      the realm's current values, under the same guard as `Stage.update`.
      One `Realm.update` lands the final box values, collection rows and order,
      and atom marks without user code in its recipe, nested in an update
      already open. Checks, equality, merges, and row listeners run during
      replay; landing records ordinary row changes without reporting them
      to the listeners again. A replay throw, including a refused write,
      discards the overlay and reaches the caller without changing the
      realm, so Frond catches it inside its settle update and records the
      call's failure there. Several stages in one update land in apply
      order, and two stages that write one box build on each other. A final
      value equal to the realm's value changes no version and notifies
      nobody. Watch effects and autoruns settle after landing; their errors
      go to `onError` and the stage stays `"applied"`.
      An enclosing update that rolls back undoes the landing and changes
      the stage's status to `"dropped"`; stage the work again in a new stage.
      An empty journal stays `"applied"`, since it had no landing to undo.
    - Conflicts replay by default. `{ conflicts: "fail" }` records the
      version of each box, collection, and atom the stage, or a child, read
      from the realm, underneath computed values too, and `Stage.apply` throws a
      `StageConflictError` naming what changed, landing nothing. An atom
      read beneath a computed value is named by that value, since an atom
      has no name (2026-11-25: atoms were unrecorded before, so a value
      over one, such as `Program.fromStream`'s, changed unseen). A box or
      collection written without reading is recorded too, at the realm's
      version, so a base write under it conflicts: the first writer wins
      under `"fail"`, the rule of snapshot isolation (the owner, 2026-11-23;
      amended by ruling 68). Under `"replay"` it stays the last writer's.
      `write.modify` reads
      its base when it comes from the realm. Two different observed versions
      conflict even after a rollback restores the first; version order is
      not observation order. Nothing retries on its
      own: a retry reruns requests, and only the author knows whether one is
      safe to repeat.
    - A child stage, `Stage.make(stage)`, is a savepoint. It reads through
      its parent; `Stage.apply` replays its recipes into the parent as one
      `Stage.update` and merges what it read into the parent's record; a
      throw leaves the parent as it was. A parent with an open child does
      not apply, and dropping a parent drops its children. Without it, a
      section an Effect program catches or retries left its writes in the
      stage, the opposite of a nested `Realm.update`.
    - A stage closes once, `"applied"` or `"dropped"`. A conflict or a replay
      throw drops it. A `Stage.apply` precondition failure, such as an open
      child or a call inside a recipe or computed value, leaves it open.
      After closing, `Stage.status` and `Stage.inspect` remain callable
      outside a recipe; `Stage.drop` does nothing, so a cleanup drops whether
      or not the work applied. Every other stage call throws
      `StageClosedError`, a bug. A `read` or a `write` kept past its recipe
      throws (43).
    - A schema box checks a staged write at `Stage.update`, where the work
      wrote it, and again during `Stage.apply`'s guarded replay. Landing
      skips the check already performed by that same box or collection.
    - `Stage.inspect` reports a stage's name, parent, status, the boxes and
      collections it wrote, and, under `{ conflicts: "fail" }`, what it
      read. A collection takes `{ name }` (`Collection.make`, `Collection.schema`,
      `Model.collectionField`), so a conflict names it: without one, every
      collection read "a collection". `bun run --cwd packages/pinna
      bench:stage` measures a refetch staged and replayed, and computed
      values read through a stage.
    - A stage left open is reported by a test realm's dispose by its name,
      through the hook `Collection.onRowChange` already uses, so an application's
      realm keeps no record of its stages.
    - `pinna-effect`'s `Stage.scoped(realm or stage, section, options)` applies
      the stage when the section succeeds and drops it otherwise; a conflict
      fails with pinna's `StageConflictError` (ruling 56 replaced the
      tagged `StageConflict`), and a replay that throws is a defect. Frond wraps the plain calls itself, since it applies inside its
      own update and only when the call is still current; `Stage.scoped` is for
      authors' savepoints and for applications such as the desk.
54. **No program requires `RealmService`** (2026-11-20, completed
    2026-11-21). `Program.changes($box)` reads the realm with `realmOf($box)`, as
    `Source.observeScoped` and `Program.whileObserved` do, and `Program.watchScoped(realm, ...)`
    and `Program.fromStream(realm, ...)` take the realm first, as `Realm.watch` does. A
    Frond operation body, and a node's acquire, refuse every requirement
    but `Scope`, and both watch selectors and build values fed by streams;
    authors already close over the realm to make boxes. `RealmService`
    stays for a `Model.Schema` decoded inside an Effect program. Amends 11.
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

59. **A collection row cannot be `undefined`** (2026-11-18; numbered 53,
    beside the stages' 53, until 2026-11-24).
    `write.upsert` and `write.replaceAll` reject an `undefined` row in every
    collection before changing any row, with
    `pinna: a collection row cannot be undefined`; an uncaught rejection
    rolls back the update. A `Model.collectionField` rejects it on decode too,
    even when the row schema accepts it. `row(key)` and `read.row` return
    `undefined` for a missing key, so readers cannot distinguish a present
    `undefined` row from a missing key. The internal absence marker let a
    row cell skip the schema check; rejecting it at entry keeps that marker
    internal and checks incoming rows whether or not a cell exists.

60. **A box's value is a tree** (2026-11-19; numbered 54, beside 54 on
    `RealmService`, until 2026-11-24). Every key that reaches an
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

61. **An unobserved `rows` or `row(key)` lets go of the rows it returned**
    (2026-11-21; numbered 55, beside 55 on rules by purpose, until
    2026-11-24). A write that changes a collection's rows empties `rows`,
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

56. **One error type, branded and tagged** (2026-11-23). Every error a Pinna
    package throws is a `PinnaError`, a plain `Error` subclass in
    pinna-core with no Effect dependency, branded with the string key
    `"~pinna/Error"` and carrying a literal `_tag` equal to its exported
    class name, written out on each class because minifiers rename
    classes. A condition code handles has its own class:
    `StageConflictError`, `StageClosedError`, `ValueRejectedError` (a write
    a box's check refuses, which threw a plain `Error` before), and
    pinna-effect's `DecodeError` (which `Model.decode` throws where it threw
    Effect's `SchemaError`, now its `cause`). Misuse is one
    `PinnaUsageError` whose `code`, prefixed by package (`pinna/…`,
    `pinna-effect/…`, `pinna-react/…`), names it from a documented list,
    typed `PinnaUsageCode | (string & {})` so a minor version can add a code
    without breaking an exhaustive `switch`; the field is `code`, not
    `reason`, because Effect's `catchReason` expects `reason` to be an
    object with its own `_tag`. `isPinnaError(value)` matches by brand, and
    `isPinnaError(value, tag)` narrows to the class through the
    `PinnaErrorByTag` interface, which each package augments with its own
    classes. `instanceof` is not the match: two copies of Pinna in one
    application each have their own classes, and `Stage.scoped` matched with
    `instanceof` before, so a conflict from another copy died as a defect.
    `toJSON` gives `_tag`, `name`, `message`, and each class's fields;
    `StageConflictError` leaves out `observables`, which hold realms. The
    internal wait past the depth limit is branded too and never escapes a
    compute. pinna-effect's `StageConflict`, a `Data.TaggedError`, is
    removed: `Stage.scoped` fails with pinna's `StageConflictError`, which
    `Effect.catchTag` takes, since a plain class with a literal `_tag`
    narrows and rejects a misspelled tag (TS2769); a thrown error inside
    `Effect.sync` is a defect `catchTag` never sees, so `Stage.scoped` moves
    the throw to a failure. No error channel is typed `PinnaError`: an open
    `_tag` there would let `catchTag` accept any tag. Usage errors are
    defects and stay out of every channel. Messages are unchanged, except
    `Model.decode`'s, which gains the `pinna: decode rejects the input: ` prefix;
    tests match `_tag` and `code`. Breaking at 0.x by the owner's word:
    `StageConflict` is gone, and `Model.decode` throws `DecodeError`. Amends 53;
    from the error part of the API redesign note, built ahead of the module
    part.
57. **Realm disposal** (2026-11-23). `Realm.dispose(realm)`, also the
    realm's `Symbol.dispose`, ends what runs in a realm and refuses anything
    more: an Effect program's `Program.changes` ends and its `Program.watchScoped` effect is
    interrupted; each autorun stops with its cleanup, each `Collection.onRowChange`
    listener stops, and each open stage is dropped, newest first; then the
    cleanup of every `Source.onObserved` hook that has begun runs, newest first;
    all of it in one batch, whose settle runs no watcher, so no hook ends
    before the last autorun cleanup. `Realm.status(realm)` is
    `"open"`, `"disposing"`, or `"disposed"`, as `Stage.status` is for a
    stage. Disposing twice does nothing. From `"disposing"` on, `Realm.watch`,
    `Realm.autorun`, `Source.observe`, `Source.onObserved`, `Collection.onRowChange`, `Stage.make`, and a
    hook mounting throw `pinna/realm-disposed`; from `"disposed"`, `Realm.update`
    does too. Reads still work and return the last values (the owner's
    choice: a component that renders between the disposal and its unmount
    shows the last state, not an error). A watch, a `Source.observe`, or a mounted
    hook stays linked and never runs again, because nothing can write:
    keeping every observer in a set, so disposal could unlink each, cost
    30% on one write among 10,000 watched rows on Node (1.48 ms to 2.03 ms)
    with the set never read, while keeping each begun hook's cleanup costs
    nothing measurable, since a hook begins once per source. Disposal from
    inside an update, a computed value, a watch's select or effect, an
    autorun, `Realm.untracked`, a hook, a stage recipe, or a row listener throws
    `pinna/dispose-not-at-rest` and stops nothing: the owner ruled it a
    caller's bug, not a case to support, and refusing it costs one check
    of fields disposal reads anyway. The Effect form is `Realm.scoped`,
    a realm released with its scope; a `Layer` over it is one line in the
    application, so none is exported. `testRealm`'s dispose reports what is
    still running, then disposes the realm, so a test that keeps using it
    fails at the use. Server rendering needs none of it: a render through
    `renderToString` links no observer. Built from the realm disposal design note.

58. **A scheduler on one watch or autorun** (2026-11-23). `Realm.watch`'s options
    and `Realm.autorun`'s new options argument take `scheduler`, a plain function
    `(run: () => void) => void` the application writes, and `Program.watchScoped`
    takes it through `Realm.watch`'s options. Pinna ships none and names no
    timing such as "frame": `requestAnimationFrame` and `setImmediate` exist
    on some hosts and not others, and a server or a test has no frame, so
    ruling 36 holds and Pinna reads no time. A watch or autorun without one
    runs before `Realm.update` returns, as before; the realm takes no scheduler,
    since deferring the settle would break that for every watcher.
    - The first run is synchronous, so its error is thrown from `Realm.watch` or
      `Realm.autorun` and nothing is watched. MobX defers a scheduled `autorun`'s
      first run but not a `reaction`'s.
    - Built on pinna-core's `Reaction`, the observer `pinna-react` uses,
      notified when marked: the settle calls the scheduler with one `run`
      and brings nothing current, and `run` asks `changed()` and does
      nothing when no source changed. Every write before `run` joins it,
      `run` reads the values current when it starts, and a computed value
      it reads recomputes once per run: 100 writes and one run cost one
      recompute, where refreshing at each settle cost 100. `previous` is
      the last run's result, as a plain watch's is.
    - `Reaction.track` schedules its reaction again when the run wrote, as
      a watch's run does, so a scheduled autorun sees its own write to a
      source it read for the first time.
    - An error from a deferred run goes to `onError`: the writer has
      returned. A run a scheduler calls at once is in the settle, and its
      error goes where a watch's does. A scheduler that throws reaches the
      settle as a watcher's error, and the next change schedules again.
    - `run` inside an update, a computed value, a watch's select, an
      autorun, or a stage recipe throws `pinna/scheduled-run-not-at-rest`:
      there values are partial, and a run between two writes of one recipe
      saw a pair no settled state held. Deferring it to the update's end
      would hide the caller's bug behind a timing nobody asked for.
    - A run called after the stop, after the realm left `"open"`, or a
      second time for one schedule does nothing; a frame that fires after
      disposal is normal, so it is not refused. A scheduled watch and
      autorun register with the realm, so disposal and `testRealm` stop and
      report each; the cost of the set falls only on scheduled ones.
    - A deferred run that writes what it read runs again at the next call
      of its scheduler, past the reach of the round limit. At 100 notices
      in a row that arrive during the reaction's own run,
      `pinna/watchers-unsettled` goes to `onError` and that schedule is
      skipped; the next change from outside schedules it (the owner's
      choice of the counting guard over a documented loop).
    - Order: every synchronous watcher of an update has run before any
      deferred run of it can start; between deferred reactions, the
      scheduler's order.
    - No option on the `pinna-react` hooks: React decides when a component
      renders.
    - MobX's `delay: ms` is left out: it is the scheduler
      `(run) => setTimeout(run, ms)`, one line in the application.
    - A cycle met while the settle brings a plain watch's sources current is
      reported there; a scheduled run's select meets it at its read
      instead.
    Built from the reaction schedulers design note.

<!-- rename-prose: off -->

62. **A module per type** (2026-11-24). Each package exports a module
    object per type, and no flat function: `Realm` (`make`, `update`,
    `untracked`, `watch`, `autorun`, `isTracking`, `dispose`, `status`),
    `Box` (`make`), `Atom` (`make`), `Computed` (`make`, `fn`),
    `Collection` (`make`, `onRowChange`, `reconcile`), `Stage` (`make`,
    `update`, `read`, `realmRead`, `apply`, `drop`, `status`, `inspect`),
    `Model` (`Class`), and `Source` (`peek`, `observe`, `onObserved`,
    `inspect`). pinna-effect's modules hold every member of pinna's, the
    same function, and add the schema forms (`Box.schema`,
    `Collection.schema`, `Model.Schema`, `Model.boxField`,
    `Model.collectionField`, `Model.context`, `Model.decode`), the scoped
    forms (`Program.watchScoped`, `Realm.scoped`, `Source.observeScoped`,
    `Stage.scoped`), and `Program` (`changes`, `fromStream`,
    `whileObserved`). Its `Collection.reconcile` is the schema form, which
    hands a call with `equals` to pinna's unchanged; pinna's requires
    `equals`, so a call either accepts behaves the same.
    - A module and its type share one name: `Box.make(realm, 0)` returns a
      `Box<number>`, through one import. `Model` is the instance type, and
      `Model.Class` the base class.
    - Types and errors stay top-level: `ValueOptions` (was `Options`),
      `UpdateRecipe` (was `Recipe`), `StageConflictError`. A type hung on a
      module is lost when pinna-effect extends the module.
    - The hooks and the testing entry stay flat: React's tooling looks for
      a bare `use*` name.
    - A module is named for what it holds, as Effect names its modules:
      `Program`, not `Programs` (the owner, 2026-11-24).
    - `Computed.fn`, as MobX's `computedFn`: `function` is a reserved word,
      and rule 5 of `AGENTS.md` takes the standard workaround.
    - `Source.peek($x)` reads one box or computed value outside every
      place, and throws `pinna/peek-while-tracking` where reads are tracked
      and `pinna/peek-in-recipe` in a stage recipe, where it would read the
      value from before the stage. Amends 43.
    - Error messages name the module member (`pinna: Realm.update cannot
      run in a computed value`); error codes are unchanged.
    The flat surface needed a workaround per collision: the `schema`
    prefix because pinna-effect re-exports every pinna name, verb-first
    and noun-first names mixed (`openStage`, `stageUpdate`), and root words
    (`watch`, `inspect`) that meet other libraries in auto-import. A module
    scopes each name to its type, so `Stage.update` and `Realm.update`
    coexist and a new member needs no prefix. The cost: a property load per
    call, and a module object kept whole once one member is used. The
    migration is `scripts/codemod/rename-api.ts`, through the TypeScript
    checker's symbols, and `scripts/codemod/rename-prose.ts` for inline
    code in the docs, both from `scripts/codemod/names.ts`. Replaces 45;
    amends 43, 44, 47, 49, and 53. The design record is
    the API redesign note.
    - The flat names before 62: the schema forms were `schemaBox`,
      `schemaCollection`, `SchemaModel`, `BoxField`, `CollectionField`,
      and `reconcileSchema`, and `Stage.scoped` was `withStage`;
      `scripts/codemod/names.ts` maps every flat name to its member. This
      ruling keeps the old names, so `rename-prose.ts` skips it.

<!-- rename-prose: on -->

63. **Views a collection keeps a row at a time** (2026-11-24). `View`
    (`ordered`, `grouped`, `totals`, `dispose`, `status`) keeps a sorted,
    filtered order of a collection's keys with windows by rank, the keys of
    each group, and a count and exact total per group. pinna-effect adds
    `View.orderedScoped`, `View.groupedScoped`, and `View.totalsScoped`,
    disposed with their scope.
    - A view is built on `Collection.onRowChange` and keeps its state in a
      box (`View.ordered`'s persistent AVL trees) or a collection (a group's
      keys or total). A failed update, a nested update, and a stage carry it
      as they carry any box, and nothing in `Realm.update` or a write knows
      views exist. The parked branch `feat/collection-views` (c6c5837) kept
      views inside the collection, with their own rollback journals, a
      check of every view at the end of every update, and a guard on every
      write; the owner chose the public hook (2026-11-24).
    - Its own module, not members of `Collection`: a module object is kept
      whole once one member is used, so `Collection.ordered` would bundle
      the trees into every application with a collection.
    - `compare` and `filter` are tracked factories that return plain
      callbacks. A box they read changes the config; the view rebuilds
      from its own trees on the next read or row write, so a `replaceAll`
      that reports rows after writing them all is never applied twice.
    - Ties under `compare` are broken by key, for string, number, and bigint
      keys; others throw `pinna/view-tie`. Insertion order would differ
      between a replay, a stage, and the realm.
    - Callbacks are a function of the row. A view finds a row's old place
      by asking again with `before`, and throws `pinna/view-out-of-step`
      where the place is empty; an answer that moves the row elsewhere is
      not found, since finding it would cost a per-key map in a box.
    - `View.totals` takes the caller's arithmetic: floating-point adds and
      subtracts drift, and Pinna does not choose a number type. Minimum and
      maximum are not totals.
    - Explicit `View.dispose`, as `Collection.onRowChange`: a view is kept
      whether read or not, so a read after hours of quiet is current
      without an `O(n log n)` rebuild. `Realm.dispose` disposes it,
      `testRealm` reports one left open, and a read through a disposed view
      throws `pinna/view-disposed`.
    - A view is refused while an open stage holds writes to its collection
      (`pinna/view-staged-rows`): its listener hears the realm's rows, and
      would miss the staged ones.
    - Out: joins, a query language, and live queries over several
      collections. A view over a view is a `Computed.make` over its keys.

64. **Snapshot and restore over a declared shape** (2026-11-24, the owner,
    on the second pass's six decisions). `read.snapshot(shape)` is `read`
    applied across a shape the caller declares, and `write.restore(shape,
    data)` is `write` applied across the same shape: a box reads and writes
    its value as held, a collection its rows in key order, a `Model.Schema`
    instance its fields under their wire keys, and plain objects and arrays
    keep their structure. Each leaf is a verb Pinna already has, so the pair
    adds no second set of semantics: a snapshot tracks in a tracked place
    and reads the stage in a recipe, and a restore lands with its update or
    not at all, puts back its own writes on a throw even when caught, and
    replays in a stage recipe.
    - The shape is declared, never discovered. Reflection over a model's
      properties threw on `apps/desk` (a `Workspace` and `Layouts` cycle, a
      `TradeBook` held by several models, one collection under two names)
      and made property names a storage format. A `Model.Class` declares no
      fields, so it throws `pinna/snapshot-not-state`, as do a computed value
      and an atom; Frond holds boxes alone (the owner, 2026-11-24), so a
      shape of boxes and collections is the main case.
    - A restore never makes a model. A row a collection lacks is added from
      an instance in the data; plain data for a `Model.Schema` row throws
      `pinna/restore-cannot-make-row`. A hidden reference to the original
      instance would not survive `JSON.stringify` or `structuredClone`, and
      `make` cannot fill a `Model.context` field or run in a stage recipe.
    - A `Model.Schema` snapshot uses wire keys, the form `make` takes,
      without `realm` and without `Model.context` fields. A plain field that
      differs from the held instance's throws `pinna/restore-plain-field`.
    - Encoding a `Model.Schema` is a read (`ObservableRealm.readerNow`):
      tracked in a tracked place, the stage's values in a recipe. It peeked
      before, so a computed value that encoded a model went stale, which
      broke rule 8 of `AGENTS.md`.
    - `Model.restore(realm, Schema, context?)(held, input)` decodes and
      restores in one call, in the open update or one of its own: the
      hydration path for a `Model.Schema`.
    - No realm-wide snapshot: a realm lists no boxes, a registry would cost
      every `Box.make`, and a box's identity means nothing after a reload.
    - No sharing between snapshots beyond the held values; a computed value
      over part of a shape keeps that part's identity.
    - Snapshot is its own feature: time travel builds on the change stream,
      which is reopened before devtools, and stages on their journal.
    Design records: the snapshot design note (the first pass) and the second
    pass, a document the owner holds.

65. **A value from a promise, and from an Effect** (2026-11-25, the owner).
    `Computed.fromPromise(realm, load, initial, options)` in `pinna` is a
    read-only value fed by the promise `(signal) => PromiseLike` returns
    while something observes it, and `Program.fromEffect(realm, effect,
    initial, options)` in `pinna-effect` is `Program.fromStream` over one
    Effect. Both have `Program.fromStream`'s lifetime (ruling 42): the work
    starts with the first observer, from the start each time, and ends
    when the last leaves, which resets the value to `initial`;
    `Realm.dispose` ends it through the begun hook's cleanup (ruling 57).
    `load` takes a function, not a started promise, because a started
    promise cannot be aborted or started again; its signal aborts when the
    observation ends, and a result or a rejection after that is dropped,
    so a slow answer never overwrites a newer one and none calls
    `Realm.update` on a disposed realm. A rejection, or a throw from
    `load`, goes to `onError` as it is, as a hook's throw does (ruling 27),
    and the value keeps what it held; `Program.fromEffect` takes an error
    type of `never`, as a stream does. No status type, refetch, cache,
    keep-alive, or Suspense hook: an asynchronous value with loading and
    failure belongs to the request library the application chose, and the
    application maps a failure into its own union inside `load`. Pinna's
    one bridge into such a library is a box a `Source.onObserved` hook
    writes (`docs/public/guides/async-state.md`). Ruling 42 kept one-line
    wrappers over `Program.fromStream` out; `Program.fromEffect` is in
    because `Computed.fromPromise` needs its Effect form ("Done" in
    `AGENTS.md`), and `fromEffect` is the name a reader looks for. A stage
    that fails on conflicts now records atom reads, so a value either
    bridge changed between staging and `Stage.apply` conflicts (ruling 53,
    amended 2026-11-25). The design record is `docs/design.md`, "Values
    from a promise or an Effect".

66. **A form kit, on declarations** (2026-11-25). Kept in the private
    repository with `pinna-form`, which is not published.

67. **Normal use is a shape** (2026-11-24). Code is normal-shaped when it
    reads and writes only through the `read` and `write` a place or an
    update handed it, inside that place or update; stays in one realm;
    compiles with no cast; and imports nothing from `src/internal`. Any
    order and nesting of public calls by normal-shaped code is normal use,
    and a rare order is not an edge merely because it is rare. A finding is
    classified by its smallest repro, independently of repair cost, first
    match: not normal-shaped, an edge; nothing ran that shows it, dropped,
    and never reported as a confirmed bug; a sentence under `docs/public`
    or a ruling here is false, or the differential test disagrees, a bug,
    each such sentence an obligation until the owner changes it; otherwise
    the most conservative default, listed. An expensive bug remains a bug;
    a cheap patch does not establish a new guarantee. An edge is closed
    only by a type, a removed state, or a throw at a check that already
    runs. A check that costs an allocation or a branch on a read, a write,
    or a recompute is not added for an edge: the edge gets one sentence
    under "Some mistakes are not caught" (`docs/public/start/principles.md`),
    no code and no test. A mistake in the application's own logic gets
    nothing. Only the owner promotes an edge. Closing every imaginable
    misuse added code whose own states needed closing. Amended by 71: its
    test 7 orders "most conservative", and its test 6 says what a default
    may cost.

68. **Visible stages** (2026-11-25, the owner asked for optimistic writes;
    designed 2026-11-23 and 2026-11-25). `Stage.make(realm, { visible:
    true })` shows a root stage over the realm until it applies or drops:
    every tracked reader, `Realm.untracked`, and `Source.peek` at rest read
    the realm's confirmed values (the base) with each showing stage on top,
    bottom first. Without it, an optimistic write was a plain `Realm.update`
    the application undid by hand, as `apps/desk` did with its `$pending`
    box and its own replay, and a refetch under it either erased the guess
    or was lost.
    - The realm keeps a stack of visible stages. For the length of each
      outermost `Realm.update`, every box, collection, and key the stack
      covers holds its base value and base version again; after the recipe
      it holds the shown values. Both swaps are raw `BoxCell.restore`
      calls outside the update's record. So a recipe reads and writes the
      base, a rollback restores the base, a `"fail"` stage records base
      versions, and a change record holds base values only: showing or
      withdrawing a guess is no write. A `Realm.update` recipe reads the
      base even when the screen shows a guess, because a recipe that added
      1 to a shown 11 would leave 12 in the base after the guess dropped.
    - Every stage call (`Stage.update`, `Stage.read`, `Stage.realmRead`,
      `Stage.apply`, a visible stage's `Stage.drop`) and
      `Collection.onRowChange` registration runs inside a `Realm.update`
      while a stack is open, so a stage reads the base through the read
      paths ruling 53 built, with no lookup of its own. The four probes the
      spike failed (a false conflict, a missed conflict, a guess left after
      `Realm.dispose`, `Stage.realmRead` returning a guess) were one fault:
      a stage call read cells holding shown values.
    - After an update that changed an input of a showing stage, the stack
      replays from the lowest such stage: each recipe runs again over the
      base and the showing stages below it. A shown value equal to the one
      shown before keeps its version, so an update that moves nothing under
      the stack notifies nobody. A visible stage reads the stages below it;
      a hidden stage and `Stage.realmRead` read the base.
    - A stage that `Stage.apply` would throw on (a conflict under
      `"fail"`, or a recipe that throws on replay) stops showing for good:
      `Stage.inspect(stage).showing` turns `false`, the stages above replay
      without it, its status stays `"open"`, and the update that moved the
      base does not fail. The error is kept as `failure`; `Stage.update`,
      `Stage.read`, and `Stage.apply` throw it, and `Stage.apply` also
      drops the stage. A recipe's own throw also reaches `onError` once,
      when the stage stops, because in the answer-wins flow nobody applies
      the guess; a `StageConflictError` does not.
    - Under `"fail"`, a read of a box a lower visible stage covers records
      the base version, so the upper stage conflicts when the lower one
      applies. A conflict is a change to the base, never to another open
      stage.
    - An atom marked in a visible stage marks when the mark enters the
      shown set and when it leaves by a drop or a stop; `Stage.apply` of a
      shown mark marks nothing more.
    - `visible` on a child stage, or a value that is not a boolean, throws
      `PinnaUsageError` `pinna/stage-visible-option`: a child has no place
      in the stack, and a second root stage does the same work.
      `pinna/view-staged-rows` counts hidden stages only, since a view made
      under a guess registers inside an update and the stack replays
      through it.
    - `Realm.dispose` takes the stack off in one step and puts the base back
      in every covered cell, so a read after disposal returns confirmed
      values. `testRealm` reports a visible stage left open.
      `Stage.inspect` gains `visible`, `showing`, and `failure`;
      `Source.inspect` gains `stages`, the names of the showing stages over
      a box, bottom first. `baseOf(box)` in `src/internal` reads a covered
      box's base for the change stream. No React hook: the shown values are
      in the graph, and a pending marker is a box the guess itself writes.
    - `pinna-effect`'s `Stage.scoped(realm, section, { visible: true })`
      shows the scoped stage while the section runs (the guess is the
      answer); `{ guess: recipe }` shows `recipe` in a visible stage, runs
      the section in a hidden one, and on success applies the answer and
      drops the guess in one `Realm.update`, so a watcher sees the settled
      value once (the answer wins). Failure and interruption drop both.
      `guess` with `visible`, or either over a stage, throws
      `pinna/stage-visible-option`. A `StageConflictError` from any call on
      the scoped stage fails the effect.
    - `StageConflictError`'s message no longer names `Stage.apply`, since a
      stopped stage throws it from three calls.
    - Cost: nothing while no stack is open (one field test at depth 1, at
      the start and the end of `Realm.update`; `increment`,
      `write-sources`, `one-write-among-many`, and `fan-out` are within
      launch noise on Node). With a stack open, a call swaps O(covered
      cells); an update that changes a stage's input replays the stack
      from that stage. A collection a guess wrote is copied on each replay:
      100,000 rows cost 3.4 ms per base write under one guess on Bun 1.4.4.
      The design record is `docs/design.md`, "Visible stages".
    - Amended 2026-11-26 (the install rule, slice 3 of the 0.2.0 fix
      plan): no application code runs between the first and the last raw
      write of a swap. `Stack.show` plans every `equals` call before any
      raw write, and an `equals` that throws reaches `onError` after the
      outermost update, as a stopped stage's error does; a handler's
      `Stage.drop` under the walk was lost before. The collection key rule
      this slice found is ruling 75. The stage fuzz gained the vocabulary that would have found the D6
      findings, and 20,000 seeds ran clean.
69. **The change stream** (2026-11-25, the owner unparked it as the base
    for devtools, replay, undo, and logging; designed the same day,
    in the change stream design note; amended by 74). `Realm.onUpdate(realm, listener)` hands one
    frozen `UpdateRecord` per landed outermost update, `{ name, stages,
    boxes, collections, atoms }`; `write.replay(record)` and
    `write.revert(record)` apply one forward and backward;
    `Program.updates(realm)` is the Effect form. Without it, every tool that
    reads writes as data wraps `Realm.update` itself, and undo rebuilds the
    collection rules by hand.
    - Net per outermost update. A nested update joins its outer one's
      record, a failed update makes none, and an update that changed
      nothing makes none. A box is one entry from `valueBefore`, which the
      update already keeps, to its value at the end; a box back at
      `versionBefore` is no entry. A row is one entry from the row it had at
      the update's start, kept per key on the first write while a listener
      exists, to its row at the end.
    - Base values only, agreed with the stages design. A visible stage
      shows by raw swaps outside `recorded`, so a box's first write records
      the base; at the end the record reads a covered box and a covered
      collection's rows through the stack's base. Showing, updating,
      dropping, and disposing a guess make no record; an atom a guess shows
      or withdraws is marked raw (`AtomCell.mark`). `Stage.apply` adds its
      stage's name to `stages`, and a shown atom it lands is in `atoms`,
      though it marks nothing again.
    - `Realm.update(realm, recipe, { name })`: the outermost update's name
      is the record's; a nested one's is ignored, as its batch is. The
      stages thread preferred stage names alone; the name was kept, since
      without it a record of an update outside a stage says only what
      changed.
    - A box by identity, never a path: a realm cannot enumerate its boxes
      (ruling 64), so only the code that declared a shape holds paths, and
      it maps them.
    - A collection is one `CollectionChange`; its own boxes (`order`,
      `changes`, a row's cell) are a `CollectionCell` subclass and never in
      `boxes`. `keys` is set only when the order's box moved.
    - Delivery after the update's watchers ran, outside any update, in
      landing order, from a queue drained where `Realm.update` returns at
      rest and as `Realm.autorun` returns; a listener may update, and its
      record queues behind. A record queued where no update encloses it (a
      hook's update in a settle that a renderer started) goes out at the
      next landing or in a microtask. No scheduler option: every record is
      needed, so nothing coalesces.
    - `write.replay` and `write.revert` are writes: a box gets `after` or
      `before`; a collection whose order moved gets `write.replaceAll` in
      that order with each unchanged key's row as held; one whose order did
      not move gets `write.upsert` or `write.remove` per row, keeping
      positions; an atom gets `write.changed`. A key the order needs that
      neither side holds throws `PinnaUsageError`
      `pinna/record-not-applicable`. Both work in a stage recipe.
    - Lifecycle as every listener (ruling 57): the stop is idempotent, the
      realm registers it, `testRealm` reports it, `Realm.dispose` stops it
      and drops queued records, `Realm.dispose` from a listener throws
      `pinna/dispose-not-at-rest`. A listener's error goes to `onError`.
      Refused where `Collection.onRowChange` is refused. No React hook: a
      record is for tools, not a render.
    - `Program.updates` buffers without bound, since persistence that skips
      a record loses data.
    - Cost: nothing kept while no listener exists. An update pays one store
      for its name at depth 1 and one field read at its end and after its
      batch; a row write and an atom's change pay one field read. With a
      listener, a row's first write per update keeps its before in a map
      with an undo entry, and the end walks the boxes written. Node
      benches are in `docs/design.md`, "Change stream".
    - Limits: a computed value is not recorded (replaying its sources
      reproduces it); an atom carries no value; a bridged value
      (`Computed.fromPromise`, `Program.fromStream`, `Program.fromEffect`) is
      its atom alone; a record lives for one session.

70. **Devtools** (2026-11-25). Kept in the private repository with
    `pinna-devtools` and `pinna-devtools-react`, which are not published.

71. **An open question is decided by the first test that answers it**
    (2026-11-25; the owner asked for the rules that settle a design
    question, and for the questions not to reach the owner). A question is
    open when no ruling, no settled point, no sentence under `docs/public`,
    and no dated word of the owner answers it. The agent that meets one
    decides it by the tests below, in order, records the decision with the
    number of the test and the alternative it lost to, and builds on. A
    design and a build end on "Decisions taken"; neither ends on "Questions
    for the owner". The owner reopens any decision by word (rule 11 of
    `AGENTS.md`). Before it, each feature ended on a list of its own: 35
    questions stood open on 2026-11-25, and 33 of them were one of five
    questions asked again per feature.
    - **What still goes to the owner.** An action under absolute rules A
      to E; a decision that reverses a ruling or the owner's dated word; a
      bend of a hard rule (4 and 8 of `AGENTS.md`); a change to what Pinna
      is for (`README.md`, "What it is for"). Nothing else waits.
    - **Test 1, answered already.** A ruling, a settled point, a sentence
      under `docs/public`, or the owner's dated word that covers the case
      decides it, read by its purpose (ruling 55). A build default that
      departs from one is a bug (ruling 67), not a question.
    - **Test 2, out of scope.** A server data cache, persistence,
      asynchronous work with its status (loading, submitting, retrying),
      and time (a clock, a named timing) belong to the application or to
      what is built on Pinna (the owner, 2026-11-23). Pinna gives each one
      bridge: a box a `Source.onObserved` hook writes, a value from a
      promise or a stream (ruling 65), a record from `Realm.onUpdate`
      (ruling 69), a `scheduler` function (ruling 58). An option that
      holds such state inside Pinna is out.
    - **Test 3, no silent wrong value.** The finding is classified by
      ruling 67 first. In normal use, an option under which a call returns,
      keeps, or shows a wrong value with no error loses to an option that
      throws, whatever the throw costs in convenience. A limit is a throw
      that names the limit, listed in the docs with its reason ("Done" in
      `AGENTS.md`). An edge gets a type, a removed state, a throw at a
      check that already runs, or one sentence, and no other code.
    - **Test 4, one form per kind.** A new thing takes the form its kind
      already has, and where two forms do one job, one goes (rule 7).
      - A read or a write goes through the `read` and `write` a place
        hands out, never a method (ruling 43). An operation that is a read
        or a write applied across something is a property of the verb:
        `read.row`, `read.snapshot`, `write.restore`, `write.replay`.
      - A member sits on the module of the type it takes first (ruling
        62). An Effect form sits beside its plain twin with the `Scoped`
        suffix (ruling 49); a stream, or a value an Effect feeds, sits on
        `Program`. A member takes a module or a package of its own when
        its code would load for callers of the host module who never call
        it and do not load that code anyway (ruling 63, `View`).
        `src/internal` is for the packages of this repository alone.
      - A thing that runs (a watch, an autorun, an observation, a hook, a
        listener, a view, a stage, a bridged value, a devtools session) is
        made by one call, which returns a plain stop function, or a handle
        with `dispose` and `status` when its state can be asked. Stopping
        twice does nothing. Once stopped, no callback of it runs again,
        a delivery in progress included. A watch's effect and a listener
        return nothing, and a returned value is an error; an autorun's
        body and a `Source.onObserved` hook return nothing or their
        cleanup (rulings 34 and 21). The realm registers it,
        `Realm.dispose` ends it, and `testRealm` reports one left running
        (ruling 57).
      - An error that code handles has its own class and goes to the
        caller alone. Misuse is a `PinnaUsageError` with a `code`, thrown
        at the call (ruling 56). A throw from the application's own
        function goes to the caller whose call ran it, and to `onError`,
        once, when no such caller is on the stack (rulings 13, 24, 58).
        A hook, a hook's cleanup, and an autorun's cleanup always go to
        `onError`, whoever is on the stack, so the caller always gets its
        release (rulings 27 and 34). A later call that cannot do its work because of that throw
        throws it again: that is a refusal, not a second report. Pinna
        writes no warning (ruling 12) and nothing to the console.
      - A name is whole words (rule 5), one term per concept (rule 10),
        and anything an error, `inspect`, or a record can mention takes
        `{ name }`.
      - One behavior in every build: no check, freeze, or message that one
        build runs and another skips.
      - A guess has one reading per place. A tracked place and a read at
        rest read the shown values; an update, a record, and a conflict
        read the confirmed values (ruling 68). No call has both meanings,
        and no second call reads the other.
    - **Test 5, a companion or a capability.** A companion is in without
      an ask, and a capability is out until one. This is where rule 7 ("no
      speculative API") meets rule 11 ("the complete option") and "Done".
      - A companion: without it, a call the docs show returns a wrong
        value, leaks, has a state that cannot be asked, starts something
        that cannot be stopped, or sends normal-shaped code (ruling 67) to
        `src/internal`.
      - A capability: a name, an option, a type parameter, or a state that
        lets code do what it could not do. It is in when the owner asks
        for it, or when a package, an app, or a contract test of this
        repository cannot be written without it. Otherwise it is out, and
        its ruling lists it under "Out" with the application code that
        replaces it.
      - What is built stays while code of this repository outside its own
        tests calls it, and goes when nothing does.
      - Before 1.0 an addition and a removal each cost one codemod (ruling
        18 and `scripts/codemod`), so "decide before the API freezes"
        weighs nothing.
    - **Test 6, the cost falls on the feature's callers.** A realm that
      does not use a feature pays at most one field test where
      `Realm.update` begins or ends, and nothing on `read`, `write`, or a
      recompute (rulings 68 and 69 hold to it). A guarantee for normal use
      may cost on the feature's own path, with its bench attached. An edge
      earns no runtime cost (ruling 67). A tool adds no branch to a path
      an application runs without the tool. Rule 8 is not traded. The
      measure is Hermes: no hot path more than 5% slower than `main`, and
      memory no worse (the owner, 2026-11-25).
    - **Test 7, still open.** The conservative option is taken and
      recorded as "open", with the evidence that would change it.
      Conservative means, in order: the option that throws over the one
      that returns; the one that adds no name; the one a later change
      reverses without changing a public name. This is the order ruling
      67 left unnamed.
    - **What ships** is decided apart from the tests. Packing and
      publishing are two acts. A package is packed for a release
      candidate once `bun run verify:pack` passes. It is published to npm
      when it has a ruling, that ruling states each departure from
      "Done", code outside its own tests has used it (an app of this
      repository, or an application built on Pinna), and the owner asks
      for that publish (rule A). Until then it keeps `"private": true`,
      which npm itself refuses to publish.
    Amends 67, whose "most conservative default" is test 7, and rule 12
    of `AGENTS.md`, whose stop for a non-bug fix becomes test 6.

72. **The open questions of 2026-11-25, decided** (2026-11-25, by ruling
    71; the open questions note holds each of the 39 with its test, its
    alternative, and the build list). The decisions that change a ruling,
    a call, or a package:
    - An `UpdateRecord` and a devtools entry are not frozen (test 6: the
      types are `readonly`, so a change needs a cast, an edge; freezing
      cost 2 to 4× the listener path on JavaScriptCore). Freezing in
      development alone is ruled out by the settled point on one
      behavior. Amends 69 and 70 once built; until then both freeze.
    - Every listener stops alike (test 4): a `Collection.onRowChange`
      listener a sibling stops during a change hears nothing more, that
      change included, as a watch stopped while due does not run; and a
      `Realm.onUpdate` listener that returns a value is an error to
      `onError`, as a row listener's is to its writer. The asynchronous
      consumer of records is `Program.updates`. To build.
    - `write.replay`, `write.revert`, and `Realm.update`'s `{ name }` stay
      (test 5: `pinna-devtools` calls each). `read.changes(shape)`,
      `Symbol.dispose` on a stop function (ruling 52 measured it),
      `Form.group` with dependencies, typed issue codes, an `included`
      rule on a list item, a recompute feed, writes from the devtools
      panel, a recording loaded in another session, and `View.grouped`
      for groups past 10,000 keys are out (tests 2 and 5).
    - `watchScoped` moves from `Realm` to `Program`. Decided first as
      staying on `Realm` (tests 1 and 4: ruling 62 puts a scoped form
      beside its plain twin), open until measured, and moved by the
      condition that decision named: on `Realm`, it added 21,047 bytes
      minified (6,787 gzip) to an entry that makes a realm, runs one
      Effect, and never calls it, against about 430 bytes of its own
      code (2026-11-25, measured in the API redesign note). The rest is Effect's
      `Queue` and fiber code, which `Program` holds for the same reason
      it holds `Stream`. Test 6: the cost falls on the callers of
      `watchScoped`, not on every application that makes a realm.
    - `@frondruntime/pinna/testing` gains `atRest(realm)` (test 5: the
      contract tests reach `src/internal` for it). A plain `Model.Schema`
      field named `__proto__` is a usage error where the class is defined
      (test 3). `pinna/foreign-realm` names a second copy of Pinna. To
      build.
    - `pinna/view-staged-rows` stays (test 3: a throw over a stale read
      through the view). Open: the core rewrite's layers may let a
      listener made under a hidden stage hear the staged rows.
    - A disabled form part is submitted (test 1: the forms page says
      so; `included` is the one way to leave a part out). A guess whose
      recipe throws on replay goes to `onError` once and is thrown by
      `Stage.apply` (test 4: a refusal). A `Devtools.jump` that forks the
      log gives no warning (test 1, ruling 12).
    - `pinna-form`, `pinna-devtools`, and `pinna-devtools-react` keep
      `"private": true` and are packed for a release candidate, not
      published ("What ships"). `next` merges to `main` as one pull
      request after the core rewrite lands in it, and the public mirror
      and npm follow at 0.1.0, each on the owner's word (test 1: the
      path agreed on 2026-11-25).
    - The core rewrite stays a rewrite of the state layer over the
      graph's algorithm. Open: the brief said "ground-up"; a hot path
      over the Hermes bar that the state layer cannot bring back is the
      evidence that reopens the graph.

73. **The core rewrite** (2026-11-25, the owner asked for the state layer
    rebuilt on one set of parts; the core rewrite design note). The graph's
    algorithm stays; the state layer around it is rebuilt, and the contract
    suite passes unchanged at every stage.
    - **The place word.** Where code runs is one integer, `Graph.place`,
      entered by `nextPlace` and restored on exit; each question is one mask
      test (`placeAllows`). It replaces six fields the realm and the graph
      inferred it from. The error that names a computing value reads
      `active` or `shadowed`, so a compute writes no extra field.
    - **One journal.** The realm's undo and a stage session's undo are one
      class, `Journal`, of `(target, a, b, c)` steps; no closure per write.
    - **The key order in place.** `keys` stays the order box. Its array
      changes in place while nothing holds it; a read of `keys`, a stage, the
      visible stack, or an update listener hands it out, and the next change
      copies. A computed `keys` was rejected: a derived value cannot put back
      its version on a rollback, so autoruns reran after a rolled-back update,
      and `Source.onObserved(keys)` broke a contract test.
    - **A stage's rows are a patch** (`RowPatch`), with per-key copy-on-write:
      before a key changes beneath it, the patch keeps the row it had. The
      design's live read was rejected by the contract test that a stage keeps
      the rows it began with ("copied collection provenance"). The order is an
      `OrderPatch`.
    - **The visible stack patches the held rows in place**, at the keys it
      wrote, and reads the base through a view at rest.
    - **Begun hooks are the graph's**; the realm keeps no wrapper. The record
      is built in `record.ts`. Sibling packages reach a realm through the
      internal entry's functions (`graphOf`, `reportAside`, `currentPlace`,
      `readerNow`, `writeNow`, `onDispose`), never its fields.
    - Not built, for the hot paths: `decide`, `makeWrite` and `makeRead`, and
      one `RowTarget` for the realm and a stage. They route `BoxCell.write`
      and the realm's `upsert` through shared code, and the 0.1.0 bar is no
      hot path more than 5% slower than `main` on Hermes. Revisited after
      Hermes run 2.
    - Cost: `bench:memory` unchanged. Node, against `next`: the graph
      scenarios within +3%. `bench:rows` at 100,000 rows: an add 0.86 µs
      (from 461 µs), a remove 12 µs (from 137 µs), a hidden stage 9 µs (from
      4.0 ms), a base write under a guess 5.3 µs (from 2.79 ms)
      (`docs/performance.md`, "The core rewrite's row probes").

74. **Restore once** (2026-11-26; amends 69. The 0.2.0 review's
    "The amended restore design"; the owner approved that row listeners
    stay silent on undo and redo when the record holds what they wrote).
    `write.revert` and `write.replay` installed a record's endpoints and
    also ran every row listener again, so a listener that wrote another
    collection the recipe had written first left it wrong (probe P3), and
    a record applied out of order installed a stale sum or order with no
    error (P1, P2).
    - **Check before writing.** A revert requires every recorded box and
      row to hold its `after` now and a moved key order to equal its
      `after` key by key, all by `Object.is`; a replay requires each
      `before`. A mismatch throws `pinna/record-not-applicable` before the
      first write. Cost: one pass over the record, on the restore's path.
    - **A serial per listener.** A collection counts its
      `Collection.onRowChange` registrations; each listener keeps the
      count after its own. The record's update keeps each collection's
      count at its end in a `WeakMap` keyed by the `CollectionChange`, so
      the public record keeps its shape. On restore, a listener hears a
      row change only when its serial is above that count: an older one
      stays silent, since the record holds what it wrote; a later one,
      a view's included, hears it through the normal path. Amends 69's
      "are writes": a restore is still a checked, journaled write that
      works in a stage recipe, rolls back whole on a throw, emits its own
      record, and notifies observers, but it runs only later listeners.
    - **Writes in the built order**: collections, then boxes, then atoms,
      so a recorded value wins over what a later listener wrote to the
      same box.
    - **A later listener cannot move a restored collection.** Once every
      collection is written, each recorded row and moved key order is
      compared with what that collection's own restore left; a change
      throws `pinna/record-not-applicable` and the update rolls back. A listener
      added after the record that hears one collection's restore can
      write another collection already restored (found in review:
      a replaced `b.x`, then an inserted `a.x`, and a later `a`
      listener that removes `b.x` on removals left `b.x` absent after a
      revert). Writing the collection again would run its later listeners
      again with no bound, and landing the wrong row is a silent wrong
      value (ruling 71 test 3). Cost: for a record of two or more
      collections, an array per collection and a second pass, on the
      restore's path only.
    - **A restore is not a refetch.** `write.revert` and `write.replay`
      install each recorded row by identity: the collection's merge
      (ruling 51) and its `equals` are off while its part is written, so a
      `Model.Schema` row comes back as the object the record holds, not
      merged into the one held, and a later listener hears the recorded
      objects. The row's boxes come back through the record's box changes.
      A merge is for data arriving from outside; merging a restore kept
      the newer object, so a revert of an older record then threw
      `pinna/record-not-applicable` on identity (test 3). Cost: two field
      swaps per recorded collection, on the restore's path; `write.upsert`
      and `write.replaceAll` read the same fields as before.
    - **A view is in no record and hears every restore.** A view's state
      box is a `CollectionCell`, and a collection `View.grouped` or
      `View.totals` keeps has `inRecord` false, so neither appears in a
      record's `boxes` or `collections`; both stay journaled and staged.
      A view's listener entry takes no serial a record counts, so it hears
      every restore and updates from the row changes. A view's state is a
      function of its rows and options, kept by a deterministic,
      incremental listener, so it needs no recorded endpoint: P2's revert
      applies and the view follows the rows, a view made at rest or in an
      update makes no record and no refusal, and records stop handing a
      view's tree objects to devtools and `Realm.onUpdate`. The design
      review of 2026-11-26 held the proposal's storage exclusion right and
      its rebuild on restore unneeded.
    - **A listener registered inside an update is refused.** A record
      whose `Realm.update` added a `Collection.onRowChange` listener to a
      collection throws `pinna/record-not-applicable`, rows changed or
      not: its writes mix with the recipe's, and its `before` holds the
      listener's state from before it existed. The design review's rule named only an
      update that also changed the collection's rows; the change stream
      fuzz found the same wrong value with no row change, so the purpose
      decides (ruling 71 test 3).
    - **A listener registered at rest restores.** The update
      `Collection.onRowChange` opens at rest for its replay keeps the rows
      the listener heard with its record (a `WeakMap` by record). Its
      revert writes nothing, since the listener still runs and older
      restores reach it; its replay writes each `after` again, the objects
      the listener first built, which the later records hold. Both check
      the rows first. Refusing it (test 3) lost to test 5: `pinna-devtools`
      and an undo stack walk the log, and every listener added lazily would
      be a wall. Writing nothing on replay lost to test 3 as well: a
      listener that heard an older restore holds a new object, and every
      later record's check would throw.
    - **Only a record the realm made.** `write.revert` and
      `write.replay` take only a record `takeRecord` built (a `WeakSet`);
      any other object throws `pinna/record-not-applicable`. What the
      realm keeps beside a record, the listener counts and the marks
      above, is keyed by the record and its changes, and a copy such as
      `{ ...record, name }` drops part of it and restored a wrong count
      (the 0.2.0 review, test 3; ruling 69 already has a record
      live for one session and name boxes by identity).
    - Rejected: a realm-wide listener generation (refuses undo after an
      unrelated listener is added; `apps/desk` adds one per
      `PositionBook`), rebuilding views on restore, and running every
      listener and throwing when the result differs from the record (P3's
      undo becomes impossible instead of wrong).
    - Not covered: state a listener keeps outside Pinna is not restored.
      Open (test 7): a listener added after some records that keeps an
      object in a box builds a new one when it hears their restore, so a
      later record's replay throws when no registration record puts the
      first object back: a listener added to an empty collection, or one
      whose registration record a fork of the history dropped.
75. **The 0.2.0 review, consolidated** (2026-11-26; the 0.2.0 review
    and the fix plan's slices 0 to 5). The slices wrote their own
    rulings (74, and the 2026-11-26 amendment of 68); this one holds what
    they left open between them, and lists what a user can observe that
    changed.
    - **Amends 39.** `useValue` and `useValues` subscribe when React
      subscribes, and `useValue` adopts its capture in React's own
      `subscribe`, with no layout effect; `useValues` and `useSelect` keep
      the layout effect, with `[store, capture]` deps. Every hook returns
      the value its render computed as the snapshot, from a capture of the
      render that nothing observes until React commits that render
      (`docs/design.md`, "React hooks"). The ruling's "know what they read
      before the render" holds, and a render React throws away no longer
      moves a subscription.
    - **`Capture` and `Reaction.follow` are `pinna-core` additions** (test
      5 of ruling 71: complete, not speculative). A value-returning
      `getSnapshot` needs a run whose reads are recorded with their
      versions and observed by nothing, and a commit that moves a
      reaction's edges to that record. The pending node `trackPending`
      reused could do neither without observing, which is what restarted a
      `Computed.fromPromise` request in a render React discarded. Both are
      raw core API, as `Reaction.adopt` is; `pinna` and `pinna-effect`
      export neither. A stated limit of the core API (an edge, ruling 67):
      `Capture.changed` sees writes, not an unobserved atom's outside
      value; `Reaction.follow` or `Reaction.activate` decide that, and the
      hooks decide only through them.
    - **The collection key rule.** Keys are equal as a `Map`'s are: `NaN`
      matches `NaN`, and `0` matches `-0`. A collection stores a key as its
      `Map` does, so a row keyed `-0` is held under `0`, and `keys`, a
      view's keys, a row listener's `key`, and a record's row `key` hand out
      `0` on every path, base or staged. Before, the order kept the sign of
      a key's first write, a view and a listener the sign of the latest
      row, and a record the `Map`'s `0`: one row, keys `Object.is` told
      apart. This reverses what review finding D5-3 expected, which was the
      first-written sign. The write paths (`upsert`, `write.remove`, their
      staged twins, `replaceAll`, the constructor) normalize inline,
      `key === 0 ? 0 : key`, off the `keyOf` wrapper, since Hermes pays for a
      call it does not inline; the wrapped `keyOf` stays for snapshots,
      views, and stage patches.
    - **The depth budget replaces the rebuilt-chain rule.** A read that
      stops past `maximumComputeDepth` (256) runs its value again at most
      `maximumRestarts` (64, in `graph.ts`) times within one outer read,
      then throws `pinna/depth-rebuilt`. The earlier rule refused the first
      retry that stopped at a value it made, so a root that made a second
      kept deep branch on its retry threw. A compute that makes and keeps
      one deep chain per run finishes in chains + 1 runs, so it reads up to
      63 kept chains; one that rebuilds a chain on every run throws after
      65 runs. Open (test 7): the conservative option, a budget, was taken
      over the alternatives, no limit (a rebuilt chain never ends) or a
      larger one (more values made before the throw). A test ties the
      numbers in `errors.md` to `graph.ts`.
    - **A record is an identity, not a shape** (the reviewer, 2026-11-26).
      A copy, a serialized record, or a hand-made one is refused with
      `pinna/record-not-applicable` (ruling 74; test 7). Devtools export or
      import of a history, if it ever comes, needs its own design and is
      not implied by this one.
    - **Edges recorded, not fixed** (ruling 67), each with one sentence
      under "Some mistakes are not caught" in
      `docs/public/start/principles.md` and a test that pins the current
      behavior: D2-3 and D2-4 (`Reaction.adopt` of the raw core from a
      derived value, and inside the reaction's own `trackPending` run), D3-3
      (`Model.restore` or `Collection.reconcile` from a nested watch's
      select), D4's `write.modify` draft stored in a new `Map`,
      `Capture.changed` over an atom nothing observes (it answers by
      writes alone; `Reaction.follow` and `Reaction.activate` see the
      atom), and D2's
      named comparator: a misuse inside the `equals` of a named
      `Computed.make` still throws loudly, but with the generic label "a
      derived value", since naming the computed value would need a store on
      each recompute that has an `equals`. Each of the first four would
      cost a check on a path ruling 71 test 6 closes; the `Capture.changed`
      limit keeps a renderer's snapshot stable, since a walk would call an
      unobserved atom changed at every call; the comparator's loud
      error with a weaker label is an edge, and its label is not worth that
      store.
    - **Public contract changes in 0.2.0 from this review.** Every one is
      in `docs/public`.
      - New errors, all in `docs/public/reference/errors.md`:
        `pinna/depth-rebuilt`; `pinna/draft-of-another-recipe` (an outer
        `write.modify`'s written draft assigned inside an inner one);
        `pinna/draft-in-write` (a `Box.schema` or `Model.boxField` written
        with a draft of an open `write.modify`); new messages of
        `pinna/record-not-applicable`: a record the realm did not hand out,
        a box, row, or key order that no longer holds the record's side, a
        record whose update added a `Collection.onRowChange` listener, and a
        collection that no longer holds the rows a listener heard.
      - `write.revert` and `write.replay` check the record first and write
        nothing on a mismatch; listeners registered before the record's
        update ended stay silent, and later ones hear the restore (ruling
        74); a registration inside an update makes a record that
        is refused.
      - A collection key `-0` is stored and handed out as `0`.
      - A draft copy keeps a prototype, `null` included, symbol keys, and a
        match array's `index`, `input`, and `groups`; a model field key may
        be a symbol; a snapshot walks symbol keys and keeps an empty
        array slot.
      - A `Collection.make` collection remembers that it holds model rows
        once a snapshot or a restore finds one, so plain data then throws
        `pinna/restore-cannot-make-row`.
      - A stage's `equals` runs before any raw write of a swap, and its
        throw reaches `onError` after the outermost update; an atom mark of
        a failed `Stage.apply` is withdrawn; a fail stage counts an atom's
        confirmed changes and a first read of a replay joins the reads at
        its confirmed version; `Stage.update` before the section returns
        its Effect throws the conflict as the Effect does.
      - A disposed view keeps the confirmed order, not a stage's.
      - `Computed.fn` returns the first of two entries made for one
        argument list before either was observed, and the second once the
        first is released.
      - React: every hook returns what its render computed and a render
        React discards moves nothing ("A render and its commit",
        `docs/public/react/hooks.md`); `useValues` keeps its array
        when equal values move to other observables; `useSelect` renders
        again only when its result changes.

## Build slices

Built in order, each with its tests: 0, housekeeping (Effect 4.1.0, the
`check` script); 1, a realm per instance; 2, the conformance suite against
the shared reactivity cases and MobX's; 3, differential property tests
against alien-signals and MobX, and benchmarks with thresholds; 3b, a reader,
replaced by ruling 43; 4, React; 5, equality and keyed data; 6,
`Computed.fn`; 6b, a clock, removed by ruling 36; 7, the Effect
programs; 8, introspection; then a value from a stream, a testing entry, and
packaging.

## Out of 1.0

A locale box and a MobX bridge; the form kit is ruling 66. From MobX: `flow`, `when`
outside the Effect programs, `intercept`, `spy`, `configure`, deep
observables, and the `is*` predicates.
