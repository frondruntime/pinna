import { expect, test } from "bun:test";
import { Schema } from "effect";
import { Box, Collection, Computed, Model, Realm, Source } from "../../src/index.ts";

test("a symbol-keyed snapshot includes the box, tracks it, and restores it", () => {
  const realm = Realm.make();
  const key = Symbol("quantity");
  const quantity = Box.make(realm, 1);
  const shape = { [key]: quantity };
  const snapshot = Computed.make(realm, (read) => read.snapshot(shape));
  const seen: Array<number> = [];
  const stop = Realm.autorun(realm, (read) => {
    seen.push(read(snapshot)[key]);
  });
  try {
    Realm.update(realm, (_read, write) => {
      write(quantity, 2);
    });
    Realm.update(realm, (_read, write) => {
      write.restore(shape, { [key]: 3 });
    });
    expect([seen, Source.peek(quantity)]).toEqual([[1, 2, 3], 3]);
  } finally {
    stop();
  }
});

test("a snapshot round-trips an array with an empty slot", () => {
  const realm = Realm.make();
  const quantity = Box.make(realm, 1);
  const shape = Array<typeof quantity>(2);
  shape[1] = quantity;
  const saved = Realm.untracked(realm, (read) => read.snapshot(shape));
  Realm.update(realm, (_read, write) => {
    write(quantity, 2);
  });
  Realm.update(realm, (_read, write) => {
    write.restore(shape, saved);
  });
  expect(Source.peek(quantity)).toBe(1);
});

test("a saved model row cannot silently turn into plain data when its collection empties", () => {
  class Item extends Model.Schema<Item>("Item")({
    id: Schema.Number,
    $count: Model.boxField(Schema.Number),
  }) {}
  const realm = Realm.make();
  const rows = Collection.make(realm, { keyOf: (row: Item) => row.id });
  Realm.update(realm, (_read, write) => {
    write.upsert(rows, Item.make({ realm, id: 1, count: 8 }));
  });
  const saved = Realm.untracked(realm, (read) => read.snapshot(rows));
  Realm.update(realm, (_read, write) => {
    write.remove(rows, 1);
  });
  let rejected = false;
  try {
    Realm.update(realm, (_read, write) => {
      write.restore(rows, saved);
    });
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("adds a model row from plain data");
  }
  const row = Realm.untracked(realm, (read) => read.row(rows, 1));
  expect([rejected, row === undefined, row instanceof Item]).toEqual([true, true, false]);
});

test("a nested modify cannot change a checked box after its value passed validation", () => {
  const realm = Realm.make();
  const outer = Box.make(realm, { row: { n: 0 } });
  const checked = Box.schema(
    realm,
    Schema.Struct({
      row: Schema.Struct({ n: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)) }),
    }),
    { row: { n: 0 } },
  );
  let code: unknown;
  try {
    Realm.update(realm, (_read, write) => {
      write.modify(outer, (draft) => {
        draft.row.n = 1;
        write.modify(checked, (destination) => {
          destination.row = draft.row;
        });
        draft.row.n = -1;
      });
    });
  } catch (error) {
    code = (error as { code?: unknown }).code;
  }
  // D4-1 (slice 0): a written draft of another recipe throws rather than copies.
  expect(code).toBe("pinna/draft-of-another-recipe");
  expect(Source.peek(checked).row.n).toBe(0);
});

test("an observed computed function entry stays available after an older entry releases", () => {
  const realm = Realm.make();
  const lookup = Computed.fn(realm, (_read, key: string) => key);
  const first = lookup("row");
  const second = lookup("row");
  const stopFirst = Source.observe(first);
  const stopSecond = Source.observe(second);
  try {
    stopFirst();
    expect(lookup("row") === second).toBe(true);
  } finally {
    stopSecond();
  }
});
