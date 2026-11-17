import { describe, expect, test } from "bun:test";
import { box as bareBox } from "@frondruntime/pinna";
import { realmOf } from "@frondruntime/pinna/internal";
import { Reaction } from "@frondruntime/pinna-core";
import { Schema } from "effect";
import {
  autorun,
  BoxField,
  CollectionField,
  computedFunction,
  createRealm,
  decode,
  type Read,
  SchemaModel,
  schemaBox,
  untracked,
  update,
  watch,
} from "../src/index.ts";
import { keptRead } from "./kept.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * The schema box: a box that checks each write against its schema and, unless
 * given `equals`, compares by the schema's equivalence.
 */

const realm = createRealm();

const collect = <Value>(
  select: (read: Read) => Value,
): { readonly seen: Array<Value>; stop(): void } => {
  const seen: Array<Value> = [];
  const stop = watch(realm, select, (value) => {
    seen.push(value);
  });
  return { seen, stop };
};

class Row extends SchemaModel<Row>("Row")({
  id: Schema.String,
  price: Schema.Number,
}) {}

class Rows extends SchemaModel<Rows>("Rows")({
  $items: CollectionField(Row, { keyOf: (row) => row.id }),
}) {}

describe("box with a schema", () => {
  test("a value the schema rejects throws and rolls the update back", () => {
    const $count = schemaBox(realm, Schema.Number, 1);
    const $name = schemaBox(realm, Schema.String, "a");
    const { seen, stop } = collect((read) => `${read($name)}${read($count)}`);
    expect(() =>
      update(realm, (_read, write) => {
        write($name, "b");
        write($count, "two" as unknown as number);
      }),
    ).toThrow("the box rejects this value");
    expect(untracked(realm, (read) => [read($name), read($count)])).toEqual(["a", 1]);
    expect(seen).toEqual([]);
    stop();
    expectRealmAtRest(realm);
  });

  test("a box's equals decides whether a value is written back", () => {
    const $point = schemaBox(realm, Schema.Struct({ x: Schema.Number }), { x: 0 });
    const original = untracked(realm, (read) => read($point));
    let runs = 0;
    const stop = autorun(realm, (read) => {
      runs++;
      read($point);
    });
    update(realm, (_read, write) => {
      write($point, { x: 1 });
      write($point, { x: 0 });
    });
    expect({ runs, same: untracked(realm, (read) => read($point)) === original }).toEqual({
      runs: 1,
      same: true,
    });
    stop();
  });

  // A renderer can track a run inside an update. The check reads boxes of
  // its own, which are not what the run read.
  test("a box's check adds nothing to the reads of a run that writes it", () => {
    const $limit = schemaBox(realm, Schema.Number, 10);
    // A filter is handed no read, so the check keeps one, as a model's filter
    // might; it reads wherever the check runs.
    const read = keptRead(realm);
    const Count = Schema.Number.check(Schema.makeFilter((count) => count <= read($limit)));
    const $count = untracked(realm, () => schemaBox(realm, Count, 0));
    let changes = 0;
    const reaction = new Reaction(realmOf($count).core, () => changes++);
    update(realm, (_read, write) => {
      reaction.track(() => {
        write($count, 1);
      });
    });
    reaction.activate();
    update(realm, (_read, write) => {
      write($limit, 20);
    });
    expect(changes).toBe(0);
    reaction.deactivate();
  });

  test("a box holds what its schema accepts, a Map included", () => {
    const Lookup = Schema.ReadonlyMap(Schema.String, Schema.Number);
    const $lookup = schemaBox(realm, Lookup, new Map([["a", 1]]));
    expect(untracked(realm, (read) => read($lookup).get("a"))).toBe(1);
  });

  test("upsert, remove, and replaceAll write a collection", () => {
    const realm = createRealm();
    const rows = decode(realm, Rows)({ items: [{ id: "a", price: 1 }] });
    const row = (id: string, price: number) => Row.make({ id, price, realm });
    update(realm, (_read, write) => write.upsert(rows.$items, row("b", 2), { at: "end" }));
    expect(untracked(realm, (read) => read(rows.$items.keys))).toEqual(["a", "b"]);
    update(realm, (_read, write) => write.remove(rows.$items, "a"));
    expect(untracked(realm, (read) => read(rows.$items.keys))).toEqual(["b"]);
    update(realm, (_read, write) => write.replaceAll(rows.$items, [row("c", 3)]));
    expect(untracked(realm, (read) => read(rows.$items.row("c"))?.price)).toBe(3);
  });

  test("checks the schema and rolls the update back", () => {
    const realm = createRealm();
    const $count = schemaBox(realm, Schema.Int, 1);
    expect(() =>
      update(realm, (_read, write) => {
        write($count, 2);
        return write($count, 2.5);
      }),
    ).toThrow();
    expect(untracked(realm, (read) => read($count))).toBe(1);
  });

  test("a computed function on a SchemaModel instance is per instance", () => {
    class Holding extends SchemaModel<Holding>("Holding")({
      $amount: BoxField(Schema.Number),
    }) {
      readonly $valueAt = computedFunction(
        this.realm,
        (read, price: number) => read(this.$amount) * price,
      );
    }
    const realm = createRealm();
    const decodeHolding = decode(realm, Holding);
    const first = decodeHolding({ amount: 2 });
    const second = decodeHolding({ amount: 3 });
    expect(untracked(realm, (read) => read(first.$valueAt(10)))).toBe(20);
    expect(untracked(realm, (read) => read(second.$valueAt(10)))).toBe(30);
  });
});

describe("pinna's bare box", () => {
  test("refuses a schema left over from a call meant for this box", () => {
    const realm = createRealm();
    class Item extends Schema.Class<Item>("Item")({ name: Schema.String }) {}
    const message = "box takes a value, not a schema";
    expect(() => bareBox(realm, Schema.Struct({ name: Schema.String }), { name: "a" })).toThrow(
      message,
    );
    expect(() => bareBox(realm, Schema.UndefinedOr(Schema.String), undefined)).toThrow(message);
    expect(() => bareBox(realm, Item)).toThrow(message);
    expectRealmAtRest(realm);
  });
});
