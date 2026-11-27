---
name: pinna-state
description: "Use when declaring, writing, or reacting to Pinna state (@frondruntime/pinna, not Pinia): a realm, Box.make, Computed.make, a Model, Realm.update, rows by key, views, Realm.watch, Realm.autorun. For components use pinna-react-components; for Effect use pinna-with-effect."
---

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->

# Pinna state, collections, and watches

Declares the state an application starts from, writes it, keeps rows by key and the lists over them, and runs code when it changes.

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

## Rules

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

4. **A box with a schema checks every write.** A `Box.schema` or a
   `Model.boxField` throws on a value its schema rejects. A `Box.make` checks nothing,
   from either package. A `Collection.make` rejects `undefined` rows and checks
   nothing else. Choose per box: data
   from outside the program (the wire, user input) goes through a schema,
   and trusted data that is written often takes a plain `Box.make` or a `Model`.
   Never weaken a schema box's check for speed.

5. **A derived value is a `$` property in the class body:**
   `readonly $total = Computed.make(this.realm, (read) => ...)`. A plain getter has
   no `read` to call; a method that takes `read` is not cached.

6. **A model is a class with `$` fields, and writes through its methods.**
   - Without Effect, it extends `Model`:
     `class Todo extends Model { readonly $done = Box.make(this.realm, false) }`,
     made with `new Todo(realm)`. `Model` holds the realm, so field
     initializers read `this.realm`, and it marks instances, so a draft leaves
     them read-only.
   - A method writes with `Realm.update(this.realm, (read, write) => ...)`, so
     callers change a model only through what it allows.
   - A collection changes its key order in place when a key is added or
     removed, while nothing holds the order. A read of `keys` (an autorun, a
     computed value, a view), an open visible stage, or a `Realm.onUpdate`
     listener holds it: the first add or remove after the read copies the
     order, so that costs more as the collection grows. Replacing a held row
     does not. Many new rows go in through one `write.replaceAll`, which
     copies once, not an `upsert` per row.
   - A list of models is a `Collection.make`, a `Model.collectionField`, or a
     `Collection.schema`, not a box
     holding instances: every write to a box reruns every reader of it, and
     a collection tracks each key on its own, so a reader of one row reruns
     only when that row changes.
   - A list sorted or filtered over a collection is a
     `View.ordered($items, { compare: (read) => comparator, filter })`, read
     through `view.range(start, end)` for what a list shows; the keys of each
     group are a `View.grouped`, and a count and total per group a
     `View.totals` with integer or bigint arithmetic. A `Computed.make` that
     sorts `$items.rows` sorts every row on each change. Callbacks are a
     function of the row, which is never changed after it is written; the
     view is made once on its owner and disposed with `View.dispose` where
     the owner ends.
   - Any other value kept a row at a time over a collection is a box written by
     `Collection.onRowChange($items, (change, read, write) => ...)`, which runs in the
     writer's update. A `Computed.make` that reduces `$items.rows` reruns over
     every row on each change. The listener never writes its own collection,
     keeps its state in boxes so it rolls back, and is added once: each
     call replays the held rows. It sees rows replaced, never a box written
     inside a row, so a sum over a `Model.boxField` is a `Computed.make`.
   - A list written whole on each refetch stays a box written through
     `Collection.reconcile(previous, next, { keyOf, equals })`, which keeps the previous
     object of every item `equals` finds unchanged.

10. **A watch or an autorun that should run at most once a frame takes a
    `scheduler`.** `Realm.watch(realm, select, effect, { scheduler })` and
    `Realm.autorun(realm, effect, { scheduler })` run when the scheduler calls the
    `run` it is handed, once for every write before it, with the values
    current then; a computed value they read recomputes once per run.
    Write the scheduler for the host, with a fallback where it has no frame:
    `(run) => requestAnimationFrame(() => run())`. Call `run` from the
    frame, a timer, an event handler, or a watch's effect, never inside an
    update or a tracked read (`pinna/scheduled-run-not-at-rest`). Keep
    the default for anything that must hold before `Realm.update` returns, such
    as a write that keeps two boxes consistent, and for React, whose hooks
    take no scheduler.

### In a component

- In a handler or an update, look a row up with `read.row($items, key)`.
  `read($items.row(key))` there makes a box for the key that the collection
  keeps until the key is removed; `read.row` makes none.

## References

Open a file under `references/` when its condition holds.

| File | Read when |
| --- | --- |
| [start.md](references/start.md) | Read when starting with Pinna. Make a realm, a box, and a computed value, write in an update, show the value in React, and choose between a plain box and a schema box. |
| [boxes.md](references/boxes.md) | Read when declaring state. Make a box, derive a cached value from it, make a computed value per argument, and name or compare them. |
| [updates.md](references/updates.md) | Read when writing state. One update, drafts of arrays and objects, rollback on a throw. |
| [collections.md](references/collections.md) | Read when state holds rows by key. Make a keyed collection, add and remove rows, read one row, render one row per key, and write a refetch without rerunning what did not change. |
| [views.md](references/views.md) | Read when a list sorts or filters a collection, or a value follows a collection by group. Keep a sorted, filtered order with windows by rank, the keys of each group, and a count and total per group, a row at a time. |
| [row-indexes.md](references/row-indexes.md) | Read when a value follows a collection a row at a time and no view covers it. Keep a set of keys, and a value per key in boxes, with collections, boxes, and onRowChange. |
| [reacting.md](references/reacting.md) | Read when code outside React runs because a value changed. Watch a selection, run an autorun with a cleanup, and write from an autorun without a loop. |
| [effects-after-the-update.md](references/effects-after-the-update.md) | Read when an update must send a request, log, or touch the DOM: the effect goes in a watch after the update. |
| [principles.md](references/principles.md) | Read when deciding whether Pinna fits, or when one of its rules looks arbitrary. What Pinna is designed for, the mechanism behind each principle, and what each one costs. |

## Another skill applies

- `pinna-react-components`: a component that shows or changes the state.
- `pinna-with-effect`: a value checked by Effect Schema, decoded from the wire, or run by an Effect program.
- `pinna-stages-and-live-data`: writes that wait for asynchronous work, show optimistically, or come from a request or a socket.
- `pinna-saving-and-history`: saving and restoring state, undo, redo, or a log of every write.

`node_modules/@frondruntime/pinna/AGENTS.md` is the same text at the installed version and wins where it differs.
