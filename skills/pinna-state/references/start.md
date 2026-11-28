# Start

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/start/index.md.

Sections: Example, Rules, Answers, Plain or schema boxes, Agent skills, See also.

## Example

A realm holds every observable it makes. Make one for the app, in module code.

```tsx
import { Realm } from "@frondruntime/pinna";

const realm = Realm.make();
```

A box is observable state. A computed value is
derived from what its function reads, and cached.

```tsx
import { Box, Computed } from "@frondruntime/pinna";

const $count = Box.make(realm, 0, { name: "count" });
const $double = Computed.make(realm, (read) => read($count) * 2, { name: "double" });
```

- A name that starts with `$` is observable. Everything else is plain data.
- `{ name }` names the value in `Source.inspect` and in its errors.
- Each call is a member of its type's module, and the module's name is also
  the type: `Box.make` returns a `Box<number>`, from one import. The modules
  are `Realm`, `Box`, `Atom`, `Computed`, `Collection`, `View`, `Stage`,
  `Model`, and `Source`, and `pinna-effect` adds `Program`.

A box is written only inside `Realm.update`, which hands out `read` and
`write`.

```tsx
import { Realm } from "@frondruntime/pinna";

const increment = () => {
  Realm.update(realm, (read, write) => {
    write($count, read($count) + 1);
  });
};
```

A component reads with `useValue` and rerenders when the value changes. It
needs no provider: the value carries its realm.

```tsx
import { useValue } from "@frondruntime/pinna-react";

function CounterButton() {
  const double = useValue($double);
  return (
    <button type="button" onClick={increment}>
      {double}
    </button>
  );
}
```

State made more than once, such as once per test, is a model: a class that
extends `Model.Class`, whose fields are made against `this.realm` and whose methods
write through `Realm.update`.

```tsx
import { Box, Computed, Model, Realm } from "@frondruntime/pinna";

class Counter extends Model.Class {
  readonly $count = Box.make(this.realm, 0, { name: "count" });
  readonly $double = Computed.make(this.realm, (read) => read(this.$count) * 2, { name: "double" });

  increment(): void {
    Realm.update(this.realm, (read, write) => {
      write(this.$count, read(this.$count) + 1);
    });
  }
}
```

A test makes the model in a realm of its own and reads as application code
does: one value with `Source.peek`, several inside `Realm.untracked`.

```tsx
import { Realm } from "@frondruntime/pinna";

const counter = new Counter(Realm.make());
counter.increment();
const double = Realm.untracked(counter.realm, (read) => read(counter.$double)); // 2
```

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
  on every write: see [Schema-checked boxes](https://pinna.frondruntime.dev/docs/effect/boxes.md).

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

```ts
import { Box, Model, Realm } from "@frondruntime/pinna-effect";
import { Schema } from "effect";

class Ticker extends Model.Schema<Ticker>("Ticker")({
  symbol: Schema.String,
  $volume: Model.boxField(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))), // checked on every write
  price: Schema.Number.check(Schema.isGreaterThan(0)), // checked once, by decode
}) {
  // Starts at the decoded price; checks nothing, and is not on the wire.
  readonly $lastPrice = Box.make(this.realm, this.price);

  tick(price: number): void {
    Realm.update(this.realm, (_read, write) => {
      write(this.$lastPrice, price);
    });
  }
}

const ticker = Model.decode(realm, Ticker)({ symbol: "ACME", volume: 0, price: 12 });
ticker.tick(12.5);
```

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

- [Coming from MobX](https://pinna.frondruntime.dev/docs/start/mobx.md): the Pinna call for each MobX one.
- [Updates](https://pinna.frondruntime.dev/docs/state/updates.md): drafts, atomic updates, and `Collection.reconcile`.
- [Reacting](reacting.md): watchers and autoruns.
- [Schema-checked boxes](https://pinna.frondruntime.dev/docs/effect/boxes.md): the same calls on Effect Schema, with models decoded from the wire.
- [Hooks](https://pinna.frondruntime.dev/docs/react/hooks.md): every way a component reads.
