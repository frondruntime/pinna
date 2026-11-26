# @frondruntime/pinna-effect

Pinna on Effect Schema: boxes that check every write against a schema,
models decoded from the wire with boxes and keyed collections as fields, and
Effect programs that react to state. It re-exports every name of
`@frondruntime/pinna` as it is, so an application imports from one package.
`effect` 4.1 or a later 4.x is a peer dependency.

0.2.0 is a pre-1.0 release: any version may change the API.

## Install

```bash
bun add @frondruntime/pinna-effect effect
```

## Example

```ts
import { Schema } from "effect";
import { Computed, Model, Realm } from "@frondruntime/pinna-effect";

const realm = Realm.make();

class Todo extends Model.Schema<Todo>("Todo")({
  id: Schema.String,
  title: Schema.String,
  $done: Model.boxField(Schema.Boolean), // a box field; the wire key is "done"
}) {
  readonly $label = Computed.make(this.realm, (read) =>
    read(this.$done) ? `✓ ${this.title}` : this.title,
  );

  toggle(): void {
    Realm.update(this.realm, (read, write) => {
      write(this.$done, !read(this.$done));
    });
  }
}

// Throws a DecodeError, holding the SchemaError, when the input does not fit.
const todo = Model.decode(realm, Todo)({ id: "1", title: "Write the docs", done: false });

todo.toggle();
const label = Realm.untracked(realm, (read) => read(todo.$label)); // "✓ Write the docs"
```

## Exports

Everything `@frondruntime/pinna` exports, and:

| Kind | Exports |
| --- | --- |
| Checked state | `Box.schema`, `Collection.schema`, `Collection.reconcile` |
| Models | `Model.Schema`, `Model.boxField`, `Model.collectionField`, `Model.context`, `Model.decode` |
| Effect programs | `RealmService`, `Program.watchScoped`, `Program.changes`, `Source.observeScoped`, `Program.whileObserved`, `Program.fromStream`, `Stage.scoped` |
| Errors | `DecodeError` |

## Documentation

<https://pinna.frondruntime.dev/docs/effect/boxes>
