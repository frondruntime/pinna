import { describe, expect, test } from "bun:test";
import {
  Atom,
  Box,
  Collection,
  Computed,
  Model,
  type Read,
  Realm,
  Source,
  Stage,
  type UpdateRecipe,
  type Write,
} from "../src/index.ts";
import { testRealm } from "../src/testing/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * A recipe runs twice, once staged and once applied, so it reads and writes
 * only through what it is handed. What would act on the realm around the
 * stage, or make something twice, throws inside it (`docs/api.md`, ruling 53).
 */

describe("inside a stage recipe", () => {
  for (const place of ["recipe", "stageRead"] as const) {
    test(`making a plain model in ${place} throws before its initializers`, () => {
      using realm = testRealm();
      let initializers = 0;
      class Item extends Model.Class {
        readonly id = ++initializers;
      }
      const stage = Stage.make(realm);
      try {
        const make = (): undefined => {
          new Item(realm);
        };
        expect(() =>
          place === "recipe" ? Stage.update(stage, make) : Stage.read(stage, make),
        ).toThrow("pinna: a model is made inside a stage recipe");
        expect(initializers).toBe(0);
      } finally {
        Stage.drop(stage);
      }
      expect(new Item(realm).id).toBe(1);
    });

    for (const [name, query] of [
      ["Stage.status", Stage.status],
      ["Stage.inspect", Stage.inspect],
    ] as const) {
      test(`${name} refuses ${place} and remains callable after closing`, () => {
        using realm = testRealm();
        const stage = Stage.make(realm);
        try {
          const inspect = (): undefined => {
            query(stage);
          };
          expect(() =>
            place === "recipe" ? Stage.update(stage, inspect) : Stage.read(stage, inspect),
          ).toThrow(`pinna: ${name} runs inside a stage recipe`);
        } finally {
          Stage.drop(stage);
        }
        expect(Stage.status(stage)).toBe("dropped");
        expect(Stage.inspect(stage).status).toBe("dropped");
      });
    }
  }

  test("update writing the realm throws, and nothing reaches the realm", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $b = Box.make(realm, 1);
    const stage = Stage.make(realm);
    expect(() =>
      Stage.update(stage, (_read, write) => {
        write($a, 2);
        Realm.update(realm, (_outerRead, outerWrite) => {
          outerWrite($b, 2);
        });
      }),
    ).toThrow(
      "pinna: a stage recipe writes the realm, through Realm.update or a write kept from one",
    );
    expect(Realm.untracked(realm, (read) => [read($a), read($b)])).toEqual([1, 1]);
    expect(Stage.read(stage, (read) => read($a))).toBe(1);
    Stage.drop(stage);
    expectRealmAtRest(realm);
  });

  test("a write kept from an open update throws", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const stage = Stage.make(realm);
    Realm.update(realm, (_read, outerWrite) => {
      expect(() =>
        Stage.update(stage, () => {
          outerWrite($a, 2);
        }),
      ).toThrow("pinna: a stage recipe writes the realm");
    });
    expect(Realm.untracked(realm, (read) => read($a))).toBe(1);
    Stage.drop(stage);
  });

  test("a read kept from an open place, and untracked, throw: they would skip the stage's values", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1, { name: "a" });
    const $rows = Collection.make<string, string>(realm, { keyOf: (row) => row });
    const stage = Stage.make(realm);
    Realm.update(realm, (outerRead) => {
      expect(() =>
        Stage.update(stage, () => {
          outerRead($a);
        }),
      ).toThrow('pinna: read("a") of the realm runs inside a stage recipe');
      expect(() =>
        Stage.update(stage, () => {
          outerRead.row($rows, "x");
        }),
      ).toThrow("pinna: read.row of the realm runs inside a stage recipe");
    });
    expect(() =>
      Stage.update(stage, () => {
        Realm.untracked(realm, (read) => read($a));
      }),
    ).toThrow("pinna: Realm.untracked of the realm runs inside a stage recipe");
    expect(() => Stage.read(stage, () => Realm.untracked(realm, (read) => read($a)))).toThrow(
      "pinna: Realm.untracked of the realm runs inside a stage recipe",
    );
    Stage.drop(stage);
  });

  test("making an observable throws: the replay would make another", () => {
    using realm = testRealm();
    class Todo extends Model.Class {
      readonly $done = Box.make(this.realm, false);
    }
    const stage = Stage.make(realm);
    const makers: ReadonlyArray<readonly [string, () => unknown]> = [
      ["a box", () => Box.make(realm, 0)],
      ["a model", () => new Todo(realm)],
      ["a computed value", () => Computed.make(realm, () => 1)],
      ["a computed function", () => Computed.fn(realm, () => 1)],
      ["an atom", () => Atom.make(realm)],
      ["a collection", () => Collection.make(realm, { keyOf: (row: string) => row })],
    ];
    for (const [what, make] of makers) {
      expect(() =>
        Stage.update(stage, () => {
          make();
        }),
      ).toThrow(`pinna: ${what} is made inside a stage recipe`);
    }
    Stage.drop(stage);
  });

  test("a watch, an autorun, an observe, an onObserved hook, and an onRowChange listener throw", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $rows = Collection.make<string, string>(realm, { keyOf: (row) => row });
    const stage = Stage.make(realm);
    const starts: ReadonlyArray<readonly [string, () => unknown]> = [
      [
        "a stage recipe cannot observe",
        () =>
          Realm.watch(
            realm,
            (read) => read($a),
            () => undefined,
          ),
      ],
      ["a stage recipe cannot observe", () => Realm.autorun(realm, () => undefined)],
      ["a stage recipe cannot observe", () => Source.observe($a)],
      [
        "Source.onObserved runs inside a stage recipe",
        () => Source.onObserved($a, () => undefined),
      ],
      [
        "Collection.onRowChange runs inside a stage recipe",
        () => Collection.onRowChange($rows, () => undefined),
      ],
    ];
    for (const [message, start] of starts) {
      expect(() =>
        Stage.update(stage, () => {
          start();
        }),
      ).toThrow(message);
    }
    Stage.drop(stage);
    expectRealmAtRest(realm);
  });

  test("a computed function read with new arguments, and a collection's row, are reads: they work", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 2);
    const times = Computed.fn(realm, (read, factor: number) => read($count) * factor);
    const $rows = Collection.make<string, string>(realm, { keyOf: (row) => row });
    const stage = Stage.make(realm);
    Stage.update(stage, (read, write) => {
      write($count, read(times(7)) + (read($rows.row("x")) === undefined ? 0 : 1));
    });
    expect(Stage.read(stage, (read) => read($count))).toBe(14);
    Stage.drop(stage);
  });

  test("a Recipe returned by a model method runs through update and through a stage alike", () => {
    using realm = testRealm();
    class Cart extends Model.Class {
      readonly $count = Box.make(this.realm, 0);
      add(amount: number): UpdateRecipe {
        return (read: Read, write: Write) => write(this.$count, read(this.$count) + amount);
      }
    }
    const cart = new Cart(realm);
    Realm.update(realm, cart.add(1));
    const stage = Stage.make(realm);
    Stage.update(stage, cart.add(2));
    expect(Stage.read(stage, (read) => read(cart.$count))).toBe(3);
    expect(Realm.untracked(realm, (read) => read(cart.$count))).toBe(1);
    Stage.drop(stage);
  });
});
