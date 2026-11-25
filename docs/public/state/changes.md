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
- `write.revert` writes `before` whatever the box holds now. An undo that
  skips a box changed since compares the box's value to the record's
  `after` first. Revert records newest first and replay them oldest first:
  a collection whose key order moved gets its whole order back, and a key
  that order needs which neither the record nor the collection holds throws
  `pinna/record-not-applicable`.
- A record is frozen and holds the values the update wrote, which Pinna
  never mutates. It lives for one session: it names boxes by identity, so
  it does not survive a reload.

## Limits

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
| `write.replay(record)` | Each box to `after`, each collection's rows to `after` and, when `keys` is set, its key order to `keys.after` through `write.replaceAll`, and each atom changed. Inside `Realm.update` or a stage recipe. A throw puts back every write it made. |
| `write.revert(record)` | The same, to each `before`. |
| `Program.updates(realm)` | A stream of every record from the next update on, unbounded, ending when the realm is disposed. |

## See also

- [Updates](./updates.md): the update a record covers, and stages.
- [Snapshots](./snapshots.md): the shape a consumer maps boxes to paths from.
- [Collections](./collections.md): `Collection.onRowChange`, the row change inside an update.
- [Programs](../effect/programs.md): the other Effect streams.
- [Error messages](../reference/errors.md#change-stream): what `write.replay` and `write.revert` throw.
