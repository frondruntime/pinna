---
title: Collections
description: Read when state holds rows by key. Make a keyed collection, add and remove rows, read one row, render one row per key, and write a refetch without rerunning what did not change.
---

## Example

A collection holds rows by key, a box for each key a reader reads, and one
box for the order of the keys, so a write to one row reruns the readers of
that row, not the readers of the list. A key's box is made on the first
read of `row(key)` and kept while the key is present, so rows nobody reads
alone cost no box. `Collection.make` makes an empty one with no schema;
`undefined` rows are rejected.

<!-- region collections.tsx#collection -->

A collection is written inside an update, with `write.upsert` and
`write.remove`.

<!-- region collections.tsx#write -->

`row(key)` tracks that key alone. A write to another row, or a new key,
reruns nothing here.

<!-- region collections.tsx#row -->

Where nothing tracks (an update's recipe, `Realm.untracked`, a watch's effect),
`read.row($items, key)` reads the row the collection holds and makes no box,
so a lookup leaves nothing behind. In a tracked place it is
`read($items.row(key))`.

<!-- region collections.tsx#lookup -->

`keys` changes only when a key is added, removed, or moved. `rows` changes
when any row or the order changes.

<!-- region collections.tsx#read -->

A list component reads `keys` and hands each row its key, so a change to one
row rerenders that row alone.

<!-- region collections.tsx#component -->

A refetch writes every row at once with `write.replaceAll`. A row that
`equals` finds unchanged is kept, and what read it does not rerun.

<!-- region collections.tsx#replaceAll -->

A value kept a row at a time listens with `Collection.onRowChange`; a
sorted order, an index by another key, and a total per group are
[views](./views.md). The listener runs inside the update that wrote
the row, with that update's `read` and `write`, so what it writes takes effect
and rolls back with the row.

<!-- region collections.tsx#onRowChange -->

## Rules

- A collection is written with `write.upsert`, `write.remove`, and
  `write.replaceAll`, inside an update. An update that throws puts back the
  keys and every row, as it does a box.
- `write.upsert` and `write.replaceAll` reject an `undefined` row with
  `pinna: a collection row cannot be undefined`, before changing any row.
  `row(key)` and `read.row` return `undefined` for a missing key, so a
  present row cannot use that value. The rule also applies to schema
  collections, even when the schema accepts `undefined`.
- `upsert` replaces a held key's row in place and puts a new key first, or
  last with `{ at: "end" }`. `remove` of a missing key changes nothing.
- Adding or removing a key copies the key order, so its cost grows with the
  collection: about 15 µs at 1,000 rows and 120 µs at 10,000 on Hermes.
  Replacing the row of a held key costs the same at any size. The order is
  one immutable array, so a failed update puts back the old one and `keys`
  answers the same array until a key changes. Many new rows go in through
  one `write.replaceAll`, which copies once; an `upsert` per row copies once
  per row, even inside one update.
- A row written under a held key is compared with `equals`, `Object.is`
  without one. A refetch builds new objects, so without `equals` it reruns
  the readers of every row.
- A key that appears twice in `replaceAll` throws
  `pinna: the collection key <key> appears twice`, and nothing is written.
- A list that renders one row per key reads `keys` and `row(key)`. `rows`
  reruns its reader when any row or the order changes.
- `keys` is observed while something reads `keys` or `rows`, or reads
  `row(key)` for a missing key. `row(key)` of a present key tracks that row
  alone, so a hook on `keys` misses a reader of one row. A feed that writes
  the rows only while any of them is read hangs on a private atom that every
  public reader reads ([Live data](../guides/live-data.md)); a feed for a
  list alone starts and stops with `keys`, through `Source.onObserved` or, with
  Effect, `Program.whileObserved`.
- `row(key)` returns the same computed value for a present key on every call;
  for a missing key, only while something observes it.
- A lookup where nothing tracks reads through `read.row($items, key)`.
  `read($items.row(key))` there makes the key's computed value and box,
  and the collection keeps both until the key is removed.
- `read.row` outside every place of its realm throws, as `read` does.
- `Collection.onRowChange` reports each row `upsert`, `remove`, or `replaceAll` adds,
  replaces, or removes, `replaceAll` a row at a time, with the row `before`
  and `after` the write; one is `undefined` for an add or a removal. A write
  that keeps a row reports nothing.
- A listener first hears each row the collection holds, in key order, as
  added, so what it keeps starts in step with the rows. A throw there adds
  no listener and reaches the caller of `Collection.onRowChange`. If settling watchers
  throws after replay commits, the listener is removed and the replay's
  writes stay committed: the caller received no function to remove it.
- A listener writes other boxes and collections. A write to the collection
  it listens to throws, and so does a listener that returns a value: it
  is synchronous. A listener that throws fails the write, which is put back.
- What a listener keeps rolls back when it lives in boxes. A plain `Map`
  of values the listener fills is not put back when the write fails; a
  `Map` of boxes is, since it holds the boxes and the boxes are put back.
- A listener sees rows the collection replaces, never a write to a box
  inside a row: a `Model.Schema` row whose box fields alone change is merged
  in place and reports nothing. A sum over a `Model.boxField` is a `Computed.make`.
- `replaceAll` writes every row, then reports them a row at a time, so a
  listener that reads the collection sees rows ahead of their reports.
- An index by another key deletes an entry only while it still names
  `change.key`: two rows that swap values report one at a time, and the
  second report would otherwise delete the first one's new entry.
- Each `Collection.onRowChange` replays the held rows to its listener, so a host adds a
  listener once, beside the boxes it fills. A listener added again, as a
  React effect in strict mode is after its cleanup, counts each row twice
  unless the host resets its boxes first.
- The function `Collection.onRowChange` returns removes the listener for good: an
  update that fails after calling it does not add it back, as with `Realm.watch`.
- `Collection.onRowChange` in a computed value or a watch's select throws, as `Realm.update`
  does there.
- A list written one row at a time is a collection. A box of an array is
  written whole, and every write reruns every reader of the box. A list
  written whole on each refetch can stay a box written through `Collection.reconcile`:
  see [Updates](./updates.md).

## Answers

| Call | Answers |
| --- | --- |
| `Collection.make(realm, { keyOf, equals?, name? })` | An empty collection with no schema; `undefined` rows are rejected. `equals` defaults to `Object.is`. `name` names its `keys` (`<name>.keys`) and `rows` (`<name>.rows`) for `Source.inspect` and errors, and the collection in a stage's conflict error and `Stage.inspect`. |
| `$items.row(key)` | A computed value of that row, or `undefined`. |
| `read.row($items, key)` | That row, or `undefined`: tracked as `read($items.row(key))` in a tracked place, and read without making a box where nothing tracks. |
| `$items.keys`, `$items.rows` | Computed values of the keys, and of every row, in order. |
| `write.upsert($items, row, { at? })` | Replaces the row under its key, or adds it first, or last with `{ at: "end" }`. |
| `write.remove($items, key)` | Removes the row under `key`. |
| `write.replaceAll($items, rows)` | Makes `rows` the collection's rows, in their order, keeping each one that is unchanged. |
| `Collection.onRowChange($items, (change, read, write) => ...)` | Calls the listener for each row a write adds, replaces, or removes, inside that write's update; `change` holds `key`, `before`, and `after`. Returns the function that removes the listener. |

## Row selection

The selected key is one box beside the collection, and each row reads a
flag of its own from a `Computed.fn`. Moving the selection
from one row to another changes two flags, so it rerenders the row that
lost the selection and the row that gained it, and a first selection changes
one; every other row's flag recomputes to the same `false`, and its
row does not render.

<!-- region collections.tsx#selection -->

The flag and the row's own computed value live for different spans.

- A flag from `isSelected(id)` lives while something observes it. Once the
  last row that reads it unmounts, it is dropped, and the next call makes a
  new one, so a list that mounts and unmounts rows keeps no flag for a row
  off screen.
- `$orders.row(id)` returns the same computed value while the key is held,
  whether a row reads it or not, and the collection keeps the key's box
  until the key is removed.

## See also

- [Updates](./updates.md): the update every write runs in, and `Collection.reconcile`.
- [Views](./views.md): a sorted, filtered order, the keys of each group, and a total per group, kept a row at a time.
- [Indexes and sets](../guides/row-indexes.md): a set of keys and a value per key, kept with `Collection.onRowChange`.
- [Hooks](../react/hooks.md): every way a component reads.
- [Collection fields](../effect/collections.md): a collection as a field of a `Model.Schema`, each row checked against a schema.
- [Equality and hashing](../effect/equality.md): what `equals` counts as an unchanged row.
