---
title: Updates
description: Read when writing state. Write a box in an update, draft arrays and objects, keep unchanged items across a refetch, rely on an update being undone when it throws, read without subscribing, and hold back the writes of asynchronous work in a stage until it succeeds.
---

## Example

A box has one way in: `Realm.update`, which hands out `read` and `write`. An array
or a plain object is changed through a draft from `write.modify` — mutated
inside the recipe, then written back once. The samples on this page and on
[Reacting](./reacting.md) share this realm and box.

<!-- region state.ts#setup -->

<!-- region state.ts#modify -->

An update is atomic. An update that throws is undone: every write before the
throw in the same update is taken back. Watchers run once the update ends, so
after a rollback they see the old state.

<!-- region state.ts#atomic -->

A refetch hands back new objects for items that did not change. `Collection.reconcile`
keeps the previous object of every item that did not change, so what derives
one item from the list returns the same value and its readers do not rerun.

<!-- region state.ts#reconcile -->

An event handler wants the value as it is now, not a subscription. It reads
through `Realm.untracked`.

<!-- region state.ts#untracked -->

## Rules

- Never keep a `read` or a `write` past its place. Neither is bound to the
  place that handed it out: outside every place of its realm a `read` throws,
  outside every update a `write` throws, and inside some other place a kept
  `read` acts as that place's own. Pass `read` down as an argument instead.
- Values are plain data. Change them with `write` or
  `write.modify`, never in place: a value is not a proxy, so a change made in
  place is seen by no watcher.
- A box's value is a tree: every key holds its own value. An array or object
  a recipe assigns is copied on the first write through the draft, so the
  caller's object keeps its value, and an object assigned at two keys is two
  values once one of them is written. Refer to one object from two places by
  a key (`selectedId`), a collection row, or a box, never by holding it
  twice: the next `write.modify` drafts each key apart, so a write through
  one key does not show at the other.
- A draft's copy is the value it copies: a plain object keeps its
  prototype, `null` included, and its symbol keys; an array keeps its
  elements, its symbol keys, and a match array's `index`, `input`, and
  `groups`. An array's other named properties are not copied, because
  finding them costs a walk over every index; keep such data in an object.
- An outer `write.modify`'s draft that the outer recipe wrote, assigned
  inside an inner one, throws
  `pinna: write.modify was given a draft another recipe wrote`, and the
  update is undone: the outer recipe can change the draft after the inner
  box's check, and a copy would hide that write. An unwritten one lands as
  the value it drafts.
- A draft handed to a plain `write` is not a value. A `Box.schema` or
  `Model.boxField` refuses it, or a value holding it, with
  `pinna: a checked box was given a draft of an open write.modify`, and the
  update is undone. A plain box stores it, and every read after the recipe
  returns throws `pinna: a draft is used after its recipe returned`: a plain
  box runs no check, and a walk on every write would cost `write` itself.
- A draft the recipe wrote and left at a second key, inside itself, or
  inside an object the recipe placed at two keys, throws
  `pinna: write.modify left an object it wrote under two keys`, and the
  update is undone. `draft.history.push(draft.present)` followed by
  `draft.present.count++` throws; a snapshot is read before the write, with
  `read($box).present`, which is the plain value. A draft at two keys that
  the recipe never wrote finalizes to the one object the box held.
- A draft stored inside a `Map`, a `Set`, or a class instance is stored as
  a draft: those are opaque values, and a read of it after the recipe
  throws `pinna: a draft is used after its recipe returned`. Keep a drafted
  value in a plain object or an array.
- An update is synchronous. A recipe that returns a promise throws at once and
  is undone, because a write after an `await` would land outside the update.
  Await first, then open a new update.
- Nested updates join the outermost one. Watchers run once, when it ends, and
  see only its end state.
- An update runs from an event, a watch's effect, or an autorun's body. It
  throws in a computed value, a watch's select, or a selector, which only
  read.
- An effect that cannot be taken back, such as a request, a message, or a
  file write, runs after the update, never inside its recipe. An update that
  throws undoes its writes, not what the recipe did outside the realm: a
  request sent inside it has gone out, and a later throw, in the same update
  or in a caller's update it joined, leaves the server with what the realm
  no longer holds. See [Effects after the update](#effects-after-the-update).

## Answers

| Call | Answers |
| --- | --- |
| `Realm.update(realm, (read, write) => ...)` | Runs the recipe atomically. If it throws, every box it wrote gets its old value back. |
| `write($box, value)` | Replaces the value. The write for a number, a string, a boolean, or any value but an array or a plain object: `write($count, read($count) + 1)`. |
| `write.modify($box, (draft) => ...)` | Writes the drafted array or object back once. It takes no updater function, and throws `pinna/modify-not-draftable` on any other value. |
| `Write` | The type of `write`, for a function an update hands it to. Each of its calls returns `undefined`, so a recipe can end in one. |
| `Collection.reconcile(previous, next, { keyOf, equals })` | `next`, with each item `equals` finds unchanged replaced by its previous instance; `previous` itself when nothing changed. A key repeated in `next` throws. |
| `Realm.untracked(realm, (read) => ...)` | What the function returns, read without subscribing. |
| `Stage.make(realm, { name?, conflicts?, visible? })` | A new `Stage` over the realm, holding nothing. `conflicts: "fail"` makes `Stage.apply` refuse when what the stage read or wrote changed. `visible: true` shows its writes over the realm's confirmed values until it applies or drops. |
| `Stage.make(stage, { name? })` | A child stage over `stage`: a savepoint that applies into it. |
| `Stage.update(stage, (read, write) => ...)` | Runs the recipe at once against the stage and keeps it. No box changes. A recipe that throws puts back what it wrote to the stage and is not kept. |
| `Stage.read(stage, (read) => ...)` | What the function returns, reading through the stage: its own writes, then, for a visible stage, the showing stages below it, and the realm's confirmed values elsewhere. |
| `Stage.realmRead(stage, (read) => ...)` | What the function returns, reading the realm's confirmed values, ignoring every stage. These reads are not recorded for the conflict check. |
| `Stage.apply(stage)` | Replays its recipes in order: over a realm, into a fresh overlay, then lands its final state in one update nested in an open one; over a stage, into that stage. A conflict or replay throw drops it; a precondition failure leaves it open. |
| `Stage.drop(stage)` | Closes the stage and its open children, and discards them. No box changes. Does nothing to a closed stage. |
| `Stage.status(stage)` | `"open"`, `"applied"`, or `"dropped"`. |
| `Stage.inspect(stage)` | The stage's name, realm, parent, status, and conflict mode; the names of the boxes and collections it wrote; under `{ conflicts: "fail" }`, the names of what it read or wrote and `Stage.apply` checks; how many recipes and open children it holds; `visible`; `showing`, `false` for a hidden stage and a stopped one; and `failure`, the error a stopped stage keeps. |
| `UpdateRecipe` | `(read, write) => undefined`: what `Realm.update` and `Stage.update` run. |
| `StageClosedError` | Thrown by `Stage.update`, `Stage.read`, `Stage.realmRead`, `Stage.apply`, or `Stage.make` of a child on a closed stage; `_tag` is `"StageClosedError"`, `stage` its name, and `status` how it closed. |
| `StageConflictError` | Thrown by `Stage.apply` on a conflict, and by `Stage.update` and `Stage.read` on a visible stage stopped by one; `_tag` is `"StageConflictError"`, `changed` names what changed, a named box or collection by its `name`, and `observables` holds it. |

## Effects after the update

A watch runs once the outermost update ends, and only for a value that
changed. An update that is undone restores every box it wrote, so a watch
that reads only boxes does not run; a `write.changed` on an atom is not
undone, and a watch that reads the atom runs. An effect that a watch
runs from the state it sees is never ahead of the realm. In the sample,
`addPair` joins two calls of `addToCart` in one update; when it throws,
both writes are undone and nothing is sent, and when it succeeds, one
request carries both items.

<!-- region state.ts#afterUpdate -->

An effect that needs no state from the realm, such as closing a dialog,
runs in the event handler after its `Realm.update` returns, and a throw leaves
the handler before it. This holds only for the outermost update: code after
a `Realm.update` that joined an outer one runs before the outer one ends, and
the outer one can still throw.

## Stages

A stage holds back the writes of asynchronous work until it succeeds:
`Stage.apply` lands them in one update, and `Stage.drop` discards them. Until
then no box changes, so nothing renders a half-done result and a failure
leaves nothing to undo. A write meant to show before the work succeeds
goes in a visible stage ([Visible stages](#visible-stages)).

<!-- region stages.ts#setup -->

<!-- region stages.ts#stage -->

A read through the stage sees the stage's own writes everywhere: a box, a
collection's `keys`, `rows`, `row`, and `read.row`, and a computed value,
which the stage evaluates over its own values. A refetch stages
`write.replaceAll` and decides on the result before anything shows.

<!-- region stages.ts#reads -->

`Stage.realmRead` reads what the realm holds, to compare it with the stage.

<!-- region stages.ts#compare -->

A function that hands back a change returns a `UpdateRecipe`, which `Realm.update` and
`Stage.update` both run.

<!-- region stages.ts#recipe -->

A recipe runs once when staged and once per `Stage.apply` along its path
through parent stages to the realm. Row listeners run for each change on
each run. Root replay runs in a fresh overlay over the realm's current values under the same
recipe guard, then one update lands the final state without user code in
its recipe. Anything it creates, an id, a time, a model, is made outside it
and closed over, so all
runs land the same thing.

<!-- region stages.ts#pure -->

A child stage, opened over a stage, is a savepoint: applied, it replays into
its parent; dropped, it leaves the parent as it was.

<!-- region stages.ts#savepoint -->

A stage opened with `{ conflicts: "fail" }` refuses to land when something it
read changed in the realm since: a box, a collection, or an atom, read
directly or beneath a computed value. An atom read beneath a computed value
is reported by that value's name.

<!-- region stages.ts#conflicts -->

A host that has its own update open lands the stage inside it, and records a
failed replay in the same update.

<!-- region stages.ts#join -->

### Rules

- Every call takes the stage first, as `Realm.update` takes the realm. The realm
  keeps no current stage, so `Realm.update` and `read` cost the same with stages
  in use.
- A recipe is a function of its `read`. It runs once when staged and once
  per `Stage.apply` through its parents to the realm, over the destination's
  values at that moment, so an id, a time, or an observable it made would
  differ between runs. Inside a recipe, inside a `Stage.read` function, and
  inside a computed value the stage evaluates, making a box, a computed
  value, a computed function, an atom, a collection, or a model throws, and
  so do `Realm.update` writing the realm, a `read` or a `write` kept from another place,
  `Realm.untracked`, `Realm.watch`, `Realm.autorun`, `Source.observe`, `Source.onObserved`, `Collection.onRowChange`,
  and every stage call. The guard covers the stage's own realm;
  `Realm.update(otherRealm, ...)` runs on every recipe run, and its writes survive
  `Stage.drop`. Pinna has no
  development mode, so these checks run in every build.
- A read through a stage sees the stage's writes; what it did not write
  reads the realm's current value. It is not a snapshot: a box the stage
  did not write can change between two reads with an `await` between them.
  Once a stage writes a collection it holds that collection's rows and
  order, so the two agree.
- A computed value read through a stage runs its own function against the
  stage's `read`, outside the graph: it starts no `Source.onObserved` source, and
  a value nothing observes reads what its boxes hold. The result is cached
  on the stage until the stage, a parent stage, or the realm changes.
- A stage writes boxes (`write`, `write.modify`), collections
  (`write.upsert`, `write.remove`, `write.replaceAll`), and atoms
  (`write.changed`, which reruns observers when the stage is applied). A
  collection write keeps a row equal to the one held, merges a refetched
  `Model.Schema` into the held instance, and runs `Collection.onRowChange` listeners
  with the stage's `read` and `write`, as in an update.
- A schema box or a schema collection checks a staged write at
  `Stage.update`, so the work learns of a refused value where it wrote it,
  and during each `Stage.apply`'s guarded replay. Landing skips the check
  already performed by that same box or collection.
- `Stage.apply` replays over the realm's values when it runs. By default it
  does not detect a conflict: a stage that added 2 to a box at 1 lands 7
  when another update moved the box to 5. With `{ conflicts: "fail" }` it
  throws a `StageConflictError` instead and lands nothing, when a box or
  collection the stage read, directly or through a computed value, changed
  since. A `write.modify` counts as a read of its box when its base comes
  from the realm, as `read` does. A box or collection the stage wrote
  without reading counts too: under `"fail"` the first writer wins, so a
  change underneath a blind write is a conflict, not a silent overwrite.
  Under `"replay"` that box is the last writer's. Reading two different versions of one box or collection
  conflicts even if a rollback restores the first version.
- `Stage.apply` replays into a fresh overlay, then lands its final box
  values, collection rows and order, and atom marks in one update, nested
  in an update already open. Row listeners run during replay, once per
  change; landing does not call them again. A replay throw, including a
  refused write, discards the overlay without changing the realm and
  reaches the caller; the caller's update keeps its own writes if it
  catches it. Several stages in one update land in apply order. Final
  values equal to the realm's values change no version and notify nobody.
  If an enclosing update rolls back the landing, the stage reads
  `"dropped"`; stage the work again in a new stage. An empty journal stays
  `"applied"`, since it had no landing to undo.
- A stage closes once, `"applied"` or `"dropped"`, and `Stage.status` says
  which. A conflict or a replay throw drops it. A `Stage.apply` precondition
  failure, such as an open child or a call inside a recipe or computed
  value, leaves it open. After closing, `Stage.status` and `Stage.inspect`
  remain callable outside a recipe; `Stage.drop` does nothing, so a `finally`
  drops whether or not the work applied. Every other stage call throws
  `StageClosedError`. A `read` or a `write` kept past its recipe throws.
- Watch effects and autoruns settle after landing. Their errors go to
  `onError` and the stage stays `"applied"`.
- A child stage reads through its parent. `Stage.apply` replays it into the
  parent as one `Stage.update`, and a throw leaves the parent as it was. A
  parent with an open child does not apply; dropping the parent drops its
  children.
- A hidden stage's values are not observable. Nothing subscribes to them, and
  `Stage.read` and `Stage.realmRead` throw in a computed value, a watch's select,
  or a selector, which would go stale on them. `Stage.update` and
  `Stage.apply` throw there as `Realm.update` does.
- A stage left open holds its overlay until it is collected. A test realm's
  dispose reports it as `stage "name" still running`, and drops it
  ([Testing](../guides/testing.md)). `Stage.inspect` reports its name,
  parent, status, and what it holds.

## Visible stages

A stage made with `{ visible: true }` shows its writes at once, over the
realm's confirmed values, and keeps showing them until `Stage.apply` lands
them or `Stage.drop` takes them off. An optimistic write is a visible
stage: a failure drops it and leaves nothing to undo by hand, and a refetch
that lands under it keeps the guess on top. When the guess is the answer,
the stage applies on success.

<!-- region stages.ts#visible -->

When the server's answer wins, the guess goes in a visible stage, the
answer in a hidden one, and one `Realm.update` applies the answer and drops
the guess, so a watcher runs once, with the settled value. A box the guess
writes, such as `$saving`, marks the row as pending for exactly as long as
the guess shows.

<!-- region stages.ts#settle -->

A visible stage replays its recipes each time something it read changes
under it. One that `Stage.apply` would refuse, by a conflict under
`{ conflicts: "fail" }` or a recipe that throws on replay, stops showing
and keeps the reason.

<!-- region stages.ts#stopped -->

### Rules

- The realm's own values are the confirmed values. Visible stages stack in
  the order made, and every reader at rest (a computed value, a watch, an
  autorun, a hook, `Realm.untracked`, `Source.peek`) sees the confirmed
  values with each showing stage on top, the newest last.
- A `Realm.update` recipe reads and writes the confirmed values, even where
  the screen shows a guess: a recipe that added 1 to a shown 11 would leave
  12 after the guess dropped. A further change to a guessed value goes in a
  stage made above the guess. Pinna does not check this, because the read
  path cannot afford the check.
- A value read at rest and written later in an update writes the shown
  value into the confirmed values: `Source.peek($count)` in a handler, then
  `write($count, count)` in an update, confirms a guess. Read inside the
  recipe instead. Pinna does not check this either.
- After each outermost update that changed something a showing stage read,
  the stack replays from the lowest such stage: each recipe runs again over
  the confirmed values and the showing stages below it. A shown value equal
  to the one shown before keeps its version, so an update that moves
  nothing under the stack reruns no reader. Showing or taking off a guess
  writes nothing to the confirmed values; a rollback restores them.
- A visible stage reads the showing stages below it. A hidden stage and
  `Stage.realmRead` read the confirmed values, so a hidden stage's
  `{ conflicts: "fail" }` check sees a guess only once it is applied.
- A stage that `Stage.apply` would refuse stops showing for good:
  `Stage.inspect(stage).showing` is `false`, its status stays `"open"`, the
  stages above replay without it, and the update that moved the value under
  it does not fail. `Stage.update`, `Stage.read`, and `Stage.apply` throw the
  error it keeps, and `Stage.apply` also drops it. A recipe's own throw also
  reaches the realm's `onError` once, after the outermost update that
  stopped the stage ends, or after the stage call that stopped it outside an
  update, since the answer-wins flow never applies the guess; a
  `StageConflictError` does not. A handler that writes or drops a stage
  runs its own update then, so every stage replays against it.
- Under `{ conflicts: "fail" }`, a read of a value a lower guess covers
  records the confirmed version, so the upper stage conflicts when the
  lower one applies. A box a replay reads or writes for the first time,
  such as through a branch a lower guess opens, joins the stage's reads at
  its confirmed version then; a replay that throws adds none.
- `Stage.apply` of a visible stage takes it off the stack and lands it as a
  hidden one lands; the stages above replay over the new values. Applying
  the bottom stage notifies nobody, since it shows what it lands: a box
  whose landing value its `equals` finds equal to the shown one keeps the
  shown value and its version. A throw
  drops the stage and reaches the caller; the caller's update keeps its own
  writes if it catches it.
- A box's `equals` runs while the stack settles what it shows, under the
  same guard as a recipe: one that updates or observes throws there. A
  throw counts as unequal, so the stack never stops half shown, and
  reaches `onError` once the outermost update ends, as a recipe's throw
  does: a handler that drops a stage there is not lost under the walk.
- An atom a visible stage marks reruns its readers when the mark starts
  showing and when it stops, not again when the stage applies. A
  `Stage.apply` that throws withdraws the mark as a drop does. A fail
  stage's conflict check counts an atom's confirmed changes, so a mark
  conflicts once its stage applies, and a dropped mark never does.
- A child of a visible stage is a hidden savepoint; `{ visible: true }` on a
  child throws `pinna/stage-visible-option`.
- Every stage call runs inside an update while a visible stage is open, so
  it is allowed exactly where `Realm.update` is. A view made while a guess is
  pending shows the guessed rows.
- `Realm.dispose` takes every visible stage off and drops it, so a read after
  disposal returns confirmed values. A test realm reports a visible stage
  left open as it reports a hidden one. `Source.inspect($box).stages` names
  the showing stages over a box, bottom first.
- An update under a guess replays the guess's recipes and swaps the rows of
  the keys the guess wrote, not the collection: about 5 µs per update under
  a one-row guess at 100,000 rows (`bench:rows`). A guess that adds or
  removes keys copies the key order once each time it replays and once when
  it applies: about 0.6 ms at 100,000 rows.
- A `Computed.fromPromise` or `Program.fromStream` value is not writable, so
  no guess stands over it: copy the answer into a box or a collection.

## See also

- [Boxes and computed](./boxes.md): declaring what an update writes.
- [Reacting](./reacting.md): running code when a value changes.
- [Schema-checked boxes](../effect/boxes.md): what a write checks when the box has a schema.
- [Collections](./collections.md): `write.upsert`, `write.remove`, and `write.replaceAll`.
- [Equality and hashing](../effect/equality.md): what `equals` and `Collection.reconcile` count as unchanged.
- [Live data](../guides/live-data.md): a WebSocket feed and a refetch, written one update per message.
