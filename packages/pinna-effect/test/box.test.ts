import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Box, Computed, Model, type Read, Realm } from "../src/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * The schema box: a box that checks each write against its schema and, unless
 * given `equals`, compares by the schema's equivalence.
 */

const realm = Realm.make();

const collect = <Value>(
  select: (read: Read) => Value,
): { readonly seen: Array<Value>; stop(): void } => {
  const seen: Array<Value> = [];
  const stop = Realm.watch(realm, select, (value) => {
    seen.push(value);
  });
  return { seen, stop };
};

class Row extends Model.Schema<Row>("Row")({
  id: Schema.String,
  price: Schema.Number,
}) {}

class Rows extends Model.Schema<Rows>("Rows")({
  $items: Model.collectionField(Row, { keyOf: (row) => row.id }),
}) {}

describe("box with a schema", () => {
  for (const [name, initial, next] of [
    ["same position", [0, 1], [-0, 2]],
    ["shifted position", [1, 0, 2], [-0, 2, 3]],
    ["unshifted fallback", [1, 0, 2], [0, -0, 3]],
  ] as const) {
    test(`incremental array validation rejects negative zero at the ${name}`, () => {
      const schema = Schema.Array(
        Schema.Number.check(Schema.makeFilter((value) => !Object.is(value, -0) || "negative zero")),
      );
      const $values = Box.schema(realm, schema, initial);
      expect(() => Realm.update(realm, (_read, write) => write($values, next))).toThrow(
        "negative zero",
      );
      expect(Realm.untracked(realm, (read) => read($values))).toBe(initial);
      expect(Schema.is(schema)(Realm.untracked(realm, (read) => read($values)))).toBe(true);
      expectRealmAtRest(realm);
    });
  }

  test("a value the schema rejects throws and rolls the update back", () => {
    const $count = Box.schema(realm, Schema.Number, 1);
    const $name = Box.schema(realm, Schema.String, "a");
    const { seen, stop } = collect((read) => `${read($name)}${read($count)}`);
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write($name, "b");
        write($count, "two" as unknown as number);
      }),
    ).toThrow(
      expect.objectContaining({
        _tag: "ValueRejectedError",
        name: "ValueRejectedError",
        message: expect.stringContaining("pinna: the box rejects this value"),
      }),
    );
    expect(Realm.untracked(realm, (read) => [read($name), read($count)])).toEqual(["a", 1]);
    expect(seen).toEqual([]);
    stop();
    expectRealmAtRest(realm);
  });

  test("a box's equals decides whether a value is written back", () => {
    const $point = Box.schema(realm, Schema.Struct({ x: Schema.Number }), { x: 0 });
    const original = Realm.untracked(realm, (read) => read($point));
    let runs = 0;
    const stop = Realm.autorun(realm, (read) => {
      runs++;
      read($point);
    });
    Realm.update(realm, (_read, write) => {
      write($point, { x: 1 });
      write($point, { x: 0 });
    });
    expect({ runs, same: Realm.untracked(realm, (read) => read($point)) === original }).toEqual({
      runs: 1,
      same: true,
    });
    stop();
  });
  test("a box holds what its schema accepts, a Map included", () => {
    const Lookup = Schema.ReadonlyMap(Schema.String, Schema.Number);
    const $lookup = Box.schema(realm, Lookup, new Map([["a", 1]]));
    expect(Realm.untracked(realm, (read) => read($lookup).get("a"))).toBe(1);
  });

  test("upsert, remove, and replaceAll write a collection", () => {
    const realm = Realm.make();
    const rows = Model.decode(realm, Rows)({ items: [{ id: "a", price: 1 }] });
    const row = (id: string, price: number) => Row.make({ id, price, realm });
    Realm.update(realm, (_read, write) => write.upsert(rows.$items, row("b", 2), { at: "end" }));
    expect(Realm.untracked(realm, (read) => read(rows.$items.keys))).toEqual(["a", "b"]);
    Realm.update(realm, (_read, write) => write.remove(rows.$items, "a"));
    expect(Realm.untracked(realm, (read) => read(rows.$items.keys))).toEqual(["b"]);
    Realm.update(realm, (_read, write) => write.replaceAll(rows.$items, [row("c", 3)]));
    expect(Realm.untracked(realm, (read) => read(rows.$items.row("c"))?.price)).toBe(3);
  });

  test("checks the schema and rolls the update back", () => {
    const realm = Realm.make();
    const $count = Box.schema(realm, Schema.Int, 1);
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write($count, 2);
        return write($count, 2.5);
      }),
    ).toThrow();
    expect(Realm.untracked(realm, (read) => read($count))).toBe(1);
  });

  test("a computed function on a SchemaModel instance is per instance", () => {
    class Holding extends Model.Schema<Holding>("Holding")({
      $amount: Model.boxField(Schema.Number),
    }) {
      readonly $valueAt = Computed.fn(
        this.realm,
        (read, price: number) => read(this.$amount) * price,
      );
    }
    const realm = Realm.make();
    const decodeHolding = Model.decode(realm, Holding);
    const first = decodeHolding({ amount: 2 });
    const second = decodeHolding({ amount: 3 });
    expect(Realm.untracked(realm, (read) => read(first.$valueAt(10)))).toBe(20);
    expect(Realm.untracked(realm, (read) => read(second.$valueAt(10)))).toBe(30);
  });
});

describe("pinna's bare box", () => {
  test("refuses a schema left over from a call meant for this box", () => {
    const realm = Realm.make();
    class Item extends Schema.Class<Item>("Item")({ name: Schema.String }) {}
    const message = "Box.make takes a value, not a schema";
    expect(() => Box.make(realm, Schema.Struct({ name: Schema.String }), { name: "a" })).toThrow(
      message,
    );
    expect(() => Box.make(realm, Schema.UndefinedOr(Schema.String), undefined)).toThrow(message);
    expect(() => Box.make(realm, Item)).toThrow(message);
    expectRealmAtRest(realm);
  });
});

describe("a schema box given an outer draft", () => {
  const positive = Schema.Struct({ n: Schema.Number.check(Schema.isGreaterThan(0)) });

  test("a plain write of a live draft into a schema box throws pinna/draft-in-write and the update is undone", () => {
    const realm = Realm.make();
    const $outer = Box.make(realm, { child: { n: 1 } });
    const $checked = Box.schema(realm, positive, { n: 1 });
    let code: unknown;
    try {
      Realm.update(realm, (_read, write) => {
        write.modify($outer, (draft) => {
          draft.child.n = 2;
          write($checked, draft.child);
          draft.child.n = -1;
        });
      });
    } catch (error) {
      code = (error as { code?: unknown }).code;
    }
    expect(code).toBe("pinna/draft-in-write");
    const [outer, checked] = Realm.untracked(realm, (read) => [read($outer), read($checked)]);
    expect([outer.child.n, checked.n]).toEqual([1, 1]);
    expectRealmAtRest(realm);
    Realm.dispose(realm);
  });

  test("a live draft inside a plain container written to a schema box throws, written or not", () => {
    const realm = Realm.make();
    const $outer = Box.make(realm, { child: { n: 1 } });
    const $checked = Box.schema(realm, Schema.Struct({ x: positive }), { x: { n: 1 } });
    for (const writeFirst of [true, false]) {
      expect(() =>
        Realm.update(realm, (_read, write) => {
          write.modify($outer, (draft) => {
            if (writeFirst) {
              draft.child.n = 2;
            }
            write($checked, { x: draft.child });
          });
        }),
      ).toThrow("a checked box was given a draft of an open write.modify");
    }
    expect(Realm.untracked(realm, (read) => read($checked).x.n)).toBe(1);
    Realm.dispose(realm);
  });

  test("a schema box write outside any recipe is unaffected", () => {
    const realm = Realm.make();
    const $checked = Box.schema(realm, positive, { n: 1 });
    Realm.update(realm, (_read, write) => {
      write($checked, { n: 3 });
    });
    expect(Realm.untracked(realm, (read) => read($checked).n)).toBe(3);
    Realm.dispose(realm);
  });

  test("an outer modify's written draft assigned in an inner modify throws and the checked box keeps its value", () => {
    const realm = Realm.make();
    const $outer = Box.make(realm, { row: { n: 0 } });
    const $checked = Box.schema(
      realm,
      Schema.Struct({
        row: Schema.Struct({ n: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)) }),
      }),
      { row: { n: 0 } },
    );
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.modify($outer, (draft) => {
          draft.row.n = 1;
          write.modify($checked, (destination) => {
            destination.row = draft.row;
          });
          draft.row.n = -1;
        });
      }),
    ).toThrow("write.modify was given a draft another recipe wrote");
    const [outer, checked] = Realm.untracked(realm, (read) => [read($outer), read($checked)]);
    expect([outer.row.n, checked.row.n]).toEqual([0, 0]);
    expectRealmAtRest(realm);
    Realm.dispose(realm);
  });
});
