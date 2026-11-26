import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { Box, Collection, Model, Realm, View } from "../src/index.ts";

/** The scoped views dispose with their scope (ruling 63). */

interface Row {
  readonly id: string;
  readonly group: string;
  readonly amount: number;
}

describe("scoped views", () => {
  test("each scoped view is kept while the scope is open and disposed when it closes", () => {
    const realm = Realm.make();
    const $rows = Collection.make<string, Row>(realm, { keyOf: (row) => row.id });
    Realm.update(realm, (_read, write) => {
      write.replaceAll($rows, [
        { id: "a", group: "x", amount: 2 },
        { id: "b", group: "x", amount: 1 },
      ]);
    });
    const views = Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          const ordered = yield* View.orderedScoped($rows, {
            compare: () => (left, right) => left.amount - right.amount,
          });
          const grouped = yield* View.groupedScoped($rows, { groupOf: (row) => row.group });
          const totals = yield* View.totalsScoped($rows, {
            project: (row) => ({ group: row.group, value: row.amount }),
            arithmetic: { zero: 0, add: (a, b) => a + b, subtract: (a, b) => a - b },
          });
          expect(Realm.untracked(realm, (read) => read(ordered.keys))).toEqual(["b", "a"]);
          expect(Realm.untracked(realm, (read) => read(grouped.group("x")))).toEqual(["a", "b"]);
          expect(Realm.untracked(realm, (read) => read(totals.group("x")))).toEqual({
            count: 2,
            total: 3,
          });
          expect([View.status(ordered), View.status(grouped), View.status(totals)]).toEqual([
            "open",
            "open",
            "open",
          ]);
          return [ordered, grouped, totals] as const;
        }),
      ),
    );
    expect(views.map((view) => View.status(view))).toEqual(["disposed", "disposed", "disposed"]);
    Realm.dispose(realm);
  });
});

class Item extends Model.Schema<Item>("ViewItem")({
  id: Schema.String,
  price: Schema.Number,
}) {}

class Items extends Model.Schema<Items>("ViewItems")({
  $items: Model.collectionField(Item, { keyOf: (item) => item.id }),
}) {}

describe("a view over a schema collection", () => {
  test("follows checked rows, leaves a rejected row out, and tracks a schema box in its config", () => {
    const realm = Realm.make();
    const store = Items.make({ realm, items: [] });
    const $limit = Box.schema(realm, Schema.Number, 10);
    const view = View.ordered(store.$items, {
      compare: () => (left, right) => left.price - right.price,
      filter: (read) => {
        const limit = read($limit);
        return (item) => item.price < limit;
      },
    });
    Realm.update(realm, (_read, write) => {
      write.replaceAll(store.$items, [
        Item.make({ id: "a", price: 5, realm }),
        Item.make({ id: "b", price: 20, realm }),
        Item.make({ id: "c", price: 1, realm }),
      ]);
    });
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual(["c", "a"]);
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.upsert(store.$items, { id: "d", price: "free" } as unknown as Item);
      }),
    ).toThrow();
    expect(Realm.untracked(realm, (read) => read(view.totalSize))).toBe(3);
    Realm.update(realm, (_read, write) => write($limit, 50));
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual(["c", "a", "b"]);
    View.dispose(view);
    Realm.dispose(realm);
  });
});
