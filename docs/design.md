# Pinna design

Status: v0 (`api.md`, ruling 18). Everything described here is built and
tested. The state is boxes and computed values read and written through
the verbs (`api.md`, ruling 43); the live objects of earlier drafts are
gone. Open questions are at the end.

## Why

MobX solves the right problem with too many surfaces: `observable`,
`makeObservable`, `makeAutoObservable`, decorators, `extendObservable`,
`Computed.make`, `computedFn`, `action`, `runInAction`, `reaction`, `Realm.autorun`,
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
3. **Writes are bounded.** A box changes only inside `Realm.update`, through
   the `write` it hands out: `write($box, value)` or a draft from
   `write.modify`. A `write` kept past its update throws, and the types
   agree: values are `readonly`, `Draft<T>` is writable.
4. **Misuse is loud.** Writing outside `Realm.update`, or starting an update in
   a computed value, a watch's select, or a selector, throws and says where
   to write instead. An autorun's body may update; one whose writes never
   settle stops at the round limit and reports it.
5. **Observation is a lifecycle.** A source is live while observed.
   `Source.onObserved` is the one hook for starting and stopping work.
6. **The graph imports nothing.** `packages/pinna-core` has no runtime
   dependencies.
   `effect` is a peer dependency of the package entry, for Schema classes.

## The graph

`packages/pinna-core/src/graph.ts`: cells, derived values, reactions, `Realm.watch`, `batch`,
`Realm.untracked`, `Source.onObserved`.

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
  landed, so `Realm.update` throws for it only when `onError` itself throws, and
  then with the writes in place. Watchers that keep writing are
  stopped after 100 rounds, reported the same way. Watchers that the
  realm's `onError` sets writing while it handles that report are stopped
  after 100 rounds too, without a second report. `Source.onObserved` hooks count
  the passes that begin a hook: after 100 of them, hooks still due are
  left due, with none of their hooks or cleanups run, and reported as hooks
  that did not settle, not as watchers, even when the watchers their writes
  set going reach their round limit first. The next flush goes on from
  there under the same limit, so hooks that never settle are reported
  again at each flush. A pass that only runs
  cleanups does not count: every cleanup ends a hook that began earlier, so
  a chain of cleanups that each stop the next observer settles however long
  it is. A `Computed.fn` entry cached inside a cleanup does not count either. The limit
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
  A retry can only use what the last one computed if it reads the same
  values, and a compute that makes a new chain deeper than 256 on every run
  never does. A synchronous compute cannot resume where it stopped, so a
  rebuilt chain is told from a kept one only by counting: the bounded read
  runs one value again at most 64 times within one outer read, then throws
  `pinna/depth-rebuilt` and leaves the realm usable. A compute that makes and
  keeps one deep branch per run finishes in branches + 1 runs, so up to 63
  kept branches read; a chain of 260 rebuilt on every run throws after 65
  runs, about 17,000 values made. An earlier rule refused the first retry
  that stopped at a value it made, which refused a root that made a second
  kept branch on its retry. The count lives in a map the bounded driver
  makes at its first restart and drops when its read ends: nothing on
  `read`, `write`, a normal recompute, or the making of a value. The map is
  never made up front, because the bounded driver also runs for each stale
  read a compute makes when no bounded read is open, which in the bench's
  `diamond` is 1,000 reads per write; a map made on each of them made
  `diamond` 1.48x slower on Node. One bounded driver never starts inside
  another, so the budget is per value per outer read: the driver runs every
  compute at a compute depth of 1 or more, and only a stale read at depth 0
  enters it, so a stale read inside the driver nests in place
  (`packages/pinna-core/test/depth-nesting.test.ts`).
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
schema (`Realm.make`, `Box.make`, `Computed.make`, `Collection.make`, `Realm.update`, `Realm.watch`,
and the rest)
and their types, as one flat surface with no namespace; it imports nothing
from `effect`, and `/internal` is what sibling packages use.
`@frondruntime/pinna-effect` re-exports all of it as it is and adds
`Box.schema`, the box that checks a schema, `Collection.schema`, `Model.decode`,
`Model.Schema`, `Model.boxField`, `Model.collectionField`, `Model.context`,
`Collection.reconcile`, and `RealmService`, and the Effect programs
`Program.watchScoped`, `Program.changes`, `Source.observeScoped`, `Program.fromStream`, and
`Program.whileObserved`. The
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
  one object the box held. A `Model.Schema`
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
  one `Realm.update` pays the copy once.
- **Equality.** A `Box.make` compares a new value with `Object.is`. A
  `Box.schema` or a `Model.boxField` compares it with its schema's equivalence, so an
  equal value notifies nobody. `Schema.Unknown`, `Schema.Any`, and
  `Schema.ObjectKeyword` compare by identity: Effect's structural fallback
  would hash the whole value on every write. A computed value and a watch compare
  with `Object.is`. `{ equals }` overrides any of them.
- **Classes.** `Model.Schema` is a `Schema.Class` whose fields are plain
  `readonly` data, except `$name` fields declared `Model.boxField(schema)` or
  `Model.collectionField(schema, { keyOf })`, which hold a box or a keyed
  collection; the wire key is `name`. Every instance has a `realm` field,
  which `Model.decode` fills and `make` takes by hand; it is never on the
  wire. `make` takes each `$` field's value under its wire key and builds
  the box in the instance's realm, so no box is shared between instances.
  `Model`, from `pinna`, is the base of a class that checks nothing. Granularity comes from boxes: a field that changes on its own is its
  own box.
- **Keyed lists.** `Collection.reconcile(previous, next, { keyOf, equals })`, or
  `Collection.reconcile(previous, next, { keyOf })` with `equals` from the
  schema, keeps the
  previous instance wherever an item's key and value are unchanged, so a
  refetch written to a box keeps row identity: a memoized row rerenders only
  when its item changed, and a refetch that changed nothing notifies nobody.
  A refetched `Model.Schema` row with equal plain fields is merged: the held
  instance stays and each box takes the refetched value, so only the readers
  of a changed box rerun. `Collection.reconcile` and `write.replaceAll` and
  `write.upsert` on a `Model.collectionField` merge; the merge hook is internal, not API.
- **Keyed collections.** `Collection.make(realm, { keyOf, equals? })`, in
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
  `Model.collectionField(schema, { keyOf })` is the same collection as a `$` field
  of a `Model.Schema`, with every row checked against `schema`.
  `row(key)` is a computed value kept per held key, and a
  `Computed.fn` entry for a missing key: it reads the key's box, or the
  order while the key is missing, so a reader of a missing key
  reruns when it arrives. A removed key's box is set to `undefined` before
  it leaves the map, so its readers rerun and find it gone. The map of
  boxes is not observable itself; the realm records each map change with
  the update and puts it back on a rollback, as it does a box write.
- **Row changes.** `Collection.onRowChange($items, listener)` calls the listener inside
  the writer's update, after each row is written, with that update's `read`
  and `write`. A value derived a row at a time, such as a sum or an index by
  another key, lives in boxes the listener writes, so it commits and rolls
  back with the rows and a watcher sees both in one delivery. A `Computed.make`
  over `rows` reaches the same value by rereading every row on each change.
  Each write path reports: `upsert` and `remove` compare the key's row
  before and after; `replaceAll`, and the `Model.collectionField` merge that runs
  it, report each old key, in the old key order, against the new map, then
  each added key in the new order. A row
  kept by `Object.is` reports nothing, which covers a `Model.Schema` row
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
value back before the error leaves `Realm.update`. The one error that leaves
`Realm.update` with the writes in place is an `onError` that throws while the
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

### One owner for what an update acquires

What an update acquires is released by a journal step on failure or by an
entry of the realm's completion list at the outermost end, never by a field
of its own. A field of its own is one more thing some exit path must
remember to clear, and an exit path that forgets it keeps a value past its
update: a key order's log of changes in place held removed keys (D5-1), the
visible stack's window held a dropped stage's row computed values (D6-4),
and a failed recipe's row patch stayed in its stage (D6-5).

- **Failure: a journal step.** A step undoes the acquisition when the
  update or stage recipe that took it throws, in the reverse of the order
  taken. `dropPatch` in `src/stage.ts`, which takes a failed recipe's row
  patch back out of the stage and retires it, is the pattern.
- **The outermost end: a completion entry.** `ObservableRealm.completions`
  is one flat array of objects with a `complete()` method. `forget`, which
  runs when the outermost update ends, failed or not, calls each entry once,
  in the order added, after the update's record is built, then empties the
  array with `length = 0`. An entry is the object that acquired, so the
  list reuses one array object and adds no wrapper objects; on Hermes
  `length = 0` drops the array's storage (docs/performance.md), so the
  first entry of a later update allocates it again. An entry does not
  throw. A key order (`OrderCell` in `src/collection.ts`) adds itself on its
  first change in place in an update, and its `complete` empties its log.
- **Not an entry.** A field that is neither acquired by an update nor
  released at its end stays a field: `stackReports` holds the errors that
  stopped visible stages and is sent once the watchers ran, after `forget`,
  or by a stage call outside any update; `scheduledRuns` counts a scheduled
  run inside its own `try`/`finally`; `AtomCell.revision` is a count, not a
  hold; `recordedCollections`, `recordedAtoms`, and `landedStages` are the
  change stream's parts of the record, which `takeRecord` clears at the
  start of `forget`.
- **Checked.** `openParts` (`src/testing/rest.ts`), which `testRealm`
  checks on disposal, reports a journal slot past the journal's end that
  still holds a value and a completion list that is not empty. Both
  fuzzers (`test/change-stream-fuzz.test.ts`,
  `test/stage-visible-fuzz.test.ts`) assert after every step that these,
  every order log, and `retainedKeys` beyond the rows held and shown are
  empty (`expectNothingHeld` in `test/rest.ts`).

The cost is one length compare at each outermost update's end, and nothing
on a read, a write, or a recompute. There is no frame object and no table
per update: the journal already owns failure, and one list owns the end.

## Stages

A stage holds the writes of asynchronous work out of the realm until the
work succeeds, then lands them in one update; a failure drops them and
leaves nothing to undo (ruling 53).

- **Overlay and journal.** A stage maps each box it wrote to its staged
  value, and each collection it wrote to a row patch (`RowPatch`,
  `src/patch.ts`) over the rows beneath it, the realm's or a lower stage's
  patch. A patch holds the stage's own writes and, for each key the rows
  beneath changed since, the row that key had when the patch began: before
  the collection or a lower patch changes a key, it hands each patch over
  it the row it had (`beforeKeyChanges`), and a whole replace beneath hands
  every row once (`beforeAllChange`). So a stage shows the rows as they were
  when it began, as a copy would, and pays per key changed, not per row
  held. The key order is the order box's staged value: an `OrderPatch`,
  the order beneath plus one immutable link per add or remove, built into
  an array once, on its first read or at the landing. The journal lists the
  recipes that ran without throwing. A child stage looks itself up first,
  then its parent, then the realm. Nothing copies the realm, and a stage
  makes no graph node.
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
  equality, merge, repeated-key check, and `Collection.onRowChange` reports as an
  update's, over the staged rows. A merge takes the `read` and `write` of
  the place it runs in, so a refetched `Model.Schema` merges into the held
  instance's boxes through the stage. Each overlay write is a step in the
  session's `Journal` (`src/journal.ts`, the class the realm's undo uses), and
  a recipe that throws rolls the journal back to its savepoint, the last
  step first.
- **The recipe guard.** A recipe runs once when staged and once per
  `Stage.apply` through its parents to the realm. Row listeners run for each
  change on each run. While it runs, the place word is the recipe kind
  (`placeKind.recipe`: deriving and recipe set; open, tracked, and
  selecting cleared) and `active` is cleared: a realm write, a watch, and an
  observe throw through the mask tests the core already makes, a kept realm
  `read` throws through the place check it already makes, and the messages
  that name a stage are built only on those throw paths. Making an
  observable, `Realm.untracked`, `Source.onObserved`,
  `Collection.onRowChange`, and the stage calls test the recipe bit
  (`placeRecipe`). `Realm.update` and `read` gain nothing.
- **Applying.** Over a realm: an optional conflict check against the
  applied stage's reads, then replay into a fresh root overlay that records
  no reads, using `runRecipes` and the same guard, checks, equality,
  listeners, merges, and savepoints as staging. Replay reads the realm's
  current values. A throw discards the overlay and drops the stage without
  changing the realm. Final equality is prepared under the guard too.
  One `Realm.update`, nested in an update already open, lands the final box
  values, collection rows and order, and atom marks without user code in
  its recipe. Box values already passed that box's check in replay; rows
  already passed that collection's check. Landing skips those checks and
  does not rerun row listeners. It records the ordinary cells, row changes,
  cache releases, and undo. Each collection tracks written keys, including
  removals; landing costs O(written boxes + written rows + marked atoms),
  with no scan of unwritten rows. Over a parent: the recipes run against
  the parent with one undo boundary, all or none. Each recipe has its own
  `read` and `write`, closed in its `finally`; landing preparation runs with
  no recipe handle open, under the guard, through a read-only session of its
  own, since comparing a held `Model.Schema` row with a staged one reads
  through the field codecs.
- **Write-back identity.** Root replay checks a box's incoming value before
  comparing it with the enclosing update's original value, then with the
  current overlay value, in the same order as an ordinary write. A value
  equal to the original restores that original object in the overlay at
  once, so later recipe reads see its identity; landing restores its
  version. Without an enclosing write, the first replay write uses the
  realm's value as the original. Existing collection row cells follow the
  same rule; rows without cells compare only with their current row, as
  an ordinary upsert does. A removed row no longer uses its old cell.
- **Final values.** A box written and then written back to its realm value,
  or a row added and then removed, lands no change: no version changes and
  no watcher runs. An ordinary update restores the box's original version
  too, but advances a collection's change counter on an add followed by a
  removal. Its `rows` watcher sees the same final rows and does not run;
  a second `{ conflicts: "fail" }` stage that read those rows conflicts.
  Applying the same writes through a stage leaves that second stage free
  to apply. Intermediate reads inside an ordinary update can observe its
  temporary values; no realm read observes replay's temporary values.
- **Closing.** A conflict or replay throw drops the stage. An open child,
  or a call inside a recipe or computed value, fails before replay and
  leaves it open. `Stage.status` and `Stage.inspect` remain callable outside
  a recipe after closing, and `Stage.drop` remains idempotent. Watch effects
  and autoruns settle after landing; errors go to `onError` and the stage
  stays `"applied"`.
  An enclosing update's rollback undoes the landing and changes the closed
  stage to `"dropped"`, with its journal still cleared. An empty journal
  stays `"applied"`, since it had no landing to undo.
- **Conflicts.** With `{ conflicts: "fail" }`, the first read of a realm
  value records the box's version: a box, or a collection's order and
  change counter, recorded also beneath a computed value's evaluation. An
  atom records its node's version, which `write.changed` moves, under the
  computed value it was read beneath, since an atom has no name; a value
  that keeps state outside Pinna, such as `Program.fromStream`'s or
  `Computed.fromPromise`'s, conflicts as a box does. A
  child's record merges into its parent's when it applies. `write.modify`
  records a read when it drafts a realm value, but not an overlay value.
  A later read of a different version replaces the record with `NaN`, which
  never matches: rollback can restore a smaller version, so numeric order
  cannot identify the first observation. The record keeps its observable
  for the conflict message. The check compares versions before the replay.

What it cost:

- A recipe must be a function of its `read`. An id, a time, or an
  observable made inside one would differ between the staged run and the
  replay; the guard catches observables, `Realm.update`, and kept reads, and an id
  or a time is a documented rule, since Pinna has no development mode.
- Computed values through a stage run uncached by the graph: a derivation
  of n reads costs n per evaluation, bounded by the stage's cache. Frond
  estimates 1 to 20 boxes and 1 to 50 recipes per stage.
- A collection costs per key a stage changes, not per row held: its
  `RowPatch` keeps a row before a key changes beneath it, and its
  `OrderPatch` adds one link per add or remove (ruling 73). Before the
  rewrite, it cost O(n) to copy on a stage's first upsert, removal, or
  order-only write, and again on the replay overlay's first such write;
  `bench:rows` at 100,000 rows took 4.0 ms for a hidden stage then and
  9 µs after. A `replaceAll` builds the replacement map instead of
  copying the held rows; replay runs it and its merges a second time. A
  refetch of 10,000 rows still does the recipe work twice. Written-key
  tracking costs O(written rows); preparing final order equality can scan
  the keys. `bench:stage` in `packages/pinna-effect` measures staging and applying
  against the update they replace. On the same machine with Bun 1.4.4,
  applying one upsert of a held row in a 100,000-row collection took a
  median 0.014709 ms before guarded overlay replay and 0.265375 ms after
  it (15 measured runs after 8 warmups; setup and staging excluded).
  `bench:stage`'s 10,000-row plain `replaceAll`, staging and applying
  included, rose from 0.77 ms to 3.57 ms; its `Model.Schema` refetch rose
  from 8.84 ms to 9.69 ms. These are local measurements, not ceilings.
- Conflicts replay unless asked. A value read through the stage can differ
  from what lands; `{ conflicts: "fail" }` turns that into an error, and the
  author decides whether rerunning the work, requests included, is safe.
- A conflict on a collection is per collection: any row change conflicts
  with any read of its rows, since a row with no cell has no version.
- A hidden stage's values are not observable: that would need a second
  graph per stage. A visible stage shows its values in the realm's own
  cells instead ("Visible stages").

The decision: stages are explicit and synchronous in `pinna`, read and
write everything the realm does, and hold the guarantee that a dropped
stage leaves no trace.

## Visible stages

A visible stage shows its writes in the realm's own cells over the
confirmed values, so an optimistic write needs no second graph and no undo
written by hand, and a refetch under it lands in the base without erasing
it (ruling 68).

- **The model.** The realm's values are the base. A stack of visible
  stages sits on it, bottom first; at rest every reader sees the base with
  each showing stage applied in order. A stage applied lands in the base
  through ruling 53's path; a stage dropped leaves it. The fuzz in
  `packages/pinna/test/stage-visible-fuzz.test.ts` checks this against an
  oracle: at every rest point the shown values equal a scratch realm with
  each showing stage applied as a hidden one, and every script ends with
  the same base whether its stages were visible or hidden. Its scripts
  (`test/fuzz/stage-script.ts`) hold conditional recipes, `"fail"` stages
  with base writes between, an atom, the keys `NaN`, `0`, `-0`, and
  objects, a box with its own `equals`, an `onError` handler that updates
  or drops a stage, and updates that apply a stage and roll back, alone
  or nested; autoruns on every value check that each saw the shown value,
  ran at most once per update, and that a no-op update ran none. The
  suite runs 200 seeds; `PINNA_STAGE_FUZZ_SEEDS=20000` ran clean on
  2026-11-26 in 18 s on Bun 1.4.4 with the install count, and is the
  gate of a change to `src/stack.ts`.
- **The window.** `Realm.update` at depth 1 asks one field, `realm.stack`.
  When a stack is open, the start of the update puts the base value and
  base version back in each covered box, key cell, and collection's held
  rows, and the end of the recipe puts the shown ones back. Both are raw
  `BoxCell.restore` calls and, for a collection, a put of the base row or
  the shown row of each key the stack wrote into the held map, in place
  (`putHeld`, `placeCell`), outside the update's record. At rest a stage's
  patch reads the base through a view over the held map (`BaseRows`). So the
  update's first write to a covered box records the base as its value
  before, which is what a rollback, a `"fail"` stage's record, and the
  change stream each need. Every stage call runs inside a `Realm.update`
  while a stack is open, so it reads the base through the paths ruling 53
  built; an earlier design asked a side table in `boxValue` and `rowsOf`,
  and three of nine probes failed on reads that forgot to ask.
- **Replay.** Each visible stage keeps the versions of the base cells it
  read (`inputs`), as a `"fail"` stage keeps its reads. When the window
  closes, the stack replays from the lowest stage whose inputs moved, or
  that a stage call changed: each recipe runs again in a fresh overlay over
  the base and the showing stages below it. A stage that would fail to
  apply stops instead and keeps its error. Then the shown values are
  settled: a value equal to the one shown before keeps its version, one
  equal to the base takes the base version, any other a new version, so an
  update that moves nothing under the stack reruns no reader. A collection
  shows the top-most stage's rows; its change counter takes a new version
  when a shown row moved. Stage caches are keyed by a revision counter
  shared by all stages, since a visible stage reads the overlays of the
  stages below it.
- **The install rule.** No application code runs between the first and
  the last raw write of a swap. `Stack.show` is two passes: a plan pass
  makes every box `equals` call and writes nothing, and an install pass
  makes the raw writes alone (`BoxCell.restore`, `putHeld`, `placeCell`, an
  atom's mark), each of which only marks the graph inside the update's
  batch. Opening the window and showing again are raw writes alone. An
  `equals` that throws joins the stopped stages' reports, sent once the
  outermost update ends, so `onError` never runs under the walk; before
  this, a handler's `Stage.drop` there was lost. `Stack.installing` is true
  for each raw pass, and `test/internal/stage-install.test.ts` counts every
  application function the fuzz runs (recipes, `equals`, the row listener,
  `compare`, `onError`, autoruns, a computed value) entered while it is: none.
- **Settling.** One flow per owner of the answer. When the guess is the
  answer, the visible stage applies on success and drops on failure. When
  the server's answer wins, the guess shows in a visible stage, the work
  writes a hidden one, and one `Realm.update` applies the hidden stage and
  drops the guess, so a watcher runs once with the settled value.
  `Stage.scoped`'s `visible` and `guess` options are the two flows.

What it costs:

- Nothing while no stack is open: two tests of one field in
  `Realm.update`. `increment` (16.22 ms base, 16.77 ms with the change),
  `write-sources` (6.91, 7.03), `one-write-among-many` (1.74, 1.72), and
  `fan-out` (8.88, 8.93): the fastest of four alternated launches each, on
  Node 22, inside launch noise. Hermes is not measured.
- With a stack open (Bun 1.4.4, per update): an update of an unrelated box
  242 ns against 45 ns with no stack; an update of the box one stage with
  one recipe wrote 3.2 µs; with 20 recipes 35.5 µs; five stages with one
  recipe each 13.9 µs. A stage call costs one swap of the covered cells.
- A collection a guess wrote costs the keys the stack wrote, not its rows:
  a base write to another row of a 100,000-row collection under a one-row
  guess costs 5.3 µs (`bench:rows`, Bun 1.4.4, 2026-11-25), against 2.79 ms
  when each show copied the rows. A guess that adds or removes keys builds
  its key order once per replay and once at the landing, O(keys): 0.57 ms
  for one staged add at 100,000 rows. Landing the order in place needs a
  lend of the live array the stack can take back, in place of the
  hand-out a stage's read of `orderCell` makes.
- A replay runs whole recipes from the lowest moved stage up: recipes are
  opaque functions, so a per-box replay is not possible.
- Two rules stay documented and unchecked, because the read path cannot
  afford the check: a `Realm.update` recipe reads confirmed values, which
  can differ from the screen; and a value read at rest and written later
  in an update writes a shown value into the base.

The decision: visible stages show over the base in the realm's cells,
every stage call reads the base in a window, and a stage that cannot apply
stops showing and says why when asked.

## Checked writes

A `Box.make` checks nothing. A `Box.schema` or a `Model.boxField` always holds a
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
- `make` and decode check a `Model.Schema` instance whole. Its plain fields
  are never written after that; its boxes check their own writes.

A rejected write throws a `ValueRejectedError`, `pinna: the box rejects
this value: ...`, inside the recipe, so the update rolls back. A box of `Schema.Unknown` checks nothing.

## Modules

Each type's calls live on one module object, and the type shares its name
(ruling 62): `Box.make(realm, 0)` returns a `Box<number>`, from one import.

- **A `const` and a type alias.** `packages/pinna/src/modules/box.ts`
  exports `const Box: BoxModule = { make: box }` and `type Box<Value>`.
  They sit in separate declaration spaces and compile together under
  `strict` and `verbatimModuleSyntax`; `export * as Box` with a `Box` type
  fails with TS2300.
- **One leaf file per module.** A module file imports the implementations,
  never the reverse. The objects are evaluated at load, so a cycle between
  two would meet the temporal dead zone.
- **pinna-effect spreads pinna's modules.** `{ ...PlainBox, schema:
  schemaBox }`, typed by an interface that extends pinna's, so a member
  pinna adds reaches pinna-effect with no edit. A local `const Box` hides
  the `type Box` that `export *` brings, so each module pinna-effect
  overrides redeclares its type; without it `Box<number>` fails with
  TS2749. `packages/pinna-effect/test/entries.test.ts` checks that each
  extended module holds pinna's own function for every member but
  `Collection.reconcile`, the schema form.
- **The implementations stay functions.** `observable.ts`, `stage.ts`, and
  `collection.ts` call each other directly; only the exports go through
  modules, and pinna-effect calls pinna's through them. `read` and `write`
  are closures a place hands out, not module members, so a recipe's reads
  and writes are unchanged.

The cost is one property load before each module call, not yet measured
on Hermes, and a module object kept whole by a bundler once one member is
used (`bun build`). The second is why the Effect stream programs sit on
`Program`, not `Realm`: `Realm.make` would otherwise pull Effect's
`Stream` into every bundle. `Program.watchScoped` runs on a `Queue` and a
child fiber, not a `Stream`: with `Stream.switchMap` it put 100.5 KB
minified (32.3 KB gzip) in a `bun build --minify` bundle of `Realm.make`
from pinna-effect, and 88.1 KB (28.2 KB) without (2026-11-24, Effect
4.1.0). It sat on `Realm` until 2026-11-25, when an entry that makes a
realm and runs one Effect measured 21,047 bytes minified (6,787 gzip)
larger with it on `Realm` than without, against about 430 bytes of its
own code; the rest is Effect's fiber and queue runtime. It moved to
`Program` (decision B2, ruling 72), so only its callers pay for it. Code
already on the modules migrates with `bun scripts/codemod/move-members.ts
<directory>`, which rewrites `Realm.watchScoped` to `Program.watchScoped`
through the TypeScript checker and adds the `Program` import. The rename ran through
`scripts/codemod/rename-api.ts`, which finds each reference through the
TypeScript checker, and `scripts/codemod/rename-prose.ts`, for inline code
in the docs; both read `scripts/codemod/names.ts`, and a second run of
either changes nothing.

## Snapshots

**A snapshot is `read` applied across a declared shape, and a restore is
`write` applied across the same shape** (ruling 64).
`packages/pinna/src/snapshot.ts` walks the shape: a box is `read(box)` and
`write(box, value)`; a collection is `read(collection.rows)` and
`write.replaceAll`; a `Model.Schema` instance describes its fields through
`modelShapeKey`, which pinna-effect's class defines, so `pinna` imports
nothing from Effect; a plain object or array recurses. Each `read` a place
hands out (the realm's, the merge reader, a stage's, and
`Stage.realmRead`'s) gets `snapshot` through `withSnapshot`, and each `write`
(the realm's and a stage's) gets `restore`, so the walk inherits what the
verbs do where they run.

- **Atomic.** The realm's `write.restore` runs inside `undoOnThrow`, a
  stage's inside the stage's own, so a throw part way puts back the
  restore's writes even when the recipe catches it. The update it runs in
  rolls back the rest.
- **Rows by key.** A restore of a collection maps the held rows by `keyOf`.
  A held `Model.Schema` row is restored in place, then passed to
  `write.replaceAll` as itself, so the collection keeps it and its readers
  do not rerun. An instance in the data whose plain fields match the held
  row's, matched by wire key, restores that row in place; any other
  instance goes to `write.replaceAll` as it is, replacing or adding the
  row. Plain data for a key no row holds is
  added as a row, unless the collection holds `Model.Schema` rows:
  `KeyedCollection.holdsModels`, set by pinna-effect for a collection of a
  model class, or any held row that is one. Then it throws.
- **Encoding is a read.** `Model.boxField` and `Model.collectionField`
  encode through `ObservableRealm.readerNow()`: a running stage recipe's
  `read`, the realm's tracked `read` in a tracked run, else the held value.
- **No registry.** Nothing is kept per box, per collection, or per realm;
  a snapshot allocates its result and a `Set` of the objects on its path,
  which catches a shape that holds itself (`pinna/snapshot-cycle`).

The cost is O(state under the shape) per call, and a snapshot in a computed
value recomputes in full on any write under the shape. `Realm.update`,
`read`, and `write` run no new code: each verb gains a property, as
`read.row` and `write.modify` are. The decision: a declared shape over
reflection, the verbs over a module call, and no realm-wide snapshot.

## Errors

Every error Pinna throws can be matched without parsing text and without
`instanceof`. Each is a `PinnaError` (`packages/pinna-core/src/errors.ts`):
a plain `Error` subclass, branded with the string key `"~pinna/Error"`, with
a literal `_tag`. A condition code handles has its own class
(`StageConflictError`, `StageClosedError`, `ValueRejectedError`,
`DecodeError`); misuse is one `PinnaUsageError` with a `code`.

- **The brand, not the class.** `isPinnaError` reads the brand, so an
  error from another copy of Pinna, another version or an add-on that
  bundles its own, matches. `instanceof` fails across copies. The brand is
  a string key, as Effect's own keys are (`"~effect/Equal"`), so two copies
  agree on it without a shared symbol registry.
- **Typed narrowing by tag.** `isPinnaError(value, "StageConflictError")`
  narrows through `PinnaErrorByTag`, an interface each package augments
  with `declare module`: pinna adds the stage errors and
  `ValueRejectedError` to pinna-core's, and pinna-effect adds `DecodeError`
  through `@frondruntime/pinna`, which re-exports it, so pinna-effect needs
  no dependency on pinna-core.
- **Effect without a dependency.** A literal `_tag` is all
  `Effect.catchTag` reads, so pinna's plain classes work in an Effect error
  channel. `Stage.scoped` moves a thrown `StageConflictError` to a failure,
  matched by brand and tag, and lets every other throw die.
- **Codes, not messages.** A code names the misuse and stays when the
  message changes, as it will when the API is renamed. Codes are prefixed by
  the package whose call was misused; pinna-core's are `pinna/…`, since an
  application reaches the graph only through pinna.

The cost is on the throw path only: a brand field and a code per error. The
hot paths construct nothing. `toJSON` gives each class's fields, so a
structured logger records more than `{}`.

## Inspection

`Source.inspect($x)` takes a box, a computed value, or an atom and returns
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

- A `Model.Schema` decodes only through `Model.decode`, which runs Effect's
  decode with the realm provided as a service: about 1.2 µs more per
  instance than a decode without one. A synchronous decode does not compile.
  Values a schema takes from the caller, such as a formatter, are the
  services of Effect `Context.Service` tags that `Model.context` fields hold,
  and `Model.decode` takes them in an Effect `Context`. An Effect decode takes
  the tag from `Effect.provideService` or a `Layer`. A field reads the tag
  from the Effect context, so the innermost provider wins: 6.8 ms on 10,000
  plain struct rows with one context field each, against 1.5 ms for a
  module variable read first. The variable was dropped because Effect
  Schema reads a field when it builds the decode, so an Effect decode
  nested inside a `Model.decode` that provided a tag the outer `Model.decode` also held
  got the outer value, with no error. A context field decoded with neither
  fails with Effect's missing-service defect, which names the tag.
- Each realm makes its own `read` and `write`, once, and each throws when
  handed an observable another realm made: a computed value, a watch, a
  `Realm.update`, or a `useSelect` of one realm cannot read or write another, open
  or not. The check is one comparison per call, against a variable of the
  closure. `useValues` throws when its observables come from two realms.
  `make` and `Model.decode` build every box of a `Model.Schema` in the instance's
  realm, and `make` throws when handed a box. Not caught:
  - a value of another realm stored in a box, a collection, or a nested
    `make`: a value is data, so storing it compares no realm. The first read
    of its boxes in the holder's realm throws, at the read, not where the
    value was stored. Checking at the store would catch only a model
    instance held directly, not one inside an array or a struct, short of
    walking every written value;
  - a `write` kept from realm A's `Realm.update` and called inside realm B's
    computed value, while that update is open (a kept verb, below);
  - realm B's `Realm.update` run inside realm A's: a rollback of A's leaves the
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
  place's own verb: a `read` kept from `Realm.untracked` and called in a computed
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
- A check on a `Model.Schema` as a whole (`Model.Schema(...)(fields).check(...)`)
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
- `Source.onObserved` hooks run when the first observer links or the last leaves.
  Inside an update or a flush they settle once the watchers are done, by
  comparing being observed then with when they last ran: an observer lost
  and gained within one update fires nothing (ruling 21).
- `Model.Schema` renames a `$name`
  field's wire key to `name` by overriding the class schema's static `ast`
  getter. The new schema decodes a struct of the fields under their wire
  keys, so each field is parsed and checked once and an error names the
  wire key. A `Model.boxField` or `Model.collectionField` decodes its wire value
  there, and the next step builds its box in the realm, which it looks up
  once for the whole instance instead of once per box. It then moves the
  fields to their own keys, adds the realm, and
  builds the instance with the transformation Effect's own class schema
  uses, which does not check the fields again. That reads Effect's `ast`
  getter off `Schema.Class` and the one transformation in its encoding,
  which depends on `Schema.Class` internals as of `effect` 4.1.0;
  `Model.Schema` throws if either is gone. The encoded type is written to
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
  `Realm.update` threw in tracked code; ruling 46 in `api.md` lets the body
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
its writes (#69), and a chain of `Source.onObserved` cleanups longer than the round
limit, each stopping the next autorun, stopped at the limit (MobX #3954).

### MobX's `onBecomeObserved` cases

`test/conformance/mobx-uses/become-observed.test.ts` ports the cases of
MobX's `__tests__/base/become-observed.ts` (MIT, Michel Weststrate, at
7.1.0) that `Source.onObserved` covers, and runs each on MobX beside Pinna.
The values every reader sees agree. The order of the hooks differs, as
`create-atom.test.ts` states: MobX starts a hook inside the read, Pinna once
the reader's run is linked. So a chain starts from the source up, not from
the reader down. A hook that loads what it guards (MobX #2667) runs the
reader once more for each list, first with nothing loaded. A cleanup that
throws goes to `onError`, not to the caller that stopped the autorun. The
`keepAlive` cases, maps, sets, and decorators are not ported:
`Source.observe` starts the held value's own hooks, which `keepAlive` does
not.

## Benchmarks

`bun run --cwd packages/pinna-effect bench:data`: a 10,000-todo model in three
subjects, each in its own process, medians of seven runs. One run, Apple
silicon, Bun; differences under about 15% are noise.

- **MobX** 7.1: plain objects, mutated in place.
- **Pinna, bare**: the same plain objects, every box checked by
  `Schema.Unknown`. It compares Pinna's reactive core with MobX's.
- **Pinna, Effect Schema**: `Model.Schema` instances, every write checked. A
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
passes a row's ceiling in `packages/pinna-effect/bench/data.ts`. Ratios hold across machines where
milliseconds do not. Each ceiling sits about twice above the ratio measured
when it was set; memory rows have none. The benchmark is not part of
`bun run check`: it takes about a minute.

Reading the table:

- Bare, Pinna matches or beats MobX on every row but one: one `Realm.update` per
  added item, which copies the 10,000-item array once per update, about 9×
  MobX's in-place push; finalizing the draft visits only the keys it
  touched. A write replaces the value, so a memoized child or the React
  Compiler sees a new identity; an in-place push would not give one.
  Batching adds into one `Realm.update` is MobX's speed.
- Toggling one row was 1.5× MobX until graph nodes stopped allocating:
  each recompute made a new dependency array and relinked its sources.
  Nodes then kept their methods on the prototype (since replaced by plain
  object literals with no prototype, `graph.ts`), made a second observer's
  `Set` and their `Source.onObserved` hooks on first use, and reused a run's
  dependency array when it read what the last run read. That took toggle
  from 987 to 463 ms and decoded memory from 25.6 to 17.2 MB.
- Boxes then stopped making closures: `get` and `peek` are prototype
  methods, and `set`, `Realm.update`, and an atom's `changed` are bound on first
  use and kept, so a box that is never written makes none and a setter can
  still be passed as `onChangeText={$name.set}`. That took decoded memory
  from 17.2 to 14.1 MB bare and from 8.7 to 5.6 MB with Effect Schema, and
  observed memory from 25.0 to 21.9 MB. The price: `get` and `peek` taken off
  their box lose `this`; a detached `get` throws on its first call. The
  methods are gone since: a box has no methods and no closures at all, and
  `read` and `write` are module functions each place hands out.
- With Effect Schema, one `Realm.update` per add is about 2–3× bare: a box of an
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
  model makes each row's label eagerly, `Model.Schema` lazily.
- Observed memory moves between runs for MobX, 35 to 52 MB on the same
  code, and toggle from 618 to 933 ms; Pinna's held at 22 MB.

### On Hermes

`bun run --cwd packages/pinna-effect bench:hermes <hermes-ios destroot>` runs the
same subjects the way a React Native release build would, with no app:
Bun bundles them, React Native 0.88.1's `@react-native/babel-preset` (a
devDependency, run with the Babel 7 it depends on) lowers them for Hermes,
`hermesc -O` compiles bytecode, and Hermes runs each subject in its own
process (`packages/pinna/bench/hermes-toolchain.ts`). Times come from the host's `now`, a
steady clock to the microsecond, since Hermes has no `performance`; memory
is allocated bytes after two collections. No ceilings: the table is read
next to Bun's. It takes about six minutes.

`bench:hermes-graph <hermes-ios destroot>`, in `packages/pinna`, does the same for the graph
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
- One `Realm.update` per add stays the weak row, 6–8× MobX, for the same reason
  as on Bun; one `Realm.update` for all adds beats MobX.
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

- `Collection.reconcile` reused a dropped edge for a source read again in another
  order, and in doing so cut the list of dropped edges it walked next. The
  sources after it stayed linked to an observer that no longer read them:
  they kept marking it, were counted twice when read again, and never ended
  their `Source.onObserved` hooks. Any run that read fewer sources in another
  order hit it, and so did a reaction's `adopt`. In C++ this is a dangling
  pointer.
- A derived value that lost its last observer partway through its own run
  unlinked the edges that run had added and not linked yet, emptying their
  sources' observer lists. `unsubscribe` now skips an unlinked edge.

### What the code assumes and nothing checks

- **One kind of tail.** The edges past a run's cursor are all linked or all
  unlinked; the code checks only the first. Both bugs above broke this.
- **Each source once per dependency list.** `Collection.reconcile` keys its scratch
  slots (`staleEdge`, `staleStamp`) by source, and a second edge to the
  same source would overwrite the first.
- **Counters never wrap.** `clock`, versions, run numbers, `walk`,
  `stamps`, and `hooksBegun` grow without bound and are compared in order;
  0 and −1 are sentinels, and `Collection.reconcile` negates a stamp to mark a moved
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
checks. The scratch fuzz that found the `Collection.reconcile` leak was this checker
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
| Capture | empty, captured (its clock current, or moved), failed (a run that threw keeps what it read); never linked |
| Scheduled watch or autorun | linked and idle, pending (the scheduler holds a `run`), running, stopped (terminal); a `run` once stopped or once the realm is not open does nothing |
| Hook | added, beginning (a placeholder cleanup), begun, ended; a removal inside a compute ends it at the next settle |
| Graph | idle, batched (`depth > 0`), settling; tracking, deriving, and walking alongside |

A derived value's fields allow 48 combinations for these 7 states, and
`cursor` is the record cursor during a run and the walk cursor during a
refresh. A read of a computing or walking value throws a cycle error; a walk
that reaches one counts it as changed.

### Scopes and ownership

- Each place saves the place word, `active`, and the run number by hand,
  in `try`/`finally`, sets the next word from the outer one (`nextPlace`),
  and restores them on exit; eight places pair `walkDepth++` with its
  decrement. In C++ each is a scope guard.
- The deriving bit of the place word (`placeDeriving`) says a derived
  value's compute or `equals` runs. A compute sets it and only a hook's
  place clears it, so nothing inside a compute writes, observes, or
  releases, however deep the call: a nested `Realm.untracked`, a reaction's
  `track` or `trackPending`, or a `Realm.untracked` inside `equals`.
  `restoreCell` throws there too, as `writeCell` and `touchSource` do; a
  rollback never runs inside a compute, since no write there is journaled.
  The error names the computing value: `active` while the place kind is
  compute, else `shadowed`, the compute an untracked read or a reaction's
  run set aside; a compute writes no field for the name. `active` says
  only what a read records.
- A hook that has begun is in the graph's `begunHooks`, in the order it
  began. A closed graph begins none, and `Graph.endBegunHooks` ends them,
  the last begun first, for the host's disposal.
- `beginBatch` and `endBatch` are public and counted: an `endBatch` with no
  open `beginBatch` throws, so `depth` never goes below 0. The one caller
  pairs them in a `finally`.
- An edge is made in one place (`recordMiss`) and dropped in several: where
  a run ends and cuts its tail, in `Collection.reconcile`, in `unsubscribe`, when a
  watch is disposed, and in `adopt`. None frees it. Each needs a free, or
  the port allocates edges from an arena.
- A node is held by user handles and by `edge.source`. A watch stays alive
  only through its sources' observer lists while linked; observer lists are
  back pointers that own nothing.

### Errors

A graph error is a `PinnaUsageError` (a cycle is one, code `pinna/cycle`,
kept as a class of its own inside the graph to find its origin), a user
error kept as a value, the "did not settle" error, a reporter's error, or a
host error that is swallowed. Where a settle's error goes depends on the
kind of settle:

| Settle | A reporter's throw goes to |
| --- | --- |
| after a write, or the end of a batch | the writer |
| after observing: track, adopt, activate, deactivate, a read, a dispose | the host |
| after `Realm.watch()` makes a watch | the caller if it came from that watch, else the host |
| after a call that failed | the host |

### What a port exposes

Beyond `index.ts`, the package reads `core.active` and the place word
(`core.place`), a cell's `version`, `nextCellVersion`, and `observerCount`.
Sibling packages reach a realm only through `@frondruntime/pinna/internal`'s
functions (`graphOf`, `reportAside`, `currentPlace`, `readerNow`,
`writeNow`, `onDispose`), never through its fields.

### Decided after the review

Each of these was a question for the owner; the rule is the one least
surprising to a reader, and a test pins each.

- Once a watch's stop function has run, its effect never runs again, even
  when the select of the run in progress called it.
- When `Realm.watch()`'s first run throws, the watch is unlinked before the
  settle, so its sources' hooks neither begin nor end.
- An `endBatch` with no open `beginBatch` throws, and `restoreCell` throws
  inside a compute.
- `track` leaves a pending run in place: `adopt` follows it even when a
  `track` ran in between, since the pending run is the render the renderer
  kept.
- `activate` and `adopt` are walks: an atom they link counts as changed
  once, whatever the last walk checked.

## React hooks

**Only a render React commits moves what a hook follows, and the value a
component renders is the one React compares.** React may render a component
and throw the render away, render it again while a write lands, or call a
store's `getSnapshot` twice in a row; each case reached a wrong screen or a
restarted source before (L2-1 to L2-4 in the 0.2.0 review).

The mechanism, in `packages/pinna-react/src/index.ts`, is one protocol for
`useValue`, `useValues`, and `useSelect`:

- **The snapshot is the rendered value.** `getSnapshot` returns the
  render's result, and the hook reads nothing else, so React's check before
  a concurrent commit sees a write that landed during the render and renders
  again (L2-1).
- **Each render has its own capture.** `useSelect` runs its function into a
  `Capture` of pinna-core: a pending node, never linked, that records each
  source with the version it read, under the selector place, so it observes
  nothing and starts no `Source.onObserved` hook. `useValue` and `useValues`
  read their observables with `peek` and keep the realm's clock. While the
  clock stays, `getSnapshot` returns the cached result; once it moved,
  `useSelect` walks the recorded versions and runs again when one moved, and
  `useValues` reads again and keeps its array when every value is equal
  (L2-3, L2-4). A render that reads what the committed render read reuses
  its capture.
- **A committed render's layout effect adopts its capture.**
  `Reaction.follow(capture)` copies the capture's edges into the hook's
  reaction and reconciles them against the live ones, so a source both read
  keeps its edge and its hook neither stops nor starts; a source that moved
  since the capture tells React to compare. A render React throws away is
  never adopted, so it cannot unsubscribe a mounted source or restart a
  `Computed.fromPromise` request (L2-2).
- **A change recaptures the committed render.** When a followed source
  changes, the committed capture runs again and the reaction follows what
  it read, even when the result is equal and no render follows, so a
  `useSelect` never keeps watching sources its function stopped reading.

`useValue` adopts in React's own `subscribe`, which React runs only for a
committed render and only when the capture changed: two captures of one
observable are one capture, so they share no source, and no `useValue`
render runs a layout effect. `useValues` and `useSelect` keep the layout
effect, with `[store, capture]` deps, since two of their captures can share
a source and React unsubscribes before it subscribes, which would stop it.

The cost: `useSelect` allocates a capture (a node, and an edge per source)
on every render with a new function, where `trackPending` reused one
pending node. On the `pinna-react` bench (Bun, happy-dom, 5 passes
interleaved with the previous hooks, on a container other builds shared),
`useValue` is 0.88 to 1.06x the previous minimum in every case; a first
version with a layout effect per `useValue` render took 1.55x on 10,000
rows all ticking. `useSelect` is 0.95 to 1.04x except mount 10,000 (1.33x)
and 1,000 rows all ticking (1.22x), within the run-to-run noise.

Decision: one protocol for every hook. Ruling 39's `useValue` still reads
no context and subscribes when React subscribes. `Reaction.trackPending`
and `adopt` stay in pinna-core, which no hook uses any more.

## Views

A view keeps a derived structure over a collection current a row at a time,
with no hook in `Realm.update` or a write (ruling 63). `View.ordered`,
`View.grouped`, and `View.totals` (`packages/pinna/src/view.ts`) each listen
with `Collection.onRowChange`, through the same registration with the label
of the view, and write their state where the realm already journals writes.

- **Ordered.** One box holds the config the trees were built with and two
  persistent AVL trees of rows (`src/view-tree.ts`): every row, and the rows
  that pass the filter. A tree holds the row itself, not a key and a row, and
  asks the collection's `keyOf` only on a tie or a read of keys. A row write removes `before` and inserts `after`, which
  copies one search path per tree, `O(log n)`. A computed value, `current`,
  answers the box when its config matches the one `compare` and `filter`
  now give, and a rebuild from the box's own trees otherwise: a sort for a
  new comparator, a scan for a new filter. The listener reads `current`, so
  the first row write after a config change stores the rebuild. `compare`
  and `filter` are two computed values, so a box only the filter reads keeps
  the comparator and does not sort. A second config change before any row
  write starts from the first one's rebuild, kept beside the box value it
  started from, so each change sorts or scans once. A rebuild
  never reads the collection: `replaceAll` writes every row before its first
  report, and a rebuild from the rows would apply those rows twice.
- **Grouped and totals.** A collection keyed by group holds each group's
  keys, or its count and total. Replacing a held group's entry costs the same
  at any size; a new or emptied group copies the groups' key order, as any
  collection does. A group read is `read.row` of that group, tracked alone.
  A group's keys are one array, so a join copies the group: one group of
  `n` keys costs `n²/2` copies to fill. Many small groups are the case it
  is for; one large group would need a persistent structure per group.
- **Lifecycle.** The view's stop, a rollback of the update that made it,
  and `Realm.dispose` each remove its listener, and each marks the view
  disposed. A disposed ordered view answers its last value, so a box its
  factories read no longer rebuilds an order nothing keeps current. A view
  is refused while an open stage holds writes to its collection
  (`pinna/view-staged-rows`): a listener hears the realm's rows, so the
  stage's rows would be missing from it.
- **Rollback and stages.** The trees and groups are box and collection
  values, so a failed update puts them back with the rows, and a stage runs
  the listener over its staged rows with its own `read` and `write`. No
  journal of the view's own exists.
- **Ties.** Two rows equal under `compare` are ordered by key. A tie
  token per insertion would put a key elsewhere after a replay or a stage
  than in the realm; a key order is the same in each.

Cost, measured on Bun with a sorted, filtered view of 10,000 rows and a
50-key window observed: a row write costs about 10 µs, against about 1 µs
for the same write with no view; a `replaceAll` of 10,000 rows into the view
costs about 50 ms, 5 µs a row. A collection with no view pays nothing: the
listener list is the one `Collection.onRowChange` already has. The cost of
the box path is the listener's work and two path copies per write; the
parked `feat/collection-views` branch avoided neither, and added a check of
every view at the end of every update.

The desk (`apps/desk/scripts/measure.ts`, 100,000 trades) moved its
hand-written index onto `View.ordered` at the same cost within the noise of
the runs: a sort change 369 ms against 357 ms, a filter keystroke 154 to
182 ms against 144 ms, and a held-trade update 0.15 ms against 0.12 ms, all
medians on Bun.

The callbacks cannot be checked for purity without a guard on every read
and write. A view throws `pinna/view-out-of-step` where it finds a row
missing from its place, and the docs require callbacks to be functions of
the row. Decision: views stay on the public hook, so the core rewrite and
the snapshot work see no view in `Realm.update`.

## Disposal

A realm is collected when nothing outside it references it, because Pinna
holds no module state: the only module-level collections are `WeakMap`s. A
realm stays alive, and keeps running, only through a root outside it: a
socket or timer a `Source.onObserved` hook started, a fiber `Program.fromStream` or
`Program.whileObserved` forked (detached from the caller's scope, held by the
Effect scheduler), a resource an autorun's cleanup stops, an Effect scope,
or a mounted React tree. The roots chain: a linked observer keeps a hook
started, and the hook's socket keeps the realm. `Realm.dispose` breaks the
chain at the hooks (ruling 57).

- **What it keeps.** The graph keeps every `Source.onObserved` hook that has
  begun (`begunHooks`), added when the hook begins and deleted when it
  ends; `Source.onObserved` hands the graph the caller's start itself, so
  adding a start twice still adds it once. Each autorun,
  `Collection.onRowChange` listener, view, and stage registers its stop in
  `registered`. `pinna-effect`'s `Program.changes` and `Program.watchScoped`
  add a listener through the internal entry's `onDispose` for their scope.
  Watches, `Source.observe`, and React reactions register nothing.
- **What it runs.** The listeners, then the registered stops, newest
  first, then every begun hook's cleanup, newest first
  (`Graph.endBegunHooks`), all in one batch: an
  autorun's stop unlinks its sources, and outside a batch that unlink would
  settle and end a source's hook before an older autorun's cleanup that
  still uses it. Ending a hook takes it out of the graph's begun hooks, so
  each cleanup runs once, whichever of the graph and the disposal ends it
  first: a component unmounting after the disposal runs nothing again. A
  closed graph begins no hook, since a mounted reaction that reads a new
  source after disposal still links it.
- **What it refuses.** The core's `closed` flag refuses a watch and a
  reaction's `activate`, and makes a settle drop its due watchers instead
  of running them, so a cleanup's write runs no watch. The realm's
  `assertOpen` refuses `Realm.autorun`, `Source.observe`, `Source.onObserved`, `Collection.onRowChange`,
  and `Stage.make` with the call's name. `Realm.update` reads the disposed
  bit (`placeDisposed`) in the same mask test of the place word that
  refuses an update in a derivation.
- **The cost.** Observers stay linked after the disposal, inert, because
  keeping them costs every application. A `Set` of linked observers, added
  at each watch and activation, put `one-write-among-many` (one write
  among 10,000 watched rows, times 1,000) at 1.93 to 2.03 ms against 1.53
  to 1.68 ms on main, on Node at the publish tier; a `Set` of wrapper
  objects cost the same, so the cost is the set's 10,000 entries, not
  hashing the nodes. Keeping begun hooks instead measured within noise of
  main on every scenario run: `make-and-dispose` 3.41 and 3.45 ms against
  3.30 and 3.51, `increment` 15.57 and 15.79 against 15.58 and 15.87,
  `write-sources` 6.74 and 6.81 against 6.65 and 6.76,
  `one-write-among-many` 1.49 and 1.67 against 1.48 and 1.63, `fan-out`
  8.44 and 8.49 against 8.24 and 8.35, `deep-chain` 4.76 and 4.80 against
  4.77 and 4.78. Hermes was not measured: the machine had no Hermes build.
  A begun hook costs a closure and a `Set.add`, once per source and
  observation; a computed function's entries and a collection's rows use
  the graph's hooks directly and pay nothing.
- **A disposal from inside a run is refused.** `pinna/dispose-not-at-rest`
  is thrown when the graph's depth, the realm's update or open depth, the
  derivation slot, or the active run is set: fields disposal would read
  anyway. Supporting it would mean disposing in the middle of a settle,
  which the owner ruled a caller's bug.

The decision: disposal ends what holds a realm alive, not every link into
it, and a disposed realm reads but never runs.

## Scheduling

Every watcher without a scheduler runs synchronously when the outermost
`Realm.update` ends, and the realm takes no scheduler. One `Realm.watch` or `Realm.autorun`
may take a `scheduler` (ruling 58): a second layer in `pinna` over
pinna-core's `Reaction`, which leaves every other watcher's timing as it was.
The libraries with a scheduler have it for a reason tied to where they sit:

- **MobX's `configure({ reactionScheduler })` wraps the run of pending
  reactions; it does not defer it.** The default is `f => f()`, and each call
  wraps the one before (`mobx/src/core/reaction.ts`). Its one user in
  practice is mobx-react-lite, which sets it to React's
  `unstable_batchedUpdates` on import, so an action that changes ten
  observers renders once under React 17 and earlier. React 18 batches
  renders itself, and `pinna-react` requires React 19.
- **MobX's `autorun` and `reaction` take `delay` and `scheduler` for one
  reaction.** `delay` becomes a `setTimeout`: throttling in application
  code, and in Pinna the scheduler `(run) => setTimeout(run, ms)`.
  `pinna-effect` also covers it with `Stream.debounce` or `Stream.throttle`
  on `Program.changes($x)`.
- **alien-signals hands scheduling to its host.** `effect(fn)` takes no
  options, and effects run when the outermost batch ends.
  `createReactiveSystem({ update, notify, unwatched })` calls `notify` for
  each watching node that turns dirty, so a framework built on the graph,
  such as Vue 3.6, decides when effects run.

**The mechanism.** A scheduled watch or autorun is a `Reaction` notified
when marked (`new Reaction(graph, onChange, label, "marked")`), a `pending`
flag, and a `run` closure (`packages/pinna/src/scheduled.ts`). The settle
calls `onChange` for such a reaction without refreshing it; `onChange` calls
the scheduler once per schedule. `run` refuses where values are partial
(`pinna/scheduled-run-not-at-rest`), does nothing once stopped or once the
realm is not open, asks `Reaction.changed()`, which brings what the last run
read current, and runs the select or the body through `track` only when
something changed. So every write before `run` joins one run with the
values current then, and a computed value it reads recomputes once per run.
`pinna-react` uses the same class notified when changed: the settle refreshes, and
the store tells React only of a real change.

`Reaction.track` schedules its reaction again when its run wrote, as
`runWatch` does: a source the run read through an edge linked only at the
run's end changed with no mark reaching it. A render cannot write, so only a
scheduled autorun meets it; without it, the autorun missed its own write.

**The cost.** `read`, `write`, `Realm.update`, and `mark` are unchanged. The
settle's loop compares the kind of a due reaction once more, before its
refresh; a watch's path takes no new comparison. `track` compares the clock
once per run. A scheduled watch or autorun registers with the realm for
disposal and `testRealm`, a set the plain ones stay out of (ruling 57).
Measured on Node 22.23.5 against the tree before it, in one checkout: all
nine bench scenarios within 1.5%, and one write among 10,000 watched rows,
whose launches spread about ±25%, at a median of 1.070 ms against 1.059 ms
over ten launches each (the reaction schedulers design note, "The
build's bench"). Hermes is not measured.

**The limits.**

- A deferred run that writes what it read is past the reach of the round
  limit, which counts the rounds of one settle. The reaction counts notices
  that arrive during its own run; at 100 in a row, `pinna/watchers-unsettled`
  goes to `onError` and that schedule is skipped.
- A cycle met while the settle brings a plain watch's sources current is
  reported there; a scheduled run's select meets it at its read instead.
  The differential check that runs every fuzz program with
  `(run) => run()` against plain watches leaves cycles out for this reason.
- Between deferred reactions Pinna promises no order: each runs when its
  scheduler calls it.

A scheduler on the realm stays out. Deferring the settle would break the
guarantee that every watcher has run when `Realm.update` returns, and a watcher's
error, which today reaches the writer ("Errors", above), would surface in a
frame callback with no link to the update that caused it.

Charts, games, and animation need no scheduler either. A chart may draw
from its own `requestAnimationFrame` loop: a watch sets a flag, and the loop
reads through `Realm.untracked` when the flag is set. A game loop keeps its
per-frame state in plain code and writes domain state at most once a frame
(`README.md`, "What it is for"). A high-rate source buffers in plain code and
opens one `Realm.update` per frame. That saves the writes as well as the runs: a
scheduler after the write cannot take back the array copy each `Realm.update`
pays. The cost is that every application with a high-rate source writes
that buffer itself, about ten lines.

Two hooks wait for a use:

- **A `notify` hook in pinna-core**, for a host that embeds the graph and
  decides when every observer runs. A reached watcher is appended to the due
  queue, a list linked through `nextDue` and `graph.dueTail` in `graph.ts`,
  in three places, `mark`, `runWatch`, and `Reaction.track`, and `settle`
  drains that queue in one place; the hook goes at the appends. Keep them
  few, or adding the hook stops being local.
- **A schedule option on the `pinna-react` hooks**, for many components
  that each want at most one render per frame from a source with many
  writers, where neither a buffer at the source nor one read loop fits. A
  controlled input never takes it, since its render has to follow each
  keystroke. `useSelect` runs its selector at every settle that reaches it;
  moving its store to a reaction notified when marked would run it once per
  render, a change with its own measurement.

## Values from a promise or an Effect

**A promise or an Effect enters Pinna as a read-only value that runs while
observed, and nothing more** (ruling 65). `Computed.fromPromise` in `pinna`
and `Program.fromEffect` in `pinna-effect` close the plain and the Effect
side of one gap: a MobX application replaces each mobx-utils `fromPromise`,
and a one-shot Effect, such as a settings read, needs no stream of one.

- **Mechanism.** `packages/pinna/src/promise.ts` is `Program.fromStream`
  without Effect: a private atom, a closure variable `latest`, and a
  computed value that reads the atom and returns `latest`. A
  `Source.onObserved` hook makes an `AbortController`, calls
  `load(signal)`, and on resolution, while its run is active, compares
  with `equals` and writes `latest` in an update that marks the atom. The
  cleanup clears the run's flag, aborts, and resets `latest` to `initial`
  in an update, unless it already holds `initial`. The state stays out of
  the update journal for fromStream's reason: ending an observation inside
  an update that throws must not restore a stale value.
- **Disposal and late answers.** `Realm.dispose` runs the hook's begun
  cleanup, so the abort and the reset are the same path as the last
  observer leaving. A result that arrives later finds its run inactive and
  writes nothing; the hand pattern in the live-data guide, an `await` then
  `Realm.update`, throws `pinna/realm-disposed` from the promise chain
  instead.
- **Failure.** A rejection while the run is active goes to
  `core.reportAside`, which is the realm's `onError` or the host's
  `reportError`, the path a hook's throw takes; a rejection after the
  cleanup, such as the abort's own `AbortError`, is dropped. The value
  holds no failure: Frond and request libraries own a status type, and an
  application maps a failure into its own union inside `load`.
- **Stages.** A promise settles in a microtask, never inside a recipe, so
  the bridge writes the realm and never a stage. A stage reads an
  unobserved value as `initial`, since a stage read subscribes to nothing.
  Before 2026-11-25 a stage opened with `{ conflicts: "fail" }` recorded
  no atom read, so every atom-backed value, `Program.fromStream`'s among
  them, changed between staging and `Stage.apply` with no conflict; the
  stage now records the atom node's version, reported under the computed
  value it was read beneath ("Stages", above).
- **Snapshot and schedulers.** A shape cannot hold a computed value, so a
  bridge value is never in a snapshot; a result to be saved is written
  into a box. The resolved value lands in a plain update, which a scheduled
  watch defers as any write.

The cost is one atom, one computed value, and one hook per bridge value,
and a closure and an `AbortController` per observation; `Realm.update`,
`read`, and `write` run no new code. Each observation starts a new request,
so a screen that comes back requests again, and shows `initial` until the
answer arrives: an already-resolved promise still settles in a microtask.
`Source.observe` holds a value whose answer must outlast its screens.

The decision: one lifetime for every value fed from outside, observation,
and no asynchronous value type in Pinna. Loading, refetch, caching, and
Suspense stay with the request library an application chose, which Pinna
holds through a box a `Source.onObserved` hook writes.

## Forms

Kept in the private repository: `pinna-form` is not published.

## Change stream

**Every landed outermost update can be read as data, one record of its net
change, at no cost while nobody listens** (ruling 69; the decisions and
their alternatives are in the change stream design note). Devtools, undo,
replay, logging, and Frond's persistence read the same record, so none of
them wraps `Realm.update` or walks the state.

- **Mechanism.** An outermost update already keeps, on each box it first
  writes, `valueBefore` and `versionBefore`, linked through `recorded`,
  and `forget()` walks that list at depth 0. While
  `realm.updateListeners` is set, `forget()` first walks it once more
  (`ObservableRealm.takeRecord`): a box back at `versionBefore` is
  skipped, a `CollectionCell` (a collection's order, change counter, or
  row cell) is left to its collection, and every other box is a
  `BoxChange`. A row has no box until a reader reads it, so a collection
  keeps `rowsBefore`, the row each key had at the update's start, on the
  first write to the key (`noteRow`, called from `hold`, the removals, and
  `replaceRows`), with an undo entry so a rolled-back nested update takes
  its note back. An atom's change is noted the same way. `Stage.apply`'s
  landing notes its stage's name. The record is frozen and queued.
- **Base values.** A visible stage swaps cells raw, outside `recorded`, so
  a first write under a guess records the base. At `forget()` the cells
  hold the shown values again, so `takeRecord` reads a covered box through
  `VisibleStack.baseOf` and a covered collection's rows through
  `baseRows`. Showing and withdrawing an atom is `AtomCell.mark`, which
  notes nothing. `packages/pinna/test/change-stream.test.ts` checks that
  showing, updating, and dropping a guess make no record, and that an
  update under one reports base values.
- **Delivery.** `Realm.update` drains the queue after `endBatch`, once the
  graph is at depth 0, so the update's watchers have run and a watcher's
  own update queued behind it. A listener runs with `draining` set: its
  update's record joins the queue, and `Realm.dispose` refuses. An update
  that ends inside a settle no update encloses (a hook's write as a
  renderer mounts) schedules a microtask drain; `Realm.autorun` drains as
  it returns, so a first run's update goes out at once.
- **Replay and revert.** `applyRecord` in `src/record.ts` takes a `read`
  and a `write`, so the realm's writer and a stage's writer share it. A
  collection whose order moved is written whole with `write.replaceAll`,
  since `write.upsert`'s `at` cannot put a key back in the middle.
  `packages/pinna/test/change-stream-fuzz.test.ts` runs 200 seeds of
  random updates, caught nested failures, failed updates, a watch that
  writes, and visible stages, and checks that records chain, that
  reverting all of them newest first restores the start, key order
  included, and that replaying all of them restores the end. The
  differential fuzz runs every program again with a listener attached and
  finds every trace unchanged.
- **Restore once** (ruling 74). A restore installs the record's values and
  runs no listener whose writes the record already holds. Before the
  first write, `assertApplicable` compares every recorded box, row, and
  moved key order with the side the restore starts from, by `Object.is`,
  and throws `pinna/record-not-applicable` on a mismatch: one pass over
  the record. Each `Collection.onRowChange` entry carries a serial from
  its collection's registration count; `takeChange` puts the count at the
  update's end in `listenerCounts`, a `WeakMap` by `CollectionChange`, and
  `restoreHeardAfter` swaps the collection's listener list for the entries
  above that count while the collection's part is written, then puts back
  every entry not stopped, so the write path reads the same one field it
  always did. A view's entry has an infinite serial, so it hears every
  restore, and its storage is out of every record: the ordered view's
  state box is a `CollectionCell`, and the collection a grouped or totals
  view keeps has `inRecord` false, so `takeChange` forgets its notes and
  reports nothing. A user registration while the realm records notes its
  collection; a record whose `Realm.update` registered one is refused, and
  the update `Collection.onRowChange` opens at rest marks its record with
  the rows its listener heard (`registrationRows`), so its revert writes
  nothing and its replay reinstalls the listener's first state; the mark
  is taken by the first record built, so a record a watcher or a
  `Realm.onUpdate` listener makes while the registration settles is its
  own, and a rollback of the update that registered takes back the
  collection's registration mark. A restore takes only a record in
  `madeRecords`, since a copy loses what is kept beside it. A record
  that lists two or more collections keeps what each restore left
  (`landedOf`) and, once all are written, compares it again
  (`movedSince`), by `Object.is`; a change throws: a later listener that
  heard one collection's restore wrote another restored before it, and
  writing that collection again would run its later listeners again.
  `restoreHeardAfter` also sets the collection's `merge` to `undefined`
  and its `equals` to `Object.is` while its part is written, and puts both
  back after, so a restore installs each recorded row by identity: a
  `Model.Schema` row is not merged into the row held, since a restore is
  not a refetch, and its boxes come back through the record's box
  changes. V8 treats a field written only in the constructor as constant
  and compiles its readers on that; the first restore that swaps `merge`
  and `equals` on a collection deoptimizes those readers once per
  collection. Hermes has no such tracking. The cost falls on the
  restore's callers only. Cost: two field swaps and an
  array per recorded collection and a second pass, on the restore's path
  only, a
  field test in `listen` and in `takeRecord`'s loop over recorded
  collections, a `WeakMap` set per recorded collection, and nothing on
  `read`, `write`, or a recompute. The limit: a listener added after some
  records that keeps an object in a box builds a new one as it hears their
  restore, so a later record's replay throws when no registration record
  can put the first object back (open, test 7). The undo fuzz in
  `change-stream-fuzz.test.ts` walks undo, redo, and out-of-order restores
  over a listener-kept sum, a listener that writes a second collection,
  an ordered view, a view and an object-keeping listener added at rest
  partway, and a listener added inside an update, against a plain-data
  model; the view fuzz in `view.test.ts` checks all three views after
  random writes, undos, and redos.
- **Cost.** Without a listener: one store at depth 1 for the update's
  name, one field read in `forget()`, one after `endBatch`, and one per
  row write and per atom change. A `CollectionCell` is a subclass, so a
  box grows by no field. With a listener: a `Map` entry and an undo entry
  on a row's first write per update, an O(n) note on `replaceAll`, and a
  walk of the boxes written at the end.

  | Node 22.23.5, `bun run bench --tier publish --library pinna`, ms | base | change stream |
  | --- | --- | --- |
  | `increment`, 8 alternating rounds | 15.58 | 16.10 |
  | `increment`, the last 3, after an unnamed update stopped storing a name | 15.62 | 15.76 |
  | `write-sources`, 8 rounds | 6.91 | 6.86 |
  | `one-write-among-many`, 5 rounds | 1.43 | 1.48 |
  | `deep-chain`, `fan-out`, `diamond`, `make-and-dispose` (2 rounds) | within 6% either way | |

  Without a listener every scenario is within the container's launch
  noise (about 10%). With one, `bun run --cwd packages/pinna
  bench:changes` on Bun 1.4.4 gives per update: a box write 84 ns without
  a listener, 1,607 ns with one; a row upsert into 10,000 rows 232 and
  2,188 ns; a `replaceAll` of 1,000 rows 116 and 658 µs. Freezing the
  record is most of it on JavaScriptCore: without `Object.freeze` the same
  three are 435 ns, 1,039 ns, and 368 µs. Hermes is not measured.
- **Decision.** Built as designed, with Pinna reporting writes as data and
  applying them back, and nothing more: paths, persistence, coalescing,
  and filtering stay with the consumer, which holds the shape and the
  policy.

## Devtools

Kept in the private repository: `pinna-devtools` and
`pinna-devtools-react` are not published.

## Agent skills

Seven agent skills under `skills/` give an agent writing an application on
Pinna the rules for one kind of work at a time, and none of them can drift
from the code: each is generated from `packages/pinna/AGENTS.md` (the hub)
and `docs/public`, and `scripts/skills/build.test.ts` fails when the
committed files differ from what `scripts/skills/build.ts` writes (ruling
76). `npx skills add frondruntime/pinna` installs them.

The hub is read whole. A skill loads its work's 76 to 141 lines and carries
that work's docs pages as references, opened on the condition the page's
own `description` states.

| Skill | Hub | References |
| --- | --- | --- |
| `pinna-state` | rules 1 to 6 (models without Effect, collections, views, row listeners, reconcile), rule 10, `read.row` | `start/index`, `state/boxes`, `state/updates` (to "Stages", and "Effects after the update"), `state/collections`, `state/views`, `guides/row-indexes`, `state/reacting`, `start/principles` |
| `pinna-react-components` | rule 9, "In a component", "No lint rule" | `react/hooks` |
| `pinna-with-effect` | rule 4, the Effect bullets of rules 6, 7, 8, 12, and rule 9 | `effect/boxes`, `effect/classes`, `effect/collections`, `effect/equality`, `effect/programs` (two parts), `guides/live-data` ("With Effect") |
| `pinna-stages-and-live-data` | rules 7, 8, 9 | `state/updates` ("Stages", "Visible stages"), `state/lifecycles`, `guides/live-data`, `guides/async-state` |
| `pinna-saving-and-history` | rules 11, 12 | `state/snapshots`, `guides/saving`, `state/changes` |
| `pinna-testing-and-errors` | "In a test", "When it throws" | `guides/testing`, `effect/programs` ("Testing"), `reference/errors`, `guides/errors` |
| `pinna-from-mobx` | "MobX habits that do not carry over" | `start/mobx` |

The mechanism: `scripts/skills/manifest.ts` names, per skill, the hub's
rules and the blocks of a rule or section by their opening words, the
`## ` sections of each page it carries, its neighbors, and its trigger
prompts. `slices.ts` cuts the hub into a rule's lead and bullets and a
section's blocks; an opening that starts no block, or two, fails.
`apps/site/scripts/regions.ts`, shared with `sync-docs`, expands each
region marker, so a skill prints the code `bun run typecheck` compiles. A
link to a page or section a reference of the same skill carries points at
that file; any other points at the page on the site. `names.ts` builds a
TypeScript program over the published packages through the `source`
condition and resolves every `Module.member`, `read.x`, `write.x`,
`use...`, error class, and `pinna/...` a skill, the hub, or a page prints.
`skills.sh.json` groups the seven on skills.sh; the test fails when it
names a skill that does not exist or leaves one out.

The cost: a skill says nothing the hub and the docs do not say, so a
sentence a skill needs is written into the hub or a page, where the
tarball and the site get it too; and the name check adds about two
seconds to `bun test ./scripts`. Each skill repeats the hub's first
paragraph, and all but `pinna-state` rules 1 to 3, about 30 lines, so a
skill read alone still reads `read` and `write` as verbs and not as
methods. Seven skills load about twice the lines per task that thirteen
did, and overlap less: a prompt about Effect, saving, or a failing test
fits one skill, where thirteen offered two.

The decision: skills are a build product of the hub and the docs, checked
like the site's samples, and shipped as `skills/` at the root of the
public repository.

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
  `pinna-effect`. Its `Collection.reconcile` and a `Model.collectionField` merge a
  `Model.Schema` row into the held one (`docs/api.md`, ruling 51); `pinna`'s
  `Collection.reconcile` and `Collection.make` keep unchanged rows and replace
  changed ones whole, and a `Model` row has no schema to merge by.
- Memory of `Source.onObserved` hooks across many short-lived observables.
- `Model.collectionField` checks only the row it writes. An add or removal
  changes the array of keys in place while nothing holds it, and copies it
  once something does: a read of `keys`, a stage, the visible stack, or an
  update listener (ruling 73). A list grown one key at a time to tens of
  thousands of keys while a component renders `keys` still copies per
  change, and may need an order structure that does not copy.
- Two lint rules the first `$` proposal planned are not built: a box or a
  computed value assigned to a name without `$`, and a plain getter that
  reads a `$` value. Neither needs type information, so a Biome GritQL
  plugin can hold them.
- Forms (ruling 66). A rule of a reusable group reads only its own parts:
  a group that needs a form's dependency takes it through the form's
  `checks` or `disabled` keyed by the group, or the group is declared
  inside a function that takes the dependency. A `Form.group` with
  dependencies of its own is out until a form needs one (ruling 72). Issue codes are `string`: a typed
  union of codes per form is out (ruling 72), and would need every
  schema's annotations typed. A list item has no `included` rule of its own. A
  disabled part is submitted, and `included: false` is the one way to
  leave a part out (ruling 72); some libraries drop disabled values
  instead. `Program.whileObserved`
  would replace the autorun that runs effectful decodes, but needs a
  scope a computed value does not have. Warnings, a visited flag, a
  description id, and a decoded view of only the dirty parts (beyond
  `$dirtyPaths`) wait for a form that needs one.
