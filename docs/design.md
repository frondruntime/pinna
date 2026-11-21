# Pinna design

Status: v0 (`api.md`, ruling 18). Everything described here is built and
tested. The state is boxes and computed values read and written through
the verbs (`api.md`, ruling 43); the live objects of earlier drafts are
gone. Open questions are at the end.

## Why

MobX solves the right problem with too many surfaces: `observable`,
`makeObservable`, `makeAutoObservable`, decorators, `extendObservable`,
`computed`, `computedFn`, `action`, `runInAction`, `reaction`, `autorun`,
`when`, `onBecomeObserved`, and mutable proxies whose behavior changes with
subclassing and field redeclaration. Pinna keeps the semantics people rely on
(granular reads and updates, getters that cache, watchers, observation-driven
lifecycles, React hooks that rerender on what a component read) and draws hard edges around them: one way to
declare a model, one way to write, and errors instead of silent misuse.

Effect's `Atom` was considered as the base. Its recompute is eager and
depth-first, so an unbatched write glitches a diamond (`bench/diamond.ts`).
Pinna owns its graph and uses Effect for the model layer.

`Atom` was measured once more on 2026-11-14, `effect` 4.1.0, through a
`pinna-bench` adapter that is not kept in the repository. The decision stands
on memory alone, since applications on Pinna ship on Hermes:

- **Retained memory, Hermes, 10,000 units, rough tier.** A box keeps 1,579
  bytes on `Atom` and 528 on Pinna; a box with a computed value 2,109 and
  1,305; a watched one 4,813 and 1,809. The adapter adds one atom per watcher,
  and without it the watched figure is 2,949.
- **Speed, publish tier, median of 5 launches.** On Hermes (hermes-ios 0.5)
  `Atom` takes 2.0 to 4.6 times Pinna's time on eight of the nine graph
  scenarios, about level with MobX, and 34 times on bursty fan-out: 5,430 ms
  against 161. On Node 26.13.1 it takes 3.0 to 6.8 times on the eight, and 22
  times on bursty fan-out. Inside `Atom.batch` every write queues each
  dependent again, stale or not (`AtomRegistry`, `propagate`), so one batch of
  100 writes to a source with 1,000 dependents queues 100,000 entries.
- **Allocation per write, rough tier.** One write to the deep chain allocates
  898,147 bytes on `Atom` and 422 on Pinna on Hermes; one write to the fan-out
  1,866,691 and 588.

What it does differently from Pinna, beside the diamond above:

- **A failed batch keeps its writes.** What `Atom.batch` wrote before its
  callback threw stays written.
- **A write is not checked.** `Atom` uses Schema to store and to serialize a
  value, not to check one on a write.
- **The deep chain sits at Node's stack limit.** Its first build recurses
  once per level. The speed run passed with the adapter's read inlined; the
  memory run overflowed the stack and passed with `--stack-size=4000`. Hermes
  ran both as is.

Neither library leaks.
The question is closed unless `Atom` changes on a write.

## Principles

1. **Glitch-free by construction.** Push marks, pull validates. A derived
   value checks its sources' versions, in read order, before it recomputes.
   Watchers run after the write settles.
2. **Reads are explicit.** What can change is a box, a computed value, an
   atom, or a collection, named with a leading `$`. An observable has no read
   or write methods: every
   place hands its function a `read`, and `read($x)` subscribes that place.
   There is no `read` outside a place; one kept past its place throws once
   no place of its realm is open (see the limits below).
   Values are plain `readonly` data.
3. **Writes are bounded.** A box changes only inside `update`, through
   the `write` it hands out: `write($box, value)` or a draft from
   `write.modify`. A `write` kept past its update throws, and the types
   agree: values are `readonly`, `Draft<T>` is writable.
4. **Misuse is loud.** Writing outside `update`, or starting an update in
   a computed value, a watch's select, or a selector, throws and says where
   to write instead. An autorun's body may update; one whose writes never
   settle stops at the round limit and reports it.
5. **Observation is a lifecycle.** A source is live while observed.
   `onObserved` is the one hook for starting and stopping work.
6. **The graph imports nothing.** `packages/pinna-core` has no runtime
   dependencies.
   `effect` is a peer dependency of the package entry, for Schema classes.

## The graph

`packages/pinna-core/src/graph.ts`: cells, derived values, reactions, `watch`, `batch`,
`untracked`, `onObserved`.

- A write marks dependents dirty; nothing recomputes until read.
- A reaction links to its sources only while active, so an unobserved derived
  value holds no subscriptions and can be collected.
- A derived value with an equality cutoff stops propagation when its result is
  unchanged.
- A derived value that throws caches the error and keeps the sources the
  throwing run read. Reads rethrow it until one of those sources changes.
- A derived value that reads itself throws a cycle error. Only the value the
  cycle began at keeps it, with every read on the way to the cycle.
- Watchers run after the write settles, in rounds, in the order they were
  marked; a watcher's writes run in the next round. A watcher's error is
  passed to the realm's `onError`, the host's `reportError` by default, and
  the other watchers still run: the write has
  landed, so `update` throws for it only when `onError` itself throws, and
  then with the writes in place. Watchers that keep writing are
  stopped after 100 rounds, reported the same way. Watchers that the
  realm's `onError` sets writing while it handles that report are stopped
  after 100 rounds too, without a second report. `onObserved` hooks count
  the passes that begin a hook: after 100 of them, hooks still due are
  left due, with none of their hooks or cleanups run, and reported as hooks
  that did not settle, not as watchers, even when the watchers their writes
  set going reach their round limit first. The next flush goes on from
  there under the same limit, so hooks that never settle are reported
  again at each flush. A pass that only runs
  cleanups does not count: every cleanup ends a hook that began earlier, so
  a chain of cleanups that each stop the next observer settles however long
  it is. A `computedFunction` entry cached inside a cleanup does not count either. The limit
  bounds how deep hooks start one another, not how many begin in one pass:
  a chain of hooks that each start the next is cut off after 100 links.

How the core runs:

- Each node is a plain object literal with no prototype, so every observer
  kind shares one shape and cells and atoms share another. Functions take a
  node by its kind (`readCell`, `readDerived`, `writeCell`); the realm's
  box, computed value, and atom classes each call their own kind's read.
- Each pair of a source and an observer is one edge. It sits in the
  observer's list of dependencies, in read order, and, only while the
  observer is observed, in the source's list of observers.
- A run reuses the edge at its cursor when it reads what it read last time,
  and reads it already made are skipped by a run stamp. When the run ends,
  the edges past the cursor are cut, and any links that changed are settled.
  A run that reads what it read before allocates nothing unless a nested
  read needs a wide membership check. After scanning 32 edges for such a
  check, the run builds a membership index, even when it added no edge;
  repeated nested reads then take linear work over the run. Every run exit
  clears the index.
- A write bumps the source's version and the graph's clock, then marks
  observers with a loop over a reused stack. A read whose node was checked at
  the current clock returns at once. Otherwise it walks down to the first
  source that changed, recomputing on the way back up.
- No step recurses except through user code: a compute that calls `get`.
  First computes and reentrant refreshes of cached values nest that way.
  Past 256 nested stale reads, the read waits: every compute above it
  discards its unfinished result, and the outermost bounded read refreshes
  the value it stopped at from a shallow stack before retrying. A suspended
  cached value keeps its value and version for the retry's equality check.
  Its triggering dependency is marked unread because the interrupted run
  already updated read versions; accepting those versions would skip the
  unfinished compute. A single chain starts each suspended compute again,
  under twice the chain in all; a compute reading separate deep branches
  can suspend and restart for each branch. Ordinary cached freshness walks
  remain iterative, and a changed earlier source can still drop a later
  stale branch without reading it.
- A watch or reaction whose run throws keeps its old sources plus the reads it
  made before the throw. A pending render that throws leaves the last pending
  render as it was. A value between a cycle's origin and the read that closed
  it keeps no link back to the origin, so no cycle of links can keep a source
  observed. The graph remembers the run that met the cycle (`cycleRun`), so a
  compute that catches the error itself still drops its link to a value
  mid-run and ends empty, and every run that met a cycle ends volatile: a
  value made from one the cycle emptied is walked at each read until it
  computes with no cycle. A graph with a cycle, caught or not, walks and
  recomputes more for it.
- A cycle that closes in a value's freshness walk, before its compute runs,
  throws from the read even if that compute would catch it: the walk is not
  inside the compute's `try`.

The core primitives live in `@frondruntime/pinna-core`, for Pinna's own
packages. `@frondruntime/pinna` exports the functions on boxes without a
schema (`createRealm`, `box`, `computed`, `collection`, `update`, `watch`,
and the rest)
and their types, as one flat surface with no namespace; it imports nothing
from `effect`, and `/internal` is what sibling packages use.
`@frondruntime/pinna-effect` re-exports all of it as it is and adds
`schemaBox`, the box that checks a schema, `schemaCollection`, `decode`,
`SchemaModel`, `BoxField`, `CollectionField`, `FromContext`,
`reconcileSchema`, and `RealmService`, and the Effect programs
`watchScoped`, `changes`, `observeScoped`, `fromStream`, and
`whileObserved`. The
hooks are `@frondruntime/pinna-react`. The site, built from `docs/public`,
lists the whole surface.

## Boxes and classes

`packages/pinna/src/observable.ts`, and `packages/pinna-effect/src/box.ts`
and `src/class.ts`.

- **A box replaces its value.** `write` writes a new value; `write.modify`
  hands the recipe a draft of the current array or plain object and writes the result.
  The box keeps its identity, the value gets a new one exactly when it
  changed, so a memoized child or the React Compiler sees the change.
  Values are not frozen: freezing makes large arrays slow to build and to
  walk in JavaScriptCore.
- **Drafts copy on write.** The first write to an array or object in a
  draft copies it; finalizing walks only the keys the recipe touched, so
  untouched items cost nothing. `shift`, `unshift`, and `splice` on a
  draft array move elements in the copy without drafting them; `sort`,
  `reverse`, `fill`, `copyWithin`, and iterating still draft every element
  they read. A draft used after its recipe returned throws. The value is a
  tree: every key that reaches an object gets its own draft, whether the
  base held the object or the recipe assigned it, so an object at two keys
  finalizes to two values once one is written, and an assigned object is
  never written. Keeping one object at two keys across calls would mean
  scanning the value on every call for the keys that hold it: 12.5 ms per
  call at 100,000 rows, against 0.057 ms for a write that finalizes the
  touched keys (Bun). A draft the recipe wrote and left at a second key,
  inside itself, or inside an object the recipe placed at two keys, throws
  at finalize instead of handing the box a graph that the next call
  splits; a draft at two keys that the recipe never wrote finalizes to the
  one object the box held. A `SchemaModel`
  or `Model` instance, a box, a computed value, a `Date`, a `Map`, or a `Set` inside a
  value is not drafted: the recipe gets the held value itself, so the types
  leave it read-only all the way down, and a recipe replaces it with a new
  one. A `Date` in a draft is not a `Date` in the types; read it with
  `getTime()`.
- **Copy on write is decided.** The first write to an array in an update
  costs O(n) for that array: 21, 64, and 1056 ms for 1000 single-item
  updates at 1k, 10k, and 100k items (one scratch run, not in `bench:data`).
  Mutating in place would remove the copy but let an array keep its
  identity across a change, so a memoized child given the array as a prop,
  or a `useMemo` dependency, would silently go stale. Batching writes into
  one `update` pays the copy once.
- **Equality.** A `box` compares a new value with `Object.is`. A
  `schemaBox` or a `BoxField` compares it with its schema's equivalence, so an
  equal value notifies nobody. `Schema.Unknown`, `Schema.Any`, and
  `Schema.ObjectKeyword` compare by identity: Effect's structural fallback
  would hash the whole value on every write. A computed value and a watch compare
  with `Object.is`. `{ equals }` overrides any of them.
- **Classes.** `SchemaModel` is a `Schema.Class` whose fields are plain
  `readonly` data, except `$name` fields declared `BoxField(schema)` or
  `CollectionField(schema, { keyOf })`, which hold a box or a keyed
  collection; the wire key is `name`. Every instance has a `realm` field,
  which `decode` fills and `make` takes by hand; it is never on the
  wire. `make` takes each `$` field's value under its wire key and builds
  the box in the instance's realm, so no box is shared between instances.
  `Model`, from `pinna`, is the base of a class that checks nothing. Granularity comes from boxes: a field that changes on its own is its
  own box.
- **Keyed lists.** `reconcile(previous, next, { keyOf, equals })`, or
  `reconcileSchema(previous, next, { keyOf })` with `equals` from the
  schema, keeps the
  previous instance wherever an item's key and value are unchanged, so a
  refetch written to a box keeps row identity: a memoized row rerenders only
  when its item changed, and a refetch that changed nothing notifies nobody.
  A refetched `SchemaModel` row with equal plain fields is merged: the held
  instance stays and each box takes the refetched value, so only the readers
  of a changed box rerun. `reconcileSchema` and `write.replaceAll` and
  `write.upsert` on a `CollectionField` merge; the merge hook is internal, not API.
- **Keyed collections.** `collection(realm, { keyOf, equals? })`, in
  `packages/pinna/src/collection.ts`, holds its rows in a map, a box for
  each key a reader reads, and one box for the order of the keys, so a write
  to one row costs that row's readers and the order box notifies only on an
  add, a removal, or a move. A key's box is made on its first read: a load
  of 10,000 rows that nobody reads alone makes none, and `rows` reads the
  map and a box the collection writes on every change, not a box per key.
  A write writes a key's own box first, then the order box, then that one,
  so a row's readers are marked before the readers of `rows` whichever
  subscribed first. When every key had a box, `rows` read each one, and a
  row's write marked its readers and the readers of `rows` in the order
  they subscribed. Watchers run in the order they were marked either way;
  the differential fuzz compares the two builds with
  `PINNA_FUZZ_IGNORE_ORDER=1`.
  `CollectionField(schema, { keyOf })` is the same collection as a `$` field
  of a `SchemaModel`, with every row checked against `schema`.
  `row(key)` is a computed value kept per held key, and a
  `computedFunction` entry for a missing key: it reads the key's box, or the
  order while the key is missing, so a reader of a missing key
  reruns when it arrives. A removed key's box is set to `undefined` before
  it leaves the map, so its readers rerun and find it gone. The map of
  boxes is not observable itself; the realm records each map change with
  the update and puts it back on a rollback, as it does a box write.
- **Row changes.** `onRowChange($items, listener)` calls the listener inside
  the writer's update, after each row is written, with that update's `read`
  and `write`. A value derived a row at a time, such as a sum or an index by
  another key, lives in boxes the listener writes, so it commits and rolls
  back with the rows and a watcher sees both in one delivery. A `computed`
  over `rows` reaches the same value by rereading every row on each change.
  Each write path reports: `upsert` and `remove` compare the key's row
  before and after; `replaceAll`, and the `CollectionField` merge that runs
  it, report each old key, in the old key order, against the new map, then
  each added key in the new order. A row
  kept by `Object.is` reports nothing, which covers a `SchemaModel` row
  merged in place: its boxes take the change, and their readers see it. A
  write with a listener runs in its own scope of the update, so a throw from
  the listener, or from the write after it reported, undoes that write and
  what the listener wrote, even when the caller catches the error. The
  rows held when a listener is added reach it first, in key order, as
  added, in an update nested in the caller's, so a host keeps no second
  path that seeds its index, and a throw there adds no listener. A
  listener that writes its own collection throws: a report inside a report would see the
  collection between two writes. With no listener a write costs one
  `undefined` check.

## One behavior in every build

Pinna has no development mode. The same checks run, and the same costs apply,
whatever `NODE_ENV` says, so a benchmark or a bug report means the same thing
everywhere.

## Atomic updates

An update whose recipe throws leaves no trace: every box it wrote gets its old
value back before the error leaves `update`. The one error that leaves
`update` with the writes in place is an `onError` that throws while the
write's watchers run.

- The first write to a box in an update records the box's old value. A
  rollback writes the old values back, newest first.
- A nested update undoes only its own writes when it throws. If the outer
  update catches the error, the outer writes stay. If the outer update
  throws, it undoes everything, including nested updates that finished.
- Watchers run once the outermost update ends and see only its end state;
  after a rollback that is the old state. A box takes back its old version
  with its old value, so nothing that read only boxes the update wrote runs
  again, an autorun included. An atom's `changed` in a rolled-back update
  still reruns its observers once.
- A write that puts back the value a box had when the outermost update
  began, by the box's equality, puts back its version too, as a rollback
  would. So an update that writes 1 and then 0 to a box at 0 reruns nothing
  that read only that box, an autorun included. A computed value read in
  between recomputes once on its next read, as after a rollback.
- A recipe that returns a promise throws at once and rolls back what it
  wrote before its first `await`: writes after an `await` would land outside
  the update. Await outside, then update.

## Stages

A stage holds the writes of asynchronous work out of the realm until the
work succeeds, then lands them in one update; a failure drops them and
leaves nothing to undo (ruling 53).

- **Overlay and journal.** A stage maps each box it wrote to its staged
  value, and each collection it wrote to a copy of its rows, with the key
  order held as the order box's staged value; the journal lists the recipes
  that ran without throwing. A child stage looks itself up first, then its
  parent, then the realm. Nothing copies the realm, and a stage makes no
  graph node.
- **Reads.** A box reads the overlay, or `peekCell`, so nothing subscribes.
  A collection's `rows` and `row` computed values are tagged with their
  collection when made (`collectionReads`), so a stage reads its own rows in
  their place: they read the collection's internals, not the `read` they are
  handed. Any other computed value runs the core node's own `compute`
  against the stage's `read`. The result is cached on the stage and cleared
  when the core's clock or the highest revision along the stage's chain
  moves, so a value read three times between two writes runs once, and a
  realm write between two reads is seen.
- **Writes.** `write` and `write.modify` check the box against the staged
  value and record what they replaced; `write.modify` drafts the staged
  value, never the realm's. A collection write runs the collection's own
  `stagedUpsert`, `stagedRemove`, or `stagedReplace`: the same check,
  equality, merge, repeated-key check, and `onRowChange` reports as an
  update's, over the staged rows. A merge takes the `read` and `write` of
  the place it runs in, so a refetched `SchemaModel` merges into the held
  instance's boxes through the stage. A recipe that throws undoes its
  overlay writes, the last first.
- **The recipe guard.** A recipe runs twice. While it runs, the core's
  `deriving` slot holds `stageMarker`, `active` is cleared, and `openDepth`
  is 0: a realm write, a watch, and an observe throw through checks the core
  already makes, a kept realm `read` throws through the place check it
  already makes, and the messages that name a stage are built only on those
  throw paths. Making an observable, `untracked`, `onObserved`,
  `onRowChange`, and the stage calls compare `deriving` with the marker.
  `update` and `read` gain nothing.
- **Applying.** Over a realm: an optional conflict check, then one `update`
  whose recipe runs each kept recipe in a nested `update`, nested in an
  update already open. Over a parent: the recipes run against the parent as
  one session, all or none.
- **Conflicts.** With `{ conflicts: "fail" }`, the first read of a realm
  value records the box's version: a box, or a collection's order and
  change counter, recorded also beneath a computed value's evaluation. A
  child's record merges into its parent's when it applies. The check
  compares versions before the replay.

What it cost:

- A recipe must be a function of its `read`. An id, a time, or an
  observable made inside one would differ between the staged run and the
  replay; the guard catches observables, `update`, and kept reads, and an id
  or a time is a documented rule, since Pinna has no development mode.
- Computed values through a stage run uncached by the graph: a derivation
  of n reads costs n per evaluation, bounded by the stage's cache. Frond
  estimates 1 to 20 boxes and 1 to 50 recipes per stage.
- A collection costs O(n) to copy on a stage's first write to it, and the
  replay runs a `replaceAll`, and its merges, a second time: a refetch of
  10,000 rows does the work twice. `bench:stage` in `packages/pinna`
  measures it against the update it replaces.
- Conflicts replay unless asked. A value read through the stage can differ
  from what lands; `{ conflicts: "fail" }` turns that into an error, and the
  author decides whether rerunning the work, requests included, is safe.
- A conflict on a collection is per collection: any row change conflicts
  with any read of its rows, since a row with no cell has no version.
- Staged values are not observable: that would need a second graph per
  stage.

The decision: stages are explicit and synchronous in `pinna`, read and
write everything the realm does, and hold the guarantee that a dropped
stage leaves no trace.

## Checked writes

A `box` checks nothing. A `schemaBox` or a `BoxField` always holds a
value that matches its schema: making the box checks the initial
value, and every write is checked before it is applied, `write` and
`write.modify` alike, on the schema's type side with `Schema.is`; the message comes from
decoding only when a check fails.

- A box of a plain `Schema.Array(X)` checks only the elements a write put in
  a new place: an element still at its index in the previous value, counted
  after any elements dropped from or added to the front, was checked when it
  landed. A push onto 10,000 rows checks one, and so does dropping the oldest
  row of a capped list to append one. Elements after a splice in the middle
  are checked again. A check that reads boxes is not rerun for elements it
  passed before.
- A write of the value the box holds (`Object.is`) is not checked again,
  for the same reason, and changes nothing: a collection's `replaceAll`
  checks only the rows it did not hold.
- Any other schema is checked whole on each write, including an array whose
  schema has checks of its own (`Schema.Array(X).check(Schema.isMinLength(1))`)
  or gives no single element schema. That costs O(n) per write, for that box
  only.
- `make` and decode check a `SchemaModel` instance whole. Its plain fields
  are never written after that; its boxes check their own writes.

A rejected write throws `pinna: the box rejects this value: ...` inside the
recipe, so the update rolls back. A box of `Schema.Unknown` checks nothing.

## Inspection

`inspect($x)` takes a box, a computed value, or an atom and returns
`{ name, realm, dependencies, observers, lastReason }`.

- `name` is the `name` option the observable was made with; an unnamed
  dependency is reported as `"<anonymous>"`.
- `realm` is the `name` option of the realm that made the observable. The
  realm keeps it in a field, so no module state holds it, and nothing
  compares it: realms are told apart by identity.
- `dependencies` are what the last run read, each once, in read order.
  Inspecting runs nothing, so a stale value reports its last run.
- `observers` is the observer count.
- `lastReason` says why a named computed value last recomputed: the first
  run, or which source changed. Anything else reports `undefined`.

Names and reasons are kept only for named observables, in a `WeakMap`, so an
unnamed observable, and so a decoded row, costs nothing for them.

## Known semantics and limits

- A `SchemaModel` decodes only through `decode`, which runs Effect's
  decode with the realm provided as a service: about 1.2 µs more per
  instance than a decode without one. A synchronous decode does not compile.
  Values a schema takes from the caller, such as a formatter, are the
  services of Effect `Context.Service` tags that `FromContext` fields hold,
  and `decode` takes them in an Effect `Context`. An Effect decode takes
  the tag from `Effect.provideService` or a `Layer`. A field reads the tag
  from the Effect context, so the innermost provider wins: 6.8 ms on 10,000
  plain struct rows with one context field each, against 1.5 ms for a
  module variable read first. The variable was dropped because Effect
  Schema reads a field when it builds the decode, so an Effect decode
  nested inside a `decode` that provided a tag the outer `decode` also held
  got the outer value, with no error. A context field decoded with neither
  fails with Effect's missing-service defect, which names the tag.
- Each realm makes its own `read` and `write`, once, and each throws when
  handed an observable another realm made: a computed value, a watch, an
  `update`, or a `useSelect` of one realm cannot read or write another, open
  or not. The check is one comparison per call, against a variable of the
  closure. `useValues` throws when its observables come from two realms.
  `make` and `decode` build every box of a `SchemaModel` in the instance's
  realm, and `make` throws when handed a box. Not caught:
  - a value of another realm stored in a box, a collection, or a nested
    `make`: a value is data, so storing it compares no realm. The first read
    of its boxes in the holder's realm throws, at the read, not where the
    value was stored. Checking at the store would catch only a model
    instance held directly, not one inside an array or a struct, short of
    walking every written value;
  - a `write` kept from realm A's `update` and called inside realm B's
    computed value, while that update is open (a kept verb, below);
  - realm B's `update` run inside realm A's: a rollback of A's leaves the
    writes to B.
- A collection row with no box, written A, then B, then A′ equal to A in
  one update, holds A′ and reruns the readers of `rows`, since the
  collection compares each write with the row it holds, not with the row
  the update began with. A key with a box puts A and its version back, as
  any box does, and reruns nobody.
- Decoding an instance that is already decoded throws, because the instance
  has a `realm` key.
- A verb is not bound to the place that handed it out. A `read` checks, when
  called, that some place of its realm is open, and a `write` that some
  update is. A kept verb throws outside them and, inside one, acts as that
  place's own verb: a `read` kept from `untracked` and called in a computed
  value tracks. Binding each verb to its place would cost a closure per run.
  Pass verbs down as arguments instead of keeping them.
- A component's render body has no `read`, so a read there does not
  type-check. Read through `useValue`, `useValues`, or `useSelect`; a `read`
  leaked into a render throws.
- A write renders at once, even inside `startTransition`: the hooks use
  `useSyncExternalStore`, and React renders a store's change as a blocking
  update. Every library built on it shares this. `useDeferredValue` over a
  hook's result moves the slow render to low priority, and a component that
  suspends on a deferred value keeps its content on screen
  (`packages/pinna-react/test/concurrent.test.tsx`).
- A check on a `SchemaModel` as a whole (`SchemaModel(...)(fields).check(...)`)
  runs at `make` and decode only; a write to one of its boxes checks the
  box's own schema, not the class's.
- A value read from a box is never changed in place. A change made through
  a cast or `Schema.mutable` skips the schema check and notifies no reader,
  so the box can hold a value its schema rejects.
- A rollback puts the old values and versions back in the cells. A version
  is never issued twice, so a computed value read during the failed update
  recomputes once on its next read. Its cutoff compares with the value it
  computed inside the failed update, not with the one its readers last saw:
  when that value was the same, no reader reruns; when it differed (0, then
  2 inside the update, then 0 again), each reader reruns once and sees the
  value it had.
- `onObserved` hooks run when the first observer links or the last leaves.
  Inside an update or a flush they settle once the watchers are done, by
  comparing being observed then with when they last ran: an observer lost
  and gained within one update fires nothing (ruling 21).
- `SchemaModel` renames a `$name`
  field's wire key to `name` by overriding the class schema's static `ast`
  getter. The new schema decodes a struct of the fields under their wire
  keys, so each field is parsed and checked once and an error names the
  wire key. A `BoxField` or `CollectionField` decodes its wire value
  there, and the next step builds its box in the realm, which it looks up
  once for the whole instance instead of once per box. It then moves the
  fields to their own keys, adds the realm, and
  builds the instance with the transformation Effect's own class schema
  uses, which does not check the fields again. That reads Effect's `ast`
  getter off `Schema.Class` and the one transformation in its encoding,
  which depends on `Schema.Class` internals as of `effect` 4.1.0;
  `SchemaModel` throws if either is gone. The encoded type is written to
  match by hand: it names the field `name` and leaves out `realm`.

## Conformance

`packages/pinna-bench/test/conformance` runs one set of cases against Pinna,
alien-signals, and MobX, through one adapter per library (`adapter.ts`). The
cases are written in this repository's words: basics, diamonds and glitches,
dynamic dependencies, batching and nested updates, errors in derived values,
and observed timing. A case a library misses is listed in `gaps.ts` and runs
as `test.failing`, so a gap that closes fails until it is removed.

| Library | Case | Gap |
| --- | --- | --- |
| Pinna | none | |
| alien-signals 3.2.1 | a derived value that threw still tracks what it read before throwing | The fixing write does not recompute it |
| alien-signals 3.2.1 | an observed hook starts with the first observer and cleans up after the last | It has no observed hook |
| MobX 7.1.7 | none | |

Not covered yet: errors thrown by a watch select or effect, since each
library reports them in its own way.

`differential.test.ts` plays 200 seeded random scripts (`random.ts`) on all
three: 2 to 5 boxes, 2 to 10 derived values that each read up to three lower
nodes, and 30 operations drawn from writes, nested updates, subscribes, and
unsubscribes. It compares every watch's notifications, every node's final
value, and how often each derived value computed on each write. A failure
names its seed, which replays exactly.

- Pinna and alien-signals agree on all three, on every seed.
- MobX agrees on notifications and values, and on counts after every write
  but one: an update that writes a box and then writes its old value back.
  MobX recomputes the readers there; Pinna and alien-signals recompute
  nothing.
- Subscribes and unsubscribes are not compared for counts: MobX drops a
  derived value's cache with its last observer, Pinna and alien-signals keep
  it.

### reactive-framework-test-suite

`test/conformance/shared-suite` runs
[reactive-framework-test-suite](https://github.com/johnsoncodehk/reactive-framework-test-suite)
0.2.0 (MIT, Johnson Chu), pinned exactly, on Pinna, MobX, and alien-signals
through one adapter each (`frameworks.ts`). MobX runs through the same
adapter, so its local result is the oracle for what a case asks. Each library runs in its own
process, the cycle cases with a time limit. `expected.ts` lists every case a
library misses and every probe answer; a change in either fails the suite.

| Library | Cases (161) | Probes (29) |
| --- | --- | --- |
| Pinna | 160 pass, 1 fail | 29 answered |
| MobX 7.1.7 | 128 pass, 14 fail, 19 skip | 27 answered, 2 skip |
| alien-signals 3.2.1 | 161 pass | 29 answered |

- The 19 cleanup cases need an effect cleanup, a function an effect returns
  to run before its next run and on dispose. Pinna's autorun takes one
  (ruling 34) and passes all 19; MobX's autorun ignores its return value,
  so they skip there, with probes #241 and #244.
- 15 cases write inside an autorun body. Pinna failed them by design while
  `update` threw in tracked code; ruling 46 in `api.md` lets the body
  update, and they pass.
- #123: a write and a later write that puts the value back, in one update,
  reran an autorun that read it. Fixed: the box takes back its old version.
  MobX fails it.
- #154 expects a throwing batch to keep its writes. Pinna's update is atomic
  and rolls them back.
- The MobX failures are MobX's own design. Pinna passes all of them.
- alien-signals passes all 161 cases and answers all 29 probes; it misses
  nothing. The package ships no alien-signals adapter, so `frameworks.ts`
  writes one from the interface. alien-signals' `effect` runs a function
  its body returns as the cleanup, so the adapter passes the effect through.
  The suite's author, Johnson Chu, also wrote alien-signals.

The probes where Pinna and MobX answer differently, each a valid design the
suite records and the owner confirmed (ruling 37 in `api.md`):

| Probe | Pinna | MobX | alien-signals |
| --- | --- | --- | --- |
| #29, #167 NaN equality | `Object.is` | `===` | `===` |
| #30 a write of the same reference | skips | propagates | skips |
| #132, #147 an update that writes a value and then its old value back | skipped | recomputed | skipped |
| #86, #107 a computed value that threw, read again | caches the error | re-evaluates | returns stale |
| #88 an effect whose first run threw | unsubscribes | keeps subscribed | keeps subscribed |
| #172 a computed value that writes its own dependency | throws | re-evaluates | re-evaluates |
| #176 what `batch` returns | nothing | the callback's value | nothing |
| #241, #244 nested autorun cleanups when the outer one stops | no cascade | skips: no cleanup | deepest first, last in first out |

Since ruling 46, Pinna answers the autorun-write probes as MobX does: #49
runs twice per write, #173 and #174 read the value after the write, and
#175 batches. #62, an effect that writes what it reads forever, answers no
throw: the autorun stops at the round limit, and the error goes to
`onError`, which the suite's realm drops.

Five more probes where alien-signals answers differently from Pinna, with
MobX's answer: #49 inner write re-run through a computed chain (runs once per
write; MobX runs twice per write), #106 effect throw isolation in a flush
(halts the flush; MobX continues), #175 effect multi-signal write batching
(unbatched; MobX batched), #209 three-level nested effect disposal (cascades;
MobX no cascade), #210 inner effects on an outer re-run (replaced; MobX
accumulates).

The run found two Pinna bugs, both fixed with a test in
`observation.test.ts`: an update that threw reran an autorun that had read
its writes (#69), and a chain of `onObserved` cleanups longer than the round
limit, each stopping the next autorun, stopped at the limit (MobX #3954).

### MobX's `onBecomeObserved` cases

`test/conformance/mobx-uses/become-observed.test.ts` ports the cases of
MobX's `__tests__/base/become-observed.ts` (MIT, Michel Weststrate, at
7.1.0) that `onObserved` covers, and runs each on MobX beside Pinna.
The values every reader sees agree. The order of the hooks differs, as
`create-atom.test.ts` states: MobX starts a hook inside the read, Pinna once
the reader's run is linked. So a chain starts from the source up, not from
the reader down. A hook that loads what it guards (MobX #2667) runs the
reader once more for each list, first with nothing loaded. A cleanup that
throws goes to `onError`, not to the caller that stopped the autorun. The
`keepAlive` cases, maps, sets, and decorators are not ported:
`observe` starts the held value's own hooks, which `keepAlive` does
not.

## Benchmarks

`bun run --cwd packages/pinna bench:data`: a 10,000-todo model in three
subjects, each in its own process, medians of seven runs. One run, Apple
silicon, Bun; differences under about 15% are noise.

- **MobX** 7.1: plain objects, mutated in place.
- **Pinna, bare**: the same plain objects, every box checked by
  `Schema.Unknown`. It compares Pinna's reactive core with MobX's.
- **Pinna, Effect Schema**: `SchemaModel` instances, every write checked. A
  schema check costs time in any library, MobX with a validator on top
  included, so this column is compared with bare Pinna, not with MobX.

| | MobX | Pinna, bare | Pinna, Effect Schema |
| --- | --- | --- | --- |
| build 10k | 13.94 ms | 7.76 ms | 16.92 ms |
| decode 10k | 14.75 ms | 3.79 ms | 27.27 ms |
| memory 10k decoded | 16.6 MB, 28 obj/row | 14.1 MB, 29 obj/row | 5.6 MB, 8 obj/row |
| memory 10k observed | 52.0 MB, 58 obj/row | 21.9 MB, 43 obj/row | 21.6 MB, 43 obj/row |
| observe 10k rows | 19.96 ms | 4.40 ms | 5.96 ms |
| toggle 1 row ×1000, observed | 933.19 ms | 344.32 ms | 362.50 ms |
| toggleAll 10k, observed | 13.07 ms | 6.39 ms | 8.52 ms |
| add ×1000, observed | 1.92 ms | 16.57 ms | 48.24 ms |
| add ×1000, unobserved | 1.50 ms | 15.59 ms | 53.53 ms |
| add 1000 in one update, observed | 1.33 ms | 1.00 ms | 1.52 ms |

The run fails when bare Pinna over MobX, or schema Pinna over bare Pinna,
passes a row's ceiling in `bench/data.ts`. Ratios hold across machines where
milliseconds do not. Each ceiling sits about twice above the ratio measured
when it was set; memory rows have none. The benchmark is not part of
`bun run check`: it takes about a minute.

Reading the table:

- Bare, Pinna matches or beats MobX on every row but one: one `update` per
  added item, which copies the 10,000-item array once per update, about 9×
  MobX's in-place push; finalizing the draft visits only the keys it
  touched. A write replaces the value, so a memoized child or the React
  Compiler sees a new identity; an in-place push would not give one.
  Batching adds into one `update` is MobX's speed.
- Toggling one row was 1.5× MobX until graph nodes stopped allocating:
  each recompute made a new dependency array and relinked its sources.
  Nodes then kept their methods on the prototype (since replaced by plain
  object literals with no prototype, `graph.ts`), made a second observer's
  `Set` and their `onObserved` hooks on first use, and reused a run's
  dependency array when it read what the last run read. That took toggle
  from 987 to 463 ms and decoded memory from 25.6 to 17.2 MB.
- Boxes then stopped making closures: `get` and `peek` are prototype
  methods, and `set`, `update`, and an atom's `changed` are bound on first
  use and kept, so a box that is never written makes none and a setter can
  still be passed as `onChangeText={$name.set}`. That took decoded memory
  from 17.2 to 14.1 MB bare and from 8.7 to 5.6 MB with Effect Schema, and
  observed memory from 25.0 to 21.9 MB. The price: `get` and `peek` taken off
  their box lose `this`; a detached `get` throws on its first call. The
  methods are gone since: a box has no methods and no closures at all, and
  `read` and `write` are module functions each place hands out.
- With Effect Schema, one `update` per add is about 2–3× bare: a box of an
  array checks only the elements a write put there, so each add checks one
  row. Before slice 5 it checked all 10,000, about 20× bare. What is left
  is finding that row: the check compares the new array with the old one
  index by index, about 24 ms per 1000 adds at 10,000 rows. Handing the
  check the indices the draft touched would make it O(1), but the check
  would then be only as sound as the draft's bookkeeping (a `delete` and a
  sparse index write each leave holes the draft does not list), and the
  array copy would stay. It was measured and left out.
- Decode with Effect Schema is about 5× bare: Effect's effectful decode
  path, which carries the realm to every nested instance.
- Bare Pinna holds more objects per decoded row than schema Pinna: the bare
  model makes each row's label eagerly, `SchemaModel` lazily.
- Observed memory moves between runs for MobX, 35 to 52 MB on the same
  code, and toggle from 618 to 933 ms; Pinna's held at 22 MB.

### On Hermes

`bun run --cwd packages/pinna bench:hermes <hermes-ios destroot>` runs the
same subjects the way a React Native release build would, with no app:
Bun bundles them, React Native 0.88.1's `@react-native/babel-preset` (a
devDependency, run with the Babel 7 it depends on) lowers them for Hermes,
`hermesc -O` compiles bytecode, and Hermes runs each subject in its own
process (`bench/hermes-toolchain.ts`). Times come from the host's `now`, a
steady clock to the microsecond, since Hermes has no `performance`; memory
is allocated bytes after two collections. No ceilings: the table is read
next to Bun's. It takes about six minutes.

`bench:hermes-graph <hermes-ios destroot>` does the same for the graph
benchmark (`bench/graph-model.ts`; `bench:graph` runs it on Bun): Pinna
against alien-signals and MobX, with a second table of bytes allocated per
run, garbage included, from `HermesInternal.getInstrumentedStats()`'s
`js_totalAllocatedBytes`. It takes about a minute and a half.

`bench:hermes-hooks <hermes-ios destroot>` runs `bench/hooks-model.ts`, the
stores of `useValue`, `useValues` and `useSelect` driven as React 19's
`useSyncExternalStore` drives them, without React, on Bun and on Hermes,
with bytes allocated per run.

The `destroot` is a `hermes-ios` release unpacked anywhere outside the
repository, with `bin/hermes` built from `bench/hermes-host.cpp` (its header
has the command). React Native caches the release it uses, for example
`~/Library/Caches/ReactNative/hermes-ios-260318099.0.5-release.tar.gz`.

Effect builds a `TextDecoder` when it loads, and Hermes has none. A React
Native app that uses Pinna's schema side must supply one (Expo does); the
bench supplies a UTF-8 one.

The reference is Hermes V1, 260318099.0.5, React Native 0.88.1's: the
`hermes-ios` release from Maven ships no `hermes` runner, so
`bench/hermes-host.cpp` is one, built against its `hermesvm` framework, and
the code is lowered by 0.88.1's preset, which keeps classes. Hermes 0.76,
React Native 0.76.3's, measured every subject about a third slower with the
same ratios to MobX. Milliseconds, before graph nodes stopped allocating
and now, with boxes making no closures either:

| | MobX | bare, before | bare | schema, before | schema |
| --- | --- | --- | --- | --- | --- |
| build 10k | 162 | 65 | 37 | 110 | 81 |
| decode 10k | 166 | 66 | 37 | 266 | 240 |
| memory 10k decoded, MB | 22.4 | 48.2 | 17.4 | 38.0 | 7.2 |
| memory 10k observed, MB | 41.0 | 58.8 | 26.5 | 58.7 | 26.5 |
| observe 10k rows | 149 | 71 | 45 | 59 | 49 |
| toggle 1 row ×1000, observed | 13518 | 9401 | 3464 | 9999 | 3394 |
| toggleAll 10k, observed | 162 | 73 | 46 | 74 | 48 |
| add ×1000, observed | 25 | 162 | 144 | 369 | 351 |
| add ×1000, unobserved | 18 | 168 | 141 | 384 | 346 |
| add 1000 in one update, observed | 16 | 10 | 6 | 15 | 10 |

- Hermes interprets without a JIT, so an object or closure per node costs
  more than on Bun. Graph nodes making none halved toggle (4324 ms, 0.38×
  MobX) and decoded memory (23.1 MB, 1.03× MobX, from 2.15×). Boxes making
  none took decoded memory to 17.4 MB bare and 7.2 MB with Effect Schema,
  from 23.1 and 12.9, and observed memory from 32.2 to 26.5 MB; toggle moved
  within the run's noise.
- One `update` per add stays the weak row, 6–8× MobX, for the same reason
  as on Bun; one `update` for all adds beats MobX.
- Decode with Effect Schema is about 6× bare: Effect's price.

`bun run --cwd packages/pinna bench` checks the diamond: Pinna computes the join once with no
mixed value; Effect's `Atom` computes it twice and shows one glitch.

### Leads

Measured, not built. Each pays for itself if a use makes it matter; none
trades a check or tracking.

- **A synchronous decode.** Decode with Effect Schema is about 6× bare on
  both engines (240 against 38 ms on Hermes, 10,000 rows), the slowest row a
  real app hits. The cost is Effect's effectful decode, which carries the
  realm to every nested instance through `RealmService`. A synchronous
  decode could hold the realm being decoded in one variable for the
  decode's duration and skip the Effect runtime; the price is that variable,
  and a nested or reentrant decode must restore it. The decode context was
  held this way and dropped (`docs/api.md`, ruling 50): Effect Schema reads
  a field when it builds the decode, so an Effect decode nested inside one
  that provided its own value read the outer one. A realm held this way
  meets the same case.

Considered and left out, because the cost is in user code or the gain needs
a non-plain value: writing an array in place when nobody read it since the
last write (an observed list is read after every write), a persistent
vector for array boxes (it is not a plain array), an incremental filter for
derived counts (the app's own `filter`, which MobX pays too), and drafts
without a `Proxy` on Hermes (it needs an API such as `box.push`).

## Porting the core

The graph in `packages/pinna-core/src/graph.ts` is the part a C++ core for
the mobile spike would replace. This section is what a port has to keep
that the code says only through call order and comments. It was recovered
by a design review of the core on 2026-11-12, which also found two bugs,
both fixed with tests:

- `reconcile` reused a dropped edge for a source read again in another
  order, and in doing so cut the list of dropped edges it walked next. The
  sources after it stayed linked to an observer that no longer read them:
  they kept marking it, were counted twice when read again, and never ended
  their `onObserved` hooks. Any run that read fewer sources in another
  order hit it, and so did a reaction's `adopt`. In C++ this is a dangling
  pointer.
- A derived value that lost its last observer partway through its own run
  unlinked the edges that run had added and not linked yet, emptying their
  sources' observer lists. `unsubscribe` now skips an unlinked edge.

### What the code assumes and nothing checks

- **One kind of tail.** The edges past a run's cursor are all linked or all
  unlinked; the code checks only the first. Both bugs above broke this.
- **Each source once per dependency list.** `reconcile` keys its scratch
  slots (`staleEdge`, `staleStamp`) by source, and a second edge to the
  same source would overwrite the first.
- **Counters never wrap.** `clock`, versions, run numbers, `walk`,
  `stamps`, and `hooksBegun` grow without bound and are compared in order;
  0 and −1 are sentinels, and `reconcile` negates a stamp to mark a moved
  edge. A port uses signed 64-bit integers.
- **A nested run has a higher number than the run around it.** `readBy >=
  run` means "read in this run or in one nested inside it", and `cycleRun >=
  run` means "this run or one nested inside it met a cycle".
- **`walk` names the current walk only while `walkDepth > 0`.** Every link
  happens inside one: `activate` and `adopt` are walks, so an atom they
  link counts as changed once, like an unobserved atom on any check.
- **Kind order is numeric.** A kind up to `DERIVED` is a source; one above
  it only reads.
- **A cycle error is recognized by identity.** Five `instanceof CycleError`
  checks, most with a test of its `origin`, decide how a run ends. A
  compute that wraps or rethrows the error, or a boundary such as JSI that
  wraps exceptions crossing it, defeats the ones that test the error. The
  link back and the volatile mark do not depend on them: they follow
  `cycleRun`, which a wrapped or caught error leaves set.
- **A hook's `begun` and `cleanups` are parallel arrays,** and a start
  function is keyed by identity: the same function added twice begins
  twice, and the first remover removes both.

A test-only checker that walks the graph and asserts these (observer count
equals list length, `linked` matches membership, tails are one kind, each
source once per list, an atom's `volatile` equals having no observers,
hooks aligned) belongs in `expectAtRest`, and the port can run the same
checks. The scratch fuzz that found the `reconcile` leak was this checker
over random graphs: 52 of 500 seeds failed before the fix, none of 2,000
after.

### States

| Kind | States |
| --- | --- |
| Cell | unobserved, observed; a version issued by `writeCell`, `touchSource`, and `restoreCell` (which puts back an earlier one) |
| Atom | unobserved and volatile (version bumped once per outermost walk), observed and not volatile |
| Derived | empty, computing, walking, current, stale, volatile, errored; observed or not alongside |
| Watch | created (linked, empty), live, scheduled, disposed (terminal) |
| Reaction | inactive or active, empty or tracked; `running` during `track`, `pendingRan` from `trackPending` to `adopt`, through any `track` in between |
| Hook | added, beginning (a placeholder cleanup), begun, ended; a removal inside a compute ends it at the next settle |
| Graph | idle, batched (`depth > 0`), settling; tracking, deriving, and walking alongside |

A derived value's fields allow 48 combinations for these 7 states, and
`cursor` is the record cursor during a run and the walk cursor during a
refresh. A read of a computing or walking value throws a cycle error; a walk
that reaches one counts it as changed.

### Scopes and ownership

- Seven places save and restore `active`, the run number, or `deriving`
  by hand, in `try`/`finally`, and eight pair `walkDepth++` with its
  decrement. In C++ each is a scope guard.
- `deriving` names the innermost derived value whose compute or `equals`
  runs. A compute sets it and only a hook's run clears it, so nothing
  inside a compute writes, observes, or releases, however deep the call:
  a nested `untracked`, a reaction's `track` or `trackPending`, or an
  `untracked` inside `equals`. `restoreCell` throws there too, as
  `writeCell` and `touchSource` do; a rollback never runs inside a compute, since no write there
  is journaled. `active` says only what a read records.
- `beginBatch` and `endBatch` are public and counted: an `endBatch` with no
  open `beginBatch` throws, so `depth` never goes below 0. The one caller
  pairs them in a `finally`.
- An edge is made in one place (`recordMiss`) and dropped in several: where
  a run ends and cuts its tail, in `reconcile`, in `unsubscribe`, when a
  watch is disposed, and in `adopt`. None frees it. Each needs a free, or
  the port allocates edges from an arena.
- A node is held by user handles and by `edge.source`. A watch stays alive
  only through its sources' observer lists while linked; observer lists are
  back pointers that own nothing.

### Errors

A graph error is a `pinna:` error, a cycle error (not exported), a user
error kept as a value, the "did not settle" error, a reporter's error, or a
host error that is swallowed. Where a settle's error goes depends on the
kind of settle:

| Settle | A reporter's throw goes to |
| --- | --- |
| after a write, or the end of a batch | the writer |
| after observing: track, adopt, activate, deactivate, a read, a dispose | the host |
| after `watch()` makes a watch | the caller if it came from that watch, else the host |
| after a call that failed | the host |

### What a port exposes

Beyond `index.ts`, the package reads `core.active` and `core.deriving`, a
cell's `version`, `nextCellVersion`, and `observerCount`.

### Decided after the review

Each of these was a question for the owner; the rule is the one least
surprising to a reader, and a test pins each.

- Once a watch's stop function has run, its effect never runs again, even
  when the select of the run in progress called it.
- When `watch()`'s first run throws, the watch is unlinked before the
  settle, so its sources' hooks neither begin nor end.
- An `endBatch` with no open `beginBatch` throws, and `restoreCell` throws
  inside a compute.
- `track` leaves a pending run in place: `adopt` follows it even when a
  `track` ran in between, since the pending run is the render the renderer
  kept.
- `activate` and `adopt` are walks: an atom they link counts as changed
  once, whatever the last walk checked.

## Scheduling

Pinna has no scheduler: every watcher runs synchronously when the outermost
`update` ends. The libraries that have one have it for a reason tied to where
they sit. None of those reasons holds for application state that React
renders; the one that will hold is a host that embeds the graph.

- **MobX's `configure({ reactionScheduler })` wraps the run of pending
  reactions; it does not defer it.** The default is `f => f()`, and each call
  wraps the one before (`mobx/src/core/reaction.ts`). Its one user in
  practice is mobx-react-lite, which sets it to React's
  `unstable_batchedUpdates` on import, so an action that changes ten
  observers renders once under React 17 and earlier. React 18 batches
  renders itself, and `pinna-react` requires React 19.
- **MobX's `autorun` and `reaction` take `delay` and `scheduler` for one
  reaction.** `delay` becomes a `setTimeout`: throttling in application
  code. `pinna-effect` covers it with `Stream.debounce` or `Stream.throttle`
  on `changes($x)`. Plain `pinna` gets a `scheduler` option on `watch` and
  `autorun` in 1.x (`api.md`, "Planned for 1.x"); until then a watch effect
  sets a timer.
- **alien-signals hands scheduling to its host.** `effect(fn)` takes no
  options, and effects run when the outermost batch ends.
  `createReactiveSystem({ update, notify, unwatched })` calls `notify` for
  each watching node that turns dirty, so a framework built on the graph,
  such as Vue 3.6, decides when effects run.

Charts, games, and animation need no scheduler in Pinna either. A chart
draws from its own `requestAnimationFrame` loop: a watch sets a flag, and the
loop reads through `untracked` when the flag is set, so the chart draws at
most once a frame while the graph stays synchronous. A game loop keeps its
per-frame state in plain code and writes domain state at most once a frame
(`README.md`, "What it is for"). A high-rate source buffers in plain code and
opens one `update` per frame. That saves the writes as well as the renders: a
scheduler after the write cannot take back the array copy each `update` pays.

The cost is that every application with a high-rate source writes that
buffer itself, about ten lines.

A scheduler on the realm is out. Deferring the settle would break the
guarantee that every watcher has run when `update` returns, and a watcher's
error, which today reaches the writer ("Errors", above), would surface in a
frame callback with no link to the update that caused it. A scheduler on one
reaction keeps that guarantee for every reaction that does not opt in, and
is planned for 1.x: a `scheduler` function on `watch` and `autorun`, as in
MobX. The application writes the function, because `requestAnimationFrame`
and `setImmediate` exist on some hosts and not others, and a server or a
test has no frame at all (`api.md`, "Planned for 1.x"). Two hooks wait for a use:

- **A `notify` hook in pinna-core**, for a host that embeds the graph and
  decides when observers run. A reached watcher is appended to the due
  queue, a list linked through `nextDue` and `graph.dueTail` in `graph.ts`,
  in two places, `mark` and `runWatch`, and `settle` drains that queue in
  one place; the hook goes at the appends. Keep them few, or adding the hook
  stops being local.
- **A schedule option on the `pinna-react` hooks**, for many components
  that each want at most one render per frame from a source with many
  writers, where neither a buffer at the source nor one read loop fits. It
  shares the 1.x reactions' scheduler and their open questions: an order
  between deferred and synchronous observers, and an error policy for a
  deferred run. A controlled input never takes it, since its render has to
  follow each keystroke.

## Open questions

- `useSyncExternalStore` takes no part in transitions: a store change during
  a transition renders as a blocking update, so `startTransition` cannot
  lower the priority of a heavy render after a Pinna write. A limit of
  `pinna-react`, separate from scheduling ("Scheduling", above).
  `useDeferredValue` covers the slow render today. A hook that copied the
  value into React state would take part, at the cost of two components
  of one render seeing different values. Open until React ships a store
  hook that takes part in transitions; React 19.3.1 has none.
- Reconciling a refetch into the boxes of instances it keeps outside
  `pinna-effect`. `reconcileSchema` and a `CollectionField` merge a
  `SchemaModel` row into the held one (`docs/api.md`, ruling 51); the
  core's `reconcile` and `collection` keep unchanged rows and replace
  changed ones whole, and a `Model` row has no schema to merge by.
- Memory of `onObserved` hooks across many short-lived observables.
- `CollectionField` checks only the row it writes, but an add or removal
  still copies the array of keys. A list grown one key at a time to tens of
  thousands of keys may need an order structure that does not copy.
- Two lint rules the first `$` proposal planned are not built: a box or a
  computed value assigned to a name without `$`, and a plain getter that
  reads a `$` value. Neither needs type information, so a Biome GritQL
  plugin can hold them.
