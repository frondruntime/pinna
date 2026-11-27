---
name: pinna-saving-and-history
description: "Use when Pinna state leaves as plain data or as records of writes: saving across a reload, hydrating, read.snapshot, write.restore, Model.restore, or undo, redo, replay, an update log, Realm.onUpdate, write.revert. For one value's side effect use pinna-state."
---

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->

# Pinna snapshots, restore, and update records

Takes declared state out as plain data and writes it back whole, and reads every landed update as a record for undo, redo, replay, and logs.

## Every skill assumes

For an agent writing an application on Pinna. Pinna is not Pinia, Vue's
store; it shares no API with it. Import the modules from
`@frondruntime/pinna`, whose boxes and models take no schema, or from
`@frondruntime/pinna-effect`, whose modules hold the same members and add
`Box.schema` and `Model.Schema` to check a schema (`effect` is its peer
dependency); the hooks come from `@frondruntime/pinna-react`. Every call is
a member of its type's module, and the module's name is also the type:
`const $count: Box<number> = Box.make(realm, 0)`, `Realm.update`,
`Stage.apply`, `Model.Class`. Import from one of the two packages in a
file, never both: each exports its own `Box`. The full documentation is at
<https://pinna.frondruntime.dev/docs/start>; this page is what to keep in
mind while writing code.

1. **`$` means observable.** A name that starts with `$` is a box, a
   computed value, an atom, or a collection. Everything else is plain,
   `readonly` data: read it anywhere, never write it.

2. **Read with the `read` a place hands out.** An observable has no read
   or write methods. `Computed.make`, `Computed.fn`, `Realm.watch`'s select,
   `Realm.autorun`, `Realm.update`, `Realm.untracked`, and `useSelect` each pass their
   function a `read`: `Computed.make(realm, (read) => read($a) + 1)`.
   Never keep a `read` past its place: outside every place of its realm
   it throws, and inside another it reads as that place's `read`. Pass it
   down instead.

3. **Write with the `write` that `Realm.update` hands out.**
   `Realm.update(realm, (read, write) => { ... })`: `write($box, value)` replaces a
   value; `write.modify($box, (draft) => { ... })` drafts arrays and plain
   objects; a collection takes `write.upsert`, `write.remove`, and
   `write.replaceAll`; an atom takes `write.changed`. An update that throws
   is rolled back, but only its writes: a request sent inside the recipe
   has gone out. Run an effect that cannot be taken back after the update,
   from a `Realm.watch`
   (<https://pinna.frondruntime.dev/docs/state/updates#effects-after-the-update>).

## Rules

11. **State goes out and comes back through a declared shape.** Declare a
    plain object of the boxes and collections to keep, under the names the
    data should carry: `const saved = { theme: $theme, tabs }`.
    `read.snapshot(saved)` reads it as plain data, in any place a `read` is
    handed out; `write.restore(saved, data)` writes it back inside
    `Realm.update`, whole or not at all.
    - Never put a computed value, an atom, or a `Model.Class` instance in a
      shape (`pinna/snapshot-not-state`): put the boxes they read, or the
      instance's boxes by name. A `Model.Schema` instance stands in the
      shape under its wire keys.
    - The data matches the shape exactly (`pinna/restore-shape`); restore a
      smaller shape for a part.
    - A restore never makes a model: a new `Model.Schema` row comes in as an
      instance, from `Model.decode` or `make`, or the whole input goes
      through `Model.restore(realm, Schema)(held, input)`.
    - A restore writes boxes and runs no method of the model. Work that must
      follow a change, such as cancelling a request, belongs in a
      `Realm.watch`, so a restore triggers it too.
    - A live snapshot, for a save or a devtools view, is
      `Computed.make(realm, (read) => read.snapshot(saved))`: it recomputes on a
      write under the shape and on no other.

12. **Tools read writes as data through `Realm.onUpdate`, never by wrapping
    `Realm.update`.** A listener gets one record per landed update, after
    its watchers ran: each box, row, key order, and atom it changed, before
    and after, in confirmed values (a visible stage's guess is never in
    one). Name an update with `Realm.update(realm, recipe, { name })` for
    logs and devtools.
    - A listener reads the record; it updates only for its own state, such
      as a log or an undo stack, and never on every record, which loops.
    - Undo is `write.revert(record)` inside `Realm.update`, newest first;
      replay is `write.replay(record)`, oldest first. An undo stack skips the
      records its own reverts make. A record applied to another state than
      the one it left throws `pinna/record-not-applicable` and writes
      nothing.
    - A `Collection.onRowChange` listener registered before the record's
      update ended does not run on undo or redo: the record holds what it
      wrote. Keep its state in
      boxes, since a plain `Map` it fills is not restored. Add a listener at
      rest, never inside `Realm.update`: a record whose update added one
      throws on undo. A view runs on every undo and redo and is in no
      record. A listener added after a record that, as it hears one
      collection's undo or redo, changes a row the record lists in another
      collection makes that undo or redo throw and write nothing.
    - A record names boxes, never paths. Code that saves across a reload or
      syncs maps each box to a path from the shape it declared (rule 11);
      Pinna keeps no path index.
    - In Effect, `Program.updates(realm)` streams every record, unbounded.

## References

Open a file under `references/` when its condition holds.

| File | Read when |
| --- | --- |
| [snapshots.md](references/snapshots.md) | Read when state goes out as plain data and comes back. Declare a shape of boxes and collections, read it with read.snapshot, write it back with write.restore, keep a live snapshot in a computed value, preview a stage, and hydrate a Model.Schema with Model.restore. |
| [saving.md](references/saving.md) | Read when state outlives a reload. Save a computed projection of what to keep, restore before the watch starts, write a burst of changes once, skip a save that changes nothing, keep a storage error as state, and write a pending save on dispose. |
| [changes.md](references/changes.md) | Read when tools need every write as data. Listen to each landed update's record with Realm.onUpdate, name an update, build undo and replay with write.revert and write.replay, map boxes to paths for persistence, and stream records with Program.updates. |

## Another skill applies

- `pinna-state`: the watch that runs a save, or code that runs when one value changes.
- `pinna-with-effect`: decoding wire data into models, and `Program.updates`.
- `pinna-stages-and-live-data`: rolling back a write that has not landed.

`node_modules/@frondruntime/pinna/AGENTS.md` is the same text at the installed version and wins where it differs.
