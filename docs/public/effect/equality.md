---
title: Equality and hashing
description: Read when a write, a refetch, or a reconcile keeps or replaces a value. Know what each box, collection, and reconcile compares with by default, why two decodes of a model with a box are not equal unless the class defines its own Equal, what Effect's Equal.equals and HashSet see, and how a class defines its own Equal and Hash.
---

Pinna compares a value written over the one held. When the two are equal,
the held value stays, and nothing that read it reruns. What counts as equal
depends on what holds the value. The Effect pages are for applications that
already use Effect: see [Schema-checked boxes](./boxes.md).

## Example

A `Box.schema` compares as `Schema.toEquivalence` of its schema does. An
equal write keeps the object the box holds.

<!-- region equality.ts#box -->

A `Model.Schema` without its own Equal compares its boxes and its realm by
identity, so two decodes of the same JSON are not equal when the class has a
`$` field.

<!-- region equality.ts#models -->

A refetch through `write.replaceAll` keeps each plain row that did not
change.

<!-- region equality.ts#refetch -->

A refetched `Model.Schema` row is merged into the held one, so a component
that reads the row reruns only when a plain field changes, and one that
reads `$size` reruns when the size does.

<!-- region equality.ts#contents -->

A `Model.Schema` that defines `[Equal.symbol]` decides its own equality. A
refetched rate under a held pair is merged, and its box takes the new bid.

<!-- region equality.ts#ownEqual -->

`{ equals }` replaces the default of any box.

<!-- region equality.ts#choosing -->

## Rules

- The core's `Box.make`, `Collection.make`, and `Computed.make` compare with `Object.is`
  unless `{ equals }` says otherwise, so a new array or object is a change.
  A computed value compares with `Object.is` in `pinna-effect` too, even
  when what it reads is a `Box.schema`.
- A `Box.schema` and a `Model.boxField` compare with the schema's equivalence,
  with the answers of `Schema.toEquivalence`. An equal write keeps the
  value held and notifies nobody, so a refetch of the same data reruns
  nothing.
- Under a schema's equivalence a primitive equals the same value, `NaN`
  equals `NaN`, and `0` equals `-0`. A `Date` equals one with the same time,
  and two invalid Dates are equal. An array or a struct compares part by
  part. A schema with an equivalence annotation, such as
  `Schema.overrideToEquivalence`, compares with it.
- A box of `Schema.Unknown`, `Schema.Any`, or `Schema.ObjectKeyword`
  compares with `Object.is`: such a schema says nothing of the value's
  shape, and a structural compare would hash the whole value on every
  write. An `Unknown` field inside a struct compares structurally.
- `{ equals }` replaces the schema's equivalence: `Object.is` counts every
  new array or object as a change, even one equal part by part, and a
  function by id counts a row with a new price as unchanged.
- A `Model.Schema` instance without its own `Equal` compares its plain fields
  by value and its boxes and its realm by identity. Every `Model.decode` makes new
  boxes, so a refetched instance with a `$` field is not equal to the one
  held, and neither is an instance from another realm.
- A `Model.Schema` with its own `[Equal.symbol]` is compared by that method
  wherever Pinna compares with the class's schema, as in a `Box.schema` and
  in `Collection.reconcile`, on every comparison, with no answer cached. A plain
  `Schema.Class` ignores its own `[Equal.symbol]` there, as Effect's schema
  does, and compares field by field.
- A refetched `Model.Schema` instance under a held key is merged into the
  held one when both are of the same class and realm and their plain fields
  are equal, or the class's own `[Equal.symbol]` finds them equal, even
  when a plain field differs. The held instance stays; each `Model.boxField`
  takes the refetched value, compared with its schema, and each
  `Model.collectionField` merges its rows the same way, so a refetch reruns only
  the readers of a box that changed. A plain field that holds a model is
  compared, not merged. Any other difference replaces the instance.
- `Collection.reconcile`, `write.replaceAll`, and `write.upsert` merge. A
  `Box.schema` of an array compares by index and does not.
- A `Model.collectionField` merges a `Model.Schema` row written under a held key
  and compares any other row with the row schema's equivalence: `replaceAll`
  and `upsert` keep every equal or merged row, and notify nobody when
  nothing changed.
- `Collection.reconcile` given `equals` compares with it alone and merges
  nothing, as `pinna`'s does, where `equals` is required: a refetch builds
  new objects, and the comparison is the caller's choice.
- `Collection.reconcile` without `equals` keeps a row that is the same instance, merges a
  `Model.Schema` row, compares any other instance of a `Schema.Class` with
  its class's equivalence, and anything else with Effect's `Equal.equals`.
  A key repeated in the new array throws before any box is written. The
  merge writes in the open update, or in one of its own; a refetch that
  changes no box opens none, so it runs inside a computed value too.
  `equals` replaces all of it.
- Effect's `Equal.equals`, which `HashSet` and `HashMap` look values up
  with, is not the schema's equivalence. It compares `Hash.hash` first,
  caches each object's hash, caches its answer for a pair of objects, and
  compares an instance by every own property. The two agree on a plain
  `Schema.Class` and on a `Model.Schema` whose fields are all plain: two
  decodes of the same JSON into one realm are equal, and `HashSet.has`
  finds either. They part on two cases:
  - A `$` property of the class body, such as a computed value, is no
    schema field. The schema's equivalence ignores it; `Equal.equals`
    compares it by identity, so two instances are not equal under Effect.
  - A `Model.Schema` with `[Equal.symbol]` and no `[Hash.symbol]` is equal
    under the schema's equivalence and not under `Equal.equals`, which
    compares hashes first. Define both, on plain fields only, such as the
    key, since Effect caches the hash.
- Under Effect's `Equal.equals`, a box, a computed value, an atom, and a
  realm equal only themselves. A plain object holding them compares them by
  identity, never by their contents.

## Answers

| Call | Compares a new value with the held one by default with |
| --- | --- |
| `Box.make(realm, initial, { equals? })` | `Object.is`. |
| `Collection.make(realm, { keyOf, equals? })` | `Object.is`, row by row. |
| `Computed.make(realm, compute, { equals? })` | `Object.is`. |
| `Box.schema(realm, schema, initial, { equals? })` | The schema's equivalence. |
| `Model.boxField(schema)` | The schema's equivalence. |
| `Model.collectionField(schema, { keyOf })` | A merge for a `Model.Schema` row, the row schema's equivalence otherwise, row by row. |
| `Collection.reconcile(previous, next, { keyOf, equals })` | `equals`, with no merge; `pinna`'s requires it. |
| `Collection.reconcile(previous, next, { keyOf })` | A merge for a `Model.Schema` row, the class's equivalence for another schema class instance, `Equal.equals` otherwise. |

## See also

- [Schema-checked boxes](./boxes.md): the box that checks a schema on every write.
- [Classes](./classes.md): the model whose fields these rules compare.
- [Collection fields](./collections.md): `replaceAll` and `Collection.reconcile` on a refetch.
- [Boxes and computed](../state/boxes.md): the core's box and its `equals`.
- [Collections](../state/collections.md): the core's collection and its `equals`.
