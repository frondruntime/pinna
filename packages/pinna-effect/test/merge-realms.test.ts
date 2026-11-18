import { describe, expect, test } from "bun:test";
import { record, testRealm } from "@frondruntime/pinna/testing";
import { Equal, Schema } from "effect";
import {
  BoxField,
  CollectionField,
  reconcileSchema,
  SchemaModel,
  schemaCollection,
  untracked,
  update,
} from "../src/index.ts";

class Quote extends SchemaModel<Quote>("Quote")({
  pair: Schema.String,
  $bid: BoxField(Schema.Number),
}) {
  [Equal.symbol](that: unknown): boolean {
    return that instanceof Quote && this.pair === that.pair;
  }
}

class Quotes extends SchemaModel<Quotes>("Quotes")({
  $items: CollectionField(Quote, { keyOf: (quote) => quote.pair }),
}) {}

describe("models whose own Equal agrees across realms", () => {
  for (const materialized of [false, true]) {
    for (const operation of ["upsert", "replaceAll"] as const) {
      test(`${operation} replaces a foreign model with a cell ${materialized}`, () => {
        using realm = testRealm();
        using other = testRealm();
        const held = Quote.make({ pair: "BTC", bid: 1, realm });
        const fresh = Quote.make({ pair: "BTC", bid: 2, realm: other });
        const rows = schemaCollection(realm, Quote, { keyOf: (quote) => quote.pair });
        update(realm, (_read, write) => {
          write.upsert(rows, held);
        });
        if (materialized) {
          untracked(realm, (read) => read(rows.row("BTC")));
        }
        using changes = record(realm, (read) => read(rows.rows));

        update(realm, (_read, write) => {
          if (operation === "upsert") {
            write.upsert(rows, fresh);
          } else {
            write.replaceAll(rows, [fresh]);
          }
        });

        expect(untracked(realm, (read) => read.row(rows, "BTC"))).toBe(fresh);
        expect(changes.values).toHaveLength(1);
        expect(changes.values[0]?.[0]).toBe(fresh);
        expect(untracked(realm, (read) => read(held.$bid))).toBe(1);
        expect(untracked(other, (read) => read(fresh.$bid))).toBe(2);
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

    const reconciled = reconcileSchema([previous], [next], { keyOf: () => "quotes" });

    expect(reconciled[0]).toBe(previous);
    expect(untracked(realm, (read) => read.row(previous.$items, "BTC"))).toBe(fresh);
    expect(changes.values).toHaveLength(1);
    expect(changes.values[0]?.[0]).toBe(fresh);
    expect(untracked(realm, (read) => read(held.$bid))).toBe(1);
    expect(untracked(other, (read) => read(fresh.$bid))).toBe(2);
  });
});
