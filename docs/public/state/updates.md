---
title: Updates
description: Read when writing state. Write a box in an update, draft arrays and objects, keep unchanged items across a refetch, rely on an update being undone when it throws, and read without subscribing.
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
- Values are plain data, `readonly` in the types. Change them with `write` or
  `write.modify`, never in place: a value is not a proxy, so a change made in
  place is seen by no watcher.
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

## See also

- [Boxes and computed](./boxes.md): declaring what an update writes.
- [Reacting](./reacting.md): running code when a value changes.
- [Schema-checked boxes](../effect/boxes.md): what a write checks when the box has a schema.
- [Collections](./collections.md): `write.upsert`, `write.remove`, and `write.replaceAll`.
- [Equality and hashing](../effect/equality.md): what `equals` and `reconcile` count as unchanged.
- [Live data](../guides/live-data.md): a WebSocket feed and a refetch, written one update per message.
