---
title: Indexes and sets
description: Read when a value follows a collection a row at a time and no view covers it. Keep a set of keys, and a value per key in boxes, with collections, boxes, and onRowChange.
---

## Example

A sorted, filtered order, the keys of each group, and a total per group are
[views](../state/views.md): `View.ordered`, `View.grouped`, and
`View.totals`. Each structure on this page takes a few lines over the calls
on [Collections](../state/collections.md), and no view covers it.
`Collection.onRowChange` keeps a structure in step with a collection a row
at a time. The samples share one collection of orders, with amounts in
whole cents.

<!-- region rowIndexes.ts#rows -->

A set of keys is a collection keyed by the key itself. `read.row` tracks
one key, so a row that asks whether it is selected reruns only when its own
key joins or leaves the set. An array in a box reruns every such reader on
each change, and each one scans the array.

<!-- region rowIndexes.ts#set -->

A value per key that no view keeps, such as the latest time each customer
ordered, is one box per key, made on the first ask. A map of values in one
box copies every value on each change and reruns every reader of every key.

<!-- region rowIndexes.ts#boxPerKey -->

A listener fills those boxes a row at a time.

<!-- region rowIndexes.ts#lastOrdered -->

A graph is a collection of edges with two indexes, `View.grouped` by source
and by target. A walk over it, such as every key reachable from one key, is
a function that reads them, run in a `Computed.make` or an update, and reruns in
full on each change it reads. Rows kept in sorted order are a
[`View.ordered`](../state/views.md).

## Rules

- Keep what a listener builds in boxes and collections, so a failed write
  puts it back with the row ([Collections](../state/collections.md)).
- Skip a report that leaves a value as it was. A write of an equal value
  still costs the listener its work.
- A `Computed.make` over `rows` derives the same values with no listener, and
  reruns over every row on each change. It fits a collection that is small
  or rarely written.

## See also

- [Views](../state/views.md): a sorted, filtered order, the keys of each group, and a total per group.
- [Collections](../state/collections.md): `Collection.onRowChange`, `read.row`, and what each write reports.
- [Updates](../state/updates.md): the update a listener runs in, and what a failed one puts back.
- [Collection fields](../effect/collections.md): a collection as a field of a `Model.Schema`.
