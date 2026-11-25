import { describe, expect, test } from "bun:test";
import {
  Atom,
  Box,
  Collection,
  Computed,
  Realm,
  Stage,
  StageConflictError,
  View,
} from "../src/index.ts";
import { retainedKeys, testRealm } from "../src/testing/index.ts";

/** Visible stages over collections, row listeners, views, and atoms (ruling 68). */

interface Order {
  readonly id: string;
  readonly qty: number;
}

const setup = () => {
  const realm = testRealm();
  const $orders = Collection.make<string, Order>(realm, { keyOf: (row) => row.id, name: "orders" });
  Realm.update(realm, (_read, write) => {
    write.replaceAll($orders, [
      { id: "a", qty: 1 },
      { id: "b", qty: 2 },
    ]);
  });
  const rows = () => Realm.untracked(realm, (read) => read($orders.rows));
  const keys = () => Realm.untracked(realm, (read) => read($orders.keys));
  return { realm, $orders, rows, keys };
};

describe("collections under a visible stage", () => {
  test("an upsert, a change, and a removal show at once and leave on drop", () => {
    const { realm, $orders, rows, keys } = setup();
    const $a = $orders.row("a");
    const $c = $orders.row("c");
    const seenA: Array<Order | undefined> = [];
    const seenC: Array<Order | undefined> = [];
    const stopA = Realm.watch(
      realm,
      (read) => read($a),
      (value) => {
        seenA.push(value);
      },
    );
    const stopC = Realm.watch(
      realm,
      (read) => read($c),
      (value) => {
        seenC.push(value);
      },
    );
    const guess = Stage.make(realm, { name: "guess", visible: true });
    Stage.update(guess, (read, write) => {
      write.upsert($orders, { id: "c", qty: 3 });
      write.upsert($orders, { ...(read.row($orders, "a") as Order), qty: 10 });
      write.remove($orders, "b");
    });
    expect(keys()).toEqual(["c", "a"]);
    expect(rows()).toEqual([
      { id: "c", qty: 3 },
      { id: "a", qty: 10 },
    ]);
    expect(Realm.untracked(realm, (read) => read.row($orders, "b"))).toBeUndefined();
    expect(seenA).toEqual([{ id: "a", qty: 10 }]);
    expect(seenC).toEqual([{ id: "c", qty: 3 }]);
    // An update recipe reads the base rows.
    let inUpdate: unknown;
    Realm.update(realm, (read) => {
      inUpdate = [read($orders.keys), read.row($orders, "c"), read($orders.row("a"))];
    });
    expect(inUpdate).toEqual([["a", "b"], undefined, { id: "a", qty: 1 }]);
    expect(seenA.length).toBe(1);
    Stage.drop(guess);
    expect(keys()).toEqual(["a", "b"]);
    expect(rows()).toEqual([
      { id: "a", qty: 1 },
      { id: "b", qty: 2 },
    ]);
    expect(seenA).toEqual([
      { id: "a", qty: 10 },
      { id: "a", qty: 1 },
    ]);
    expect(seenC).toEqual([{ id: "c", qty: 3 }, undefined]);
    stopA();
    stopC();
    expect([...retainedKeys($orders)].sort()).toEqual(["a", "b"]);
    Realm.dispose(realm);
  });

  test("a refetch replaceAll under a guess keeps the guessed row", () => {
    const { realm, $orders, rows } = setup();
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (_read, write) =>
      write.upsert($orders, { id: "c", qty: 3 }, { at: "end" }),
    );
    Realm.update(realm, (_read, write) =>
      write.replaceAll($orders, [
        { id: "a", qty: 5 },
        { id: "b", qty: 6 },
      ]),
    );
    expect(rows()).toEqual([
      { id: "a", qty: 5 },
      { id: "b", qty: 6 },
      { id: "c", qty: 3 },
    ]);
    // The refetch confirms the row: the settle lands it and drops the guess.
    Realm.update(realm, (_read, write) => {
      write.upsert($orders, { id: "c", qty: 3 }, { at: "end" });
      Stage.drop(guess);
    });
    expect(rows()).toEqual([
      { id: "a", qty: 5 },
      { id: "b", qty: 6 },
      { id: "c", qty: 3 },
    ]);
    Realm.dispose(realm);
  });

  test("a base write to a row the guess did not write shows through", () => {
    const { realm, $orders, rows } = setup();
    const $b = $orders.row("b");
    const seen: Array<Order | undefined> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($b),
      (value) => {
        seen.push(value);
      },
    );
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (_read, write) => write.upsert($orders, { id: "a", qty: 9 }));
    Realm.update(realm, (_read, write) => write.upsert($orders, { id: "b", qty: 20 }));
    expect(rows()).toEqual([
      { id: "a", qty: 9 },
      { id: "b", qty: 20 },
    ]);
    expect(seen).toEqual([{ id: "b", qty: 20 }]);
    Stage.apply(guess);
    expect(rows()).toEqual([
      { id: "a", qty: 9 },
      { id: "b", qty: 20 },
    ]);
    stop();
    Realm.dispose(realm);
  });

  test("a row a reader made a cell for while it showed leaves with the guess, and the base can add it", () => {
    const { realm, $orders, keys } = setup();
    // Made outside the recipe, so each replay lands the same row.
    const guessed = { id: "c", qty: 3 };
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (_read, write) => write.upsert($orders, guessed));
    const $c = $orders.row("c");
    const seen: Array<Order | undefined> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($c),
      (value) => {
        seen.push(value);
      },
    );
    expect(Realm.untracked(realm, (read) => read($c))).toEqual({ id: "c", qty: 3 });
    // The base adds the key under the guess: the cell must not stand in the base.
    Realm.update(realm, (read, write) => {
      expect(read($c)).toBeUndefined();
      write.upsert($orders, { id: "c", qty: 30 }, { at: "end" });
      expect(read($c)).toEqual({ id: "c", qty: 30 });
    });
    expect(Realm.untracked(realm, (read) => read($c))).toEqual({ id: "c", qty: 3 });
    Stage.drop(guess);
    expect(Realm.untracked(realm, (read) => read($c))).toEqual({ id: "c", qty: 30 });
    expect(keys()).toEqual(["a", "b", "c"]);
    expect(seen).toEqual([{ id: "c", qty: 30 }]);
    stop();
    Realm.dispose(realm);
  });

  test("an update that changes nothing under the stack notifies nobody: box, collection, and view covered", () => {
    const { realm, $orders } = setup();
    const $unrelated = Box.make(realm, 0);
    const $label = Box.make(realm, "x");
    const view = View.ordered($orders, { compare: () => (left, right) => left.qty - right.qty });
    const runs = { rows: 0, label: 0, view: 0 };
    const stops = [
      Realm.watch(
        realm,
        (read) => read($orders.rows),
        () => {
          runs.rows++;
        },
      ),
      Realm.watch(
        realm,
        (read) => read($label),
        () => {
          runs.label++;
        },
      ),
      Realm.watch(
        realm,
        (read) => read(view.keys),
        () => {
          runs.view++;
        },
      ),
    ];
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (_read, write) => {
      write.upsert($orders, { id: "c", qty: 0 });
      write($label, "y");
    });
    expect(runs).toEqual({ rows: 1, label: 1, view: 1 });
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual(["c", "a", "b"]);
    Realm.update(realm, (_read, write) => write($unrelated, 1));
    Realm.update(realm, () => undefined);
    expect(runs).toEqual({ rows: 1, label: 1, view: 1 });
    Stage.drop(guess);
    expect(runs).toEqual({ rows: 2, label: 2, view: 2 });
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual(["a", "b"]);
    for (const stop of stops) stop();
    View.dispose(view);
    Realm.dispose(realm);
  });
});

describe("row listeners and views", () => {
  test("a listener runs in each replay; what it writes is covered and leaves with the stage", () => {
    const { realm, $orders } = setup();
    const $total = Box.make(realm, 0);
    const calls: Array<string> = [];
    const stop = Collection.onRowChange($orders, (change, read, write) => {
      calls.push(change.key);
      write($total, read($total) - (change.before?.qty ?? 0) + (change.after?.qty ?? 0));
    });
    calls.length = 0;
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (_read, write) => write.upsert($orders, { id: "c", qty: 4 }));
    expect(Realm.untracked(realm, (read) => read($total))).toBe(7);
    Realm.update(realm, (_read, write) => write.upsert($orders, { id: "a", qty: 11 }));
    // The base update and the replay over it each run the listener once.
    expect(calls).toEqual(["c", "a", "c"]);
    expect(Realm.untracked(realm, (read) => read($total))).toBe(17);
    Stage.drop(guess);
    expect(Realm.untracked(realm, (read) => read($total))).toBe(13);
    stop();
    Realm.dispose(realm);
  });

  test("a view made during a pending guess shows the guessed row and loses it on drop", () => {
    const { realm, $orders } = setup();
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (_read, write) => write.upsert($orders, { id: "c", qty: 0 }));
    const view = View.ordered($orders, { compare: () => (left, right) => left.qty - right.qty });
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual(["c", "a", "b"]);
    Stage.drop(guess);
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual(["a", "b"]);
    View.dispose(view);
    Realm.dispose(realm);
  });

  test("a view made before the guess shows the same", () => {
    const { realm, $orders } = setup();
    const view = View.ordered($orders, { compare: () => (left, right) => left.qty - right.qty });
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (_read, write) => write.upsert($orders, { id: "c", qty: 0 }));
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual(["c", "a", "b"]);
    Stage.drop(guess);
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual(["a", "b"]);
    View.dispose(view);
    Realm.dispose(realm);
  });

  test("a grouped view and totals follow a guess", () => {
    const { realm, $orders } = setup();
    const groups = View.grouped($orders, { groupOf: (row) => (row.qty > 1 ? "big" : "small") });
    const totals = View.totals($orders, {
      arithmetic: {
        zero: 0,
        add: (total: number, value: number) => total + value,
        subtract: (total: number, value: number) => total - value,
      },
      project: (row: Order) => ({ group: "all", value: row.qty }),
    });
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (_read, write) => write.upsert($orders, { id: "c", qty: 5 }));
    expect(Realm.untracked(realm, (read) => read(groups.group("big")))).toEqual(["b", "c"]);
    expect(Realm.untracked(realm, (read) => read(totals.group("all")))).toEqual({
      count: 3,
      total: 8,
    });
    Stage.drop(guess);
    expect(Realm.untracked(realm, (read) => read(groups.group("big")))).toEqual(["b"]);
    expect(Realm.untracked(realm, (read) => read(totals.group("all")))).toEqual({
      count: 2,
      total: 3,
    });
    View.dispose(groups);
    View.dispose(totals);
    Realm.dispose(realm);
  });

  test("a hidden stage that holds rows still refuses a new view (pinna/view-staged-rows)", () => {
    const { realm, $orders } = setup();
    const hidden = Stage.make(realm);
    Stage.update(hidden, (_read, write) => write.upsert($orders, { id: "c", qty: 0 }));
    expect(() =>
      View.ordered($orders, { compare: () => (left, right) => left.qty - right.qty }),
    ).toThrow("cannot start while a stage holds writes to its collection");
    Stage.drop(hidden);
    Realm.dispose(realm);
  });
});

describe("atoms", () => {
  test("a mark shows on entering and on leaving by a drop, and not again at apply", () => {
    using realm = testRealm();
    const $outside = Atom.make(realm);
    let runs = 0;
    const $reads = Computed.make(realm, (read) => {
      read($outside);
      return ++runs;
    });
    const stop = Realm.watch(
      realm,
      (read) => read($reads),
      () => undefined,
    );
    expect(runs).toBe(1);
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (_read, write) => write.changed($outside));
    expect(runs).toBe(2);
    Stage.drop(guess);
    expect(runs).toBe(3);
    const applied = Stage.make(realm, { visible: true });
    Stage.update(applied, (_read, write) => write.changed($outside));
    expect(runs).toBe(4);
    Stage.apply(applied);
    expect(runs).toBe(4);
    stop();
  });
});

describe("found by the fuzz", () => {
  test("an upper stage reads past an empty stage between it and a lower one", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 0);
    const lower = Stage.make(realm, { visible: true });
    Stage.update(lower, (_read, write) => write($count, 8));
    const empty = Stage.make(realm, { visible: true });
    const applied = Stage.make(realm, { visible: true });
    const upper = Stage.make(realm, { visible: true });
    Stage.apply(applied);
    Stage.update(upper, (_read, write) => write($count, 0));
    expect(Realm.untracked(realm, (read) => read($count))).toBe(0);
    for (const stage of [lower, empty, upper]) Stage.drop(stage);
  });

  test("a view replayed over a lower stage's overlay recomputes after each of the upper stage's writes", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 0);
    const rows = Collection.make<number, { id: number; value: number }>(realm, {
      keyOf: (row) => row.id,
    });
    const view = View.ordered(rows, { compare: () => (left, right) => left.value - right.value });
    const lower = Stage.make(realm, { visible: true });
    Stage.update(lower, (read, write) => write($count, read($count) + 3));
    Stage.update(lower, (_read, write) => write.upsert(rows, { id: 3, value: 4 }));
    Realm.update(realm, (_read, write) =>
      write.replaceAll(rows, [
        { id: 1, value: 4 },
        { id: 3, value: 4 },
      ]),
    );
    const upper = Stage.make(realm, { visible: true });
    Stage.update(upper, (_read, write) => write.upsert(rows, { id: 1, value: 7 }));
    Stage.update(upper, (_read, write) => write.upsert(rows, { id: 0, value: 3 }, { at: "end" }));
    // The lower stage changes: the upper one replays both upserts through the view.
    Stage.update(lower, (read, write) => write($count, read($count) + 2));
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual([0, 3, 1]);
    Stage.drop(upper);
    Stage.drop(lower);
    View.dispose(view);
  });
});

test('found by the fuzz: a row a lower guess wrote, read by a "fail" guess above, records the base', () => {
  using realm = testRealm();
  const rows = Collection.make<number, { id: number; value: number }>(realm, {
    keyOf: (row) => row.id,
  });
  Realm.update(realm, (_read, write) =>
    write.replaceAll(rows, [
      { id: 0, value: 2 },
      { id: 3, value: 2 },
    ]),
  );
  const lower = Stage.make(realm, { visible: true });
  Stage.update(lower, (_read, write) => write.remove(rows, 3));
  const upper = Stage.make(realm, { visible: true, conflicts: "fail" });
  Stage.update(upper, (read, write) => {
    const row = read.row(rows, 3);
    if (row !== undefined) write.upsert(rows, { id: 3, value: row.value + 1 });
  });
  expect(Stage.inspect(upper).read).toEqual(["a collection"]);
  Realm.update(realm, (_read, write) => write.upsert(rows, { id: 1, value: 2 }));
  expect(Stage.inspect(upper).showing).toBe(false);
  expect(() => Stage.apply(upper)).toThrow("changed since the stage read it");
  Stage.drop(lower);
});

describe("review findings on PR 20", () => {
  test("a fail stage over a lower stage's replaceAll conflicts when the base rows move", () => {
    using realm = testRealm();
    const $rows = Collection.make<string, { id: string; n: number }>(realm, {
      keyOf: (row) => row.id,
      name: "rows",
    });
    Realm.update(realm, (_read, write) => write.replaceAll($rows, [{ id: "a", n: 1 }]));
    const lower = Stage.make(realm, { visible: true });
    Stage.update(lower, (_read, write) =>
      write.replaceAll($rows, [
        { id: "a", n: 2 },
        { id: "b", n: 2 },
      ]),
    );
    const reader = Stage.make(realm, { visible: true, conflicts: "fail" });
    Stage.update(reader, (read, write) => {
      write.upsert($rows, { id: "c", n: read.row($rows, "a")?.n ?? 0 });
    });
    const blind = Stage.make(realm, { visible: true, conflicts: "fail" });
    Stage.update(blind, (_read, write) => write.upsert($rows, { id: "d", n: 0 }));
    Realm.update(realm, (_read, write) => write.upsert($rows, { id: "a", n: 9 }));
    for (const stage of [reader, blind]) {
      expect(Stage.inspect(stage).showing).toBe(false);
      expect(Stage.inspect(stage).failure).toBeInstanceOf(StageConflictError);
      Stage.drop(stage);
    }
    Stage.drop(lower);
  });

  test("a hidden child of a visible stage refuses a view, as any hidden stage does", () => {
    using realm = testRealm();
    const $rows = Collection.make<string, { id: string; n: number }>(realm, {
      keyOf: (row) => row.id,
    });
    const root = Stage.make(realm, { visible: true });
    const child = Stage.make(root);
    Stage.update(child, (_read, write) => write.upsert($rows, { id: "c", n: 1 }));
    expect(() => View.ordered($rows, { compare: () => (left, right) => left.n - right.n })).toThrow(
      "cannot start while a stage holds writes to its collection",
    );
    Stage.drop(root);
  });
});
