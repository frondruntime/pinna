import { describe, expect, test } from "bun:test";
import { Stage } from "../../src/index.ts";
import { makeBox } from "../../src/internal/index.ts";
import { testRealm } from "../../src/testing/index.ts";

/** Internals: a box over a custom check, made with `makeBox`. The public form is `Box.schema` in pinna-effect. */

describe("box equality through a stage", () => {
  test("a staged write skips identical values and checks before comparing equal values", () => {
    using realm = testRealm();
    const calls: Array<string> = [];
    const initial = { id: 1, valid: true };
    const $value = makeBox(
      realm,
      (value) => {
        calls.push("check");
        return (value as typeof initial).valid
          ? undefined
          : { message: "invalid", cause: undefined };
      },
      (left, right) => {
        calls.push("equals");
        return left.id === right.id;
      },
      initial,
      undefined,
    );
    calls.length = 0;
    const stage = Stage.make(realm);
    try {
      Stage.update(stage, (_read, write) => {
        write($value, initial);
        expect(calls).toEqual([]);
        expect(() => write($value, { id: 1, valid: false })).toThrow("invalid");
        expect(calls).toEqual(["check"]);
        calls.length = 0;
        write($value, { id: 1, valid: true });
        expect(calls).toEqual(["check", "equals"]);
      });
      expect(Stage.read(stage, (read) => read($value))).toBe(initial);
      expect(Stage.inspect(stage).boxes).toEqual([]);
    } finally {
      Stage.drop(stage);
    }
  });
});
