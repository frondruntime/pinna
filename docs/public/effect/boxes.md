---
title: Schema-checked boxes
description: Read when an app already uses Effect. Import the core's calls from pinna-effect, make a box that checks an Effect Schema on every write, and know what a schema adds to a write.
---

The Effect pages are for applications that already use Effect.
`@frondruntime/pinna-effect` has the same calls as `@frondruntime/pinna`, on
Effect Schema, and `effect` is its peer dependency. It adds what the core
lacks: boxes that check a schema on every write, models as
[classes](./classes.md) decoded from the wire, with boxes and
[collections](./collections.md) as fields, and [programs](./programs.md) that
run with a scope. An
application without Effect needs none of it: start at [Start](../start/index.md).

## Example

`Box.schema` takes a schema before the initial value. The other calls, and the
hooks of `@frondruntime/pinna-react`, are the core's.

<!-- region effectBoxes.ts#box -->

A write equal to the current value notifies nobody. A box compares with its
schema's equivalence, so an equal array or object counts as unchanged.

<!-- region effectBoxes.ts#equivalence -->

A write the schema rejects throws from the update, and every write before it in
the same update is undone.

<!-- region effectBoxes.ts#rejected -->

`write.modify` drafts an array or a plain object, then writes it back once,
checked against the schema.

<!-- region effectBoxes.ts#modify -->

## Rules

- `pinna-effect`'s modules hold every member of `pinna`'s as it is, except
  `Collection.reconcile`. Its `Box.make` and `Collection.make` check nothing
  and compare with `Object.is` unless given `{ equals }`.
  The members it adds use a schema: `Box.schema`, `Collection.schema`, and
  `Model.Schema` with `Model.boxField` and `Model.collectionField`. An
  application imports from one package.
- `Collection.reconcile` given `{ equals }` compares with it and merges
  nothing, as `pinna`'s does. Without it, it works the comparison out from
  the schema and writes a refetched `Model.Schema` row's values into the
  boxes of the row it keeps, so it is not a read-only helper
  ([Equality and hashing](./equality.md)).
- `Box.make` given a schema throws and names `Box.schema`, so a box meant to check a
  schema never silently checks nothing.
- A box of a plain `Schema.Array(element)` checks only the elements a write
  put there: a push onto 10,000 rows checks one. Any other box checks its
  whole value on every write. A list written one row at a time is a
  [collection field](./collections.md).
- A `Box.schema` compares with its schema's equivalence unless `{ equals }`
  says otherwise. What each schema counts as equal is on
  [Equality and hashing](./equality.md).
- `Box.schema` throws when `initial` does not fit the schema.
- A value the schema accepts is plain data, `readonly` in the types. A value
  changed in place is checked by no schema.

## Answers

| Call | Answers |
| --- | --- |
| `Box.schema(realm, schema, initial, { name?, equals? })` | A box of the values `schema` accepts. Throws when `initial` does not fit. |
| `write($box, value)` | Replaces the value, checked against the schema. |
| `write.modify($box, (draft) => ...)` | Writes the drafted array or object back once, checked. |

## Checks and rules

A check runs when a value is written, on that value alone, and never again
(a write of the value the box holds runs none):
a read, a recompute, or a change elsewhere does not run it. So a check holds
only what the value itself decides.

- Terms that must agree, such as the two dates of a stay, are one schema
  value with one check. A `Model.boxField`'s check sees its own value and no
  sibling field, and a check on the `Model.Schema` as a whole runs when an
  instance is made, decoded, or written to a schema box, never when a box
  of the instance changes. A filter made with `Schema.makeFilter`
  that returns a string fails with that string as its message: see
  [Errors](../guides/errors.md#fields-a-schema-refuses).

<!-- region effectBoxes.ts#related -->

- A rule that depends on time, such as a date that must be after today, or
  on another box's value, is no check of the box: the value it judged would
  stay in the box after today moves past it. It is checked where the input
  is accepted, in the update that writes it, and what it allows from then on
  is a computed value that follows both.

<!-- region effectBoxes.ts#eligibility -->

## See also

- [Boxes and computed](../state/boxes.md): the core's box, with no schema.
- [Updates](../state/updates.md): what an update undoes when it throws.
- [Classes](./classes.md): boxes as fields of a model decoded from the wire.
- [Errors and debugging](../guides/errors.md#with-effect): the errors a schema adds, and the path and message of each field it refuses.
- [Equality and hashing](./equality.md): what each schema counts as the same value, and a class's own `Equal`.
