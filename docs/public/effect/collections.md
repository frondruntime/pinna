---
title: Collection fields
description: Read when a model holds rows by key. Declare a CollectionField, decode it from a plain array, write a refetch that keeps rows equal under the schema, and reconcile a schema-checked box of an array.
---

The Effect pages are for applications that already use Effect: see
[Schema-checked boxes](./boxes.md). A `CollectionField` is the core's
[collection](../state/collections.md) as a field of a `SchemaModel`: it is
read with `row(key)`, `read.row`, `keys`, and `rows`, and written with `write.upsert`,
`write.remove`, and `write.replaceAll`, as that page shows.

## Example

A `CollectionField` holds rows by key, each row checked against the
row schema. On the wire it is a plain array. The rows here are the `Todo` of
[Classes](./classes.md):

<!-- region models.ts#class -->

<!-- region models.ts#collection -->

<!-- region models.ts#list -->

A refetch writes every row at once with `write.replaceAll`. A row equal under
the schema to the one held is kept, and what read it does not rerun. A
`SchemaModel` row with a `$` field is merged: the held row stays, and its
boxes take the refetched values.

<!-- region models.ts#replaceAll -->

`reconcile` takes `equals`, here the item schema's equivalence, so a
`schemaBox` of a plain array keeps the previous object of every item that did
not change. `reconcileSchema` takes no schema, and works `equals` out from
each pair of items when it is left out, as
[Equality and hashing](./equality.md) lists. A plain `Schema.Struct` row
compares with Effect's `Equal.equals`, which never sees a schema, so a
`toEquivalence` annotation on a Struct is not used there.

<!-- region models.ts#reconcile -->

`reconcileSchema` takes arrays only. One refetched model is a list of one on
each side, under any key, such as a constant: the result is the held
instance, its boxes set to the refetched values, or the refetched instance
when a plain field differs.

<!-- region models.ts#reconcileOne -->

`schemaCollection` is the collection a `CollectionField` holds, with no model
around it: for rows a service or a feed owns, such as the trades a feed
writes. It starts empty and checks and compares rows as the field does.

<!-- region models.ts#standalone -->

## Rules

- A `CollectionField` checks each row against the row schema when it
  lands: on `decode`, `write.upsert`, and `write.replaceAll`. A row the schema
  rejects throws from the update, which rolls back. A `schemaCollection`
  checks on `write.upsert` and `write.replaceAll` the same way.
- A row written under a held key is compared with the row schema's
  equivalence, so a refetch of equal rows reruns nothing.
- A key names one row. A repeated key fails the `decode` and throws from
  `write.replaceAll`, both with `pinna: the collection key <key> appears twice`.
  `reconcile` and `reconcileSchema` throw
  `pinna: reconcile: the key <key> appears twice`.
- A row with a `$` field is a new instance after every `decode`, with new
  boxes. `replaceAll`, `upsert`, and `reconcileSchema` merge it into the row
  held under its key, so only the readers of a changed box rerun. When they
  merge is on [Equality and hashing](./equality.md).

## Answers

| Call | Answers |
| --- | --- |
| `CollectionField(schema, { keyOf })` | A field of rows by key, each checked against `schema`, a plain array on the wire. |
| `schemaCollection(realm, schema, { keyOf, equals? })` | An empty collection of rows `schema` accepts, the one a `CollectionField` holds. A row is compared with `equals`, the schema's equivalence by default, and a `SchemaModel` row is merged into the held one. |
| `reconcileSchema(previous, next, { keyOf, equals? })` | As `reconcile` on [Updates](../state/updates.md), with `equals` optional and a `SchemaModel` item merged into the held one. |

## See also

- [Collections](../state/collections.md): reading and writing a collection, and rendering one row per key.
- [Classes](./classes.md): the model a collection field lives on.
- [Updates](../state/updates.md): the update every write runs in.
- [Hooks](../react/hooks.md): a row component that rerenders alone.
- [Equality and hashing](./equality.md): a row class's own `Equal`, and what each schema counts as equal.
- [Live data](../guides/live-data.md): a refetch and a feed written into a collection field.
