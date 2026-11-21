import { describe, expect, test } from "bun:test";
import {
  applyStage,
  atom,
  autorun,
  box,
  collection,
  computed,
  dropStage,
  inspectStage,
  onRowChange,
  openStage,
  stageRead,
  stageUpdate,
  untracked,
  update,
} from "../src/index.ts";
import { held, record, retainedKeys, testRealm } from "../src/testing/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * Collection and atom writes through a stage: the same check, equality, and
 * `onRowChange` reports as in an update, over the stage's rows, and landed
 * by the replay (`docs/api.md`, ruling 53).
 */

interface Item {
  readonly id: number;
  readonly price: number;
}

const items = (realm: Parameters<typeof collection>[0]) =>
  collection<number, Item>(realm, {
    keyOf: (item) => item.id,
    equals: (left, right) => left.id === right.id && left.price === right.price,
  });

describe("collection writes through a stage", () => {
  test("a refetch of 1,000 rows through replaceAll lands in one update, and the stage reads its own rows", () => {
    using realm = testRealm();
    const $items = items(realm);
    const initial = Array.from({ length: 1000 }, (_, id) => ({ id, price: id }));
    update(realm, (_read, write) => {
      write.replaceAll($items, initial);
    });
    using keyCounts = record(realm, (read) => read($items.keys).length);
    let rowsRuns = 0;
    using _ = held(
      autorun(realm, (read) => {
        read($items.rows);
        rowsRuns++;
        return undefined;
      }),
    );
    const refetch = Array.from({ length: 1000 }, (_, index) => ({
      id: index + 500,
      price: index % 2 === 0 ? index + 500 : 0,
    }));
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write.replaceAll($items, refetch);
    });
    expect(stageRead(stage, (read) => [read($items.keys).length, read.row($items, 501)])).toEqual([
      1000,
      { id: 501, price: 0 },
    ]);
    expect(untracked(realm, (read) => read.row($items, 0))).toEqual({ id: 0, price: 0 });
    expect(rowsRuns).toBe(1);
    applyStage(stage);
    expect(rowsRuns).toBe(2);
    expect(keyCounts.values).toEqual([]);
    expect(untracked(realm, (read) => [read($items.keys)[0], read.row($items, 501)])).toEqual([
      500,
      { id: 501, price: 0 },
    ]);
    // A row equal to the one held stays the same object.
    const kept = initial[600] as Item;
    expect(untracked(realm, (read) => read.row($items, 600))).toBe(kept);
    expect(retainedKeys($items).size).toBe(1000);
  });

  test("a replaceAll that changes nothing leaves the stage's overlay and cache as they were", () => {
    using realm = testRealm();
    const $items = items(realm);
    const rows = [
      { id: 1, price: 1 },
      { id: 2, price: 2 },
    ];
    update(realm, (_read, write) => {
      write.replaceAll($items, rows);
    });
    let runs = 0;
    const $sum = computed(realm, (read) => {
      runs++;
      return read($items.rows).reduce((total, item) => total + item.price, 0);
    });
    const stage = openStage(realm);
    expect(stageRead(stage, (read) => read($sum))).toBe(3);
    stageUpdate(stage, (_read, write) => {
      write.replaceAll($items, [
        { id: 1, price: 1 },
        { id: 2, price: 2 },
      ]);
    });
    expect(stageRead(stage, (read) => read($sum))).toBe(3);
    expect(runs).toBe(1);
    expect(inspectStage(stage).collections).toBe(0);
    // The same rows in another order stage the order alone.
    stageUpdate(stage, (_read, write) => {
      write.replaceAll($items, [rows[1] as Item, rows[0] as Item]);
    });
    expect(stageRead(stage, (read) => [read($items.keys), read($sum)])).toEqual([[2, 1], 3]);
    dropStage(stage);
  });

  test("a row equal to the one held keeps the held object through the stage", () => {
    using realm = testRealm();
    const $items = items(realm);
    const row = { id: 1, price: 1 };
    update(realm, (_read, write) => {
      write.upsert($items, row);
    });
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write.upsert($items, { id: 1, price: 1 });
    });
    expect(stageRead(stage, (read) => read.row($items, 1))).toBe(row);
    dropStage(stage);
  });

  test("a repeated key throws and leaves the stage's rows as they were", () => {
    using realm = testRealm();
    const $items = items(realm);
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write.upsert($items, { id: 1, price: 1 });
    });
    expect(() =>
      stageUpdate(stage, (_read, write) => {
        write.upsert($items, { id: 2, price: 2 });
        write.replaceAll($items, [
          { id: 3, price: 3 },
          { id: 3, price: 4 },
        ]);
      }),
    ).toThrow("pinna: the collection key 3 appears twice");
    expect(stageRead(stage, (read) => read($items.keys))).toEqual([1]);
    dropStage(stage);
  });

  test("a throwing recipe puts back the rows, the order, and a collection it first wrote", () => {
    using realm = testRealm();
    const $items = items(realm);
    update(realm, (_read, write) => {
      write.upsert($items, { id: 1, price: 1 });
    });
    const stage = openStage(realm);
    expect(() =>
      stageUpdate(stage, (_read, write) => {
        write.upsert($items, { id: 2, price: 2 });
        write.remove($items, 1);
        throw new Error("refused");
      }),
    ).toThrow("refused");
    expect(stageRead(stage, (read) => [read($items.keys), read($items.rows)])).toEqual([
      [1],
      [{ id: 1, price: 1 }],
    ]);
    dropStage(stage);
    expect(untracked(realm, (read) => read($items.keys))).toEqual([1]);
  });

  test("onRowChange listeners run with the stage's read and write, and again on replay", () => {
    using realm = testRealm();
    const $items = items(realm);
    const $total = box(realm, 0);
    const stop = onRowChange($items, (change, read, write) => {
      write($total, read($total) - (change.before?.price ?? 0) + (change.after?.price ?? 0));
    });
    using _ = held(stop);
    using totals = record(realm, (read) => read($total));
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write.upsert($items, { id: 1, price: 5 });
      write.upsert($items, { id: 2, price: 7 });
    });
    expect(stageRead(stage, (read) => read($total))).toBe(12);
    expect(untracked(realm, (read) => read($total))).toBe(0);
    stageUpdate(stage, (_read, write) => {
      write.remove($items, 1);
    });
    expect(stageRead(stage, (read) => read($total))).toBe(7);
    applyStage(stage);
    expect(totals.values).toEqual([7]);
  });

  test("a listener that writes its own collection through a stage throws", () => {
    using realm = testRealm();
    const $items = items(realm);
    using _ = held(
      onRowChange($items, (change, _read, write) => {
        if (change.after !== undefined && change.after.price > 0) {
          write.upsert($items, { id: change.key, price: 0 });
        }
      }),
    );
    const stage = openStage(realm);
    expect(() =>
      stageUpdate(stage, (_read, write) => {
        write.upsert($items, { id: 1, price: 5 });
      }),
    ).toThrow("pinna: write.upsert on the collection an onRowChange listener is reporting");
    expect(stageRead(stage, (read) => read($items.keys))).toEqual([]);
    dropStage(stage);
  });

  test("a collection of another realm throws", () => {
    using ui = testRealm({ name: "ui" });
    using quotes = testRealm({ name: "quotes" });
    const $theirs = items(quotes);
    const stage = openStage(ui);
    expect(() =>
      stageUpdate(stage, (_read, write) => {
        write.upsert($theirs, { id: 1, price: 1 });
      }),
    ).toThrow('is handed an observable of another realm (realm "quotes", not "ui")');
    dropStage(stage);
  });
});

describe("an atom through a stage", () => {
  test("write.changed is kept for the replay: what observed the atom reruns once, when applied", () => {
    using realm = testRealm();
    const $feed = atom(realm);
    let runs = 0;
    using _ = held(
      autorun(realm, (read) => {
        read($feed);
        runs++;
        return undefined;
      }),
    );
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write.changed($feed);
    });
    expect(runs).toBe(1);
    applyStage(stage);
    expect(runs).toBe(2);
    expectRealmAtRest(realm);
  });
});
