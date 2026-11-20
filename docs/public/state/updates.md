---
title: Updates
description: Read when writing state. Write a box in an update, draft arrays and objects, keep unchanged items across a refetch, rely on an update being undone when it throws, read without subscribing, and hold back the writes of asynchronous work in a stage until it succeeds.
---

## Example

A box has one way in: `update`, which hands out `read` and `write`. An array
or a plain object is changed through a draft from `write.modify` — mutated
inside the recipe, then written back once. The samples on this page and on
[Reacting](./reacting.md) share this realm and box.

<!-- region state.ts#setup -->

<!-- region state.ts#modify -->

An update is atomic. An update that throws is undone: every write before the
throw in the same update is taken back. Watchers run once the update ends, so
after a rollback they see the old state.

<!-- region state.ts#atomic -->

A refetch hands back new objects for items that did not change. `reconcile`
keeps the previous object of every item that did not change, so what derives
one item from the list returns the same value and its readers do not rerun.

<!-- region state.ts#reconcile -->

An event handler wants the value as it is now, not a subscription. It reads
through `untracked`.

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
- A draft the recipe wrote and left at a second key, inside itself, or
  inside an object the recipe placed at two keys, throws
  `pinna: write.modify left an object it wrote under two keys`, and the
  update is undone. `draft.history.push(draft.present)` followed by
  `draft.present.count++` throws; a snapshot is read before the write, with
  `read($box).present`, which is the plain value. A draft at two keys that
  the recipe never wrote finalizes to the one object the box held.
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
| `update(realm, (read, write) => ...)` | Runs the recipe atomically. If it throws, every box it wrote gets its old value back. |
| `write($box, value)` | Replaces the value. |
| `write.modify($box, (draft) => ...)` | Writes the drafted array or object back once. |
| `Write` | The type of `write`, for a function an update hands it to. Each of its calls returns `undefined`, so a recipe can end in one. |
| `reconcile(previous, next, { keyOf, equals })` | `next`, with each item `equals` finds unchanged replaced by its previous instance; `previous` itself when nothing changed. A key repeated in `next` throws. |
| `untracked(realm, (read) => ...)` | What the function returns, read without subscribing. |
| `openStage(realm)` | A new `Stage` over the realm, holding nothing. |
| `stageUpdate(stage, (read, write) => ...)` | Runs the recipe at once against the stage and keeps it. No box changes. A recipe that throws puts back what it wrote to the stage and is not kept. |
| `stageRead(stage, (read) => ...)` | What the function returns, reading the stage's value of a box it wrote and the realm's current value of any other. |
| `realmRead(stage, (read) => ...)` | What the function returns, reading the realm's values as `untracked` does, ignoring the stage. |
| `applyStage(stage)` | Closes the stage and replays its recipes, in order, in one update over the realm's values at that moment. Joins an open update. |
| `dropStage(stage)` | Closes the stage and discards it. No box changes. |

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
runs in the event handler after its `update` returns, and a throw leaves
the handler before it. This holds only for the outermost update: code after
an `update` that joined an outer one runs before the outer one ends, and
the outer one can still throw.

## Stages

A stage holds back the writes of asynchronous work until it succeeds:
`applyStage` lands them in one update, and `dropStage` discards them. Until
then no box changes, so nothing renders a half-done result and a failure
leaves nothing to undo. An optimistic write, one meant to show before the
work succeeds, stays a plain `update` that the application undoes by hand.

<!-- region stages.ts#setup -->

<!-- region stages.ts#stage -->

The work compares what it staged with what the realm holds now.

<!-- region stages.ts#compare -->

A host that has its own update open lands the stage inside it.

<!-- region stages.ts#join -->

### Rules

- Every call takes the stage first, as `update` takes the realm. The realm
  keeps no current stage, so `update` and `read` cost the same with stages
  in use.
- `applyStage` replays the recipes over the realm's values when it runs,
  and does not detect a conflict. A recipe that read a box another update
  changed since reads the new value: a stage that added 2 to a box at 1
  lands 7 when another update moved the box to 5. Read the realm's value
  with `realmRead` before applying to refuse a change made since.
- A replayed recipe that throws, or writes a value a box's check refuses,
  throws from `applyStage` and rolls back the whole update it joined. Catch
  around `applyStage` to keep the outer update's own writes.
- A stage closes once. `applyStage` closes it even when it throws, so call
  `applyStage` outside the `try` whose `catch` calls `dropStage`. After it is
  applied or dropped every call on it throws, and so does a `read` or a
  `write` kept past its recipe.
- A stage writes boxes only. `write.upsert`, `write.remove`,
  `write.replaceAll`, and `write.changed` throw in a stage recipe, and so does
  a `read` of a computed value, which would return the realm's value and not
  one over the staged boxes. `read.row` reads the realm's row, since no
  collection write is staged. An atom reads as `undefined`, as it does
  anywhere.
- A schema box checks a staged write twice: at `stageUpdate`, so the work
  learns of a refused value where it wrote it, and at `applyStage`, where it
  lands.
- Staged values are not observable. Nothing subscribes to them, and
  `stageRead` and `realmRead` throw in a computed value, a watch's select, or
  a selector, which would go stale on them. `stageUpdate` and `applyStage`
  throw there as `update` does.
- A stage left open holds its overlay until it is collected. A test realm's
  dispose reports it as `stage still running`
  ([Testing](../guides/testing.md)).

## See also

- [Boxes and computed](./boxes.md): declaring what an update writes.
- [Reacting](./reacting.md): running code when a value changes.
- [Schema-checked boxes](../effect/boxes.md): what a write checks when the box has a schema.
- [Collections](./collections.md): `write.upsert`, `write.remove`, and `write.replaceAll`.
- [Equality and hashing](../effect/equality.md): what `equals` and `reconcile` count as unchanged.
- [Live data](../guides/live-data.md): a WebSocket feed and a refetch, written one update per message.
