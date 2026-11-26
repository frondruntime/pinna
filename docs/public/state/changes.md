---
title: Change stream
description: Read when tools need every write as data. Listen to each landed update's record with Realm.onUpdate, name an update, build undo and replay with write.revert and write.replay, map boxes to paths for persistence, and stream records with Program.updates.
---

## Example

`Realm.onUpdate(realm, listener)` hands the listener one record per landed
outermost update: each box the update changed with its value before and
after, each collection with its rows before and after and its key order
when it moved, and each atom it changed. `Realm.update`'s `{ name }` labels
the record.

<!-- region changes.ts#listen -->

`write.revert(record)` writes every `before` back, and `write.replay(record)`
every `after`. Each is a write, so an undo is checked, recorded, staged in a
stage recipe, and undone on a throw like any write.

<!-- region changes.ts#undo -->

A record names each box and collection by identity. Code that needs paths,
for saving across a reload or for sync, maps them from the shape it
declared.

<!-- region changes.ts#paths -->

## Rules

- One record per landed outermost update. A nested update adds to its
  outer one's record; an update that throws makes none; an update that
  changed nothing, every box written back and every row upserted equal,
  makes none.
- A record is net. A box written three times is one entry, from its value
  when the update began to its value when it landed; a row added and
  removed in one update is no entry. Undo, replay, and persistence each
  need the net change, and the update already keeps each box's first value.
- A record holds confirmed values only. A visible stage's shown values never
  reach one: showing, updating, and dropping a guess is no write and makes
  no record, and an update under a guess reports the values it wrote, not
  the values on screen. `Stage.apply` lands as writes, and the record's
  `stages` names each stage it landed, `undefined` for an unnamed one.
- A listener runs after the update's watchers, outside any update, in the
  order updates landed. A listener may call `Realm.update`; that update's
  record follows the current one. A listener that updates on every record
  loops.
- A listener added inside an update takes records from the next update on.
  A listener's error goes to the realm's `onError`, and the other listeners
  still run, because the update already landed.
- A collection's own boxes never appear in `boxes`: the collection appears
  once in `collections`, with `rows` as `Collection.onRowChange` reports
  them (`key`, `before`, `after`, `undefined` for absent) and `keys`
  (`before` and `after`) only when the key order moved. A `Model.Schema`
  row merged in place changes its `Model.boxField` boxes, which appear in
  `boxes`, and no row.
- `write.revert` and `write.replay` take only a record `Realm.onUpdate`
  handed out; a copy, such as `{ ...record, name }`, or a record made by
  hand throws `pinna/record-not-applicable`. The realm keeps beside each
  record which listeners its update had, and a copy loses that.
- A record applies only to the state it left. `write.revert` requires
  every box and row the record changed to hold its `after` now, and a key
  order it moved to equal its `after` key by key; `write.replay` requires
  each `before`. Values compare by `Object.is`. A mismatch throws
  `pinna/record-not-applicable` before the first write, so nothing is
  written. Revert records newest first and replay them oldest first;
  applied out of order, a record would install values computed from a
  state that is gone, such as a sum a listener keeps one change off.
  The check reads each recorded box and row through `read`, so in a stage
  recipe under `conflicts: "fail"` every recorded box is a conflict input,
  and a visible stage that replays a restore stops with
  `pinna/record-not-applicable` once the base moves under it; both are
  intended.
- A `Collection.onRowChange` listener added before a record's update ended
  does not run when that record is reverted or replayed: the record
  already holds what it wrote, in the boxes and collections it lists, and
  those land at the record's values. A listener added later runs for each
  row the restore changes, as for any write, because the record holds
  nothing of its state.
- A view (`View.ordered`, `View.grouped`, `View.totals`) is in no record:
  its boxes and collections never appear in `boxes` or `collections`, and
  it runs for each row every restore changes. Its state follows from the
  rows and its options, so it needs no recorded value, and a record
  applies whatever views exist.
- `write.revert` and `write.replay` write collections first, then boxes,
  then atoms, so a recorded value wins over what a later listener wrote to
  the same box.
- A listener added after the record that, as it hears one collection's
  restore, changes a row the record lists, or a key order it moved, in a
  collection restored before throws `pinna/record-not-applicable`, and
  every write of the restore is put back. Each collection is compared with
  what its own restore left once all are written; writing it again would
  run its later listeners again, so the restore refuses rather than land a
  value the record does not hold.
- A record whose `Realm.update` added a `Collection.onRowChange` listener
  throws `pinna/record-not-applicable` on `write.revert` and
  `write.replay`, whether or not the update changed rows: it holds what
  the new listener wrote, and its `before` holds that state from before
  the listener existed. Add listeners at rest.
- A record made only by a listener added at rest, which holds what it
  wrote as it heard the rows held, restores without running it: its
  `write.revert` writes nothing, since the listener still runs and its
  state follows the rows, and its `write.replay` writes each `after`
  again, the state the listener first built, which the records after it
  hold. Both require the collection to hold the rows the listener first
  heard.
- A record is frozen and holds the values the update wrote, which Pinna
  never mutates. It lives for one session: it names boxes by identity, so
  it does not survive a reload.

## Limits

- State a row listener keeps outside Pinna, such as a plain `Map` or a log
  line, is not restored: a listener registered before the record's update
  ended does not run on `write.revert` or `write.replay`. `Realm.onUpdate` hands the restore's
  own record to code that mirrors state.
- A `Collection.onRowChange` listener added after some records runs when
  their restore changes rows, and a listener that keeps an object in a box
  builds a new one. A record made after it was added holds the object it
  built first, so that record's `write.replay` after such a restore throws
  `pinna/record-not-applicable` unless the record of the listener's own
  registration was replayed first and put the object back. Two cases have
  no such record: a listener added to an empty collection, which wrote
  nothing; and a history that dropped the registration's record, as a new
  write after an undo past it does. A listener that keeps numbers or
  strings, and a view, are not affected. Open (ruling 74).
- A computed value is not in a record. It is derived, so replaying its
  sources reproduces it.
- An atom carries no value. Its entry says it changed; replay and revert
  change it again, and the state it stands for stays where it is.
- A `Computed.fromPromise`, `Program.fromStream`, or `Program.fromEffect`
  value is an atom's change in a record, never its value: the value lives in
  a closure. A tool that shows one reads it with `Source.peek`.
- A record queued where no update encloses it, such as a `Source.onObserved`
  hook's update as a renderer mounts, goes out at the next update's end or
  in a microtask, whichever comes first.

## With Effect

`Program.updates(realm)` is a stream of every record. Its buffer is
unbounded, since persistence that skips a record loses data. It ends when
the realm is disposed and requires no service.

<!-- region programs.ts#updates -->

## Answers

| Call | Answers |
| --- | --- |
| `Realm.onUpdate(realm, (record) => ...)` | Adds a listener and returns its stop, which does nothing the second time. Throws in a computed value, a watch's select, a selector, and a stage recipe, and once the realm is disposing. `Realm.dispose` stops it and drops records not yet handed out; `testRealm` reports one left running. |
| `Realm.update(realm, recipe, { name })` | The update, with `name` on its record. A nested update's name is ignored. An empty name throws `pinna/empty-name`. |
| `UpdateRecord` | `{ name, stages, boxes, collections, atoms }`: `boxes` in the order first written, each `{ box, before, after }`; `collections` each `{ collection, rows, keys }`; `atoms` in the order first changed. |
| `write.replay(record)` | Throws `pinna/record-not-applicable` unless the state holds each `before`, or the record's update added a listener. Then each collection's rows to `after` and, when `keys` is set, its key order to `keys.after` through `write.replaceAll`, then each box to `after`, then each atom changed. Inside `Realm.update` or a stage recipe. A throw puts back every write it made. |
| `write.revert(record)` | The same from each `after`, to each `before`. A `Collection.onRowChange` listener added before the record's update ended does not run for either; a view always runs. Both install each recorded row by identity, with no merge and no `equals`: a `Model.Schema` row comes back as the object the record holds, and its boxes through the record's box changes. |
| `Program.updates(realm)` | A stream of every record from the next update on, unbounded, ending when the realm is disposed. |

## See also

- [Updates](./updates.md): the update a record covers, and stages.
- [Snapshots](./snapshots.md): the shape a consumer maps boxes to paths from.
- [Collections](./collections.md): `Collection.onRowChange`, the row change inside an update.
- [Programs](../effect/programs.md): the other Effect streams.
- [Error messages](../reference/errors.md#change-stream): what `write.replay` and `write.revert` throw.
