---
title: Start
description: Read when starting with Pinna. Make a realm, a box, and a computed value, write in an update, show the value in React, and choose between a plain box and a schema box.
---

## Example

A realm holds every observable it makes. Make one for the app, in module code.

<!-- region start.tsx#realm -->

A box is observable state. A computed value is
derived from what its function reads, and cached.

<!-- region start.tsx#box -->

- A name that starts with `$` is observable. Everything else is plain data.
- `{ name }` names the value in `Source.inspect` and in its errors.
- Each call is a member of its type's module, and the module's name is also
  the type: `Box.make` returns a `Box<number>`, from one import. The modules
  are `Realm`, `Box`, `Atom`, `Computed`, `Collection`, `View`, `Stage`,
  `Model`, and `Source`, and `pinna-effect` adds `Program`.

A box is written only inside `Realm.update`, which hands out `read` and
`write`.

<!-- region start.tsx#update -->

A component reads with `useValue` and rerenders when the value changes. It
needs no provider: the value carries its realm.

<!-- region start.tsx#component -->

State made more than once, such as once per test, is a model: a class that
extends `Model.Class`, whose fields are made against `this.realm` and whose methods
write through `Realm.update`.

<!-- region start.tsx#model -->

A test makes the model in a realm of its own and reads as application code
does: one value with `Source.peek`, several inside `Realm.untracked`.

<!-- region start.tsx#test -->

## Rules

- An observable has no read or write methods. Every place that reads hands out
  `read`; `Realm.update` alone also hands out `write`.
- An update that throws is undone: every write before the throw is taken
  back, except a `write.changed` on an atom, whose watchers still run.
- There is no default realm. Batches, tracking, watchers, and errors stay
  inside the realm that made them, so a test with a realm of its own shares
  nothing with the next.
- The samples on these pages use one realm made in module code, for brevity.
- The pages under Core and React import from `@frondruntime/pinna`, which
  needs no Effect, and `@frondruntime/pinna-react`. The pages under Effect
  import from `@frondruntime/pinna-effect`, which re-exports every call of
  `@frondruntime/pinna` and adds boxes and models that check an Effect Schema
  on every write: see [Schema-checked boxes](../effect/boxes.md).

## Answers

| Call | Answers |
| --- | --- |
| `Realm.make({ onError?, name? })` | A realm. `onError` gets the errors with no caller, and defaults to the host's `reportError`. `name` labels the realm in `Source.inspect` and in an error about another realm; it is never compared. |
| `Box.make(realm, initial, options?)` | A box. A write equal to the current value under `Object.is` notifies nobody. |
| `Computed.make(realm, (read) => ..., options?)` | A cached value derived from what the function reads. |
| `Realm.update(realm, (read, write) => ...)` | Runs the recipe atomically. Watchers see its end state once. |
| `useValue($x)` | The value of `$x`; the component rerenders when it changes. |
| `class X extends Model` | A model that checks nothing. Field initializers read `this.realm`; `new X(realm)` makes one. |

## Plain or schema boxes

The choice is per box, not per application. A plain `Box.make` and a
`Collection.make` check nothing, and neither does `Model`, the base class of a
model with no schema. A schema box, a `Box.schema` or a `Model.Schema`'s
`Model.boxField`, checks every write against its schema, and a `Model.collectionField`
checks each row against its row schema when the row lands. A value the
schema rejects throws and undoes the update.

- Data from outside the program, such as a response from the wire or user
  input, goes through a schema. `Model.decode(realm, schema)(input)` checks it once
  at the boundary, whatever boxes then hold it.
- A value whose writes need a runtime check takes a schema box: the check
  runs on every write.
- Trusted data that is written often takes a plain box, which runs no check.
- A schema box's check is never weakened for speed. The plain box is the way
  to check nothing; there is no option that turns a schema box's check off.

A `Model.Schema`, from `@frondruntime/pinna-effect`, can hold a plain box in
its class body beside its `Model.boxField`s. The plain box checks nothing, and the
`Model.boxField` keeps checking.

<!-- region models.ts#plain -->

- A box in the class body is not a schema field, so it is not on the wire:
  `Model.decode` does not fill it, and encoding does not write it.
- A body box seeded from a decoded field, as
  `readonly $lastPrice = Box.make(this.realm, this.price)`, starts from a value
  that `Model.decode` checked once. Later writes to the box check nothing, and the
  field `price` and the encoded output stay at the decoded value.
- No `$` field is both on the wire and unchecked. A `$` field on the wire is
  a `Model.boxField`, which checks every write, or a `Model.collectionField`, which
  checks every row written to it.

## Agent skills

Eight agent skills give a coding agent a map of the library and the rules
of one task at a time. `pinna-overview` loads first: every module and its calls, and
the skill for each task. The other seven cover state, React components,
Effect, stages and live data, saving and history, testing and errors, and
moving from MobX. The `skills` command line
(<https://skills.sh>) installs them into a project:

```bash
npx skills add frondruntime/pinna
```

`node_modules/@frondruntime/pinna/AGENTS.md` holds the same rules at the
installed version, and wins where the two differ.

## See also

- [Coming from MobX](./mobx.md): the Pinna call for each MobX one.
- [Updates](../state/updates.md): drafts, atomic updates, and `Collection.reconcile`.
- [Reacting](../state/reacting.md): watchers and autoruns.
- [Schema-checked boxes](../effect/boxes.md): the same calls on Effect Schema, with models decoded from the wire.
- [Hooks](../react/hooks.md): every way a component reads.
