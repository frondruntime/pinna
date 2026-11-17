import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  makeAutoObservable,
  autorun as mobxAutorun,
  type ObservableMap,
  observable,
  observableRef,
  reaction,
  runInAction,
} from "mobx";
import {
  autorun,
  type Box,
  CollectionField,
  createRealm,
  decode,
  type Realm,
  SchemaModel,
  schemaBox,
  update,
} from "../../../src/index.ts";

/**
 * An application's `observable` and `ObservableMap` uses, each beside its Pinna
 * rewrite. A case runs both and expects the same trace.
 */

const Position = Schema.Struct({ id: Schema.String, size: Schema.Number });
type Position = typeof Position.Type;

const a1: Position = { id: "a", size: 1 };
const b1: Position = { id: "b", size: 1 };

/** A position book: a list held by reference, replaced on each change. */
class MobxBook {
  items: ReadonlyArray<Position>;

  constructor(items: ReadonlyArray<Position>) {
    this.items = items;
    // On MobX 6 this is `observable.ref`; MobX 7 names it `observableRef`.
    makeAutoObservable(this, { items: observableRef });
  }

  upsert(position: Position): void {
    this.items = this.items.some((item) => item.id === position.id)
      ? this.items.map((item) => (item.id === position.id ? position : item))
      : [position, ...this.items];
  }

  remove(id: string): void {
    this.items = this.items.filter((item) => item.id !== id);
  }
}

/** The rewrite: a plain class holding a box of the list. */
class PinnaBook {
  readonly $items: Box<ReadonlyArray<Position>>;

  constructor(
    readonly realm: Realm,
    items: ReadonlyArray<Position>,
  ) {
    this.$items = schemaBox(realm, Schema.Array(Position), items);
  }

  upsert(position: Position): void {
    update(this.realm, (read, write) => {
      const items = read(this.$items);
      write(
        this.$items,
        items.some((item) => item.id === position.id)
          ? items.map((item) => (item.id === position.id ? position : item))
          : [position, ...items],
      );
    });
  }

  remove(id: string): void {
    update(this.realm, (read, write) => {
      write(
        this.$items,
        read(this.$items).filter((item) => item.id !== id),
      );
    });
  }
}

const bookSteps = (book: {
  upsert: (position: Position) => void;
  remove: (id: string) => void;
}) => {
  book.upsert({ id: "a", size: 2 });
  book.upsert({ id: "c", size: 1 });
  book.remove("b");
};

const bookTrace = ["a:1 b:1", "a:2 b:1", "c:1 a:2 b:1", "c:1 a:2"];

const show = (items: ReadonlyArray<Position>): string =>
  items.map((item) => `${item.id}:${item.size}`).join(" ");

describe("observable.ref on a model field", () => {
  test("MobX: each change replaces the list and reruns its reader", () => {
    const book = new MobxBook([a1, b1]);
    const seen: Array<string> = [];
    const stop = mobxAutorun(() => {
      seen.push(show(book.items));
    });
    bookSteps(book);
    stop();
    expect(seen).toEqual(bookTrace);
  });

  test("Pinna: a box of the list, written inside update", () => {
    const realm = createRealm();
    const book = new PinnaBook(realm, [a1, b1]);
    const seen: Array<string> = [];
    const stop = autorun(realm, (read) => {
      seen.push(show(read(book.$items)));
    });
    bookSteps(book);
    stop();
    expect(seen).toEqual(bookTrace);
  });
});

/** The playground's rates: a map whose readers read one key each. */
const ratesTrace = {
  euro: [1.1, 1.2],
  pound: [1.3, undefined],
  keys: [
    ["EUR/USD", "GBP/USD"],
    ["EUR/USD", "GBP/USD", "USD/JPY"],
    ["EUR/USD", "USD/JPY"],
  ],
};

class Rate extends SchemaModel<Rate>("Rate")({
  pair: Schema.String,
  rate: Schema.Number,
}) {}

class Rates extends SchemaModel<Rates>("Rates")({
  $items: CollectionField(Rate, { keyOf: (rate) => rate.pair }),
}) {}

describe("ObservableMap", () => {
  test("MobX: a write to one key reruns only that key's reader", () => {
    const rates: ObservableMap<string, number> = observable.map([
      ["EUR/USD", 1.1],
      ["GBP/USD", 1.3],
    ]);
    const seen = {
      euro: [] as Array<unknown>,
      pound: [] as Array<unknown>,
      keys: [] as Array<unknown>,
    };
    const stops = [
      mobxAutorun(() => {
        seen.euro.push(rates.get("EUR/USD"));
      }),
      mobxAutorun(() => {
        seen.pound.push(rates.get("GBP/USD"));
      }),
      reaction(
        () => [...rates.keys()].sort(),
        (keys) => {
          seen.keys.push(keys);
        },
        { fireImmediately: true },
      ),
    ];
    runInAction(() => {
      rates.set("EUR/USD", 1.2);
    });
    runInAction(() => {
      rates.set("USD/JPY", 150);
    });
    runInAction(() => {
      rates.delete("GBP/USD");
    });
    for (const stop of stops) {
      stop();
    }
    expect(seen).toEqual(ratesTrace);
  });

  test("Pinna: a CollectionField, tracked key by key", () => {
    const realm = createRealm();
    const rates = decode(
      realm,
      Rates,
    )({
      items: [
        { pair: "EUR/USD", rate: 1.1 },
        { pair: "GBP/USD", rate: 1.3 },
      ],
    });
    const seen = {
      euro: [] as Array<unknown>,
      pound: [] as Array<unknown>,
      keys: [] as Array<unknown>,
    };
    const stops = [
      autorun(realm, (read) => {
        seen.euro.push(read(rates.$items.row("EUR/USD"))?.rate);
      }),
      autorun(realm, (read) => {
        seen.pound.push(read(rates.$items.row("GBP/USD"))?.rate);
      }),
      // A new key goes first in a collection and last in a map; sorted, the
      // two agree.
      autorun(realm, (read) => {
        seen.keys.push([...read(rates.$items.keys)].sort());
      }),
    ];
    update(realm, (_read, write) => {
      write.upsert(rates.$items, Rate.make({ pair: "EUR/USD", rate: 1.2, realm }));
    });
    update(realm, (_read, write) => {
      write.upsert(rates.$items, Rate.make({ pair: "USD/JPY", rate: 150, realm }));
    });
    update(realm, (_read, write) => {
      write.remove(rates.$items, "GBP/USD");
    });
    for (const stop of stops) {
      stop();
    }
    expect(seen).toEqual(ratesTrace);
  });
});
