# Collection fields

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/effect/collections.md.

Sections: Example, Rules, Answers, See also.

The Effect pages are for applications that already use Effect: see
[Schema-checked boxes](boxes.md). A `Model.collectionField` is the core's
[collection](https://pinna.frondruntime.dev/docs/state/collections.md) as a field of a `Model.Schema`: it is
read with `row(key)`, `read.row`, `keys`, and `rows`, and written with `write.upsert`,
`write.remove`, and `write.replaceAll`, as that page shows.

## Example

A `Model.collectionField` holds rows by key, each row checked against the
row schema. On the wire it is a plain array. The rows here are the `Todo` of
[Classes](classes.md):

```ts
import { Computed, Model, Realm } from "@frondruntime/pinna-effect";
import { Schema } from "effect";

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
```

```ts
import { Computed, Model, Realm } from "@frondruntime/pinna-effect";

class TodoList extends Model.Schema<TodoList>("TodoList")({
  $items: Model.collectionField(Todo, { keyOf: (todo) => todo.id }),
}) {
  readonly $open = Computed.make(
    this.realm,
    (read) => read(this.$items.rows).filter((todo) => !read(todo.$done)).length,
    { name: "TodoList.open" },
  );

  add(todo: Todo): void {
    Realm.update(this.realm, (_read, write) => {
      write.upsert(this.$items, todo, { at: "end" });
    });
  }

  remove(id: string): void {
    Realm.update(this.realm, (_read, write) => {
      write.remove(this.$items, id);
    });
  }
}
```

```ts
import { Model, Realm } from "@frondruntime/pinna-effect";

// On the wire, a collection is a plain array.
const items = [
  { id: "1", title: "Write the docs", done: false },
  { id: "2", title: "Read them", done: true },
];
const list = Model.decode(realm, TodoList)({ items });

const open = Realm.untracked(realm, (read) => read(list.$open)); // 1
```

A refetch writes every row at once with `write.replaceAll`. A row equal under
the schema to the one held is kept, and what read it does not rerun. A
`Model.Schema` row with a `$` field is merged: the held row stays, and its
boxes take the refetched values.

```ts
import { Model, Realm } from "@frondruntime/pinna-effect";
import { Schema } from "effect";

// No `$` field, so it is declared as a plain Schema.Class.
class Quote extends Schema.Class<Quote>("Quote")({
  symbol: Schema.String,
  price: Schema.Number,
}) {}

class Market extends Model.Schema<Market>("Market")({
  $quotes: Model.collectionField(Quote, { keyOf: (quote) => quote.symbol }),
}) {
  receive(quotes: ReadonlyArray<Quote>): void {
    Realm.update(this.realm, (_read, write) => {
      // A quote equal to the one held is kept: what read its row does not rerun.
      write.replaceAll(this.$quotes, quotes);
    });
  }
}

const market = Model.decode(realm, Market)({ quotes: [] });

const receiveQuotes = (json: unknown) => {
  market.receive(Model.decode(realm, Schema.Array(Quote))(json));
};
```

`Collection.reconcile` given `equals`, here the item schema's equivalence,
keeps the previous object of every item of a `Box.schema` of a plain array
that did not change. It takes no schema: given no `equals`, it works the
comparison out from each pair of items, as
[Equality and hashing](equality.md) lists. A plain `Schema.Struct` row
compares with Effect's `Equal.equals`, which never sees a schema, so a
`toEquivalence` annotation on a Struct is not used there.

```ts
import { Box, Collection, Computed, Model, Realm } from "@frondruntime/pinna-effect";
import { Schema } from "effect";

const Rate = Schema.Struct({ currency: Schema.String, rate: Schema.Number });
const sameRate = Schema.toEquivalence(Rate);
const $rates = Box.schema(realm, Schema.Array(Rate), []);
const rateOf = Computed.fn(realm, (read, currency: string) =>
  read($rates).find((rate) => rate.currency === currency),
);

const receiveRates = (json: unknown) => {
  const next = Model.decode(realm, Schema.Array(Rate))(json);
  Realm.update(realm, (read, write) => {
    // An unchanged rate keeps its previous object, so rateOf for it
    // returns the same value and its readers do not rerun.
    write(
      $rates,
      Collection.reconcile(read($rates), next, {
        keyOf: (rate) => rate.currency,
        equals: sameRate,
      }),
    );
  });
};
```

`Collection.reconcile` takes arrays only. One refetched model is a list of one on
each side, under any key, such as a constant: the result is the held
instance, its boxes set to the refetched values, or the refetched instance
when a plain field differs.

```ts
import { Collection, Model } from "@frondruntime/pinna-effect";

// One model, refetched: a list of one on each side. With one item, any key
// does, such as a constant.
const refreshTodo = (held: Todo, json: unknown): Todo => {
  const fresh = Model.decode(realm, Todo)(json);
  const [next = fresh] = Collection.reconcile([held], [fresh], { keyOf: () => "todo" });
  return next; // `held`, its $done set to the refetched value, or `fresh`
};
```

`Collection.schema` is the collection a `Model.collectionField` holds, with no model
around it: for rows a service or a feed owns, such as the trades a feed
writes. It starts empty and checks and compares rows as the field does.

```ts
import { Collection, Model, Realm } from "@frondruntime/pinna-effect";

// The collection a Model.collectionField holds, with no model around it.
const $quotes = Collection.schema(realm, Quote, { keyOf: (quote) => quote.symbol });

const receiveQuote = (json: unknown) => {
  // decode checks the wire data; upsert checks the row again as it lands.
  const quote = Model.decode(realm, Quote)(json);
  Realm.update(realm, (_read, write) => {
    write.upsert($quotes, quote);
  });
};
```

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
  merge is on [Equality and hashing](equality.md).

## Answers

| Call | Answers |
| --- | --- |
| `Model.collectionField(schema, { keyOf, name? })` | A field of rows by key, each checked against `schema`, a plain array on the wire. `name` names every instance's collection, as `Collection.make`'s does. |
| `Collection.schema(realm, schema, { keyOf, equals?, name? })` | An empty collection of rows `schema` accepts, the one a `Model.collectionField` holds. A row is compared with `equals`, the schema's equivalence by default, and a `Model.Schema` row is merged into the held one. |
| `Collection.reconcile(previous, next, { keyOf, equals? })` | As `pinna`'s `Collection.reconcile` on [Updates](https://pinna.frondruntime.dev/docs/state/updates.md), with `equals` optional and a `Model.Schema` item merged into the held one. |

## See also

- [Collections](https://pinna.frondruntime.dev/docs/state/collections.md): reading and writing a collection, and rendering one row per key.
- [Classes](classes.md): the model a collection field lives on.
- [Updates](https://pinna.frondruntime.dev/docs/state/updates.md): the update every write runs in.
- [Hooks](https://pinna.frondruntime.dev/docs/react/hooks.md): a row component that rerenders alone.
- [Equality and hashing](equality.md): a row class's own `Equal`, and what each schema counts as equal.
- [Live data](https://pinna.frondruntime.dev/docs/guides/live-data.md): a refetch and a feed written into a collection field.
