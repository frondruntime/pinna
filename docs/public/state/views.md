---
title: Views
description: Read when a list sorts or filters a collection, or a value follows a collection by group. Keep a sorted, filtered order with windows by rank, the keys of each group, and a count and total per group, a row at a time.
---

## Example

A view is kept up to date a row at a time: each write to a row moves that
row's key in the view, so a write to one of 10,000 rows does not sort or
sum 10,000 rows. `View.ordered` keeps the keys sorted and filtered,
`View.grouped` the keys of each group, and `View.totals` a count and a
total per group. Each listens with `Collection.onRowChange` and keeps its
state in boxes and collections of the same realm, so a failed update puts
the view back with the rows, and a stage reads the view over its staged
rows.

<!-- region views.ts#rows -->

`View.ordered` takes a `compare` factory and an optional `filter` factory.
Each is tracked: the boxes it reads sort or filter the view again when
they change.

<!-- region views.ts#ordered -->

`range(start, end)` is the keys at those ranks of the filtered order. A
list that scrolls reads the range it shows and hands each row its key, as
a list of a collection reads `keys` and `row(key)`.

<!-- region views.ts#window -->

`View.grouped` keeps the keys of each group. `group(name)` tracks that
group alone.

<!-- region views.ts#grouped -->

`View.totals` keeps a count and a total per group, with arithmetic the
caller gives.

<!-- region views.ts#totals -->

A view is kept from the moment it is made until it is disposed, read or
not.

<!-- region views.ts#dispose -->

## Rules

- A row write moves one key: `O(log n)` for an ordered view of `n` rows,
  and one or two groups for `View.grouped` and `View.totals`. About 10 µs a
  row write for a sorted, filtered view of 10,000 rows on Bun, against
  about 1 µs for the write alone.
- A change to what `compare` reads sorts every row again, `O(n log n)`; a
  change to what `filter` alone reads filters the sorted rows again, `O(n)`.
  The rebuild runs on the next read or row write, not on the box write.
- `compare`, `filter`, `groupOf`, and `project` read no observable and give
  the same answer for the same row every time. A view finds a row's old
  place by asking again with the row `before` the write; an answer that
  changed leaves the view out of step with the rows. `View.ordered` throws
  `pinna/view-out-of-step` where it finds a row missing from its place;
  `View.grouped` throws it for a key missing from its group. A changed
  `project` value is not found, and the total drifts.
- Rows are not changed after they are written. A view holds the row it was
  reported, and a row mutated in place is found at no place.
- Equal rows under `compare` are ordered by key, when both keys are
  strings, numbers, or bigints. Other keys that tie throw `pinna/view-tie`:
  break the tie in `compare`. The key order keeps a tie in the same place
  after a rollback, a stage, or a replay.
- `compare` returns a number; `NaN` or a non-number throws
  `pinna/view-compare-result`. The write that met it fails and is put back.
- `range(start, end)` takes whole numbers from 0; others throw
  `pinna/view-range`. The end is clamped to `size`, and an end before the
  start gives an empty array. The same arguments give the same computed
  value while something observes it.
- `keys` reruns its reader on any change to the filtered order. A list
  reads a `range`.
- `View.grouped` puts a key last in its group when it joins, and drops a
  group with no key. A row whose group stays the same changes no group.
  A join or a leave copies the group's keys, so it costs the group's size:
  filling one group of `n` keys copies `n²/2` keys, 50 million for a group
  of 10,000. It fits many small groups, such as orders per customer.
- `View.totals` keeps a group in its place in `groups` when a row's value
  changes and its group does not.
- `View.totals` needs exact arithmetic: `add` and `subtract` undo each
  other. Floating-point amounts round on each add and subtract, so a total
  kept that way drifts from the sum of its rows; keep cents as integers, or
  use bigints. A group with no row reads `{ count: 0, total: zero }`. A
  minimum or maximum is not a total, because a removal cannot be
  subtracted.
- A view over a `Model.collectionField` sees the rows the collection
  replaces. A row whose box fields alone change is merged in place and
  reports nothing, so a view that sorts by a box field does not move it.
  Sort by plain fields, or keep that order in a `Computed.make`.
- A view is not made while an open hidden stage holds writes to its
  collection, and throws `pinna/view-staged-rows` there: the view hears the
  realm's rows, so it would miss the staged rows and fail on the stage's
  next write of one. A stage made after the view, or one that wrote other
  collections only, is read through the view. A visible stage does not
  count, though a hidden child of one does: a view made while a guess is pending shows the guessed rows, and
  loses them when the guess drops.
- A view is in no `Realm.onUpdate` record: its boxes and collections never
  appear in one, and `write.revert` and `write.replay` report each row they
  change to it, as any write does. Its state follows from the rows, so an
  undo or a redo, in any order the records allow, leaves it in step
  ([Change stream](./changes.md)).
- A view made in an update that fails is disposed with that update.
- A view is made where `Collection.onRowChange` can be called: not in a
  computed value, a watch's select, or a stage recipe. It takes a
  collection made by Pinna, and throws `pinna/not-made-by-pinna` for
  another value.
- `View.dispose` stops the view; disposing twice does nothing. A read
  through a disposed view, such as `view.keys` or `view.range(0, 10)`,
  throws `pinna/view-disposed`. A computed value taken before disposal keeps
  the realm's confirmed value as of disposal: never an order between two
  writes of one update, and never a stage's rows or comparator, even one a
  handle showed before the disposal. A view disposed inside an update keeps
  the rows that update leaves, rolled back or not, in the order its last row
  write before the disposal built. `Realm.dispose` disposes every view of the realm, and
  `testRealm` reports a view left open as `View.ordered "<name>" still
  running`.

## Answers

| Call | Answers |
| --- | --- |
| `View.ordered($items, { compare, filter?, name? })` | A view of `$items`'s keys sorted by `compare(read)`'s comparator, kept by `filter(read)`'s predicate, or every key when it returns `undefined`. |
| `view.size`, `view.totalSize` | Computed values of the count of keys that pass the filter, and of every key. |
| `view.keys` | A computed value of every key that passes the filter, in order. |
| `view.range(start, end)` | A computed value of the keys at ranks `start` up to, not including, `end`. |
| `View.grouped($items, { groupOf, name? })` | A view of `$items`'s keys by `groupOf(row, key)`, or out of every group for `undefined`. |
| `view.group(group)` | A computed value of the group's keys, in the order they joined; empty for a group with none. |
| `view.groups` | A computed value of the groups that hold a key. |
| `View.totals($items, { project, arithmetic, name? })` | A view of a count and total per group: `project(row, key)` gives `{ group, value }`, or `undefined` to leave the row out. `arithmetic` is `{ zero, add, subtract, equals? }`. |
| `view.group(group)` | A computed value of `{ count, total }` for the group. |
| `View.dispose(view)` | Stops the view. |
| `View.status(view)` | `"open"`, or `"disposed"` after `View.dispose` or `Realm.dispose`. |

`name` names the view in errors and in `testRealm`, and its computed values
for `Source.inspect`, such as `<name>.size`.

## See also

- [Collections](./collections.md): `Collection.onRowChange`, which every view listens with.
- [Indexes and sets](../guides/row-indexes.md): a set of keys and structures no view covers, kept by hand.
- [Lifecycles](./lifecycles.md): disposing what an owner made.
- [Updates](./updates.md#stages): reading a view over staged rows.
