import { describe, expect, test } from "bun:test";
import { equalKey, hashKey, schemaKey } from "@frondruntime/pinna/internal";
import { Equal, Hash, Schema } from "effect";
import { equalsOf } from "../../src/schema.ts";

/**
 * Internals: pinna-effect's own equality builder (`equalsOf`) against
 * Effect's, and the identity keys Pinna and Effect share. The public twin is
 * the equality a box shows: an equal write notifies nobody.
 */

describe("schema equality agrees with Effect's", () => {
  class Point extends Schema.Class<Point>("Point")({
    time: Schema.Date,
    value: Schema.Number,
  }) {}
  const at = (time: number | string): Date => new Date(time);
  const cases: ReadonlyArray<readonly [string, Schema.Top, unknown, unknown]> = [
    ["fresh equal Dates", Schema.Date, at(1), at(1)],
    ["different Dates", Schema.Date, at(1), at(2)],
    ["two invalid Dates", Schema.Date, at("nope"), at("nope")],
    ["an invalid and a valid Date", Schema.Date, at("nope"), at(1)],
    ["DateFromString's type side", Schema.DateFromString, at(5), at(5)],
    ["a Date and a non-Date", Schema.Date, at(1), 1],
    ["arrays of equal Dates", Schema.Array(Schema.Date), [at(1), at(2)], [at(1), at(2)]],
    ["arrays of different lengths", Schema.Array(Schema.Date), [at(1)], [at(1), at(2)]],
    ["arrays of NaN", Schema.Array(Schema.Number), [Number.NaN], [Number.NaN]],
    ["an array and a non-array", Schema.Array(Schema.Number), [1], { 0: 1, length: 1 }],
    [
      "equal structs",
      Schema.Struct({ at: Schema.Date, n: Schema.Number }),
      { at: at(1), n: 1 },
      { at: at(1), n: 1 },
    ],
    [
      "structs that differ in one field",
      Schema.Struct({ at: Schema.Date, n: Schema.Number }),
      { at: at(1), n: 1 },
      { at: at(1), n: 2 },
    ],
    [
      "an optional key present on one side only",
      Schema.Struct({ n: Schema.optionalKey(Schema.Number) }),
      { n: 1 },
      {},
    ],
    [
      "an optional key absent on both sides",
      Schema.Struct({ n: Schema.optionalKey(Schema.Number) }),
      {},
      {},
    ],
    [
      "classes with equal fields",
      Schema.Array(Point),
      [new Point({ time: at(1), value: 1 })],
      [new Point({ time: at(1), value: 1 })],
    ],
    [
      "classes with a different Date",
      Schema.Array(Point),
      [new Point({ time: at(1), value: 1 })],
      [new Point({ time: at(2), value: 1 })],
    ],
    ["a union", Schema.Union([Schema.Date, Schema.String]), at(1), at(1)],
    ["a record", Schema.Record(Schema.String, Schema.Date), { a: at(1) }, { a: at(1) }],
    ["a tuple", Schema.Tuple([Schema.Date, Schema.Number]), [at(1), 1], [at(1), 1]],
  ];

  for (const [name, schema, left, right] of cases) {
    test(name, () => {
      const effect = Schema.toEquivalence(schema as Schema.Schema<unknown>);
      expect(equalsOf<unknown>(schema)(left, right)).toBe(effect(left, right));
      expect(equalsOf<unknown>(schema)(right, left)).toBe(effect(right, left));
    });
  }
});

describe("identity under Effect's Equal", () => {
  test("Effect still uses the keys Pinna spells out", () => {
    expect(Equal.symbol).toBe(equalKey);
    expect(Hash.symbol).toBe(hashKey);
    expect(schemaKey in Schema.String).toBe(true);
    expect(Schema.isSchema({ [schemaKey]: schemaKey })).toBe(true);
  });
});
