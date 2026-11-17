---
title: Indexes and sets
description: Read when a value follows a collection a row at a time. Keep a set of keys, the keys of each group, a sum per group, and rows in sorted order, with collections, boxes, and onRowChange.
---

## Example

Each structure on this page is built from a collection or from boxes, and
`onRowChange` keeps it in step with a collection a row at a time. Pinna has
no call for any of them. Each one takes a few lines over the calls on
[Collections](../state/collections.md).

The samples share one collection of orders. Amounts are whole cents.

<!-- region rowIndexes.ts#rows -->

A set of keys is a collection keyed by the key itself. `read.row` answers
whether a key is in it, and where reads are tracked it tracks that key
alone. A row that asks whether it is selected therefore reruns when its own
key joins or leaves the set, and not when another key does. An array in a
box reruns every such reader on each change, and each one scans the array.

<!-- region rowIndexes.ts#set -->

The keys of each group and the sum of each group keep one box per group,
made on the first ask. A map of groups in one box copies every group on
each change and reruns every reader of every group.

<!-- region rowIndexes.ts#boxPerKey -->

The ids of each customer's orders. A row is reported with its value
`before` and `after` the write, so a move from one customer to another
leaves the first group and joins the second in the same report.

<!-- region rowIndexes.ts#index -->

A sum per customer subtracts the row `before` and adds the row `after`, so
a change costs two writes however many orders the customer has.

<!-- region rowIndexes.ts#totals -->

Rows in sorted order sit in one box, and each change takes its place by
binary search. A `computed` that sorts `rows` sorts every row on each
change.

<!-- region rowIndexes.ts#sorted -->

A graph is a collection of edges with two indexes like the one above, one
by the edge's source and one by its target. A walk over it, such as every key
reachable from one key, is a function that reads those indexes, run in a `computed`
or in an update.

## Rules

- Keep what a listener builds in boxes and collections. A write that fails
  puts them back with the row. A plain `Map` of values keeps the failed
  write's changes. A `Map` of boxes is safe: it holds the boxes, and the
  boxes are put back.
- Find `before` by the value it was reported with, never by reading the
  collection. `replaceAll` writes every row before its first report, so
  `read.row` in a listener can return a row ahead of its report. The sorted
  box holds the rows as reported for this reason.
- Give a sorted order a tie-breaker, such as the key. Binary search then
  finds exactly one place for each row, and removing `before` removes that
  row and not another row with the same amount.
- Skip a report that leaves a row's group as it was. Removing and adding
  the key again moves it to the end of its group and reruns that group's
  readers for nothing.
- Keep amounts as integers when a listener adds and subtracts them. Each
  floating-point add and subtract rounds, so a sum kept that way drifts from
  the sum of its rows.
- Add each listener once, beside the boxes it fills, and keep the function
  `onRowChange` returns. Each `onRowChange` first reports every held row as
  added, so a second listener over the same boxes counts each row twice.
- A change copies the array it writes: a group's keys, or every sorted row.
  A collection copies its key order the same way when a key is added or
  removed. A `replaceAll` that adds n rows reports n adds, so filling the
  sorted box from empty copies O(n²) rows. Where that cost shows, a
  persistent balanced tree in the box copies one path, O(log n), per change.
- A `computed` over `rows` derives the same values with no listener to add
  or remove, and reruns over every row on each change. It fits a collection
  that is small or rarely written.

## Answers

| Structure | Built from | A change costs |
| --- | --- | --- |
| A set of keys | `collection` keyed by the key | the collection's write; adding or removing a key copies its key order |
| The keys of each group | a box per group, `onRowChange` | a copy of each group it leaves or joins |
| A sum per group | a box per group, `onRowChange` | two writes |
| Rows in sorted order | one box, `onRowChange`, binary search | O(log n) to find the place, and a copy of the rows |
| A graph | a collection of edges, two indexes | as each index; a walk reruns in full |

## See also

- [Collections](../state/collections.md): `onRowChange`, `read.row`, and what each write reports.
- [Updates](../state/updates.md): the update a listener runs in, and what a failed one puts back.
- [Collection fields](../effect/collections.md): a collection as a field of a `SchemaModel`.
