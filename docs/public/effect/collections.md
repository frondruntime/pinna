---
title: Collection fields
description: Read when a model holds rows by key. Declare a CollectionField, decode it from a plain array, write a refetch that keeps rows equal under the schema, and reconcile a schema-checked box of an array.
---

The Effect pages are for applications that already use Effect: see
[Schema-checked boxes](./boxes.md). A `Model.collectionField` is the core's
[collection](../state/collections.md) as a field of a `Model.Schema`: it is
read with `row(key)`, `read.row`, `keys`, and `rows`, and written with `write.upsert`,
`write.remove`, and `write.replaceAll`, as that page shows.

## Example

A `Model.collectionField` holds rows by key, each row checked against the
row schema. On the wire it is a plain array. The rows here are the `Todo` of
[Classes](./classes.md):

<!-- region models.ts#class -->

<!-- region models.ts#collection -->

<!-- region models.ts#list -->

A refetch writes every row at once with `write.replaceAll`. A row equal under
the schema to the one held is kept, and what read it does not rerun. A
`Model.Schema` row with a `$` field is merged: the held row stays, and its
boxes take the refetched values.

<!-- region models.ts#replaceAll -->

`Collection.reconcile` given `equals`, here the item schema's equivalence,
keeps the previous object of every item of a `Box.schema` of a plain array
that did not change. It takes no schema: given no `equals`, it works the
comparison out from each pair of items, as
[Equality and hashing](./equality.md) lists. A plain `Schema.Struct` row
compares with Effect's `Equal.equals`, which never sees a schema, so a
`toEquivalence` annotation on a Struct is not used there.

<!-- region models.ts#reconcile -->

`Collection.reconcile` takes arrays only. One refetched model is a list of one on
each side, under any key, such as a constant: the result is the held
instance, its boxes set to the refetched values, or the refetched instance
when a plain field differs.

<!-- region models.ts#reconcileOne -->

`Collection.schema` is the collection a `Model.collectionField` holds, with no model
around it: for rows a service or a feed owns, such as the trades a feed
writes. It starts empty and checks and compares rows as the field does.

<!-- region models.ts#standalone -->

## Rules

- A `Model.collectionField` checks each row against the row schema when it
  lands: on `Model.decode`, `write.upsert`, and `write.replaceAll`. A row the schema
  rejects throws from the update, which rolls back. A `Collection.schema`
  checks on `write.upsert` and `write.replaceAll` the same way.
- An `undefined` row is rejected with `pinna: a collection row cannot be
  undefined`, even when the row schema accepts it: `row(key)` and
  `read.row` use `undefined` for a missing key. `Model.decode` throws a
  `DecodeError` holding a `Schema.SchemaError` with that message, and an
  Effect decode fails with the `SchemaError`, before `keyOf` runs; `make` throws its schema error;
  `write.upsert` and `write.replaceAll` throw the message before changing
  any row.
- A row written under a held key is compared with the row schema's
  equivalence, so a refetch of equal rows reruns nothing.
- A key names one row. A repeated key fails the `Model.decode` and throws from
  `write.replaceAll`, both with `pinna: the collection key <key> appears twice`.
  `Collection.reconcile`, with or without `equals`, throws
  `pinna: reconcile: the key <key> appears twice`.
- A row with a `$` field is a new instance after every `Model.decode`, with new
  boxes. `replaceAll`, `upsert`, and `Collection.reconcile` merge it into the row
  held under its key, so only the readers of a changed box rerun. When they
  merge is on [Equality and hashing](./equality.md).

## Answers

| Call | Answers |
| --- | --- |
| `Model.collectionField(schema, { keyOf, name? })` | A field of rows by key, each checked against `schema`, a plain array on the wire. `name` names every instance's collection, as `Collection.make`'s does. |
| `Collection.schema(realm, schema, { keyOf, equals?, name? })` | An empty collection of rows `schema` accepts, the one a `Model.collectionField` holds. A row is compared with `equals`, the schema's equivalence by default, and a `Model.Schema` row is merged into the held one. |
| `Collection.reconcile(previous, next, { keyOf, equals? })` | As `pinna`'s `Collection.reconcile` on [Updates](../state/updates.md), with `equals` optional and a `Model.Schema` item merged into the held one. |

## See also

- [Collections](../state/collections.md): reading and writing a collection, and rendering one row per key.
- [Classes](./classes.md): the model a collection field lives on.
- [Updates](../state/updates.md): the update every write runs in.
- [Hooks](../react/hooks.md): a row component that rerenders alone.
- [Equality and hashing](./equality.md): a row class's own `Equal`, and what each schema counts as equal.
- [Live data](../guides/live-data.md): a refetch and a feed written into a collection field.
