---
title: Classes
description: Read when modeling domain data. Declare a SchemaModel with box fields, derive values on it, write from its methods, decode it from the wire, and hand it the caller's own values, in a decode or an Effect program.
---

The Effect pages are for applications that already use Effect: see
[Schema-checked boxes](./boxes.md).

## Example

A model is a `SchemaModel`: a `Schema.Class` whose instances hold a realm
that its wire form never carries. A field whose name starts with `$` is a
`BoxField`, or a `CollectionField` of rows by key
([Collection fields](./collections.md)), and its wire key drops the `$`. A
field without `$` is plain, `readonly` data. The class keeps `check` and
`annotate`, and seals `extend`, `mapFields`, `makeOption`, and `makeEffect`.

<!-- region models.ts#class -->

- A derived value is a `$` property of the class body, made with
  `computed(this.realm, ...)`. It is not a schema field, so it is not on the
  wire.
- A method that writes calls `update(this.realm, ...)`.

`decode(realm, Todo)` makes instances from wire data. Every instance and
every box inside it belongs to the realm `decode` is given, the one made
above the class.

<!-- region models.ts#decode -->

A `FromContext` field holds a value of the caller's own, such as a
formatter or a client: the service of an Effect `Context.Service` tag.
`decode` takes it from the `Context` it is given; it is never on the wire.

<!-- region models.ts#context -->

An Effect program decodes the same class with `Schema.decodeUnknownEffect`.
The tag is one of its requirements, provided as any service is, with
`Effect.provideService` or a `Layer`. The realm comes from `RealmService`, as
for every Effect program.

<!-- region models.ts#contextEffect -->

## Rules

- Make instances with `decode(realm, Todo)(json)`. Every instance has a
  `realm` field, never on the wire: `decode` fills it, and field initializers
  use `this.realm`.
- `Todo.make({ id, title, done: false, realm })` builds an instance from
  values already in hand. It takes each `$` field's starting value under its
  wire key, and builds the box in the instance's realm. A box under the `$`
  key throws
  `pinna: Todo.make takes the value of $done under "done", never a box under "$done"`,
  so a spread instance never shares its box with the new one.
- `make` checks each `$` field's value even under `{ disableChecks: true }`,
  which skips only the plain fields' checks: the box checks every value it
  holds, its first included.
- A model in another schema's `make` is an instance. A plain object in its
  place throws
  `pinna: a Todo field of another schema takes an instance; build it with Todo.make or decode`,
  because its boxes would be another instance's, or none.
- A field list that breaks a naming rule makes `SchemaModel` throw when the
  class is defined, so no instance is ever half-declared:
  - two fields with one wire key, such as `$count` and `count`:
    `pinna: Counter.$count and Counter.count both read "count"; rename one`;
  - a field whose wire key is `realm`:
    `pinna: Counter.realm reads "realm", the realm the instance belongs to; rename the field`;
  - a `$` field that is not a `BoxField` or a `CollectionField`:
    `pinna: Counter.$count is named as a box; declare it BoxField(...) or CollectionField(...)`;
  - a `BoxField` or a `CollectionField` without `$`:
    `pinna: Counter.count holds a box; name it $count`.
- `BoxField` and `CollectionField` are fields of a `SchemaModel` only. In
  any other schema they fail to decode and encode with
  `pinna: BoxField is a SchemaModel field; declare it in SchemaModel(...), never in another schema`
  (or `CollectionField`), because the `$` key would go on the wire.
- `extend`, `mapFields`, `makeOption`, and `makeEffect` throw and do not
  compile on a `SchemaModel`: the first two would declare fields without its
  checks, and the last two would take boxes where `make` takes values. The
  call throws `pinna: Todo.extend is not supported; declare another SchemaModel with every field it needs`,
  and the same for `mapFields`; `makeOption` and `makeEffect` throw
  `pinna: Todo.makeOption is not supported; call make, which throws the schema error, or decode`.
- A plain getter has no `read` to call, and a method that takes `read` is not
  cached. A value several components need is a computed field.
- A context field's tag is a requirement of the decode, at any depth:
  `decode` without a `Context` holding the tag does not compile, and neither
  does running a `Schema.decodeUnknownEffect` that nothing provides it to.
  A `Context` holding more tags compiles. A schema with no context field
  takes no `Context`. `Schema.decodeUnknownSync` does not compile on such a
  schema, because it runs without services.
- The `Context` given to `decode` may hold any Effect service, such as a
  `Clock`, and the schema's own transformations read them from Effect.
- A field reads its tag from the Effect context, so the innermost provider
  wins, as for any service: an Effect decode inside a `decode`'s
  transformation that provides a tag the outer `decode` also holds reads its
  own value.
- Plain fields are never written after `decode`. A value that changes is a
  `$` field.
- Encoding an instance, as `Schema.encodeSync(Todo)(todo)`, gives the
  schema's wire fields and nothing else, each `$` field's current value under
  its wire key. The `realm`, a `FromContext` field, computed fields, and
  other instance properties stay off the wire, so what is sent is the schema's encoded form.
- Declare a class with no `$` field as a plain `Schema.Class`. A
  `SchemaModel` without one still has a `realm` field, so decoding it needs a
  realm, and `RealmService` in an Effect program, for nothing to observe.

## Answers

| Call | Answers |
| --- | --- |
| `SchemaModel<Self>(identifier)(fields)` | A class whose `$` fields are boxes or collections, checked by its schema. |
| `BoxField(schema)` | A field that is a box of `schema`, under the wire key without the `$`. |
| `CollectionField(rowSchema, { keyOf })` | A field that is a collection of rows by key, each row checked against `rowSchema` and compared with its equivalence: see [Collection fields](./collections.md). |
| `decode(realm, schema, context?)(input)` | The decoded value, or throws `Schema.SchemaError`. |
| `FromContext(tag)` | A field holding the service of `tag`, never on the wire, that puts `tag` in the schema's requirements. |
| `Todo.make({ ...values, realm })` | An instance from values in hand, each `$` field's value under its wire key. |

## See also

- [Schema-checked boxes](./boxes.md): what a `$` field checks on a write.
- [Errors](../guides/errors.md#fields-a-schema-refuses): the path and message of each field `decode` refuses.
- [Collection fields](./collections.md): rows by key, as a `$` field.
- [Boxes and computed](../state/boxes.md): what a `$` field and a computed field are.
- [Updates](../state/updates.md): what a write checks, and when it is undone.
- [Hooks](../react/hooks.md): reading a model in a component.
- [Equality and hashing](./equality.md): when two instances of a model are equal, and a class's own `Equal`.
- [Coming from MobX](../start/mobx.md): a MobX store as a `SchemaModel`.
