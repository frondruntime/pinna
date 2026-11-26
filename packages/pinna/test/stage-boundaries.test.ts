import { describe, expect, test } from "bun:test";
import { Atom, Box, Collection, Realm, Source, Stage, StageConflictError } from "../src/index.ts";
import { retainedKeys, testRealm } from "../src/testing/index.ts";

/**
 * Stages where they meet the rest of the realm: a key the stage adds and
 * removes, a fail stage's reads on replay, atom marks and conflicts, what a
 * dropped or failed recipe keeps, and an `onError` handler that writes or
 * drops a stage while the visible stack replays.
 */

describe("a hidden stage's key order", () => {
  test("a NaN key added and removed lands as no key and no row", () => {
    using realm = testRealm();
    const $rows = Collection.make<number, number>(realm, { keyOf: (value) => value });
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write.upsert($rows, Number.NaN);
      write.remove($rows, Number.NaN);
    });
    Stage.apply(stage);
    expect(Realm.untracked(realm, (read) => [read($rows.keys), read($rows.rows)])).toEqual([
      [],
      [],
    ]);
  });

  test("a NaN key removed and added again lands once", () => {
    using realm = testRealm();
    const $rows = Collection.make<number, number>(realm, { keyOf: (value) => value });
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write.upsert($rows, Number.NaN);
      write.remove($rows, Number.NaN);
      write.upsert($rows, Number.NaN);
    });
    Stage.apply(stage);
    expect(Realm.untracked(realm, (read) => [read($rows.keys), read($rows.rows)])).toEqual([
      [Number.NaN],
      [Number.NaN],
    ]);
  });
});

describe("a visible fail stage's replay", () => {
  test("a box it writes first on replay conflicts with a confirmed write", () => {
    using realm = testRealm();
    const $route = Box.make(realm, false);
    const $value = Box.make(realm, 3, { name: "answer" });
    const lower = Stage.make(realm, { visible: true });
    const upper = Stage.make(realm, { visible: true, conflicts: "fail" });
    Stage.update(upper, (read, write) => {
      if (read($route)) write($value, 4);
    });
    Stage.update(lower, (_read, write) => {
      write($route, true);
    });
    expect(Source.peek($value)).toBe(4);
    Realm.update(realm, (_read, write) => {
      write($value, 7);
    });
    expect(Stage.inspect(upper).showing).toBe(false);
    expect(Stage.inspect(upper).failure).toBeInstanceOf(StageConflictError);
    expect(() => Stage.apply(upper)).toThrow(StageConflictError);
    expect(Source.peek($value)).toBe(7);
    Stage.drop(lower);
  });
});

describe("atom marks and conflicts", () => {
  test("a hidden fail stage conflicts once a visible mark it read past is applied", () => {
    using realm = testRealm();
    const atom = Atom.make(realm);
    const $result = Box.make(realm, 0);
    const visible = Stage.make(realm, { visible: true });
    Stage.update(visible, (_read, write) => {
      write.changed(atom);
    });
    const hidden = Stage.make(realm, { conflicts: "fail" });
    Stage.update(hidden, (read, write) => {
      read(atom);
      write($result, 1);
    });
    Stage.apply(visible);
    expect(() => Stage.apply(hidden)).toThrow(StageConflictError);
  });

  test("a dropped visible mark does not conflict with a hidden fail stage", () => {
    using realm = testRealm();
    const atom = Atom.make(realm);
    const hidden = Stage.make(realm, { conflicts: "fail" });
    Stage.read(hidden, (read) => read(atom));
    const visible = Stage.make(realm, { visible: true });
    Stage.update(visible, (_read, write) => {
      write.changed(atom);
    });
    Stage.drop(visible);
    expect(() => Stage.apply(hidden)).not.toThrow();
  });

  test("a failed visible apply withdraws its mark, so readers run again", () => {
    using realm = testRealm();
    const $allowed = Box.make(realm, false);
    const atom = Atom.make(realm);
    const lower = Stage.make(realm, { visible: true });
    Stage.update(lower, (_read, write) => {
      write($allowed, true);
    });
    const upper = Stage.make(realm, { visible: true });
    let runs = 0;
    const stop = Realm.autorun(realm, (read) => {
      read(atom);
      runs++;
      return undefined;
    });
    Stage.update(upper, (read, write) => {
      if (!read($allowed)) throw new Error("must be allowed");
      write.changed(atom);
    });
    expect(runs).toBe(2);
    expect(() => Stage.apply(upper)).toThrow("must be allowed");
    expect(Stage.status(upper)).toBe("dropped");
    expect(runs).toBe(3);
    stop();
    Stage.drop(lower);
  });
});

describe("applying the bottom visible stage", () => {
  test("a value equal by the box's equals keeps the shown value and reruns nobody", () => {
    using realm = testRealm();
    const $amount = Box.make(
      realm,
      { amount: 0 },
      { equals: (left, right) => left.amount === right.amount },
    );
    let runs = 0;
    const stop = Realm.autorun(realm, (read) => {
      read($amount);
      runs++;
      return undefined;
    });
    const visible = Stage.make(realm, { visible: true });
    Stage.update(visible, (_read, write) => {
      write.modify($amount, (draft) => {
        draft.amount++;
      });
    });
    const shown = Source.peek($amount);
    expect(runs).toBe(2);
    Stage.apply(visible);
    expect(Source.peek($amount)).toBe(shown);
    expect(runs).toBe(2);
    stop();
  });
});

describe("what a stage keeps after its rows leave", () => {
  test("a key only a dropped visible stage showed keeps no row computed", () => {
    using realm = testRealm();
    const $rows = Collection.make<number, number>(realm, { keyOf: (row) => row });
    for (const key of [1, 2, 3]) {
      const stage = Stage.make(realm, { visible: true });
      Stage.update(stage, (_read, write) => {
        write.upsert($rows, key);
      });
      expect(Realm.untracked(realm, (read) => read($rows.row(key)))).toBe(key);
      Stage.drop(stage);
    }
    expect(Realm.untracked(realm, (read) => read($rows.keys))).toEqual([]);
    expect([...retainedKeys($rows)]).toEqual([]);
  });

  test("a recipe that throws keeps none of the rows it wrote", async () => {
    using realm = testRealm();
    const $rows = Collection.make<number, { id: number }>(realm, { keyOf: (row) => row.id });
    const stage = Stage.make(realm);
    const references = (() =>
      Array.from({ length: 4 }, (_, id) => {
        const row = { id };
        const reference = new WeakRef(row);
        expect(() =>
          Stage.update(stage, (_read, write) => {
            write.replaceAll($rows, [row]);
            throw new Error("aborted");
          }),
        ).toThrow("aborted");
        expect(() =>
          Stage.update(stage, (_read, write) => {
            write.upsert($rows, { id: id + 10 });
            throw new Error("aborted");
          }),
        ).toThrow("aborted");
        return reference;
      }))();
    expect(Stage.inspect(stage).recipes).toBe(0);
    for (let pass = 0; pass < 3; pass++) {
      await Bun.sleep(0);
      Bun.gc(true);
    }
    expect(references.filter((reference) => reference.deref() !== undefined)).toEqual([]);
    Stage.update(stage, (_read, write) => {
      write.upsert($rows, { id: 1 });
    });
    Stage.apply(stage);
    expect(Realm.untracked(realm, (read) => read($rows.keys))).toEqual([1]);
  });
});

describe("an onError handler while the visible stack replays", () => {
  test("a write from the handler reaches a stage below the stopped one", () => {
    let report = () => {};
    using realm = testRealm({ onError: () => report() });
    const $input = Box.make(realm, 0);
    const $shown = Box.make(realm, 0);
    const $fail = Box.make(realm, false);
    report = () =>
      Realm.update(realm, (_read, write) => {
        write($input, 9);
      });
    const lower = Stage.make(realm, { visible: true });
    Stage.update(lower, (read, write) => {
      write($shown, read($input) + 1);
    });
    const upper = Stage.make(realm, { visible: true });
    Stage.update(upper, (read) => {
      if (read($fail)) throw new Error("cancel");
    });
    Realm.update(realm, (_read, write) => {
      write($fail, true);
    });
    expect(Realm.untracked(realm, (read) => [read($input), read($shown)])).toEqual([9, 10]);
    expect(Stage.inspect(upper).showing).toBe(false);
    Stage.drop(upper);
    Stage.drop(lower);
  });

  test("the handler drops the stopped stage while another stage stays above it", () => {
    let retire = () => {};
    const errors: Array<unknown> = [];
    using realm = testRealm({
      onError: (error) => {
        errors.push(error);
        retire();
      },
    });
    const $ready = Box.make(realm, true);
    const lower = Stage.make(realm, { visible: true });
    Stage.update(lower, (read) => {
      if (!read($ready)) throw new Error("cancel");
    });
    const upper = Stage.make(realm, { visible: true });
    retire = () => Stage.drop(lower);
    Realm.update(realm, (_read, write) => {
      write($ready, false);
    });
    expect(errors.map((error) => (error as Error).message)).toEqual(["cancel"]);
    expect(Stage.status(lower)).toBe("dropped");
    expect(Stage.status(upper)).toBe("open");
    expect(Source.peek($ready)).toBe(false);
    Stage.drop(upper);
  });
});
