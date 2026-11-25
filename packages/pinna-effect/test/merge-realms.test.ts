import { describe, expect, test } from "bun:test";
import { record, testRealm } from "@frondruntime/pinna/testing";
import { Equal, Schema } from "effect";
import { Collection, Model, Realm } from "../src/index.ts";

class Quote extends Model.Schema<Quote>("Quote")({
  pair: Schema.String,
  $bid: Model.boxField(Schema.Number),
}) {
  [Equal.symbol](that: unknown): boolean {
    return that instanceof Quote && this.pair === that.pair;
  }
}

class Quotes extends Model.Schema<Quotes>("Quotes")({
  $items: Model.collectionField(Quote, { keyOf: (quote) => quote.pair }),
}) {}

describe("models whose own Equal agrees across realms", () => {
  for (const wasRead of [false, true]) {
    for (const operation of ["upsert", "replaceAll"] as const) {
      test(`${operation} replaces a foreign model ${wasRead ? "on a row that was read" : "on a row never read"}`, () => {
        using realm = testRealm();
        using other = testRealm();
        const held = Quote.make({ pair: "BTC", bid: 1, realm });
        const fresh = Quote.make({ pair: "BTC", bid: 2, realm: other });
        const rows = Collection.schema(realm, Quote, { keyOf: (quote) => quote.pair });
        Realm.update(realm, (_read, write) => {
          write.upsert(rows, held);
        });
        if (wasRead) {
          Realm.untracked(realm, (read) => read(rows.row("BTC")));
        }
        using changes = record(realm, (read) => read(rows.rows));

        Realm.update(realm, (_read, write) => {
          if (operation === "upsert") {
            write.upsert(rows, fresh);
          } else {
            write.replaceAll(rows, [fresh]);
          }
        });

        expect(Realm.untracked(realm, (read) => read.row(rows, "BTC"))).toBe(fresh);
        expect(changes.values).toHaveLength(1);
        expect(changes.values[0]?.[0]).toBe(fresh);
        expect(Realm.untracked(realm, (read) => read(held.$bid))).toBe(1);
        expect(Realm.untracked(other, (read) => read(fresh.$bid))).toBe(2);
      });
    }
  }

  test("a parent merge replaces a foreign model in its CollectionField", () => {
    using realm = testRealm();
    using other = testRealm();
    const held = Quote.make({ pair: "BTC", bid: 1, realm });
    const fresh = Quote.make({ pair: "BTC", bid: 2, realm: other });
    const previous = Quotes.make({ items: [held], realm });
    const next = Quotes.make({ items: [fresh], realm });
    using changes = record(realm, (read) => read(previous.$items.rows));

    const reconciled = Collection.reconcile([previous], [next], { keyOf: () => "quotes" });

    expect(reconciled[0]).toBe(previous);
    expect(Realm.untracked(realm, (read) => read.row(previous.$items, "BTC"))).toBe(fresh);
    expect(changes.values).toHaveLength(1);
    expect(changes.values[0]?.[0]).toBe(fresh);
    expect(Realm.untracked(realm, (read) => read(held.$bid))).toBe(1);
    expect(Realm.untracked(other, (read) => read(fresh.$bid))).toBe(2);
  });
});
