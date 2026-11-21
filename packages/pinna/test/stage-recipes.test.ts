import { describe, expect, test } from "bun:test";
import {
  atom,
  autorun,
  box,
  collection,
  computed,
  computedFunction,
  dropStage,
  Model,
  observe,
  onObserved,
  onRowChange,
  openStage,
  type Read,
  type Recipe,
  stageRead,
  stageUpdate,
  untracked,
  update,
  type Write,
  watch,
} from "../src/index.ts";
import { testRealm } from "../src/testing/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * A recipe runs twice, once staged and once applied, so it reads and writes
 * only through what it is handed. What would act on the realm around the
 * stage, or make something twice, throws inside it (`docs/api.md`, ruling 53).
 */

describe("inside a stage recipe", () => {
  test("update writing the realm throws, and nothing reaches the realm", () => {
    using realm = testRealm();
    const $a = box(realm, 1);
    const $b = box(realm, 1);
    const stage = openStage(realm);
    expect(() =>
      stageUpdate(stage, (_read, write) => {
        write($a, 2);
        update(realm, (_outerRead, outerWrite) => {
          outerWrite($b, 2);
        });
      }),
    ).toThrow("pinna: a stage recipe writes the realm, through update or a write kept from one");
    expect(untracked(realm, (read) => [read($a), read($b)])).toEqual([1, 1]);
    expect(stageRead(stage, (read) => read($a))).toBe(1);
    dropStage(stage);
    expectRealmAtRest(realm);
  });

  test("a write kept from an open update throws", () => {
    using realm = testRealm();
    const $a = box(realm, 1);
    const stage = openStage(realm);
    update(realm, (_read, outerWrite) => {
      expect(() =>
        stageUpdate(stage, () => {
          outerWrite($a, 2);
        }),
      ).toThrow("pinna: a stage recipe writes the realm");
    });
    expect(untracked(realm, (read) => read($a))).toBe(1);
    dropStage(stage);
  });

  test("a read kept from an open place, and untracked, throw: they would skip the stage's values", () => {
    using realm = testRealm();
    const $a = box(realm, 1, { name: "a" });
    const $rows = collection<string, string>(realm, { keyOf: (row) => row });
    const stage = openStage(realm);
    update(realm, (outerRead) => {
      expect(() =>
        stageUpdate(stage, () => {
          outerRead($a);
        }),
      ).toThrow('pinna: read("a") of the realm runs inside a stage recipe');
      expect(() =>
        stageUpdate(stage, () => {
          outerRead.row($rows, "x");
        }),
      ).toThrow("pinna: read.row of the realm runs inside a stage recipe");
    });
    expect(() =>
      stageUpdate(stage, () => {
        untracked(realm, (read) => read($a));
      }),
    ).toThrow("pinna: untracked of the realm runs inside a stage recipe");
    expect(() => stageRead(stage, () => untracked(realm, (read) => read($a)))).toThrow(
      "pinna: untracked of the realm runs inside a stage recipe",
    );
    dropStage(stage);
  });

  test("making an observable throws: the replay would make another", () => {
    using realm = testRealm();
    class Todo extends Model {
      readonly $done = box(this.realm, false);
    }
    const stage = openStage(realm);
    const makers: ReadonlyArray<readonly [string, () => unknown]> = [
      ["a box", () => box(realm, 0)],
      ["a box", () => new Todo(realm)],
      ["a computed value", () => computed(realm, () => 1)],
      ["a computed function", () => computedFunction(realm, () => 1)],
      ["an atom", () => atom(realm)],
      ["a collection", () => collection(realm, { keyOf: (row: string) => row })],
    ];
    for (const [what, make] of makers) {
      expect(() =>
        stageUpdate(stage, () => {
          make();
        }),
      ).toThrow(`pinna: ${what} is made inside a stage recipe`);
    }
    dropStage(stage);
  });

  test("a watch, an autorun, an observe, an onObserved hook, and an onRowChange listener throw", () => {
    using realm = testRealm();
    const $a = box(realm, 1);
    const $rows = collection<string, string>(realm, { keyOf: (row) => row });
    const stage = openStage(realm);
    const starts: ReadonlyArray<readonly [string, () => unknown]> = [
      [
        "a stage recipe cannot observe",
        () =>
          watch(
            realm,
            (read) => read($a),
            () => undefined,
          ),
      ],
      ["a stage recipe cannot observe", () => autorun(realm, () => undefined)],
      ["a stage recipe cannot observe", () => observe($a)],
      ["onObserved runs inside a stage recipe", () => onObserved($a, () => undefined)],
      ["onRowChange runs inside a stage recipe", () => onRowChange($rows, () => undefined)],
    ];
    for (const [message, start] of starts) {
      expect(() =>
        stageUpdate(stage, () => {
          start();
        }),
      ).toThrow(message);
    }
    dropStage(stage);
    expectRealmAtRest(realm);
  });

  test("a computed function read with new arguments, and a collection's row, are reads: they work", () => {
    using realm = testRealm();
    const $count = box(realm, 2);
    const times = computedFunction(realm, (read, factor: number) => read($count) * factor);
    const $rows = collection<string, string>(realm, { keyOf: (row) => row });
    const stage = openStage(realm);
    stageUpdate(stage, (read, write) => {
      write($count, read(times(7)) + (read($rows.row("x")) === undefined ? 0 : 1));
    });
    expect(stageRead(stage, (read) => read($count))).toBe(14);
    dropStage(stage);
  });

  test("a Recipe returned by a model method runs through update and through a stage alike", () => {
    using realm = testRealm();
    class Cart extends Model {
      readonly $count = box(this.realm, 0);
      add(amount: number): Recipe {
        return (read: Read, write: Write) => write(this.$count, read(this.$count) + amount);
      }
    }
    const cart = new Cart(realm);
    update(realm, cart.add(1));
    const stage = openStage(realm);
    stageUpdate(stage, cart.add(2));
    expect(stageRead(stage, (read) => read(cart.$count))).toBe(3);
    expect(untracked(realm, (read) => read(cart.$count))).toBe(1);
    dropStage(stage);
  });
});
