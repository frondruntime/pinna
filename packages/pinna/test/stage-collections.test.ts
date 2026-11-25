import { describe, expect, test } from "bun:test";
import { Atom, Box, Collection, Computed, type Read, Realm, Stage } from "../src/index.ts";
import { held, record, retainedKeys, testRealm } from "../src/testing/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * Collection and atom writes through a stage: the same check, equality, and
 * `Collection.onRowChange` reports as in an update, over the stage's rows, and landed
 * by the replay (`docs/api.md`, ruling 53).
 */

interface Item {
  readonly id: number;
  readonly price: number;
}

const items = (realm: Parameters<typeof Collection.make>[0]) =>
  Collection.make<number, Item>(realm, {
    keyOf: (item) => item.id,
    equals: (left, right) => left.id === right.id && left.price === right.price,
  });

describe("collection writes through a stage", () => {
  for (const verb of ["upsert", "remove", "replaceAll"] as const) {
    for (const copied of [false, true]) {
      test(`a caught ${verb} listener failure restores rows, listener writes, and caches (${copied ? "copied" : "first write"})`, () => {
        using realm = testRealm();
        const $items = items(realm);
        const $side = Collection.make<number, number>(realm, { keyOf: (value) => value });
        const $count = Box.make(realm, 0);
        const $progress = Box.make(realm, 0);
        const $summary = Computed.make(realm, (read) => [read($items.keys), read($count)]);
        Realm.update(realm, (_read, write) => {
          write.upsert($items, { id: 1, price: 1 });
        });
        using _ = held(
          Collection.onRowChange($items, (change, read, write) => {
            write($count, read($count) + 1);
            if ((change.key === 1 && change.after === undefined) || change.key === 2) {
              write.upsert($side, 2);
              read($summary);
              throw new Error("refused row");
            }
          }),
        );
        const stage = Stage.make(realm);
        const snapshot = (read: Read) => [
          read($items.keys),
          read($items.rows),
          read($count),
          read($side.keys),
          read($progress),
          read($summary),
        ];
        try {
          if (copied) {
            Stage.update(stage, (_read, write) => {
              write.upsert($items, { id: 1, price: 10 });
            });
          }
          Stage.update(stage, (read, write) => {
            write($progress, 1);
            expect(() => {
              if (verb === "upsert") write.upsert($items, { id: 2, price: 2 });
              if (verb === "remove") write.remove($items, 1);
              if (verb === "replaceAll") write.replaceAll($items, [{ id: 2, price: 2 }]);
            }).toThrow("refused row");
            expect(snapshot(read)).toEqual([
              [1],
              [{ id: 1, price: copied ? 10 : 1 }],
              copied ? 2 : 1,
              [],
              1,
              [[1], copied ? 2 : 1],
            ]);
            write.upsert($items, { id: 3, price: 3 });
          });
          const expected = [
            [3, 1],
            [
              { id: 3, price: 3 },
              { id: 1, price: copied ? 10 : 1 },
            ],
            copied ? 3 : 2,
            [],
            1,
            [[3, 1], copied ? 3 : 2],
          ];
          expect(Stage.read(stage, snapshot)).toEqual(expected);
          Stage.apply(stage);
          expect(Realm.untracked(realm, snapshot)).toEqual(expected);
        } finally {
          Stage.drop(stage);
        }
      });
    }
  }

  test("a refetch of 1,000 rows through replaceAll lands in one update, and the stage reads its own rows", () => {
    using realm = testRealm();
    const $items = items(realm);
    const initial = Array.from({ length: 1000 }, (_, id) => ({ id, price: id }));
    Realm.update(realm, (_read, write) => {
      write.replaceAll($items, initial);
    });
    using keyCounts = record(realm, (read) => read($items.keys).length);
    let rowsRuns = 0;
    using _ = held(
      Realm.autorun(realm, (read) => {
        read($items.rows);
        rowsRuns++;
        return undefined;
      }),
    );
    const refetch = Array.from({ length: 1000 }, (_, index) => ({
      id: index + 500,
      price: index % 2 === 0 ? index + 500 : 0,
    }));
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write.replaceAll($items, refetch);
    });
    expect(Stage.read(stage, (read) => [read($items.keys).length, read.row($items, 501)])).toEqual([
      1000,
      { id: 501, price: 0 },
    ]);
    expect(Realm.untracked(realm, (read) => read.row($items, 0))).toEqual({ id: 0, price: 0 });
    expect(rowsRuns).toBe(1);
    Stage.apply(stage);
    expect(rowsRuns).toBe(2);
    expect(keyCounts.values).toEqual([]);
    expect(Realm.untracked(realm, (read) => [read($items.keys)[0], read.row($items, 501)])).toEqual(
      [500, { id: 501, price: 0 }],
    );
    // A row equal to the one held stays the same object.
    const kept = initial[600] as Item;
    expect(Realm.untracked(realm, (read) => read.row($items, 600))).toBe(kept);
    expect(retainedKeys($items).size).toBe(1000);
  });

  test("a replaceAll that changes nothing leaves the stage's overlay and cache as they were", () => {
    using realm = testRealm();
    const $items = items(realm);
    const rows = [
      { id: 1, price: 1 },
      { id: 2, price: 2 },
    ];
    Realm.update(realm, (_read, write) => {
      write.replaceAll($items, rows);
    });
    let runs = 0;
    const $sum = Computed.make(realm, (read) => {
      runs++;
      return read($items.rows).reduce((total, item) => total + item.price, 0);
    });
    const stage = Stage.make(realm);
    expect(Stage.read(stage, (read) => read($sum))).toBe(3);
    Stage.update(stage, (_read, write) => {
      write.replaceAll($items, [
        { id: 1, price: 1 },
        { id: 2, price: 2 },
      ]);
    });
    expect(Stage.read(stage, (read) => read($sum))).toBe(3);
    expect(runs).toBe(1);
    expect(Stage.inspect(stage).collections).toEqual([]);
    // The same rows in another order stage the order alone.
    Stage.update(stage, (_read, write) => {
      write.replaceAll($items, [rows[1] as Item, rows[0] as Item]);
    });
    expect(Stage.read(stage, (read) => [read($items.keys), read($sum)])).toEqual([[2, 1], 3]);
    Stage.drop(stage);
  });

  test("a row equal to the one held keeps the held object through the stage", () => {
    using realm = testRealm();
    const $items = items(realm);
    const row = { id: 1, price: 1 };
    Realm.update(realm, (_read, write) => {
      write.upsert($items, row);
    });
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write.upsert($items, { id: 1, price: 1 });
    });
    expect(Stage.read(stage, (read) => read.row($items, 1))).toBe(row);
    Stage.drop(stage);
  });

  test("an undefined row throws, as in an update, and leaves the stage's rows as they were", () => {
    using realm = testRealm();
    const $items = items(realm);
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write.upsert($items, { id: 1, price: 1 });
    });
    expect(() =>
      Stage.update(stage, (_read, write) => {
        write.upsert($items, undefined as unknown as Item);
      }),
    ).toThrow("pinna: a collection row cannot be undefined");
    expect(() =>
      Stage.update(stage, (_read, write) => {
        write.replaceAll($items, [{ id: 2, price: 2 }, undefined as unknown as Item]);
      }),
    ).toThrow("pinna: a collection row cannot be undefined");
    expect(Stage.read(stage, (read) => read($items.keys))).toEqual([1]);
    Stage.drop(stage);
  });

  test("a repeated key throws and leaves the stage's rows as they were", () => {
    using realm = testRealm();
    const $items = items(realm);
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write.upsert($items, { id: 1, price: 1 });
    });
    expect(() =>
      Stage.update(stage, (_read, write) => {
        write.upsert($items, { id: 2, price: 2 });
        write.replaceAll($items, [
          { id: 3, price: 3 },
          { id: 3, price: 4 },
        ]);
      }),
    ).toThrow("pinna: the collection key 3 appears twice");
    expect(Stage.read(stage, (read) => read($items.keys))).toEqual([1]);
    Stage.drop(stage);
  });

  test("a throwing recipe puts back the rows, the order, and a collection it first wrote", () => {
    using realm = testRealm();
    const $items = items(realm);
    Realm.update(realm, (_read, write) => {
      write.upsert($items, { id: 1, price: 1 });
    });
    const stage = Stage.make(realm);
    expect(() =>
      Stage.update(stage, (_read, write) => {
        write.upsert($items, { id: 2, price: 2 });
        write.remove($items, 1);
        throw new Error("refused");
      }),
    ).toThrow("refused");
    expect(Stage.read(stage, (read) => [read($items.keys), read($items.rows)])).toEqual([
      [1],
      [{ id: 1, price: 1 }],
    ]);
    Stage.drop(stage);
    expect(Realm.untracked(realm, (read) => read($items.keys))).toEqual([1]);
  });

  test("onRowChange listeners run with the stage's read and write, and again on replay", () => {
    using realm = testRealm();
    const $items = items(realm);
    const $total = Box.make(realm, 0);
    const stop = Collection.onRowChange($items, (change, read, write) => {
      write($total, read($total) - (change.before?.price ?? 0) + (change.after?.price ?? 0));
    });
    using _ = held(stop);
    using totals = record(realm, (read) => read($total));
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write.upsert($items, { id: 1, price: 5 });
      write.upsert($items, { id: 2, price: 7 });
    });
    expect(Stage.read(stage, (read) => read($total))).toBe(12);
    expect(Realm.untracked(realm, (read) => read($total))).toBe(0);
    Stage.update(stage, (_read, write) => {
      write.remove($items, 1);
    });
    expect(Stage.read(stage, (read) => read($total))).toBe(7);
    Stage.apply(stage);
    expect(totals.values).toEqual([7]);
  });

  test("a listener that writes its own collection through a stage throws", () => {
    using realm = testRealm();
    const $items = items(realm);
    using _ = held(
      Collection.onRowChange($items, (change, _read, write) => {
        if (change.after !== undefined && change.after.price > 0) {
          write.upsert($items, { id: change.key, price: 0 });
        }
      }),
    );
    const stage = Stage.make(realm);
    expect(() =>
      Stage.update(stage, (_read, write) => {
        write.upsert($items, { id: 1, price: 5 });
      }),
    ).toThrow(
      "pinna: write.upsert on the collection a Collection.onRowChange listener is reporting",
    );
    expect(Stage.read(stage, (read) => read($items.keys))).toEqual([]);
    Stage.drop(stage);
  });

  test("a collection of another realm throws", () => {
    using ui = testRealm({ name: "ui" });
    using quotes = testRealm({ name: "quotes" });
    const $theirs = items(quotes);
    const stage = Stage.make(ui);
    expect(() =>
      Stage.update(stage, (_read, write) => {
        write.upsert($theirs, { id: 1, price: 1 });
      }),
    ).toThrow('is handed an observable of another realm (realm "quotes", not "ui")');
    Stage.drop(stage);
  });
});

describe("an atom through a stage", () => {
  test("write.changed is kept for the replay: what observed the atom reruns once, when applied", () => {
    using realm = testRealm();
    const $feed = Atom.make(realm);
    let runs = 0;
    using _ = held(
      Realm.autorun(realm, (read) => {
        read($feed);
        runs++;
        return undefined;
      }),
    );
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write.changed($feed);
    });
    expect(runs).toBe(1);
    Stage.apply(stage);
    expect(runs).toBe(2);
    expectRealmAtRest(realm);
  });
});
