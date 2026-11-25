import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Schema } from "effect";
import {
  Collection,
  isPinnaError,
  Model as PinnaModel,
  type Read,
  Realm,
  RealmService,
  Source,
  type Write,
} from "../src/index.ts";
import { keptWrite } from "./kept.ts";
import { expectRealmAtRest } from "./rest.ts";

class Row extends PinnaModel.Schema<Row>("Row")({
  id: Schema.String,
  price: Schema.Number,
}) {}

class Rows extends PinnaModel.Schema<Rows>("Rows")({
  $items: PinnaModel.collectionField(Row, { keyOf: (row) => row.id }),
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
    return Realm.watch(realm, selects[name], (value) => {
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

const keysOf = (realm: Realm, rows: Rows) =>
  Realm.untracked(realm, (read) => read(rows.$items.keys));
const priceOf = (realm: Realm, rows: Rows, id: string) =>
  Realm.untracked(realm, (read) => read(rows.$items.row(id))?.price);

describe("CollectionField", () => {
  describe("an undefined row is a schema failure, even when the row schema accepts it", () => {
    class OptionalRows extends PinnaModel.Schema<OptionalRows>("OptionalRows")({
      $items: PinnaModel.collectionField(Schema.Undefined, { keyOf: () => 1 }),
    }) {}
    // A `keyOf` that reads the row would throw on `undefined` if it ran.
    class KeyedRows extends PinnaModel.Schema<KeyedRows>("KeyedRows")({
      $items: PinnaModel.collectionField(Schema.UndefinedOr(Row), {
        keyOf: (row) => (row as Row).id,
      }),
    }) {}

    test.each([
      ["OptionalRows", OptionalRows],
      ["KeyedRows", KeyedRows],
    ] as const)("decode of %s throws the schema error", (_name, Model) => {
      const realm = Realm.make();
      const failure = (() => {
        try {
          PinnaModel.decode(realm, Model)({ items: [undefined] });
        } catch (error) {
          return error;
        }
        return undefined;
      })();
      expect(isPinnaError(failure, "DecodeError")).toBe(true);
      expect(Schema.isSchemaError((failure as Error).cause)).toBe(true);
      expect((failure as Error).message).toContain("pinna: a collection row cannot be undefined");
      expectRealmAtRest(realm);
    });

    test.each([
      ["OptionalRows", OptionalRows],
      ["KeyedRows", KeyedRows],
    ] as const)("the Effect decode of %s fails instead of dying", (_name, Model) => {
      const realm = Realm.make();
      const exit = Effect.runSyncExit(
        Schema.decodeUnknownEffect(Model)({ items: [undefined] }).pipe(
          Effect.provideService(RealmService, realm),
        ),
      );
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true);
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false);
      expectRealmAtRest(realm);
    });

    test("make throws the schema error and builds no collection", () => {
      const realm = Realm.make();
      expect(() => OptionalRows.make({ realm, items: [undefined] })).toThrow(
        "Schema validation failed",
      );
      expectRealmAtRest(realm);
    });
  });

  test("a repeated key with no string form fails the Effect decode instead of dying", () => {
    const realm = Realm.make();
    const key: unknown = Object.create(null);
    class Unprintable extends PinnaModel.Schema<Unprintable>("Unprintable")({
      $items: PinnaModel.collectionField(Schema.Number, { keyOf: () => key }),
    }) {}
    const exit = Effect.runSyncExit(
      Schema.decodeUnknownEffect(Unprintable)({ items: [1, 2] }).pipe(
        Effect.provideService(RealmService, realm),
      ),
    );
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true);
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false);
    expect(Cause.pretty((exit as Exit.Failure<unknown, unknown>).cause)).toContain(
      "pinna: the collection key (an unprintable object) appears twice",
    );
    expectRealmAtRest(realm);
  });

  test("decodes from a plain array under the wire key and encodes back to it", () => {
    const realm = Realm.make();
    const json = rowsJson(["a", 1], ["b", 2]);
    const rows = PinnaModel.decode(realm, Rows)(json);

    expect(keysOf(realm, rows)).toEqual(["a", "b"]);
    expect(priceOf(realm, rows, "b")).toBe(2);
    expect(Schema.encodeSync(Rows)(rows)).toEqual(json);
  });

  test("a write to one key notifies that key's readers only", () => {
    const realm = Realm.make();
    const rows = PinnaModel.decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));
    const { seen, stop } = watchAll(realm, {
      a: (read) => read(rows.$items.row("a"))?.price,
      b: (read) => read(rows.$items.row("b"))?.price,
      keys: (read) => read(rows.$items.keys),
    });

    Realm.update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "a", 10));
    });

    expect(seen).toEqual({ a: [10], b: [], keys: [] });
    stop();
  });

  test("writing another realm's collection throws, and the rows stay", () => {
    const realm = Realm.make();
    const other = Realm.make();
    const rows = PinnaModel.decode(other, Rows)(rowsJson(["a", 1]));
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.upsert(rows.$items, row(realm, "a", 10));
      }),
    ).toThrow("write.upsert($observable) is handed an observable of another realm");
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.remove(rows.$items, "a");
      }),
    ).toThrow("write.remove");
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.replaceAll(rows.$items, []);
      }),
    ).toThrow("write.replaceAll");
    expect(priceOf(other, rows, "a")).toBe(1);
  });

  test("adding, removing, and reordering notify the key readers only", () => {
    const realm = Realm.make();
    const rows = PinnaModel.decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));
    const { seen, stop } = watchAll(realm, {
      a: (read) => read(rows.$items.row("a")),
      b: (read) => read(rows.$items.row("b")),
      keys: (read) => read(rows.$items.keys),
    });

    Realm.update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "c", 3));
    });
    Realm.update(realm, (_read, write) => {
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
    const realm = Realm.make();
    const rows = PinnaModel.decode(realm, Rows)(rowsJson(["a", 1]));

    Realm.update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "b", 2));
    });

    expect(keysOf(realm, rows)).toEqual(["b", "a"]);
  });

  test("upsert with at end puts a new key last, and leaves an existing key in place", () => {
    const realm = Realm.make();
    const rows = PinnaModel.decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));

    Realm.update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "c", 3), { at: "end" });
      write.upsert(rows.$items, row(realm, "a", 5), { at: "end" });
      write.upsert(rows.$items, row(realm, "d", 4), { at: "start" });
    });

    expect(keysOf(realm, rows)).toEqual(["d", "a", "b", "c"]);
    expect(priceOf(realm, rows, "a")).toBe(5);
  });

  test("rows reads every row in key order and follows each one", () => {
    const realm = Realm.make();
    const rows = PinnaModel.decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));
    const { seen, stop } = watchAll(realm, {
      prices: (read) => read(rows.$items.rows).map((each) => each.price),
    });

    Realm.update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "b", 3));
    });
    Realm.update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "c", 4));
    });
    Realm.update(realm, (_read, write) => {
      write.remove(rows.$items, "a");
    });
    Realm.update(realm, (_read, write) => {
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
    const realm = Realm.make();
    const rows = PinnaModel.decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));
    const { seen, stop } = watchAll(realm, { rows: (read) => read(rows.$items.rows) });
    const first = Realm.untracked(realm, (read) => read(rows.$items.row("a"))) as Row;

    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows.$items, [row(realm, "a", 1), row(realm, "b", 2)]);
    });
    // The row comes back under a new cell; the array it makes holds the same rows.
    Realm.update(realm, (_read, write) => {
      write.remove(rows.$items, "a");
      write.upsert(rows.$items, first);
    });
    stop();

    expect(seen.rows).toEqual([]);
  });

  test("a reader of a missing key sees it when it is added, and again when it is removed", () => {
    const realm = Realm.make();
    const rows = PinnaModel.decode(realm, Rows)(rowsJson(["a", 1]));
    const { seen, stop } = watchAll(realm, {
      x: (read) => read(rows.$items.row("x"))?.price,
      a: (read) => read(rows.$items.row("a"))?.price,
    });

    Realm.update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "x", 7));
    });
    Realm.update(realm, (_read, write) => {
      write.remove(rows.$items, "x");
    });
    Realm.update(realm, (_read, write) => {
      write.remove(rows.$items, "a");
    });

    expect(seen).toEqual({ x: [7, undefined], a: [undefined] });
    expect(priceOf(realm, rows, "x")).toBeUndefined();
    stop();
  });

  test("removing a missing key changes nothing", () => {
    const realm = Realm.make();
    const rows = PinnaModel.decode(realm, Rows)(rowsJson(["a", 1]));
    const { seen, stop } = watchAll(realm, { keys: (read) => read(rows.$items.keys) });

    Realm.update(realm, (_read, write) => {
      write.remove(rows.$items, "missing");
    });

    expect(seen.keys).toEqual([]);
    stop();
  });

  test("row returns the same computed value while it is observed", () => {
    const realm = Realm.make();
    const rows = PinnaModel.decode(realm, Rows)(rowsJson(["a", 1]));
    const stop = Realm.watch(
      realm,
      (read) => read(rows.$items.row("a")),
      () => {},
    );

    expect(rows.$items.row("a")).toBe(rows.$items.row("a"));
    stop();
  });

  test("replaceAll keeps unchanged rows and notifies nobody when nothing changed", () => {
    const realm = Realm.make();
    const rows = PinnaModel.decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));
    const before = Realm.untracked(realm, (read) => read(rows.$items.row("a")));
    const { seen, stop } = watchAll(realm, {
      a: (read) => read(rows.$items.row("a")),
      b: (read) => read(rows.$items.row("b")),
      keys: (read) => read(rows.$items.keys),
    });

    Realm.update(realm, (_read, write) => {
      write.replaceAll(
        rows.$items,
        PinnaModel.decode(realm, Schema.Array(Row))(rowsJson(["a", 1], ["b", 2]).items),
      );
    });

    expect(seen).toEqual({ a: [], b: [], keys: [] });
    expect(Realm.untracked(realm, (read) => read(rows.$items.row("a")))).toBe(before as never);
    stop();
  });

  test("replaceAll writes changed rows, adds new keys, and drops missing ones", () => {
    const realm = Realm.make();
    const rows = PinnaModel.decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));
    const { seen, stop } = watchAll(realm, {
      a: (read) => read(rows.$items.row("a"))?.price,
      b: (read) => read(rows.$items.row("b"))?.price,
      c: (read) => read(rows.$items.row("c"))?.price,
    });

    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows.$items, [row(realm, "a", 1), row(realm, "c", 3)]);
    });

    expect(seen).toEqual({ a: [], b: [undefined], c: [3] });
    expect(keysOf(realm, rows)).toEqual(["a", "c"]);
    stop();
  });
});

describe("CollectionField writes", () => {
  test("a write kept past its update throws", () => {
    const realm = Realm.make();
    const rows = PinnaModel.decode(realm, Rows)(rowsJson(["a", 1]));
    const write = keptWrite(realm);

    expect(() => write.upsert(rows.$items, row(realm, "b", 2))).toThrow("inside Realm.update");
    expect(() => write.remove(rows.$items, "a")).toThrow("inside Realm.update");
    expect(() => write.replaceAll(rows.$items, [])).toThrow("inside Realm.update");
    expectRealmAtRest(realm);
  });

  test("a value the schema rejects is not written", () => {
    const realm = Realm.make();
    const rows = PinnaModel.decode(realm, Rows)(rowsJson(["a", 1]));

    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.upsert(rows.$items, { id: "a", price: "ten" } as never);
      }),
    ).toThrow("rejects this value");
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.upsert(rows.$items, { id: "b", price: "ten" } as never);
      }),
    ).toThrow("rejects this value");
    expect(keysOf(realm, rows)).toEqual(["a"]);
    expect(priceOf(realm, rows, "a")).toBe(1);
    expectRealmAtRest(realm);
  });

  test("a replaceAll the schema rejects, caught inside an update, writes nothing", () => {
    const realm = Realm.make();
    const json = rowsJson(["a", 1], ["c", 3]);
    const rows = PinnaModel.decode(realm, Rows)(json);
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
      Realm.update(realm, (_read, write) => {
        expect(() => write.replaceAll(rows.$items, values as never)).toThrow("rejects this value");
      });
      expect(keysOf(realm, rows)).toEqual(["a", "c"]);
      expect(
        Realm.untracked(realm, (read) => read(rows.$items.rows).map((value) => value.price)),
      ).toEqual([1, 3]);
      expect(Schema.encodeSync(Rows)(rows)).toEqual(json);
    }
    expect(seen).toEqual({ a: [], c: [], keys: [] });
    stop();
    expectRealmAtRest(realm);
  });

  test("replaceAll writes wherever upsert and remove do, as in a tracked run inside an update", () => {
    const realm = Realm.make();
    const rows = PinnaModel.decode(realm, Rows)(rowsJson(["a", 1]));
    const writes: Array<(write: Write) => void> = [
      (write) => write.upsert(rows.$items, row(realm, "b", 2)),
      (write) => write.remove(rows.$items, "b"),
      (write) => write.replaceAll(rows.$items, [row(realm, "a", 3)]),
    ];
    for (const each of writes) {
      Realm.update(realm, (_read, write) => {
        const stop = Realm.watch(
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
    const realm = Realm.make();
    const rows = PinnaModel.decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));
    const { seen, stop } = watchAll(realm, {
      a: (read) => read(rows.$items.row("a"))?.price,
      b: (read) => read(rows.$items.row("b"))?.price,
      c: (read) => read(rows.$items.row("c"))?.price,
      keys: (read) => read(rows.$items.keys),
    });

    expect(() =>
      Realm.update(realm, (_read, write) => {
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

    Realm.update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "c", 4));
      write.remove(rows.$items, "b");
    });
    expect(seen).toEqual({ a: [], b: [undefined], c: [4], keys: [["c", "a"]] });
    stop();
    expectRealmAtRest(realm);
  });

  test("a key a failed update added and read leaves its readers following the key", () => {
    const realm = Realm.make();
    const rows = PinnaModel.decode(realm, Rows)(rowsJson(["a", 1]));
    const { seen, stop } = watchAll(realm, {
      c: (read) => read(rows.$items.row("c"))?.price,
    });

    expect(() =>
      Realm.update(realm, (read, write) => {
        write.upsert(rows.$items, row(realm, "c", 3));
        expect(read(rows.$items.row("c"))?.price).toBe(3);
        throw new Error("the recipe fails");
      }),
    ).toThrow("the recipe fails");

    expect(seen).toEqual({ c: [] });
    expect(priceOf(realm, rows, "c")).toBeUndefined();

    Realm.update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "c", 4));
    });
    expect(seen).toEqual({ c: [4] });
    expect(priceOf(realm, rows, "c")).toBe(4);

    Realm.update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "c", 5));
    });
    expect(seen).toEqual({ c: [4, 5] });
    stop();
    expectRealmAtRest(realm);
  });

  test("a repeated key fails the decode and throws from replaceAll", () => {
    const realm = Realm.make();
    expect(() => PinnaModel.decode(realm, Rows)(rowsJson(["a", 1], ["a", 2]))).toThrow(
      "appears twice",
    );

    const rows = PinnaModel.decode(realm, Rows)(rowsJson(["a", 1]));
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.replaceAll(rows.$items, [row(realm, "b", 1), row(realm, "b", 2)]);
      }),
    ).toThrow("appears twice");
    expect(keysOf(realm, rows)).toEqual(["a"]);
    expectRealmAtRest(realm);
  });

  test("a class takes a collection only under a $ key", () => {
    expect(() =>
      PinnaModel.Schema("Bad")({
        items: PinnaModel.collectionField(Row, { keyOf: (item) => item.id }),
      }),
    ).toThrow("Bad.items holds a box; name it $items");
  });
});

describe("CollectionField rows and order", () => {
  test("row(key) is the same computed on every call for a present key, observed or not", () => {
    const realm = Realm.make();
    const rows = PinnaModel.decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));
    expect(rows.$items.row("a")).toBe(rows.$items.row("a"));
    const stop = Source.observe(rows.$items.row("b"));
    expect(rows.$items.row("b")).toBe(rows.$items.row("b"));
    stop();
  });

  test("a held row(key) follows its key through a removal and a re-add", () => {
    const realm = Realm.make();
    const rows = PinnaModel.decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));
    const held = rows.$items.row("a");
    const { seen, stop } = watchAll(realm, { a: (read) => read(held)?.price });
    Realm.update(realm, (_read, write) => {
      write.remove(rows.$items, "a");
    });
    Realm.update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "a", 3));
    });
    expect(seen).toEqual({ a: [undefined, 3] });
    expect(Realm.untracked(realm, (read) => read(held)?.price)).toBe(3);
    stop();
  });

  test("a held row(key) still reads its key after a failed update removed it", () => {
    const realm = Realm.make();
    const rows = PinnaModel.decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));
    const held = rows.$items.row("a");
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.remove(rows.$items, "a");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(Realm.untracked(realm, (read) => read(held)?.price)).toBe(1);
    expect(rows.$items.row("a")).toBe(held);
    expect(keysOf(realm, rows)).toEqual(["a", "b"]);
    expectRealmAtRest(realm);
  });

  test("several removals in one update leave the keys in order, read mid-update too", () => {
    const realm = Realm.make();
    const rows = PinnaModel.decode(
      realm,
      Rows,
    )(rowsJson(["a", 1], ["b", 2], ["c", 3], ["d", 4], ["e", 5]));
    const { seen, stop } = watchAll(realm, { keys: (read) => read(rows.$items.keys) });
    Realm.update(realm, (read, write) => {
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
    class Numbered extends PinnaModel.Schema<Numbered>("Numbered")({
      id: Schema.Number,
    }) {}
    class Table extends PinnaModel.Schema<Table>("Table")({
      $items: PinnaModel.collectionField(Numbered, { keyOf: (item) => item.id }),
    }) {}
    const realm = Realm.make();
    const table = PinnaModel.decode(
      realm,
      Table,
    )({ items: [{ id: 0 }, { id: Number.NaN }, { id: 1 }] });
    Realm.update(realm, (_read, write) => {
      write.remove(table.$items, -0);
      write.remove(table.$items, Number.NaN);
    });
    expect(Realm.untracked(realm, (read) => read(table.$items.keys))).toEqual([1]);
    expect(
      Realm.untracked(realm, (read) => read(table.$items.rows).map((item) => item.id)),
    ).toEqual([1]);
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
    class Plain extends PinnaModel.Schema<Plain>("Plain")({ id: Schema.String, size: Counted }) {}
    class Boxed extends PinnaModel.Schema<Boxed>("Boxed")({
      id: Schema.String,
      $size: PinnaModel.boxField(Counted),
    }) {}
    class Holder extends PinnaModel.Schema<Holder>("Holder")({
      $items: PinnaModel.collectionField(Boxed, { keyOf: (item) => item.id }),
    }) {}
    const realm = Realm.make();
    PinnaModel.decode(realm, Plain)({ id: "a", size: 1 });
    const plain = checks;
    checks = 0;
    PinnaModel.decode(realm, Boxed)({ id: "a", size: 1 });
    expect(checks).toBe(plain);
    checks = 0;
    const holder = PinnaModel.decode(
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
    const item = Realm.untracked(realm, (read) => read(holder.$items.row("a"))) as Boxed;
    Realm.update(realm, (_read, write) => {
      write(item.$size, 3);
    });
    expect(checks).toBe(1);
  });

  test("read.row reads a held row where nothing tracks, and the old row after a failed update", () => {
    const realm = Realm.make();
    const rows = PinnaModel.decode(realm, Rows)(rowsJson(["a", 1], ["b", 2]));
    const { seen, stop } = watchAll(realm, { a: (read) => read.row(rows.$items, "a")?.price });

    expect(() =>
      Realm.update(realm, (read, write) => {
        write.upsert(rows.$items, row(realm, "a", 10));
        write.remove(rows.$items, "b");
        expect(read.row(rows.$items, "a")?.price).toBe(10);
        expect(read.row(rows.$items, "b")).toBeUndefined();
        throw new Error("the recipe fails");
      }),
    ).toThrow("the recipe fails");

    expect(Realm.untracked(realm, (read) => read.row(rows.$items, "a")?.price)).toBe(1);
    expect(Realm.untracked(realm, (read) => read.row(rows.$items, "b")?.price)).toBe(2);
    Realm.update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "a", 5));
    });
    expect(seen).toEqual({ a: [5] });
    stop();
    expectRealmAtRest(realm);
  });
});

describe("schemaCollection", () => {
  for (const wasRead of [false, true]) {
    for (const operation of ["upsert", "replaceAll"] as const) {
      test(`${operation} rejects undefined and checks incoming rows ${wasRead ? "on a row that was read" : "on a row never read"}`, () => {
        const realm = Realm.make();
        const rows = Collection.schema(realm, Schema.Number, { keyOf: () => 1 });
        Realm.update(realm, (_read, write) => {
          write.upsert(rows, 7);
        });
        if (wasRead) {
          Realm.untracked(realm, (read) => read(rows.row(1)));
        }

        for (const value of [undefined, "invalid"]) {
          expect(() =>
            Realm.update(realm, (_read, write) => {
              if (operation === "upsert") {
                write.upsert(rows, value as never);
              } else {
                write.replaceAll(rows, [value as never]);
              }
            }),
          ).toThrow(
            value === undefined
              ? "pinna: a collection row cannot be undefined"
              : "rejects this value",
          );
          expect(Realm.untracked(realm, (read) => read(rows.rows))).toEqual([7]);
        }
        expectRealmAtRest(realm);
      });
    }
  }

  test("rejects undefined even when the row schema accepts it", () => {
    const realm = Realm.make();
    const rows = Collection.schema(realm, Schema.Undefined, { keyOf: () => 1 });
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.upsert(rows, undefined);
      }),
    ).toThrow("pinna: a collection row cannot be undefined");
    expect(Realm.untracked(realm, (read) => read(rows.rows))).toEqual([]);
    expectRealmAtRest(realm);
  });

  const Trade = Schema.Struct({
    id: Schema.String,
    amount: Schema.Number.check(Schema.isGreaterThan(0)),
  });
  type Trade = typeof Trade.Type;

  test("starts empty and takes rows the schema accepts", () => {
    const realm = Realm.make();
    const trades = Collection.schema(realm, Trade, { keyOf: (trade) => trade.id });

    expect(Realm.untracked(realm, (read) => read(trades.keys))).toEqual([]);
    Realm.update(realm, (_read, write) => {
      write.upsert(trades, { id: "a", amount: 1 });
    });

    expect(Realm.untracked(realm, (read) => read(trades.row("a")))).toEqual({ id: "a", amount: 1 });
    expectRealmAtRest(realm);
  });

  test("a row the schema rejects throws, and the update puts back every write", () => {
    const realm = Realm.make();
    const trades = Collection.schema(realm, Trade, { keyOf: (trade) => trade.id });
    Realm.update(realm, (_read, write) => {
      write.upsert(trades, { id: "a", amount: 1 });
    });

    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.upsert(trades, { id: "b", amount: 2 });
        write.upsert(trades, { id: "a", amount: -1 });
      }),
    ).toThrow("rejects this value");
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.replaceAll(trades, [{ id: "c", amount: 0 }]);
      }),
    ).toThrow("rejects this value");

    expect(Realm.untracked(realm, (read) => read(trades.keys))).toEqual(["a"]);
    expect(Realm.untracked(realm, (read) => read(trades.row("a")))).toEqual({ id: "a", amount: 1 });
    expectRealmAtRest(realm);
  });

  test("a row equal under the schema keeps the held row and reruns nobody", () => {
    const realm = Realm.make();
    const trades = Collection.schema(realm, Trade, { keyOf: (trade) => trade.id });
    Realm.update(realm, (_read, write) => {
      write.upsert(trades, { id: "a", amount: 1 });
    });
    const held = Realm.untracked(realm, (read) => read(trades.row("a")));
    const { seen, stop } = watchAll(realm, {
      a: (read) => read(trades.row("a")),
      rows: (read) => read(trades.rows),
    });

    Realm.update(realm, (_read, write) => {
      write.upsert(trades, { id: "a", amount: 1 });
      write.replaceAll(trades, [{ id: "a", amount: 1 }]);
    });

    expect(seen).toEqual({ a: [], rows: [] });
    expect(Realm.untracked(realm, (read) => read(trades.row("a")))).toBe(held as never);
    stop();
  });

  test("options.equals replaces the schema's equivalence", () => {
    const realm = Realm.make();
    const trades = Collection.schema(realm, Trade, {
      keyOf: (trade) => trade.id,
      equals: (previous: Trade, next: Trade) => previous.id === next.id,
    });
    Realm.update(realm, (_read, write) => {
      write.upsert(trades, { id: "a", amount: 1 });
    });
    const { seen, stop } = watchAll(realm, { a: (read) => read(trades.row("a"))?.amount });

    Realm.update(realm, (_read, write) => {
      write.upsert(trades, { id: "a", amount: 2 });
    });

    expect(seen).toEqual({ a: [] });
    expect(Realm.untracked(realm, (read) => read(trades.row("a"))?.amount)).toBe(1);
    stop();
  });

  test("a SchemaModel row is merged into the row held under its key", () => {
    class Order extends PinnaModel.Schema<Order>("Order")({
      id: Schema.String,
      $price: PinnaModel.boxField(Schema.Number.check(Schema.isGreaterThan(0))),
    }) {}
    const realm = Realm.make();
    const orders = Collection.schema(realm, Order, { keyOf: (order) => order.id });
    Realm.update(realm, (_read, write) => {
      write.upsert(orders, Order.make({ id: "a", price: 1, realm }));
    });
    const held = Realm.untracked(realm, (read) => read(orders.row("a"))) as Order;
    const { seen, stop } = watchAll(realm, {
      row: (read) => read(orders.row("a")),
      price: (read) => read(held.$price),
    });

    Realm.update(realm, (_read, write) => {
      write.upsert(orders, Order.make({ id: "a", price: 2, realm }));
    });

    expect(seen).toEqual({ row: [], price: [2] });
    expect(Realm.untracked(realm, (read) => read(orders.row("a")))).toBe(held);
    stop();
  });
});
