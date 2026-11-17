// The site's docs print the regions of this file (docs/public/effect/classes.md,
// docs/public/effect/collections.md, the cart of docs/public/start/mobx.md, and the ticker
// of docs/public/start/index.md), so `bun run typecheck` compiles what the pages show. The
// collection that checks nothing is `collections.tsx`, on pinna.
import {
  BoxField,
  box,
  CollectionField,
  computed,
  computedFunction,
  createRealm,
  decode,
  FromContext,
  RealmService,
  reconcile,
  reconcileSchema,
  SchemaModel,
  schemaBox,
  schemaCollection,
  untracked,
  update,
  watch,
} from "@frondruntime/pinna-effect";
import { Context, Effect, Schema } from "effect";

// #region class
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
// #endregion

// #region decode
// Throws the SchemaError when the input does not fit.
const todo = decode(realm, Todo)({ id: "1", title: "Write the docs", done: false });

todo.toggle();
const label = untracked(realm, (read) => read(todo.$label)); // "✓ Write the docs"
// #endregion

// #region context
interface MoneyFormat {
  readonly format: (amount: number) => string;
}

// An Effect service: the field requires it, and the caller provides it.
class Money extends Context.Service<Money, MoneyFormat>()("app/Money") {}

class Price extends SchemaModel<Price>("Price")({
  $amount: BoxField(Schema.Number),
  money: FromContext(Money), // the caller's own value, never on the wire
}) {
  readonly $label = computed(this.realm, (read) => this.money.format(read(this.$amount)));
}

const euros: MoneyFormat = { format: (amount) => `€${amount.toFixed(2)}` };
const price = decode(realm, Price, Context.make(Money, euros))({ amount: 12 });
// #endregion

// #region contextEffect
// Money is a requirement like any service: Effect<Price, SchemaError, Money | RealmService>.
const loadPrice = (json: unknown) => Schema.decodeUnknownEffect(Price)(json);

const loaded = Effect.runSync(
  loadPrice({ amount: 12 }).pipe(
    Effect.provideService(Money, euros),
    Effect.provideService(RealmService, realm),
  ),
);
// #endregion

// #region cart
class Cart extends SchemaModel<Cart>("Cart")({
  $quantity: BoxField(Schema.Int),
  $price: BoxField(Schema.Number),
}) {
  readonly $total = computed(this.realm, (read) => read(this.$quantity) * read(this.$price));

  add(): void {
    update(this.realm, (read, write) => {
      write(this.$quantity, read(this.$quantity) + 1);
    });
  }
}

const cart = decode(realm, Cart)({ quantity: 1, price: 10 });

watch(
  realm,
  (read) => read(cart.$total),
  (total) => {
    console.log(`total: ${total}`);
  },
);
// #endregion

// #region collection
class TodoList extends SchemaModel<TodoList>("TodoList")({
  $items: CollectionField(Todo, { keyOf: (todo) => todo.id }),
}) {
  readonly $open = computed(
    this.realm,
    (read) => read(this.$items.rows).filter((todo) => !read(todo.$done)).length,
    { name: "TodoList.open" },
  );

  add(todo: Todo): void {
    update(this.realm, (_read, write) => {
      write.upsert(this.$items, todo, { at: "end" });
    });
  }

  remove(id: string): void {
    update(this.realm, (_read, write) => {
      write.remove(this.$items, id);
    });
  }
}
// #endregion

// #region list
// On the wire, a collection is a plain array.
const items = [
  { id: "1", title: "Write the docs", done: false },
  { id: "2", title: "Read them", done: true },
];
const list = decode(realm, TodoList)({ items });

const open = untracked(realm, (read) => read(list.$open)); // 1
// #endregion

// #region replaceAll
// No `$` field, so it is declared as a plain Schema.Class.
class Quote extends Schema.Class<Quote>("Quote")({
  symbol: Schema.String,
  price: Schema.Number,
}) {}

class Market extends SchemaModel<Market>("Market")({
  $quotes: CollectionField(Quote, { keyOf: (quote) => quote.symbol }),
}) {
  receive(quotes: ReadonlyArray<Quote>): void {
    update(this.realm, (_read, write) => {
      // A quote equal to the one held is kept: what read its row does not rerun.
      write.replaceAll(this.$quotes, quotes);
    });
  }
}

const market = decode(realm, Market)({ quotes: [] });

const receiveQuotes = (json: unknown) => {
  market.receive(decode(realm, Schema.Array(Quote))(json));
};
// #endregion

// #region standalone
// The collection a CollectionField holds, with no model around it.
const $quotes = schemaCollection(realm, Quote, { keyOf: (quote) => quote.symbol });

const receiveQuote = (json: unknown) => {
  // decode checks the wire data; upsert checks the row again as it lands.
  const quote = decode(realm, Quote)(json);
  update(realm, (_read, write) => {
    write.upsert($quotes, quote);
  });
};
// #endregion

// #region reconcile
const Rate = Schema.Struct({ currency: Schema.String, rate: Schema.Number });
const sameRate = Schema.toEquivalence(Rate);
const $rates = schemaBox(realm, Schema.Array(Rate), []);
const rateOf = computedFunction(realm, (read, currency: string) =>
  read($rates).find((rate) => rate.currency === currency),
);

const receiveRates = (json: unknown) => {
  const next = decode(realm, Schema.Array(Rate))(json);
  update(realm, (read, write) => {
    // An unchanged rate keeps its previous object, so rateOf for it
    // returns the same value and its readers do not rerun.
    write(
      $rates,
      reconcile(read($rates), next, { keyOf: (rate) => rate.currency, equals: sameRate }),
    );
  });
};

// #endregion

// #region reconcileOne
// One model, refetched: a list of one on each side. With one item, any key
// does, such as a constant.
const refreshTodo = (held: Todo, json: unknown): Todo => {
  const fresh = decode(realm, Todo)(json);
  const [next = fresh] = reconcileSchema([held], [fresh], { keyOf: () => "todo" });
  return next; // `held`, its $done set to the refetched value, or `fresh`
};

// #endregion

// #region plain
class Ticker extends SchemaModel<Ticker>("Ticker")({
  symbol: Schema.String,
  $volume: BoxField(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))), // checked on every write
  price: Schema.Number.check(Schema.isGreaterThan(0)), // checked once, by decode
}) {
  // Starts at the decoded price; checks nothing, and is not on the wire.
  readonly $lastPrice = box(this.realm, this.price);

  tick(price: number): void {
    update(this.realm, (_read, write) => {
      write(this.$lastPrice, price);
    });
  }
}

const ticker = decode(realm, Ticker)({ symbol: "ACME", volume: 0, price: 12 });
ticker.tick(12.5);

// #endregion

export {
  cart,
  label,
  loaded,
  open,
  price,
  rateOf,
  realm,
  receiveQuote,
  receiveQuotes,
  receiveRates,
  refreshTodo,
  Todo,
  TodoList,
  ticker,
};
