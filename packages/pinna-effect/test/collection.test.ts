import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  BoxField,
  CollectionField,
  createRealm,
  decode,
  observe,
  type Read,
  type Realm,
  SchemaModel,
  schemaCollection,
  untracked,
  update,
  type Write,
  watch,
} from "../src/index.ts";
import { keptWrite } from "./kept.ts";
import { expectRealmAtRest } from "./rest.ts";

class Row extends SchemaModel<Row>("Row")({
  id: Schema.String,
  price: Schema.Number,
}) {}

class Rows extends SchemaModel<Rows>("Rows")({
  $items: CollectionField(Row, { keyOf: (row) => row.id }),
}) {}

const rowsJson = (...rows: ReadonlyArray<readonly [string, number]>) => ({
  items: rows.map(([id, price]) => ({ id, price })),
});

const row = (realm: Realm, id: string, price: number): Row => Row.make({ id, price, realm });

/** Every value each watch's effect saw, by name. */
const watchAll = <Name extends string>(
  realm: Realm,
  selects: Record<Name, (read: Read) => unknown>,
) => {
  const seen = {} as Record<Name, Array<unknown>>;
  const stops = (Object.keys(selects) as Array<Name>).map((name) => {
    const values: Array<unknown> = [];
    seen[name] = values;
    return watch(realm, selects[name], (value) => {
      values.push(value);
    });
  });
  return {
    seen,
    stop: () => {
      for (const stop of stops) {
        stop();
      }
    },
  };
};

const keysOf = (realm: Realm, rows: Rows) => untracked(realm, (read) => read(rows.$items.keys));
const priceOf = (realm: Realm, rows: Rows, id: string) =>
  untracked(realm, (read) => read(rows.$items.row(id))?.price);

describe("CollectionField", () => {
  test("decodes from a plain array under the wire key and encodes back to it", () => {
    const realm = createRealm();
    const json = rowsJson(["a", 1], ["b", 2]);
    const rows = decode(realm, Rows)(json);

    expect(keysOf(realm, rows)).toEqual(["a", "b"]);
    expect(priceOf(realm, rows, "b")).toBe(2);
    expect(Schema.encodeSync(Rows)(rows)).toEqual(json);
  });

  test("a write to one key notifies that key's readers only", () => {
    const realm = createRealm();
    const rows = decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));
    const { seen, stop } = watchAll(realm, {
      a: (read) => read(rows.$items.row("a"))?.price,
      b: (read) => read(rows.$items.row("b"))?.price,
      keys: (read) => read(rows.$items.keys),
    });

    update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "a", 10));
    });

    expect(seen).toEqual({ a: [10], b: [], keys: [] });
    stop();
  });

  test("writing another realm's collection throws, and the rows stay", () => {
    const realm = createRealm();
    const other = createRealm();
    const rows = decode(other, Rows)(rowsJson(["a", 1]));
    expect(() =>
      update(realm, (_read, write) => {
        write.upsert(rows.$items, row(realm, "a", 10));
      }),
    ).toThrow("write.upsert($observable) is handed an observable of another realm");
    expect(() =>
      update(realm, (_read, write) => {
        write.remove(rows.$items, "a");
      }),
    ).toThrow("write.remove");
    expect(() =>
      update(realm, (_read, write) => {
        write.replaceAll(rows.$items, []);
      }),
    ).toThrow("write.replaceAll");
    expect(priceOf(other, rows, "a")).toBe(1);
  });

  test("adding, removing, and reordering notify the key readers only", () => {
    const realm = createRealm();
    const rows = decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));
    const { seen, stop } = watchAll(realm, {
      a: (read) => read(rows.$items.row("a")),
      b: (read) => read(rows.$items.row("b")),
      keys: (read) => read(rows.$items.keys),
    });

    update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "c", 3));
    });
    update(realm, (_read, write) => {
      write.replaceAll(rows.$items, [row(realm, "b", 2), row(realm, "c", 3), row(realm, "a", 1)]);
    });

    expect(seen.keys).toEqual([
      ["c", "a", "b"],
      ["b", "c", "a"],
    ]);
    expect(seen.a).toEqual([]);
    expect(seen.b).toEqual([]);
    stop();
  });

  test("a new key goes first", () => {
    const realm = createRealm();
    const rows = decode(realm, Rows)(rowsJson(["a", 1]));

    update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "b", 2));
    });

    expect(keysOf(realm, rows)).toEqual(["b", "a"]);
  });

  test("upsert with at end puts a new key last, and leaves an existing key in place", () => {
    const realm = createRealm();
    const rows = decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));

    update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "c", 3), { at: "end" });
      write.upsert(rows.$items, row(realm, "a", 5), { at: "end" });
      write.upsert(rows.$items, row(realm, "d", 4), { at: "start" });
    });

    expect(keysOf(realm, rows)).toEqual(["d", "a", "b", "c"]);
    expect(priceOf(realm, rows, "a")).toBe(5);
  });

  test("rows reads every row in key order and follows each one", () => {
    const realm = createRealm();
    const rows = decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));
    const { seen, stop } = watchAll(realm, {
      prices: (read) => read(rows.$items.rows).map((each) => each.price),
    });

    update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "b", 3));
    });
    update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "c", 4));
    });
    update(realm, (_read, write) => {
      write.remove(rows.$items, "a");
    });
    update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "b", 3));
    });
    stop();

    expect(seen.prices).toEqual([
      [1, 3],
      [4, 1, 3],
      [4, 3],
    ]);
    expect(rows.$items.rows).toBe(rows.$items.rows);
  });

  test("rows keeps its array until a row or the order changes", () => {
    const realm = createRealm();
    const rows = decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));
    const { seen, stop } = watchAll(realm, { rows: (read) => read(rows.$items.rows) });
    const first = untracked(realm, (read) => read(rows.$items.row("a"))) as Row;

    update(realm, (_read, write) => {
      write.replaceAll(rows.$items, [row(realm, "a", 1), row(realm, "b", 2)]);
    });
    // The row comes back under a new cell; the array it makes holds the same rows.
    update(realm, (_read, write) => {
      write.remove(rows.$items, "a");
      write.upsert(rows.$items, first);
    });
    stop();

    expect(seen.rows).toEqual([]);
  });

  test("a reader of a missing key sees it when it is added, and again when it is removed", () => {
    const realm = createRealm();
    const rows = decode(realm, Rows)(rowsJson(["a", 1]));
    const { seen, stop } = watchAll(realm, {
      x: (read) => read(rows.$items.row("x"))?.price,
      a: (read) => read(rows.$items.row("a"))?.price,
    });

    update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "x", 7));
    });
    update(realm, (_read, write) => {
      write.remove(rows.$items, "x");
    });
    update(realm, (_read, write) => {
      write.remove(rows.$items, "a");
    });

    expect(seen).toEqual({ x: [7, undefined], a: [undefined] });
    expect(priceOf(realm, rows, "x")).toBeUndefined();
    stop();
  });

  test("removing a missing key changes nothing", () => {
    const realm = createRealm();
    const rows = decode(realm, Rows)(rowsJson(["a", 1]));
    const { seen, stop } = watchAll(realm, { keys: (read) => read(rows.$items.keys) });

    update(realm, (_read, write) => {
      write.remove(rows.$items, "missing");
    });

    expect(seen.keys).toEqual([]);
    stop();
  });

  test("row returns the same computed value while it is observed", () => {
    const realm = createRealm();
    const rows = decode(realm, Rows)(rowsJson(["a", 1]));
    const stop = watch(
      realm,
      (read) => read(rows.$items.row("a")),
      () => {},
    );

    expect(rows.$items.row("a")).toBe(rows.$items.row("a"));
    stop();
  });

  test("replaceAll keeps unchanged rows and notifies nobody when nothing changed", () => {
    const realm = createRealm();
    const rows = decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));
    const before = untracked(realm, (read) => read(rows.$items.row("a")));
    const { seen, stop } = watchAll(realm, {
      a: (read) => read(rows.$items.row("a")),
      b: (read) => read(rows.$items.row("b")),
      keys: (read) => read(rows.$items.keys),
    });

    update(realm, (_read, write) => {
      write.replaceAll(
        rows.$items,
        decode(realm, Schema.Array(Row))(rowsJson(["a", 1], ["b", 2]).items),
      );
    });

    expect(seen).toEqual({ a: [], b: [], keys: [] });
    expect(untracked(realm, (read) => read(rows.$items.row("a")))).toBe(before as never);
    stop();
  });

  test("replaceAll writes changed rows, adds new keys, and drops missing ones", () => {
    const realm = createRealm();
    const rows = decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));
    const { seen, stop } = watchAll(realm, {
      a: (read) => read(rows.$items.row("a"))?.price,
      b: (read) => read(rows.$items.row("b"))?.price,
      c: (read) => read(rows.$items.row("c"))?.price,
    });

    update(realm, (_read, write) => {
      write.replaceAll(rows.$items, [row(realm, "a", 1), row(realm, "c", 3)]);
    });

    expect(seen).toEqual({ a: [], b: [undefined], c: [3] });
    expect(keysOf(realm, rows)).toEqual(["a", "c"]);
    stop();
  });
});

describe("CollectionField writes", () => {
  test("a write kept past its update throws", () => {
    const realm = createRealm();
    const rows = decode(realm, Rows)(rowsJson(["a", 1]));
    const write = keptWrite(realm);

    expect(() => write.upsert(rows.$items, row(realm, "b", 2))).toThrow("inside update");
    expect(() => write.remove(rows.$items, "a")).toThrow("inside update");
    expect(() => write.replaceAll(rows.$items, [])).toThrow("inside update");
    expectRealmAtRest(realm);
  });

  test("a value the schema rejects is not written", () => {
    const realm = createRealm();
    const rows = decode(realm, Rows)(rowsJson(["a", 1]));

    expect(() =>
      update(realm, (_read, write) => {
        write.upsert(rows.$items, { id: "a", price: "ten" } as never);
      }),
    ).toThrow("rejects this value");
    expect(() =>
      update(realm, (_read, write) => {
        write.upsert(rows.$items, { id: "b", price: "ten" } as never);
      }),
    ).toThrow("rejects this value");
    expect(keysOf(realm, rows)).toEqual(["a"]);
    expect(priceOf(realm, rows, "a")).toBe(1);
    expectRealmAtRest(realm);
  });

  test("a replaceAll the schema rejects, caught inside an update, writes nothing", () => {
    const realm = createRealm();
    const json = rowsJson(["a", 1], ["c", 3]);
    const rows = decode(realm, Rows)(json);
    const { seen, stop } = watchAll(realm, {
      a: (read) => read(rows.$items.row("a"))?.price,
      c: (read) => read(rows.$items.row("c"))?.price,
      keys: (read) => read(rows.$items.keys),
    });

    // A new key rejected after "c" is dropped and "a" written; then an existing key rejected.
    for (const values of [
      [row(realm, "a", 2), { id: "b", price: "ten" }],
      [row(realm, "c", 4), { id: "a", price: "ten" }],
    ]) {
      update(realm, (_read, write) => {
        expect(() => write.replaceAll(rows.$items, values as never)).toThrow("rejects this value");
      });
      expect(keysOf(realm, rows)).toEqual(["a", "c"]);
      expect(
        untracked(realm, (read) => read(rows.$items.rows).map((value) => value.price)),
      ).toEqual([1, 3]);
      expect(Schema.encodeSync(Rows)(rows)).toEqual(json);
    }
    expect(seen).toEqual({ a: [], c: [], keys: [] });
    stop();
    expectRealmAtRest(realm);
  });

  test("replaceAll writes wherever upsert and remove do, as in a tracked run inside an update", () => {
    const realm = createRealm();
    const rows = decode(realm, Rows)(rowsJson(["a", 1]));
    const writes: Array<(write: Write) => void> = [
      (write) => write.upsert(rows.$items, row(realm, "b", 2)),
      (write) => write.remove(rows.$items, "b"),
      (write) => write.replaceAll(rows.$items, [row(realm, "a", 3)]),
    ];
    for (const each of writes) {
      update(realm, (_read, write) => {
        const stop = watch(
          realm,
          () => each(write),
          () => {},
        );
        stop();
      });
    }
    expect(keysOf(realm, rows)).toEqual(["a"]);
    expect(priceOf(realm, rows, "a")).toBe(3);
    expectRealmAtRest(realm);
  });

  test("a failed update puts back the keys, every row, and every removed or added key", () => {
    const realm = createRealm();
    const rows = decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));
    const { seen, stop } = watchAll(realm, {
      a: (read) => read(rows.$items.row("a"))?.price,
      b: (read) => read(rows.$items.row("b"))?.price,
      c: (read) => read(rows.$items.row("c"))?.price,
      keys: (read) => read(rows.$items.keys),
    });

    expect(() =>
      update(realm, (_read, write) => {
        write.upsert(rows.$items, row(realm, "a", 10));
        write.remove(rows.$items, "b");
        write.upsert(rows.$items, row(realm, "c", 3));
        throw new Error("the recipe fails");
      }),
    ).toThrow("the recipe fails");

    expect(seen).toEqual({ a: [], b: [], c: [], keys: [] });
    expect(keysOf(realm, rows)).toEqual(["a", "b"]);
    expect(priceOf(realm, rows, "a")).toBe(1);
    expect(priceOf(realm, rows, "b")).toBe(2);
    expect(priceOf(realm, rows, "c")).toBeUndefined();

    update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "c", 4));
      write.remove(rows.$items, "b");
    });
    expect(seen).toEqual({ a: [], b: [undefined], c: [4], keys: [["c", "a"]] });
    stop();
    expectRealmAtRest(realm);
  });

  test("a key a failed update added and read leaves its readers following the key", () => {
    const realm = createRealm();
    const rows = decode(realm, Rows)(rowsJson(["a", 1]));
    const { seen, stop } = watchAll(realm, {
      c: (read) => read(rows.$items.row("c"))?.price,
    });

    expect(() =>
      update(realm, (read, write) => {
        write.upsert(rows.$items, row(realm, "c", 3));
        expect(read(rows.$items.row("c"))?.price).toBe(3);
        throw new Error("the recipe fails");
      }),
    ).toThrow("the recipe fails");

    expect(seen).toEqual({ c: [] });
    expect(priceOf(realm, rows, "c")).toBeUndefined();

    update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "c", 4));
    });
    expect(seen).toEqual({ c: [4] });
    expect(priceOf(realm, rows, "c")).toBe(4);

    update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "c", 5));
    });
    expect(seen).toEqual({ c: [4, 5] });
    stop();
    expectRealmAtRest(realm);
  });

  test("a repeated key fails the decode and throws from replaceAll", () => {
    const realm = createRealm();
    expect(() => decode(realm, Rows)(rowsJson(["a", 1], ["a", 2]))).toThrow("appears twice");

    const rows = decode(realm, Rows)(rowsJson(["a", 1]));
    expect(() =>
      update(realm, (_read, write) => {
        write.replaceAll(rows.$items, [row(realm, "b", 1), row(realm, "b", 2)]);
      }),
    ).toThrow("appears twice");
    expect(keysOf(realm, rows)).toEqual(["a"]);
    expectRealmAtRest(realm);
  });

  test("a class takes a collection only under a $ key", () => {
    expect(() =>
      SchemaModel("Bad")({ items: CollectionField(Row, { keyOf: (item) => item.id }) }),
    ).toThrow("Bad.items holds a box; name it $items");
  });
});

describe("CollectionField rows and order", () => {
  test("row(key) is the same computed on every call for a present key, observed or not", () => {
    const realm = createRealm();
    const rows = decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));
    expect(rows.$items.row("a")).toBe(rows.$items.row("a"));
    const stop = observe(rows.$items.row("b"));
    expect(rows.$items.row("b")).toBe(rows.$items.row("b"));
    stop();
  });

  test("a held row(key) follows its key through a removal and a re-add", () => {
    const realm = createRealm();
    const rows = decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));
    const held = rows.$items.row("a");
    const { seen, stop } = watchAll(realm, { a: (read) => read(held)?.price });
    update(realm, (_read, write) => {
      write.remove(rows.$items, "a");
    });
    update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "a", 3));
    });
    expect(seen).toEqual({ a: [undefined, 3] });
    expect(untracked(realm, (read) => read(held)?.price)).toBe(3);
    stop();
  });

  test("a held row(key) still reads its key after a failed update removed it", () => {
    const realm = createRealm();
    const rows = decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));
    const held = rows.$items.row("a");
    expect(() =>
      update(realm, (_read, write) => {
        write.remove(rows.$items, "a");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(untracked(realm, (read) => read(held)?.price)).toBe(1);
    expect(rows.$items.row("a")).toBe(held);
    expect(keysOf(realm, rows)).toEqual(["a", "b"]);
    expectRealmAtRest(realm);
  });

  test("several removals in one update leave the keys in order, read mid-update too", () => {
    const realm = createRealm();
    const rows = decode(realm, Rows)(rowsJson(["a", 1], ["b", 2], ["c", 3], ["d", 4], ["e", 5]));
    const { seen, stop } = watchAll(realm, { keys: (read) => read(rows.$items.keys) });
    update(realm, (read, write) => {
      write.remove(rows.$items, "b");
      expect(read(rows.$items.keys)).toEqual(["a", "c", "d", "e"]);
      write.remove(rows.$items, "e");
      write.remove(rows.$items, "missing");
      write.upsert(rows.$items, row(realm, "f", 6), { at: "end" });
      write.upsert(rows.$items, row(realm, "g", 7));
    });
    expect(seen).toEqual({ keys: [["g", "a", "c", "d", "f"]] });
    stop();
  });

  test("a number key removes as the cells' Map finds it: NaN by NaN, 0 by -0", () => {
    class Numbered extends SchemaModel<Numbered>("Numbered")({
      id: Schema.Number,
    }) {}
    class Table extends SchemaModel<Table>("Table")({
      $items: CollectionField(Numbered, { keyOf: (item) => item.id }),
    }) {}
    const realm = createRealm();
    const table = decode(realm, Table)({ items: [{ id: 0 }, { id: Number.NaN }, { id: 1 }] });
    update(realm, (_read, write) => {
      write.remove(table.$items, -0);
      write.remove(table.$items, Number.NaN);
    });
    expect(untracked(realm, (read) => read(table.$items.keys))).toEqual([1]);
    expect(untracked(realm, (read) => read(table.$items.rows).map((item) => item.id))).toEqual([1]);
  });
});

describe("decoded boxes", () => {
  test("a BoxField adds no check to the decode's, and a write still checks", () => {
    let checks = 0;
    const Counted = Schema.Number.check(
      Schema.makeFilter(() => {
        checks++;
        return true;
      }),
    );
    class Plain extends SchemaModel<Plain>("Plain")({ id: Schema.String, size: Counted }) {}
    class Boxed extends SchemaModel<Boxed>("Boxed")({
      id: Schema.String,
      $size: BoxField(Counted),
    }) {}
    class Holder extends SchemaModel<Holder>("Holder")({
      $items: CollectionField(Boxed, { keyOf: (item) => item.id }),
    }) {}
    const realm = createRealm();
    decode(realm, Plain)({ id: "a", size: 1 });
    const plain = checks;
    checks = 0;
    decode(realm, Boxed)({ id: "a", size: 1 });
    expect(checks).toBe(plain);
    checks = 0;
    const holder = decode(
      realm,
      Holder,
    )({
      items: [
        { id: "a", size: 1 },
        { id: "b", size: 2 },
      ],
    });
    expect(checks).toBe(2 * plain);
    checks = 0;
    const item = untracked(realm, (read) => read(holder.$items.row("a"))) as Boxed;
    update(realm, (_read, write) => {
      write(item.$size, 3);
    });
    expect(checks).toBe(1);
  });

  test("read.row reads a held row where nothing tracks, and the old row after a failed update", () => {
    const realm = createRealm();
    const rows = decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));
    const { seen, stop } = watchAll(realm, { a: (read) => read.row(rows.$items, "a")?.price });

    expect(() =>
      update(realm, (read, write) => {
        write.upsert(rows.$items, row(realm, "a", 10));
        write.remove(rows.$items, "b");
        expect(read.row(rows.$items, "a")?.price).toBe(10);
        expect(read.row(rows.$items, "b")).toBeUndefined();
        throw new Error("the recipe fails");
      }),
    ).toThrow("the recipe fails");

    expect(untracked(realm, (read) => read.row(rows.$items, "a")?.price)).toBe(1);
    expect(untracked(realm, (read) => read.row(rows.$items, "b")?.price)).toBe(2);
    update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "a", 5));
    });
    expect(seen).toEqual({ a: [5] });
    stop();
    expectRealmAtRest(realm);
  });
});

describe("schemaCollection", () => {
  const Trade = Schema.Struct({
    id: Schema.String,
    amount: Schema.Number.check(Schema.isGreaterThan(0)),
  });
  type Trade = typeof Trade.Type;

  test("starts empty and takes rows the schema accepts", () => {
    const realm = createRealm();
    const trades = schemaCollection(realm, Trade, { keyOf: (trade) => trade.id });

    expect(untracked(realm, (read) => read(trades.keys))).toEqual([]);
    update(realm, (_read, write) => {
      write.upsert(trades, { id: "a", amount: 1 });
    });

    expect(untracked(realm, (read) => read(trades.row("a")))).toEqual({ id: "a", amount: 1 });
    expectRealmAtRest(realm);
  });

  test("a row the schema rejects throws, and the update puts back every write", () => {
    const realm = createRealm();
    const trades = schemaCollection(realm, Trade, { keyOf: (trade) => trade.id });
    update(realm, (_read, write) => {
      write.upsert(trades, { id: "a", amount: 1 });
    });

    expect(() =>
      update(realm, (_read, write) => {
        write.upsert(trades, { id: "b", amount: 2 });
        write.upsert(trades, { id: "a", amount: -1 });
      }),
    ).toThrow("rejects this value");
    expect(() =>
      update(realm, (_read, write) => {
        write.replaceAll(trades, [{ id: "c", amount: 0 }]);
      }),
    ).toThrow("rejects this value");

    expect(untracked(realm, (read) => read(trades.keys))).toEqual(["a"]);
    expect(untracked(realm, (read) => read(trades.row("a")))).toEqual({ id: "a", amount: 1 });
    expectRealmAtRest(realm);
  });

  test("a row equal under the schema keeps the held row and reruns nobody", () => {
    const realm = createRealm();
    const trades = schemaCollection(realm, Trade, { keyOf: (trade) => trade.id });
    update(realm, (_read, write) => {
      write.upsert(trades, { id: "a", amount: 1 });
    });
    const held = untracked(realm, (read) => read(trades.row("a")));
    const { seen, stop } = watchAll(realm, {
      a: (read) => read(trades.row("a")),
      rows: (read) => read(trades.rows),
    });

    update(realm, (_read, write) => {
      write.upsert(trades, { id: "a", amount: 1 });
      write.replaceAll(trades, [{ id: "a", amount: 1 }]);
    });

    expect(seen).toEqual({ a: [], rows: [] });
    expect(untracked(realm, (read) => read(trades.row("a")))).toBe(held as never);
    stop();
  });

  test("options.equals replaces the schema's equivalence", () => {
    const realm = createRealm();
    const trades = schemaCollection(realm, Trade, {
      keyOf: (trade) => trade.id,
      equals: (previous: Trade, next: Trade) => previous.id === next.id,
    });
    update(realm, (_read, write) => {
      write.upsert(trades, { id: "a", amount: 1 });
    });
    const { seen, stop } = watchAll(realm, { a: (read) => read(trades.row("a"))?.amount });

    update(realm, (_read, write) => {
      write.upsert(trades, { id: "a", amount: 2 });
    });

    expect(seen).toEqual({ a: [] });
    expect(untracked(realm, (read) => read(trades.row("a"))?.amount)).toBe(1);
    stop();
  });

  test("a SchemaModel row is merged into the row held under its key", () => {
    class Order extends SchemaModel<Order>("Order")({
      id: Schema.String,
      $price: BoxField(Schema.Number.check(Schema.isGreaterThan(0))),
    }) {}
    const realm = createRealm();
    const orders = schemaCollection(realm, Order, { keyOf: (order) => order.id });
    update(realm, (_read, write) => {
      write.upsert(orders, Order.make({ id: "a", price: 1, realm }));
    });
    const held = untracked(realm, (read) => read(orders.row("a"))) as Order;
    const { seen, stop } = watchAll(realm, {
      row: (read) => read(orders.row("a")),
      price: (read) => read(held.$price),
    });

    update(realm, (_read, write) => {
      write.upsert(orders, Order.make({ id: "a", price: 2, realm }));
    });

    expect(seen).toEqual({ row: [], price: [2] });
    expect(untracked(realm, (read) => read(orders.row("a")))).toBe(held);
    stop();
  });
});
