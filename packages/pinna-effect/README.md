# @frondruntime/pinna-effect

Pinna on Effect Schema: boxes that check every write against a schema,
models decoded from the wire with boxes and keyed collections as fields, and
Effect programs that react to state. It re-exports every name of
`@frondruntime/pinna` as it is, so an application imports from one package.
`effect` 4.1 or a later 4.x is a peer dependency.

0.0.1 is a pre-1.0 release: any version may change the API.

## Install

```bash
bun add @frondruntime/pinna-effect effect
```

## Example

```ts
import { Schema } from "effect";
import {
  BoxField,
  computed,
  createRealm,
  decode,
  SchemaModel,
  untracked,
  update,
} from "@frondruntime/pinna-effect";

const realm = createRealm();

class Todo extends SchemaModel<Todo>("Todo")({
  id: Schema.String,
  title: Schema.String,
  $done: BoxField(Schema.Boolean), // a box field; the wire key is "done"
}) {
  readonly $label = computed(this.realm, (read) =>
    read(this.$done) ? `✓ ${this.title}` : this.title,
  );

  toggle(): void {
    update(this.realm, (read, write) => {
      write(this.$done, !read(this.$done));
    });
  }
}

// Throws the SchemaError when the input does not fit.
const todo = decode(realm, Todo)({ id: "1", title: "Write the docs", done: false });

todo.toggle();
const label = untracked(realm, (read) => read(todo.$label)); // "✓ Write the docs"
```

## Exports

Everything `@frondruntime/pinna` exports, and:

| Kind | Exports |
| --- | --- |
| Checked state | `schemaBox`, `schemaCollection`, `reconcileSchema` |
| Models | `SchemaModel`, `BoxField`, `CollectionField`, `FromContext`, `decode` |
| Effect programs | `RealmService`, `watchScoped`, `changes`, `observeScoped`, `whileObserved`, `fromStream`, `withStage` |
| Errors | `StageConflict` |

## Documentation

<https://pinna.frondruntime.dev/docs/effect/boxes>
