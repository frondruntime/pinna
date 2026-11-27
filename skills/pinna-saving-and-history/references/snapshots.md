# Snapshots

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/state/snapshots.md.

Sections: Example, Rules, With Effect, Answers, See also.

## Example

A snapshot reads a shape the code declares: a plain object or array of
boxes, collections, and `Model.Schema` instances. The shape's keys are the
snapshot's keys, and what the shape leaves out, such as a hover, stays out.

```ts
import { Box, Collection, Realm } from "@frondruntime/pinna";

interface Tab {
  readonly id: string;
  readonly title: string;
}

const realm = Realm.make();
const $theme = Box.make<"light" | "dark">(realm, "light");
const $sidebarOpen = Box.make(realm, true);
// Shown on screen, never saved: it is not in the shape.
const $hovered = Box.make<string | undefined>(realm, undefined);
const tabs = Collection.make(realm, { keyOf: (tab: Tab) => tab.id });

// The keys are the snapshot's keys: renaming a box leaves saved data as it was.
const workspace = { theme: $theme, sidebar: { open: $sidebarOpen }, tabs };
```

`read.snapshot(shape)` is `read` applied across the shape: each box's value
as held, and each collection's rows in key order. `Snapshot<typeof shape>`
is its type.

```ts
import { Realm, type Snapshot } from "@frondruntime/pinna";

const saved: Snapshot<typeof workspace> = Realm.untracked(realm, (read) =>
  read.snapshot(workspace),
);
// { theme: "light", sidebar: { open: true }, tabs: [] }
```

`write.restore(shape, data)` is `write` applied across the same shape, inside
`Realm.update`.

```ts
import { Realm, type Snapshot } from "@frondruntime/pinna";

const restore = (data: Snapshot<typeof workspace>): void => {
  Realm.update(realm, (_read, write) => {
    // Every box and row lands, or none: a throw puts the restore back.
    write.restore(workspace, data);
  });
};
```

In a computed value, a snapshot tracks every box and collection in the
shape, so the value recomputes on a write under the shape and on no other.

```ts
import { Computed } from "@frondruntime/pinna";

// Recomputes on any write under the shape, and on none outside it.
const $text = Computed.make(realm, (read) => JSON.stringify(read.snapshot(workspace)));
```

`Stage.read` hands out the stage's `read`, so its snapshot is the state as
the stage would land it.

```ts
import { type Snapshot, Stage } from "@frondruntime/pinna";

const preview = (stage: Stage): Snapshot<typeof workspace> =>
  Stage.read(stage, (read) => read.snapshot(workspace));
```

## Rules

- A shape holds boxes, collections, `Model.Schema` instances, and plain
  objects and arrays of them. Anything else throws
  `pinna/snapshot-not-state`, naming the path: a computed value, which
  recomputes from the boxes a restore writes; an atom, which holds no value;
  a `Model.Class` instance, which declares no fields, so put its boxes in the
  shape by name; and a plain value. A shape that holds itself throws
  `pinna/snapshot-cycle`.
- A plain object's keys are its own enumerable keys, symbols included, as
  the `Snapshot` type maps them. An array's empty slot is an empty slot in
  its snapshot, and its restore takes an empty slot there.
- A box's value is the snapshot's leaf, as held: a `Date` stays a `Date`, and
  an unchanged box gives the same object in two snapshots. A model instance
  inside a box's value is that instance, never walked. The data is as plain
  as the values; the encoded form is a schema's (see "With Effect").
- A snapshot reads as `read` does where it runs: tracked in a computed value,
  a watch's select, or an autorun; the stage's values in a stage recipe or
  `Stage.read`; untracked in an update or `Realm.untracked`. A snapshot
  outside every place throws `pinna/read-outside-place`.
- Two snapshots share nothing but the held values. A part of the state that
  must keep its identity while nothing under it changes is a computed value
  over that part of the shape.
- `write.restore` writes each box through `write`, so a schema box checks the
  value and an equal value notifies nobody. Restoring the state held writes
  nothing and reruns nothing.
- A restore lands with its update or not at all. A throw part way puts back
  every write the restore made, even when the recipe catches the error.
- The data's shape matches the shape exactly: a missing or an added key, an
  object where an array belongs, or an array of another length throws
  `pinna/restore-shape`, naming the path. A partial restore is a restore of a
  smaller shape.
- A collection takes the data's rows by key, in the data's order: a key the
  data lacks is removed, and each change reports to `Collection.onRowChange`.
  A `Model.Schema` row held under a key is restored in place, so readers of
  the row do not rerun; readers of its boxes do.
- A collection keys a data row with its own `keyOf`, so a `keyOf` for
  `Model.Schema` rows reads a plain field, which the data holds under the
  same name. A `keyOf` that calls a method of the instance throws
  `pinna/restore-shape` on a data row.
- An instance in the data whose plain fields match the row held under its
  key restores that row in place; one whose plain fields differ replaces
  it, as a refetch does.
- A restore never makes a model. A row the collection lacks is added from an
  instance in the data; plain data for a `Model.Schema` row throws
  `pinna/restore-cannot-make-row`. Make the instance with `Model.decode` or
  `make`, or decode the whole input with `Model.restore`.
- A `Collection.make` collection knows it holds `Model.Schema` rows once a
  snapshot or a restore finds one in it or a restore adds one from its data,
  and keeps knowing after its last model row is removed, so plain data then
  throws `pinna/restore-cannot-make-row` too. One that a snapshot or a
  restore has never seen hold a model row takes plain data as plain rows: its
  rows have no schema to say otherwise. `Collection.schema` and `Model.collectionField`
  know from their schema.
- A restore is writes, not the model's methods: a method that does more than
  write, such as cancelling work when a tab closes, does not run. What must
  happen on a change belongs in a `Realm.watch`.
- A restore in a stage recipe writes constants, so it replays to the same
  result and lands at `Stage.apply`.
- No call snapshots a whole realm: a realm lists no boxes, and a box's
  identity means nothing after a reload. The application's root shape is
  the root of its snapshot.

## With Effect

A `Model.Schema` instance in a shape gives its wire keys, each `$` field's
snapshot in place of its box or collection: the form `make` takes, without
`realm`. A `Model.context` field is the caller's service and stays out.

```ts
import { Model } from "@frondruntime/pinna-effect";
import { Schema } from "effect";

class Todo extends Model.Schema<Todo>("Todo")({
  id: Schema.Number,
  title: Schema.String,
  $done: Model.boxField(Schema.Boolean),
}) {}

class Board extends Model.Schema<Board>("Board")({
  id: Schema.String,
  $todos: Model.collectionField(Todo, { keyOf: (todo) => todo.id }),
}) {}

const board = Model.decode(realm, Board)({ id: "main", todos: [] });
```

```ts
import { Realm } from "@frondruntime/pinna-effect";

// Wire keys, each $ field's snapshot in place of its box: { id, todos: [{ id, title, done }] }.
const data = Realm.untracked(realm, (read) => read.snapshot({ board }));
```

`Model.restore(realm, Schema, context?)(held, input)` decodes `input`, then
restores the decoded instance into `held`, in the open update or one of its
own. A new row is the decoded instance, so nothing is decoded twice.

```ts
import { Model } from "@frondruntime/pinna-effect";

// Decodes, then restores in place: a held row stays the same instance, and a
// new row is the decoded one.
const hydrate = (input: unknown): void => {
  Model.restore(realm, Board)(board, input);
};
```

Encoding a model is a read: `Schema.encodeSync(Board)(board)` tracks in a
tracked place, so a computed value that encodes recomputes on a change.

```ts
import { Computed } from "@frondruntime/pinna-effect";
import { Schema } from "effect";

// Encoding reads the boxes as read does: this recomputes when a todo changes.
const $wire = Computed.make(realm, () => Schema.encodeSync(Board)(board));
```

A decode makes boxes, and a stage recipe may not, so in a stage the decode
runs outside and the recipe restores the decoded instance.

```ts
import { Model, Stage } from "@frondruntime/pinna-effect";

const refetch = (input: unknown, stage: Stage): void => {
  // A decode makes boxes, which a stage recipe may not: decode outside.
  const fresh = Model.decode(realm, Board)(input);
  Stage.update(stage, (_read, write) => {
    write.restore(board, fresh);
  });
};
```

- A plain field is never written after the model is made. Data whose plain
  field differs from the held instance's throws `pinna/restore-plain-field`.
- `Model.restore` throws `DecodeError` for input the schema refuses, and
  writes nothing. Inside a stage recipe it throws `pinna/made-in-recipe`.
- In a stage recipe, an encode reads the stage's values.

## Answers

| Call | Answers |
| --- | --- |
| `read.snapshot(shape)` | The shape as plain data: each box's value, each collection's rows in key order, each `Model.Schema` instance's data under its wire keys. |
| `write.restore(shape, data)` | Writes `data` across `shape` inside the update; returns `undefined`. |
| `Snapshot<Shape>` | The type `read.snapshot(shape)` returns. |
| `RestoreData<Shape>` | The type `write.restore` takes: a snapshot, where a `Model.Schema` instance may stand in for its data. |
| `Model.restore(realm, Schema, context?)(held, input)` | Decodes `input` and restores it into `held`, in place; returns `undefined`. |

## See also

- [Updates](https://pinna.frondruntime.dev/docs/state/updates.md): stages, and the update a restore lands with.
- [Collections](https://pinna.frondruntime.dev/docs/state/collections.md): rows by key, and `Collection.onRowChange`.
- [Classes](https://pinna.frondruntime.dev/docs/effect/classes.md): `Model.Schema`, `Model.decode`, and the wire form.
- [Saving state](saving.md): saving a computed projection of what to keep.
- [Error messages](https://pinna.frondruntime.dev/docs/reference/errors#snapshots): every message a snapshot and a restore throw.
