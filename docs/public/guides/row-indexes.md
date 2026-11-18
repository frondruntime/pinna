---
title: Indexes and sets
description: Read when a value follows a collection a row at a time. Keep a set of keys, the keys of each group, and a sum per group, with collections, boxes, and onRowChange.
---

## Example

Each structure on this page takes a few lines over the calls on
[Collections](../state/collections.md); Pinna has no call for any of them.
`onRowChange` keeps a structure in step with a collection a row at a time.
The samples share one collection of orders, with amounts in whole cents.

<!-- region rowIndexes.ts#rows -->

A set of keys is a collection keyed by the key itself. `read.row` tracks
one key, so a row that asks whether it is selected reruns only when its own
key joins or leaves the set. An array in a box reruns every such reader on
each change, and each one scans the array.

<!-- region rowIndexes.ts#set -->

A value per group, such as its keys or its sum, is one box per group, made
on the first ask. A map of groups in one box copies every group on each
change and reruns every reader of every group.

<!-- region rowIndexes.ts#boxPerKey -->

The ids of each customer's orders. `onRowChange` reports a row `before` and
`after` the write, so an order that moves to another customer leaves one
group and joins the other in the same report.

<!-- region rowIndexes.ts#index -->

A sum per customer subtracts the row `before` and adds the row `after`: two
writes per change, however many orders the customer has.

<!-- region rowIndexes.ts#totals -->

A graph is a collection of edges with two such indexes, one by source and
one by target. A walk over it, such as every key reachable from one key, is
a function that reads them, run in a `computed` or an update, and reruns in
full on each change it reads. Rows kept in sorted order are on
[Collections](../state/collections.md#sorted-rows).

## Rules

- Keep what a listener builds in boxes and collections, so a failed write
  puts it back with the row ([Collections](../state/collections.md)).
- Skip a report that leaves a row's group as it was. Removing the key and
  adding it again moves it to the end of its group and reruns that group's
  readers for nothing.
- Keep amounts as integers. Each floating-point add and subtract rounds, so
  a sum kept that way drifts from the sum of its rows.
- A change copies the group it writes, as a collection copies its key order
  when a key is added or removed.
- A `computed` over `rows` derives the same values with no listener, and
  reruns over every row on each change. It fits a collection that is small
  or rarely written.

## See also

- [Collections](../state/collections.md): `onRowChange`, `read.row`, what each write reports, and sorted rows.
- [Updates](../state/updates.md): the update a listener runs in, and what a failed one puts back.
- [Collection fields](../effect/collections.md): a collection as a field of a `SchemaModel`.
