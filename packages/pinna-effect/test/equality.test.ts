import { describe, expect, test } from "bun:test";
import * as Plain from "@frondruntime/pinna";
import { record } from "@frondruntime/pinna/testing";
import { Equal, Hash, HashSet, Schema, SchemaIssue } from "effect";
import {
  Atom,
  Box,
  Collection,
  Computed,
  type Equals,
  Model,
  Realm,
  type ReconcileOptions,
} from "../src/index.ts";
import { expectRealmAtRest } from "./rest.ts";

const realm = Realm.make();

const Row = Schema.Struct({ id: Schema.String, price: Schema.Number });
type Row = typeof Row.Type;

const write = <Value>($box: Box<Value>, value: Value): void => {
  Realm.update(realm, (_read, write) => {
    write($box, value);
  });
};

class Quote extends Model.Schema<Quote>("Quote")({
  id: Schema.String,
  tags: Schema.Array(Schema.String),
}) {}

class Position extends Model.Schema<Position>("Position")({
  id: Schema.String,
  $size: Model.boxField(Schema.Number),
}) {}

describe("default equality", () => {
  test("a box notifies nobody when the new value equals the old one under its schema", () => {
    const $rows = Box.schema(realm, Schema.Array(Row), [{ id: "a", price: 1 }]);
    using watched = record(realm, (read) => read($rows));
    write($rows, [{ id: "a", price: 1 }]);
    expect(watched.values.length).toBe(0);
    write($rows, [{ id: "a", price: 2 }]);
    expect(watched.values.length).toBe(1);
  });

  test("an equal write keeps the value the box had", () => {
    const first = [{ id: "a", price: 1 }];
    const $rows = Box.schema(realm, Schema.Array(Row), first);
    write($rows, [{ id: "a", price: 1 }]);
    expect(Realm.untracked(realm, (read) => read($rows))).toBe(first);
  });

  test("equals: Object.is opts back into identity", () => {
    const $rows = Box.schema(realm, Schema.Array(Row), [], { equals: Object.is });
    using watched = record(realm, (read) => read($rows));
    write($rows, []);
    expect(watched.values.length).toBe(1);
  });

  test("an Equals of the caller's own decides, such as by id alone", () => {
    const sameId: Equals<ReadonlyArray<Row>> = (left, right) =>
      left.length === right.length && left.every((row, index) => row.id === right[index]?.id);
    const $rows = Box.schema(realm, Schema.Array(Row), [{ id: "a", price: 1 }], { equals: sameId });
    using watched = record(realm, (read) => read($rows));
    write($rows, [{ id: "a", price: 2 }]);
    expect(watched.values.length).toBe(0);
    write($rows, [{ id: "b", price: 2 }]);
    expect(watched.values.length).toBe(1);
  });

  test("a BoxField compares with its schema too", () => {
    class Basket extends Model.Schema<Basket>("Basket")({
      $items: Model.boxField(Schema.Array(Schema.String)),
    }) {}
    const basket = Model.decode(realm, Basket)({ items: ["apple"] });
    using watched = record(realm, (read) => read(basket.$items));
    write(basket.$items, ["apple"]);
    expect(watched.values.length).toBe(0);
    write(basket.$items, ["pear"]);
    expect(watched.values.length).toBe(1);
  });

  test("SchemaModel instances compare their plain fields by value", () => {
    const decodeQuote = Model.decode(realm, Quote);
    const $quote = Box.schema(realm, Quote, decodeQuote({ id: "a", tags: ["x"] }));
    using watched = record(realm, (read) => read($quote));
    write($quote, decodeQuote({ id: "a", tags: ["x"] }));
    expect(watched.values.length).toBe(0);
    write($quote, decodeQuote({ id: "a", tags: ["y"] }));
    expect(watched.values.length).toBe(1);
  });

  test("SchemaModel instances compare their boxes by identity, not by contents", () => {
    const decodePosition = Model.decode(realm, Position);
    const first = decodePosition({ id: "a", size: 1 });
    const $position = Box.schema(realm, Position, first);
    using watched = record(realm, (read) => read($position));
    write($position, Position.make({ id: "a", size: 1, realm }));
    expect(watched.values.length).toBe(1);
    write($position, decodePosition({ id: "a", size: 1 }));
    expect(watched.values.length).toBe(2);
  });

  test("SchemaModel instances from different realms are not equal", () => {
    const other = Realm.make();
    const $quote = Box.schema(realm, Quote, Model.decode(realm, Quote)({ id: "a", tags: [] }));
    using watched = record(realm, (read) => read($quote));
    write($quote, Model.decode(other, Quote)({ id: "a", tags: [] }));
    expect(watched.values.length).toBe(1);
  });

  test("a computed value still compares with Object.is", () => {
    const $count = Box.schema(realm, Schema.Number, 1);
    const $pair = Computed.make(realm, (read) => [read($count) > 0]);
    using watched = record(realm, (read) => read($pair));
    write($count, 2);
    expect(watched.values.length).toBe(1);
  });
});

describe("reconcile", () => {
  const keyOf = (row: Row): string => row.id;
  const equals = Equal.equals;

  test("keeps the previous instance for an unchanged key", () => {
    const a = { id: "a", price: 1 };
    const b = { id: "b", price: 2 };
    const next = Collection.reconcile(
      [a, b],
      [
        { id: "a", price: 1 },
        { id: "b", price: 3 },
      ],
      { keyOf, equals },
    );
    expect(next[0]).toBe(a);
    expect(next[1]).toEqual({ id: "b", price: 3 });
    expect(next[1]).not.toBe(b);
  });

  test("its options type requires equals: a refetch builds new objects", () => {
    // @ts-expect-error equals is required.
    const missing: ReconcileOptions<Row, string> = { keyOf };
    expect(missing.keyOf({ id: "a", price: 1 })).toBe("a");
    const options: ReconcileOptions<Row, string> = { keyOf, equals };
    const previous = [{ id: "a", price: 1 }];
    expect(Collection.reconcile(previous, [{ id: "a", price: 1 }], options)).toBe(previous);
  });

  test("follows the next order, adds new keys, and drops missing ones", () => {
    const a = { id: "a", price: 1 };
    const b = { id: "b", price: 2 };
    const c = { id: "c", price: 3 };
    const next = Collection.reconcile(
      [a, b],
      [
        { id: "c", price: 3 },
        { id: "a", price: 1 },
      ],
      { keyOf, equals },
    );
    expect(next).toEqual([c, a]);
    expect(next[1]).toBe(a);
  });

  test("returns the previous array when every item and its place are unchanged", () => {
    const previous = [
      { id: "a", price: 1 },
      { id: "b", price: 2 },
    ];
    const next = Collection.reconcile(
      previous,
      [
        { id: "a", price: 1 },
        { id: "b", price: 2 },
      ],
      { keyOf, equals },
    );
    expect(next).toBe(previous);
  });

  test("throws on a key the next array repeats", () => {
    expect(() =>
      Collection.reconcile(
        [],
        [
          { id: "a", price: 1 },
          { id: "a", price: 2 },
        ],
        { keyOf, equals },
      ),
    ).toThrow("reconcile: the key a appears twice");
    expectRealmAtRest(realm);
  });

  test("a refetch written through reconcile notifies nobody and keeps row identity", () => {
    const $rows = Box.schema(realm, Schema.Array(Row), [
      { id: "a", price: 1 },
      { id: "b", price: 2 },
    ]);
    const first = Realm.untracked(realm, (read) => read($rows))[0];
    using watched = record(realm, (read) => read($rows));
    const refetch = (rows: ReadonlyArray<Row>): void =>
      write(
        $rows,
        Collection.reconcile(
          Realm.untracked(realm, (read) => read($rows)),
          rows,
          { keyOf, equals },
        ),
      );
    refetch([
      { id: "a", price: 1 },
      { id: "b", price: 2 },
    ]);
    expect(watched.values.length).toBe(0);
    refetch([
      { id: "a", price: 1 },
      { id: "b", price: 5 },
    ]);
    expect(watched.values.length).toBe(1);
    expect(Realm.untracked(realm, (read) => read($rows))[0]).toBe(first);
  });

  test("SchemaModel rows compare with their class's equivalence", () => {
    const decodeQuotes = Model.decode(realm, Schema.Array(Quote));
    const previous = decodeQuotes([
      { id: "a", tags: ["x"] },
      { id: "b", tags: ["y"] },
    ]);
    const next = Collection.reconcile(
      previous,
      decodeQuotes([
        { id: "a", tags: ["x"] },
        { id: "b", tags: ["z"] },
      ]),
      { keyOf: (quote) => quote.id, equals: Schema.toEquivalence(Quote) },
    );
    expect(next[0]).toBe(previous[0]);
    expect(next[1]).not.toBe(previous[1]);
  });

  test("a plain row compares its boxes and computed values by identity, never by walking them", () => {
    const row = (id: string, $size: Box<number>) => ({
      id,
      $size,
      $double: Computed.make(realm, (read) => read($size) * 2),
    });
    const $size = Box.schema(realm, Schema.Number, 1);
    const first = row("a", $size);
    const kept = Collection.reconcile([first], [{ ...first }], {
      keyOf: (item) => item.id,
      equals: Equal.equals,
    });
    expect(kept[0]).toBe(first);
    const next = Collection.reconcile([first], [row("a", Box.schema(realm, Schema.Number, 1))], {
      keyOf: (item) => item.id,
      equals: Equal.equals,
    });
    expect(next[0]).not.toBe(first);
  });

  test("a refetched SchemaModel row with a box is a new row: its box is a new box", () => {
    const decodePositions = Model.decode(realm, Schema.Array(Position));
    const previous = decodePositions([{ id: "a", size: 1 }]);
    const next = Collection.reconcile(previous, decodePositions([{ id: "a", size: 1 }]), {
      keyOf: (position) => position.id,
      equals: Schema.toEquivalence(Position),
    });
    expect(next[0]).not.toBe(previous[0]);
  });

  test("equals decides when a row is unchanged, such as by its boxes' contents", () => {
    const decodePositions = Model.decode(realm, Schema.Array(Position));
    const previous = decodePositions([{ id: "a", size: 1 }]);
    let compared = 0;
    const equals = (old: Position, fresh: Position): boolean => {
      compared++;
      return (
        old.id === fresh.id &&
        Realm.untracked(realm, (read) => read(old.$size)) ===
          Realm.untracked(realm, (read) => read(fresh.$size))
      );
    };
    const keyOf = (position: Position): string => position.id;
    const same = Collection.reconcile(previous, decodePositions([{ id: "a", size: 1 }]), {
      keyOf,
      equals,
    });
    expect(same).toBe(previous);
    expect(compared).toBe(1);
    const moved = Collection.reconcile(previous, decodePositions([{ id: "a", size: 2 }]), {
      keyOf,
      equals,
    });
    expect(moved[0]).not.toBe(previous[0]);
  });

  test("equals runs only for a key previous holds, and never for the same instance", () => {
    let compared = 0;
    const equals = (): boolean => {
      compared++;
      return true;
    };
    const a = { id: "a", price: 1 };
    const next = Collection.reconcile([a], [a, { id: "b", price: 2 }], { keyOf, equals });
    expect(next[0]).toBe(a);
    expect(compared).toBe(0);
  });
});

describe("reconcileSchema", () => {
  const keyOf = (row: Row): string => row.id;

  test("compares a plain row structurally when equals is left out", () => {
    const a = { id: "a", price: 1 };
    const previous = [a, { id: "b", price: 2 }];
    const next = Collection.reconcile(
      previous,
      [
        { id: "a", price: 1 },
        { id: "b", price: 3 },
      ],
      { keyOf },
    );
    expect(next[0]).toBe(a);
    expect(next[1]).toEqual({ id: "b", price: 3 });
    expect(Collection.reconcile(next, [{ ...a }, { id: "b", price: 3 }], { keyOf })).toBe(next);
  });

  test("compares a SchemaModel row with its class's schema", () => {
    const decodeQuotes = Model.decode(realm, Schema.Array(Quote));
    const previous = decodeQuotes([
      { id: "a", tags: ["x"] },
      { id: "b", tags: ["y"] },
    ]);
    const next = Collection.reconcile(
      previous,
      decodeQuotes([
        { id: "a", tags: ["x"] },
        { id: "b", tags: ["z"] },
      ]),
      { keyOf: (quote) => quote.id },
    );
    expect(next[0]).toBe(previous[0]);
    expect(next[1]).not.toBe(previous[1]);
  });

  test("a refetched SchemaModel row with a box is merged: the held row and its box stay", () => {
    const decodePositions = Model.decode(realm, Schema.Array(Position));
    const previous = decodePositions([{ id: "a", size: 1 }]);
    const next = Collection.reconcile(previous, decodePositions([{ id: "a", size: 1 }]), {
      keyOf: (position) => position.id,
    });
    expect(next).toBe(previous);
  });

  test("equals replaces the schema's comparison", () => {
    const previous = [{ id: "a", price: 1 }];
    const next = Collection.reconcile(previous, [{ id: "a", price: 2 }], {
      keyOf,
      equals: (old, fresh) => old.id === fresh.id,
    });
    expect(next).toBe(previous);
  });

  test("Collection.reconcile here works out equals from the schema; pinna's takes it", () => {
    expect(Collection.reconcile).not.toBe(Plain.Collection.reconcile);
  });
});

describe("primitive equality", () => {
  // An autorun, not a watch: a watch compares what it selects by itself.
  test("a number box counts 0 and -0, and NaN and NaN, as the same value", () => {
    const $count = Box.schema(realm, Schema.Number, 0);
    let runs = 0;
    const stop = Realm.autorun(realm, (read) => {
      runs++;
      read($count);
    });
    write($count, -0);
    expect(runs).toBe(1);
    write($count, Number.NaN);
    expect(runs).toBe(2);
    write($count, Number.NaN);
    expect(runs).toBe(2);
    write($count, 1);
    expect(runs).toBe(3);
    stop();
  });

  test("a schema's own equivalence decides for a primitive box", () => {
    const Rounded = Schema.Number.pipe(
      Schema.overrideToEquivalence(() => (a: number, b: number) => Math.round(a) === Math.round(b)),
    );
    const $price = Box.schema(realm, Rounded, 1);
    using watched = record(realm, (read) => read($price));
    write($price, 1.2);
    expect(watched.values.length).toBe(0);
    write($price, 2);
    expect(watched.values.length).toBe(1);
  });

  test("string, boolean, and literal boxes compare by value", () => {
    const $name = Box.schema(realm, Schema.String, "a");
    const $done = Box.schema(realm, Schema.Boolean, false);
    const $side = Box.schema(realm, Schema.Literals(["buy", "sell"]), "buy");
    using watched = record(realm, (read) => [read($name), read($done), read($side)]);
    Realm.update(realm, (_read, write) => {
      write($name, "b");
      write($name, "a");
      write($done, false);
      write($side, "buy");
    });
    expect(watched.values.length).toBe(0);
    write($side, "sell");
    expect(watched.values.length).toBe(1);
  });
});

describe("unknown boxes", () => {
  test("Schema.Unknown and Schema.Any accept every value", () => {
    const $unknown = Box.schema(realm, Schema.Unknown, null);
    const $any = Box.schema(realm, Schema.Any, null);
    for (const value of [undefined, 1, "a", { a: 1 }, [1], Number.NaN]) {
      Realm.update(realm, (_read, write) => {
        write($unknown, value);
        write($any, value);
      });
      expect(Realm.untracked(realm, (read) => read($unknown))).toBe(value);
    }
  });

  test("a refined Schema.Unknown still rejects what its check rejects", () => {
    const Text = Schema.Unknown.check(Schema.makeFilter((value) => typeof value === "string"));
    expect(() => Box.schema(realm, Text, 1)).toThrow("the box rejects this value");
    const $text = Box.schema(realm, Text, "a");
    expect(() => write($text, 1)).toThrow("the box rejects this value");
    const Present = Schema.Any.check(Schema.makeFilter((value) => value !== undefined));
    const $present = Box.schema(realm, Present, 1);
    expect(() => write($present, undefined)).toThrow("the box rejects this value");
    expectRealmAtRest(realm);
  });
});

describe("incremental checks", () => {
  for (const [name, element, initial, next, path] of [
    ["primitive", Schema.Number, [1], [1, "bad"], [1]],
    [
      "nested",
      Schema.Struct({ price: Schema.Number }),
      [{ price: 1 }],
      [{ price: 1 }, { price: "bad" }],
      [1, "price"],
    ],
  ] as const) {
    test(`a rejected ${name} array element keeps its structured error path`, () => {
      const $values = Box.schema(realm, Schema.Array(element), initial);
      let cause: unknown;
      try {
        Realm.update(realm, (_read, write) => write($values, next as unknown as typeof initial));
      } catch (error) {
        cause = (error as Error).cause;
      }
      expect(Schema.isSchemaError(cause)).toBe(true);
      if (!Schema.isSchemaError(cause)) {
        throw new Error("expected a schema error");
      }
      expect(SchemaIssue.makeFormatterStandardSchemaV1()(cause.issue).issues).toEqual([
        { path, message: "Expected number" },
      ]);
      expect(Realm.untracked(realm, (read) => read($values))).toBe(initial);
      expectRealmAtRest(realm);
    });
  }

  const counted = (): { readonly schema: Schema.Codec<number>; readonly count: () => number } => {
    let count = 0;
    const schema = Schema.Number.check(
      Schema.makeFilter(() => {
        count++;
        return true;
      }),
    );
    return { schema, count: () => count };
  };

  test("a write checks only the elements that are not where they were", () => {
    const { schema, count } = counted();
    const $numbers = Box.schema(realm, Schema.Array(schema), [1, 2, 3]);
    const before = count();
    Realm.update(realm, (_read, write) => {
      write.modify($numbers, (numbers) => {
        numbers.push(4);
      });
    });
    expect(count() - before).toBe(1);
  });

  test("a write that drops the first element and appends one checks one", () => {
    const { schema, count } = counted();
    const $numbers = Box.schema(realm, Schema.Array(schema), [1, 2, 3, 4]);
    const before = count();
    write($numbers, [...Realm.untracked(realm, (read) => read($numbers)).slice(1), 5]);
    expect(count() - before).toBe(1);
    expect(Realm.untracked(realm, (read) => read($numbers))).toEqual([2, 3, 4, 5]);
  });

  test("a draft that shifts and pushes checks only the pushed element", () => {
    let count = 0;
    const Checked = Row.check(
      Schema.makeFilter(() => {
        count++;
        return true;
      }),
    );
    const $rows = Box.schema(realm, Schema.Array(Checked), [
      { id: "a", price: 1 },
      { id: "b", price: 2 },
      { id: "c", price: 3 },
    ]);
    count = 0;
    Realm.update(realm, (_read, write) => {
      write.modify($rows, (rows) => {
        rows.shift();
        rows.push({ id: "d", price: 4 });
      });
    });
    expect(count).toBe(1);
    expect(Realm.untracked(realm, (read) => read($rows)).map((row) => row.id)).toEqual([
      "b",
      "c",
      "d",
    ]);
  });

  test("a write that drops several elements from the front checks only the new ones", () => {
    const { schema, count } = counted();
    const $numbers = Box.schema(realm, Schema.Array(schema), [1, 2, 3, 4, 5, 6]);
    const before = count();
    write($numbers, [...Realm.untracked(realm, (read) => read($numbers)).slice(3), 7, 8]);
    expect(count() - before).toBe(2);
  });

  test("a write that adds an element at the front checks one", () => {
    const { schema, count } = counted();
    const $numbers = Box.schema(realm, Schema.Array(schema), [1, 2, 3]);
    const before = count();
    write($numbers, [0, ...Realm.untracked(realm, (read) => read($numbers))]);
    expect(count() - before).toBe(1);
  });

  test("a first element copied from later in the array checks no more than that element", () => {
    const { schema, count } = counted();
    const $numbers = Box.schema(realm, Schema.Array(schema), [1, 2, 3, 4, 5]);
    const before = count();
    write($numbers, [3, 2, 3, 4, 5]);
    expect(count() - before).toBeLessThanOrEqual(1);
  });

  test("swapping the first two elements checks no more than the two", () => {
    const { schema, count } = counted();
    const $numbers = Box.schema(realm, Schema.Array(schema), [1, 2, 3, 4, 5]);
    const before = count();
    write($numbers, [2, 1, 3, 4, 5]);
    expect(count() - before).toBeLessThanOrEqual(2);
  });

  test("an element replaced in a shifted array is still checked", () => {
    const { schema, count } = counted();
    const $numbers = Box.schema(realm, Schema.Array(schema), [1, 2, 3, 4, 5]);
    const before = count();
    write($numbers, [2, 3, 30, 5, 6]);
    expect(count() - before).toBe(2);
  });

  test("a new element that does not fit a shifted array is rejected at its new index", () => {
    const $rows = Box.schema(realm, Schema.Array(Row), [
      { id: "a", price: 1 },
      { id: "b", price: 2 },
      { id: "c", price: 3 },
    ]);
    const [, b, c] = Realm.untracked(realm, (read) => read($rows));
    expect(() =>
      write($rows, [b as Row, c as Row, { id: "d", price: "free" as unknown as number }]),
    ).toThrow("at [2]: ");
    expect(Realm.untracked(realm, (read) => read($rows))).toHaveLength(3);
    expectRealmAtRest(realm);
  });

  test("a repeated element that misleads the shift does not let a bad element through", () => {
    const Positive = Schema.Number.check(Schema.isGreaterThan(0));
    const $numbers = Box.schema(realm, Schema.Array(Positive), [9, 1, 2, 1, 3]);
    expect(() => write($numbers, [1, 3, -1])).toThrow("at [2]: ");
    expect(Realm.untracked(realm, (read) => read($numbers))).toEqual([9, 1, 2, 1, 3]);
    expectRealmAtRest(realm);
  });

  test("an object element kept in its place is not checked again", () => {
    let count = 0;
    const Checked = Row.check(
      Schema.makeFilter(() => {
        count++;
        return true;
      }),
    );
    const $rows = Box.schema(realm, Schema.Array(Checked), [
      { id: "a", price: 1 },
      { id: "b", price: 2 },
    ]);
    count = 0;
    Realm.update(realm, (_read, write) => {
      write.modify($rows, (rows) => {
        const row = rows[1];
        if (row !== undefined) {
          row.price = 3;
        }
      });
    });
    expect(count).toBe(1);
  });

  test("writing the value a box holds checks nothing and changes nothing", () => {
    let count = 0;
    const Checked = Row.check(
      Schema.makeFilter(() => {
        count++;
        return true;
      }),
    );
    const $row = Box.schema(realm, Checked, { id: "a", price: 1 });
    const held = Realm.untracked(realm, (read) => read($row));
    using seen = record(realm, (read) => read($row));
    count = 0;
    write($row, held);
    expect(count).toBe(0);
    expect(seen.values.length).toBe(0);
    write($row, { id: "a", price: 2 });
    expect(count).toBe(1);
    expect(seen.values.length).toBe(1);
  });

  test("replacing a collection's rows checks only the rows it did not hold", () => {
    let count = 0;
    const Checked = Row.check(
      Schema.makeFilter(() => {
        count++;
        return true;
      }),
    );
    class Book extends Model.Schema<Book>("Book")({
      $rows: Model.collectionField(Checked, { keyOf: (row) => row.id }),
    }) {}
    const book = Model.decode(
      realm,
      Book,
    )({
      rows: [
        { id: "a", price: 1 },
        { id: "b", price: 2 },
        { id: "c", price: 3 },
      ],
    });
    const [a, , c] = Realm.untracked(realm, (read) => read(book.$rows.rows));
    count = 0;
    Realm.update(realm, (_read, write) => {
      write.replaceAll(book.$rows, [a as Row, c as Row, { id: "d", price: 4 }]);
    });
    expect(count).toBe(1);
    expect(Realm.untracked(realm, (read) => read(book.$rows.keys))).toEqual(["a", "c", "d"]);
  });

  test("a new element that does not fit is still rejected", () => {
    const $rows = Box.schema(realm, Schema.Array(Row), [{ id: "a", price: 1 }]);
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.modify($rows, (rows) => {
          rows.push({ id: "b", price: "free" as unknown as number });
        });
      }),
    ).toThrow("the box rejects this value");
    expect(Realm.untracked(realm, (read) => read($rows))).toHaveLength(1);
    expectRealmAtRest(realm);
  });

  test("a check on the array itself still runs on every write", () => {
    const $tags = Box.schema(realm, Schema.Array(Schema.String).check(Schema.isMaxLength(2)), [
      "a",
    ]);
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.modify($tags, (tags) => {
          tags.push("b", "c");
        });
      }),
    ).toThrow("the box rejects this value");
    expectRealmAtRest(realm);
  });

  test("a rejected write keeps the schema's error as its cause", () => {
    const thrown = (write: () => void): unknown => {
      try {
        write();
      } catch (error) {
        return error;
      }
      return undefined;
    };
    const $price = Box.schema(realm, Schema.Number, 1);
    const $rows = Box.schema(realm, Schema.Array(Row), [{ id: "a", price: 1 }]);
    const whole = thrown(() => write($price, "ten" as unknown as number));
    const element = thrown(() =>
      Realm.update(realm, (_read, write) => {
        write.modify($rows, (rows) => {
          rows.push({ id: "b", price: "free" as unknown as number });
        });
      }),
    );
    for (const error of [whole, element]) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("the box rejects this value");
      expect(Schema.isSchemaError((error as Error).cause)).toBe(true);
    }
    expect((element as Error).message).toContain("at [1]: ");
    expectRealmAtRest(realm);
  });

  test("a value that is not an array is rejected by an array box", () => {
    const $tags = Box.schema(realm, Schema.Array(Schema.String), ["a"]);
    expect(() => write($tags, "a" as unknown as ReadonlyArray<string>)).toThrow(
      "the box rejects this value",
    );
    expectRealmAtRest(realm);
  });
});

describe("a SchemaModel with its own Equal", () => {
  class Rate extends Model.Schema<Rate>("Rate")({
    pair: Schema.String,
    $bid: Model.boxField(Schema.Number),
    at: Schema.Number,
  }) {
    [Equal.symbol](that: unknown): boolean {
      return (
        that instanceof Rate &&
        this.pair === that.pair &&
        Realm.untracked(realm, (read) => read(this.$bid)) ===
          Realm.untracked(realm, (read) => read(that.$bid))
      );
    }

    [Hash.symbol](): number {
      return Hash.string(this.pair);
    }
  }

  const decodeRates = Model.decode(realm, Schema.Array(Rate));
  const keyOf = (rate: Rate): string => rate.pair;
  const equals = Schema.toEquivalence(Rate);

  test("reconcile with its class's equivalence compares it with its own Equal", () => {
    const previous = decodeRates([{ pair: "BTC", bid: 1, at: 1 }]);
    expect(
      Collection.reconcile(previous, decodeRates([{ pair: "BTC", bid: 1, at: 2 }]), {
        keyOf,
        equals,
      }),
    ).toBe(previous);
    const moved = Collection.reconcile(previous, decodeRates([{ pair: "BTC", bid: 2, at: 2 }]), {
      keyOf,
      equals,
    });
    expect(moved[0]).not.toBe(previous[0]);
  });

  test("reconcileSchema compares it with its own Equal when equals is left out", () => {
    const previous = decodeRates([{ pair: "BTC", bid: 1, at: 1 }]);
    expect(
      Collection.reconcile(previous, decodeRates([{ pair: "BTC", bid: 1, at: 2 }]), { keyOf }),
    ).toBe(previous);
    const moved = Collection.reconcile(previous, decodeRates([{ pair: "BTC", bid: 2, at: 2 }]), {
      keyOf,
    });
    expect(moved[0]).not.toBe(previous[0]);
  });

  test("a box of an array of it notifies nobody when every row is equal under its Equal", () => {
    const $rates = Box.schema(
      realm,
      Schema.Array(Rate),
      decodeRates([{ pair: "BTC", bid: 1, at: 1 }]),
    );
    using watched = record(realm, (read) => read($rates));
    write($rates, decodeRates([{ pair: "BTC", bid: 1, at: 2 }]));
    expect(watched.values.length).toBe(0);
    write($rates, decodeRates([{ pair: "BTC", bid: 2, at: 2 }]));
    expect(watched.values.length).toBe(1);
  });

  test("its Equal runs on every comparison: a result is never cached", () => {
    const [first] = decodeRates([{ pair: "BTC", bid: 1, at: 1 }]);
    const [second] = decodeRates([{ pair: "BTC", bid: 1, at: 2 }]);
    const $rate = Box.schema(realm, Rate, first as Rate);
    using watched = record(realm, (read) => read($rate));
    write($rate, second as Rate);
    expect(watched.values.length).toBe(0);
    write((second as Rate).$bid, 5);
    write($rate, second as Rate);
    expect(watched.values.length).toBe(1);
  });

  test("a SchemaModel without its own Equal still compares its fields", () => {
    const previous = Model.decode(realm, Schema.Array(Quote))([{ id: "a", tags: ["x"] }]);
    const next = Model.decode(realm, Schema.Array(Quote))([{ id: "a", tags: ["x"] }]);
    expect(
      Collection.reconcile(previous, next, {
        keyOf: (quote) => quote.id,
        equals: Schema.toEquivalence(Quote),
      }),
    ).toBe(previous);
  });
});

describe("SchemaModel brand", () => {
  test("a draft cannot write a SchemaModel instance's fields", () => {
    const $quotes = Box.schema(realm, Schema.Array(Quote), [
      Quote.make({ id: "a", tags: [], realm }),
    ]);
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.modify($quotes, (quotes) => {
          const quote = quotes[0];
          if (quote !== undefined) {
            // @ts-expect-error A SchemaModel instance is not drafted; replace it with Quote.make.
            quote.id = "b";
          }
        });
      }),
    ).not.toThrow();
    expectRealmAtRest(realm);
  });
});

describe("schema equality agrees with Effect's", () => {
  test("a Date box treats a fresh equal Date as the same value", () => {
    const first = new Date(1);
    const $at = Box.schema(realm, Schema.Date, first);
    using watched = record(realm, (read) => read($at));
    write($at, new Date(1));
    expect(watched.values.length).toBe(0);
    expect(Realm.untracked(realm, (read) => read($at))).toBe(first);
    write($at, new Date(2));
    expect(watched.values.length).toBe(1);
  });
});

describe("identity under Effect's Equal", () => {
  test("two boxes, computed values, atoms, and realms with equal contents are not equal", () => {
    const realm = Realm.make();
    const other = Realm.make();
    const pairs: ReadonlyArray<readonly [unknown, unknown]> = [
      [Box.schema(realm, Schema.Number, 1), Box.schema(realm, Schema.Number, 1)],
      [Computed.make(realm, () => 1), Computed.make(realm, () => 1)],
      [Atom.make(realm), Atom.make(realm)],
      [realm, other],
    ];
    for (const [left, right] of pairs) {
      expect(Equal.equals(left, right)).toBe(false);
      expect(Equal.equals(left, left)).toBe(true);
      expect(Hash.hash(left)).toBe(Hash.hash(left));
    }
  });
});

describe("a schema that says nothing of the value's shape", () => {
  const shapeless: ReadonlyArray<readonly [string, Schema.Schema<object>]> = [
    ["Schema.Unknown", Schema.Unknown as Schema.Schema<object>],
    ["Schema.Any", Schema.Any as Schema.Schema<object>],
    ["Schema.ObjectKeyword", Schema.ObjectKeyword],
  ];

  for (const [name, schema] of shapeless) {
    test(`a ${name} box counts an equal-shaped object as a change`, () => {
      const held = { a: 1 };
      const $value = Box.schema(realm, schema, held);
      using watched = record(realm, (read) => read($value));
      write($value, held);
      expect(watched.values.length).toBe(0);
      write($value, { a: 1 });
      expect(watched.values.length).toBe(1);
    });
  }

  test("an Unknown field inside a struct still compares structurally", () => {
    const $value = Box.schema(realm, Schema.Struct({ a: Schema.Unknown }), { a: { x: 1 } });
    const held = Realm.untracked(realm, (read) => read($value));
    using watched = record(realm, (read) => read($value));
    write($value, { a: { x: 1 } });
    expect(watched.values.length).toBe(0);
    expect(Realm.untracked(realm, (read) => read($value))).toBe(held);
    write($value, { a: { x: 2 } });
    expect(watched.values.length).toBe(1);
  });
});

describe("a plain Schema.Class with its own Equal", () => {
  // One quote per symbol, whatever its price.
  class Ticker extends Schema.Class<Ticker>("Ticker")({
    symbol: Schema.String,
    price: Schema.Number,
  }) {
    [Equal.symbol](that: unknown): boolean {
      return that instanceof Ticker && this.symbol === that.symbol;
    }

    [Hash.symbol](): number {
      return Hash.string(this.symbol);
    }
  }

  class Board extends Model.Schema<Board>("Board")({
    $tickers: Model.collectionField(Ticker, { keyOf: (ticker) => ticker.symbol }),
  }) {}

  test("a schemaBox ignores it and compares field by field", () => {
    const $ticker = Box.schema(realm, Ticker, new Ticker({ symbol: "A", price: 1 }));
    using watched = record(realm, (read) => read($ticker));
    write($ticker, new Ticker({ symbol: "A", price: 1 }));
    expect(watched.values.length).toBe(0);
    write($ticker, new Ticker({ symbol: "A", price: 2 }));
    expect(watched.values.length).toBe(1);
  });

  test("reconcileSchema ignores it and compares field by field", () => {
    const previous = [new Ticker({ symbol: "A", price: 1 })];
    const keyOf = (ticker: Ticker): string => ticker.symbol;
    expect(Collection.reconcile(previous, [new Ticker({ symbol: "A", price: 1 })], { keyOf })).toBe(
      previous,
    );
    const moved = Collection.reconcile(previous, [new Ticker({ symbol: "A", price: 2 })], {
      keyOf,
    });
    expect(moved[0]).not.toBe(previous[0]);
    expect(moved[0]?.price).toBe(2);
  });

  test("a CollectionField's replaceAll ignores it: an equal row is kept, a new price is written", () => {
    const board = Model.decode(realm, Board)({ tickers: [{ symbol: "A", price: 1 }] });
    const held = Realm.untracked(realm, (read) => read(board.$tickers.row("A")));
    using watched = record(realm, (read) => read(board.$tickers.row("A")));
    Realm.update(realm, (_read, write) => {
      write.replaceAll(board.$tickers, [new Ticker({ symbol: "A", price: 1 })]);
    });
    expect(watched.values.length).toBe(0);
    expect(Realm.untracked(realm, (read) => read(board.$tickers.row("A")))).toBe(held);
    Realm.update(realm, (_read, write) => {
      write.replaceAll(board.$tickers, [new Ticker({ symbol: "A", price: 2 })]);
    });
    expect(watched.values.length).toBe(1);
    expect(Realm.untracked(realm, (read) => read(board.$tickers.row("A")))?.price).toBe(2);
  });
});

describe("Effect's Equal.equals against the schema's equivalence", () => {
  test("they agree on a SchemaModel whose fields are all plain, and HashSet finds either", () => {
    class Venue extends Model.Schema<Venue>("Venue")({ id: Schema.String }) {}
    const first = Model.decode(realm, Venue)({ id: "x" });
    const again = Model.decode(realm, Venue)({ id: "x" });
    expect(Schema.toEquivalence(Venue)(first, again)).toBe(true);
    expect(Equal.equals(first, again)).toBe(true);
    expect(HashSet.has(HashSet.make(first), again)).toBe(true);
  });

  test("they agree on a plain Schema.Class, and HashSet finds either", () => {
    class Venue extends Schema.Class<Venue>("Venue")({ id: Schema.String }) {}
    const first = new Venue({ id: "x" });
    const again = new Venue({ id: "x" });
    expect(Schema.toEquivalence(Venue)(first, again)).toBe(true);
    expect(Equal.equals(first, again)).toBe(true);
    expect(HashSet.has(HashSet.make(first), again)).toBe(true);
  });

  test("a computed value in the class body is ignored by the schema and compared by identity by Effect", () => {
    class Venue extends Model.Schema<Venue>("Venue")({ id: Schema.String }) {
      readonly $upper = Computed.make(this.realm, () => this.id.toUpperCase());
    }
    const first = Model.decode(realm, Venue)({ id: "x" });
    const again = Model.decode(realm, Venue)({ id: "x" });
    expect(Schema.toEquivalence(Venue)(first, again)).toBe(true);
    expect(Equal.equals(first, again)).toBe(false);
  });

  test("an own Equal without a Hash is called by the schema and never reached by Effect", () => {
    class Venue extends Model.Schema<Venue>("Venue")({
      id: Schema.String,
      $volume: Model.boxField(Schema.Number),
    }) {
      [Equal.symbol](that: unknown): boolean {
        return that instanceof Venue && this.id === that.id;
      }
    }
    const first = Model.decode(realm, Venue)({ id: "x", volume: 1 });
    const again = Model.decode(realm, Venue)({ id: "x", volume: 2 });
    expect(Schema.toEquivalence(Venue)(first, again)).toBe(true);
    expect(Equal.equals(first, again)).toBe(false);
  });
});

describe("an equals that reads through the update's read", () => {
  test("reconcileSchema keeps a row whose box holds the same value", () => {
    const decodePositions = Model.decode(realm, Schema.Array(Position));
    const $positions = Box.schema(
      realm,
      Schema.Array(Position),
      decodePositions([{ id: "a", size: 1 }]),
    );
    const held = Realm.untracked(realm, (read) => read($positions));
    using watched = record(realm, (read) => read($positions));
    const receive = (json: unknown): void => {
      const next = decodePositions(json);
      Realm.update(realm, (read, write) => {
        write(
          $positions,
          Collection.reconcile(read($positions), next, {
            keyOf: (position) => position.id,
            equals: (old, fresh) => old.id === fresh.id && read(old.$size) === read(fresh.$size),
          }),
        );
      });
    };
    receive([{ id: "a", size: 1 }]);
    expect(watched.values.length).toBe(0);
    expect(Realm.untracked(realm, (read) => read($positions))).toBe(held);
    receive([{ id: "a", size: 2 }]);
    expect(watched.values.length).toBe(1);
  });
});

describe("merging a refetched SchemaModel into the held instance", () => {
  test("cross-realm reconciliation replaces a model despite its own Equal and honors caller equality", () => {
    class Quote extends Model.Schema<Quote>("Quote")({
      pair: Schema.String,
      $bid: Model.boxField(Schema.Number),
    }) {
      [Equal.symbol](that: unknown): boolean {
        return that instanceof Quote && this.pair === that.pair;
      }

      [Hash.symbol](): number {
        return Hash.string(this.pair);
      }
    }
    const other = Realm.make();
    const held = Model.decode(realm, Quote)({ pair: "BTC", bid: 1 });
    const fresh = Model.decode(other, Quote)({ pair: "BTC", bid: 2 });
    const previous = [held];
    const keyOf = (quote: Quote): string => quote.pair;
    const next = Collection.reconcile(previous, [fresh], { keyOf });
    expect(next[0]).toBe(fresh);
    expect(Realm.untracked(other, (read) => read((next[0] as Quote).$bid))).toBe(2);
    expect(Realm.untracked(realm, (read) => read(held.$bid))).toBe(1);
    expect(Collection.reconcile(previous, [fresh], { keyOf, equals: () => true })).toBe(previous);
    expect(Collection.reconcile(previous, [fresh], { keyOf, equals: () => false })[0]).toBe(fresh);
    expectRealmAtRest(realm);
    expectRealmAtRest(other);
  });

  class Holding extends Model.Schema<Holding>("Holding")({
    id: Schema.String,
    name: Schema.String,
    $size: Model.boxField(Schema.Number),
  }) {}

  class Portfolio extends Model.Schema<Portfolio>("Portfolio")({
    id: Schema.String,
    $holdings: Model.collectionField(Holding, { keyOf: (holding) => holding.id }),
  }) {}

  class Desk extends Model.Schema<Desk>("Desk")({
    $portfolios: Model.collectionField(Portfolio, { keyOf: (portfolio) => portfolio.id }),
  }) {}

  const decodeHolding = Model.decode(realm, Holding);
  const decodeHoldings = Model.decode(realm, Schema.Array(Holding));
  const keyOf = (holding: Holding): string => holding.id;
  const sizeOf = (holding: Holding | undefined): number | undefined =>
    holding === undefined ? undefined : Realm.untracked(realm, (read) => read(holding.$size));
  const portfolioOf = (size: number) =>
    Model.decode(realm, Portfolio)({ id: "p", holdings: [{ id: "a", name: "Acme", size }] });

  test("replaceAll keeps the held instance and writes a changed box", () => {
    const portfolio = portfolioOf(1);
    const held = Realm.untracked(realm, (read) => read(portfolio.$holdings.row("a")));
    using rowReaders = record(realm, (read) => read(portfolio.$holdings.row("a")));
    using sizeReaders = record(realm, (read) => read((held as Holding).$size));
    Realm.update(realm, (_read, write) => {
      write.replaceAll(portfolio.$holdings, [decodeHolding({ id: "a", name: "Acme", size: 2 })]);
    });
    expect(Realm.untracked(realm, (read) => read(portfolio.$holdings.row("a")))).toBe(held);
    expect(sizeOf(held)).toBe(2);
    expect(rowReaders.values.length).toBe(0);
    expect(sizeReaders.values.length).toBe(1);
  });

  test("an unchanged refetch notifies nobody", () => {
    const portfolio = portfolioOf(1);
    const held = Realm.untracked(realm, (read) => read(portfolio.$holdings.row("a")));
    using rowsReaders = record(realm, (read) => read(portfolio.$holdings.rows));
    using sizeReaders = record(realm, (read) => read((held as Holding).$size));
    Realm.update(realm, (_read, write) => {
      write.replaceAll(portfolio.$holdings, [decodeHolding({ id: "a", name: "Acme", size: 1 })]);
    });
    expect(rowsReaders.values.length).toBe(0);
    expect(sizeReaders.values.length).toBe(0);
  });

  test("a plain field that differs replaces the instance", () => {
    const portfolio = portfolioOf(1);
    const held = Realm.untracked(realm, (read) => read(portfolio.$holdings.row("a")));
    Realm.update(realm, (_read, write) => {
      write.replaceAll(portfolio.$holdings, [
        decodeHolding({ id: "a", name: "Acme Inc", size: 2 }),
      ]);
    });
    const next = Realm.untracked(realm, (read) => read(portfolio.$holdings.row("a")));
    expect(next).not.toBe(held);
    expect(next?.name).toBe("Acme Inc");
    expect(sizeOf(held)).toBe(1);
  });

  test("upsert merges as replaceAll does", () => {
    const portfolio = portfolioOf(1);
    const held = Realm.untracked(realm, (read) => read(portfolio.$holdings.row("a")));
    Realm.update(realm, (_read, write) => {
      write.upsert(portfolio.$holdings, decodeHolding({ id: "a", name: "Acme", size: 3 }));
    });
    expect(Realm.untracked(realm, (read) => read(portfolio.$holdings.row("a")))).toBe(held);
    expect(sizeOf(held)).toBe(3);
  });

  test("a nested CollectionField merges its rows too", () => {
    const desk = Model.decode(
      realm,
      Desk,
    )({
      portfolios: [{ id: "p", holdings: [{ id: "a", name: "Acme", size: 1 }] }],
    });
    const portfolio = Realm.untracked(realm, (read) =>
      read(desk.$portfolios.row("p")),
    ) as Portfolio;
    const holding = Realm.untracked(realm, (read) => read(portfolio.$holdings.row("a")));
    Realm.update(realm, (_read, write) => {
      write.replaceAll(desk.$portfolios, [portfolioOf(4)]);
    });
    expect(Realm.untracked(realm, (read) => read(desk.$portfolios.row("p")))).toBe(portfolio);
    expect(Realm.untracked(realm, (read) => read(portfolio.$holdings.row("a")))).toBe(holding);
    expect(sizeOf(holding)).toBe(4);
  });

  test("a rejected update puts the merged box back", () => {
    const portfolio = portfolioOf(1);
    const held = Realm.untracked(realm, (read) => read(portfolio.$holdings.row("a")));
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.replaceAll(portfolio.$holdings, [decodeHolding({ id: "a", name: "Acme", size: 5 })]);
        throw new Error("abandon");
      }),
    ).toThrow("abandon");
    expect(sizeOf(held)).toBe(1);
    expectRealmAtRest(realm);
  });

  test("reconcileSchema merges outside an update, in one of its own", () => {
    const previous = decodeHoldings([{ id: "a", name: "Acme", size: 1 }]);
    using sizeReaders = record(realm, (read) => read((previous[0] as Holding).$size));
    const next = Collection.reconcile(
      previous,
      decodeHoldings([{ id: "a", name: "Acme", size: 2 }]),
      {
        keyOf,
      },
    );
    expect(next).toBe(previous);
    expect(sizeOf(previous[0])).toBe(2);
    expect(sizeReaders.values.length).toBe(1);
    expectRealmAtRest(realm);
  });

  test("reconcileSchema merges inside an update, which a throw rolls back", () => {
    const previous = decodeHoldings([{ id: "a", name: "Acme", size: 1 }]);
    const fresh = decodeHoldings([{ id: "a", name: "Acme", size: 2 }]);
    expect(() =>
      Realm.update(realm, () => {
        Collection.reconcile(previous, fresh, { keyOf });
        expect(sizeOf(previous[0])).toBe(2);
        throw new Error("abandon");
      }),
    ).toThrow("abandon");
    expect(sizeOf(previous[0])).toBe(1);
  });

  test("reconcileSchema that writes nothing runs inside a computed value", () => {
    const previous = decodeHoldings([{ id: "a", name: "Acme", size: 1 }]);
    const fresh = decodeHoldings([{ id: "a", name: "Acme", size: 1 }]);
    const $kept = Computed.make(realm, () => Collection.reconcile(previous, fresh, { keyOf }));
    expect(Realm.untracked(realm, (read) => read($kept))).toBe(previous);
  });

  test("a caller's equals turns the merge off", () => {
    const previous = decodeHoldings([{ id: "a", name: "Acme", size: 1 }]);
    const next = Collection.reconcile(
      previous,
      decodeHoldings([{ id: "a", name: "Acme", size: 2 }]),
      {
        keyOf,
        equals: () => false,
      },
    );
    expect(next[0]).not.toBe(previous[0]);
    expect(sizeOf(previous[0])).toBe(1);
  });

  test("a key repeated in the new array throws before any box is written", () => {
    const previous = decodeHoldings([{ id: "a", name: "Acme", size: 1 }]);
    const fresh = [
      decodeHolding({ id: "a", name: "Acme", size: 5 }),
      decodeHolding({ id: "a", name: "Acme", size: 6 }),
    ];
    expect(() => Collection.reconcile(previous, fresh, { keyOf })).toThrow("appears twice");
    expect(sizeOf(previous[0])).toBe(1);
  });

  test("a schemaBox of an array does not merge: a refetch replaces the held row", () => {
    const held = decodeHoldings([{ id: "a", name: "Acme", size: 1 }]);
    const $holdings = Box.schema(realm, Schema.Array(Holding), held);
    using readers = record(realm, (read) => read($holdings));
    write($holdings, decodeHoldings([{ id: "a", name: "Acme", size: 1 }]));
    const next = Realm.untracked(realm, (read) => read($holdings));
    expect(next).not.toBe(held);
    expect(next[0]).not.toBe(held[0]);
    expect(readers.values.length).toBe(1);
  });

  test("an instance from another realm is not merged", () => {
    const other = Realm.make();
    const previous = decodeHoldings([{ id: "a", name: "Acme", size: 1 }]);
    const next = Collection.reconcile(
      previous,
      Model.decode(other, Schema.Array(Holding))([{ id: "a", name: "Acme", size: 2 }]),
      { keyOf },
    );
    expect(next[0]).not.toBe(previous[0]);
    expect(sizeOf(previous[0])).toBe(1);
  });

  test("a class's own Equal decides whether the instance stays, and its boxes still merge", () => {
    class Quote extends Model.Schema<Quote>("Quote")({
      pair: Schema.String,
      at: Schema.Number,
      $bid: Model.boxField(Schema.Number),
    }) {
      [Equal.symbol](that: unknown): boolean {
        return that instanceof Quote && this.pair === that.pair;
      }

      [Hash.symbol](): number {
        return Hash.string(this.pair);
      }
    }
    const decodeQuotes = Model.decode(realm, Schema.Array(Quote));
    const previous = decodeQuotes([{ pair: "BTC", at: 1, bid: 1 }]);
    const next = Collection.reconcile(previous, decodeQuotes([{ pair: "BTC", at: 2, bid: 2 }]), {
      keyOf: (quote) => quote.pair,
    });
    expect(next).toBe(previous);
    expect(previous[0]?.at).toBe(1);
    expect(Realm.untracked(realm, (read) => read((previous[0] as Quote).$bid))).toBe(2);
  });
});
