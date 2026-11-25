import { describe, expect, test } from "bun:test";
import { type Box, Realm, Stage } from "../../src/index.ts";
import { type Check, makeBox } from "../../src/internal/index.ts";
import { testRealm } from "../../src/testing/index.ts";

/** Internals: a box over a custom check, made with `makeBox`. The public form is `Box.schema` in pinna-effect. */

/** A box over `check`, as pinna-effect's `Box.schema` builds one over its schema. */
const makeCheckedBox = <Value>(realm: Realm, initial: Value, check: Check): Box<Value> =>
  makeBox(realm, check, Object.is, initial, undefined);

describe("stageUpdate", () => {
  test("a schema box's check runs at stageUpdate, against the staged value", () => {
    using realm = testRealm();
    const rejects = { message: "not positive", cause: undefined };
    const checks: Array<[unknown, unknown]> = [];
    const $positive = makeCheckedBox(realm, 1, (value, previous) => {
      checks.push([value, previous]);
      return typeof value === "number" && value > 0 ? undefined : rejects;
    });
    // Making the box checked its initial value.
    expect(checks).toEqual([[1, undefined]]);
    checks.length = 0;
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write($positive, 5);
    });
    expect(() =>
      Stage.update(stage, (_read, write) => {
        write($positive, -1);
      }),
    ).toThrow("pinna: the box rejects this value: not positive");
    expect(checks).toEqual([
      [5, 1],
      [-1, 5],
    ]);
    expect(Stage.read(stage, (read) => read($positive))).toBe(5);
    Stage.apply(stage);
    // Checked again where it lands, against the realm's value.
    expect(checks.at(-1)).toEqual([5, 1]);
    expect(Realm.untracked(realm, (read) => read($positive))).toBe(5);
  });
});
