import { describe, expect, test } from "bun:test";
import { Box, Collection, Computed, Realm, Stage } from "../src/index.ts";
import { record, testRealm } from "../src/testing/index.ts";

/**
 * A child stage, opened over a stage, is a savepoint: it reads through its
 * parent, applies into the parent, and drops without touching it
 * (`docs/api.md`, ruling 53).
 */

describe("a child stage", () => {
  test("a failed child replay restores the parent's read record with its overlay and journal", () => {
    using realm = testRealm();
    const $gate = Box.make(realm, false, { name: "gate" });
    const $kept = Box.make(realm, 1, { name: "kept" });
    const $value = Box.make(realm, 0, { name: "value" });
    const $rows = Collection.make<number, number>(realm, { keyOf: (value) => value });
    const parent = Stage.make(realm, { conflicts: "fail" });
    const child = Stage.make(parent);
    try {
      Stage.update(parent, (read, write) => {
        write($value, read($kept) * 10);
        write.upsert($rows, 1);
      });
      Stage.update(child, (read, write) => {
        write($value, 20);
        write.upsert($rows, 2);
        read($kept);
        if (read($gate)) throw new Error("replay refused");
      });
      const before = Stage.inspect(parent);
      Realm.update(realm, (_read, write) => {
        write($gate, true);
      });
      expect(() => Stage.apply(child)).toThrow("replay refused");
      expect(Stage.inspect(parent)).toEqual({ ...before, children: 0 });
      expect(Stage.read(parent, (read) => [read($value), read($rows.keys)])).toEqual([10, [1]]);
      Realm.update(realm, (_read, write) => {
        write($gate, false);
      });
      Stage.apply(parent);
      expect(Realm.untracked(realm, (read) => [read($value), read($rows.keys)])).toEqual([10, [1]]);
    } finally {
      Stage.drop(parent);
    }
  });

  test("a failed ordinary recipe still keeps its reads", () => {
    using realm = testRealm();
    const $gate = Box.make(realm, false, { name: "gate" });
    const stage = Stage.make(realm, { conflicts: "fail" });
    try {
      expect(() =>
        Stage.update(stage, (read) => {
          read($gate);
          throw new Error("refused");
        }),
      ).toThrow("refused");
      expect(Stage.inspect(stage).read).toEqual(["gate"]);
    } finally {
      Stage.drop(stage);
    }
  });

  test("reads through its parent, and applies into the parent, not the realm", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $b = Box.make(realm, 1);
    const $sum = Computed.make(realm, (read) => read($a) + read($b));
    const parent = Stage.make(realm, { name: "call" });
    Stage.update(parent, (_read, write) => {
      write($a, 2);
    });
    const child = Stage.make(parent, { name: "section" });
    expect(Stage.read(child, (read) => read($a))).toBe(2);
    Stage.update(child, (read, write) => {
      write($b, read($a) * 10);
    });
    expect(Stage.read(child, (read) => read($sum))).toBe(22);
    expect(Stage.read(parent, (read) => read($sum))).toBe(3);
    Stage.apply(child);
    expect(Stage.status(child)).toBe("applied");
    expect(Stage.read(parent, (read) => read($sum))).toBe(22);
    expect(Realm.untracked(realm, (read) => read($sum))).toBe(2);
    Stage.apply(parent);
    expect(Realm.untracked(realm, (read) => read($sum))).toBe(22);
  });

  test("dropped, it leaves the parent as it was: a caught section leaks nothing", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const parent = Stage.make(realm);
    const child = Stage.make(parent);
    Stage.update(child, (_read, write) => {
      write($a, 99);
    });
    Stage.drop(child);
    expect(Stage.read(parent, (read) => read($a))).toBe(1);
    Stage.apply(parent);
    expect(Realm.untracked(realm, (read) => read($a))).toBe(1);
  });

  test("replays into the parent's current values, and a throw on replay leaves the parent as it was", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $b = Box.make(realm, 0);
    const parent = Stage.make(realm);
    const child = Stage.make(parent);
    Stage.update(child, (read, write) => {
      if (read($a) > 1) {
        throw new Error("the parent moved");
      }
      write($b, 1);
    });
    Stage.update(parent, (_read, write) => {
      write($a, 2);
    });
    expect(() => Stage.apply(child)).toThrow("the parent moved");
    expect(Stage.status(child)).toBe("dropped");
    expect(Stage.read(parent, (read) => [read($a), read($b)])).toEqual([2, 0]);
    Stage.drop(parent);
  });

  test("a parent with an open child does not apply; dropping the parent drops the child", () => {
    using realm = testRealm();
    const parent = Stage.make(realm);
    const child = Stage.make(parent);
    const grandchild = Stage.make(child);
    expect(Stage.inspect(parent).children).toBe(1);
    expect(() => Stage.apply(parent)).toThrow(
      "pinna: Stage.apply runs on a stage while a child stage of it is open",
    );
    Stage.drop(parent);
    expect([Stage.status(parent), Stage.status(child), Stage.status(grandchild)]).toEqual([
      "dropped",
      "dropped",
      "dropped",
    ]);
  });

  test("grandchildren apply up the chain, and collections follow", () => {
    using realm = testRealm();
    const $rows = Collection.make<string, string>(realm, { keyOf: (row) => row });
    using keys = record(realm, (read) => read($rows.keys));
    const root = Stage.make(realm);
    const child = Stage.make(root);
    const grandchild = Stage.make(child);
    Stage.update(grandchild, (_read, write) => {
      write.upsert($rows, "c");
    });
    Stage.update(child, (_read, write) => {
      write.upsert($rows, "b");
    });
    Stage.apply(grandchild);
    expect(Stage.read(child, (read) => read($rows.keys))).toEqual(["c", "b"]);
    Stage.apply(child);
    expect(Stage.read(root, (read) => read($rows.keys))).toEqual(["c", "b"]);
    expect(keys.values).toEqual([]);
    Stage.apply(root);
    expect(keys.values).toEqual([["c", "b"]]);
  });

  test("takes no conflicts option: its root checks what it read", () => {
    using realm = testRealm();
    const parent = Stage.make(realm);
    expect(() => Stage.make(parent, { conflicts: "fail" })).toThrow(
      "pinna: a child stage takes no conflicts option",
    );
    Stage.drop(parent);
  });
});

describe("several stages", () => {
  test("two stages that write one box: the second applied builds on the first", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 0);
    const first = Stage.make(realm);
    const second = Stage.make(realm);
    Stage.update(first, (read, write) => {
      write($count, read($count) + 1);
    });
    Stage.update(second, (read, write) => {
      write($count, read($count) + 10);
    });
    Stage.apply(second);
    Stage.apply(first);
    expect(Realm.untracked(realm, (read) => read($count))).toBe(11);
  });

  test("several stages in one update land in apply order, and watchers see the end state once", () => {
    using realm = testRealm();
    const $log = Box.make<ReadonlyArray<string>>(realm, []);
    using logs = record(realm, (read) => read($log));
    const first = Stage.make(realm);
    const second = Stage.make(realm);
    Stage.update(first, (_read, write) => {
      write.modify($log, (log) => {
        log.push("first");
      });
    });
    Stage.update(second, (_read, write) => {
      write.modify($log, (log) => {
        log.push("second");
      });
    });
    Realm.update(realm, () => {
      Stage.apply(second);
      Stage.apply(first);
    });
    expect(logs.values).toEqual([["second", "first"]]);
  });
});

describe("inspectStage", () => {
  test("reports the name, realm, parent, status, and what the stage holds", () => {
    using realm = testRealm({ name: "app" });
    const $a = Box.make(realm, 1, { name: "a" });
    const $anonymous = Box.make(realm, 1);
    const $rows = Collection.make<string, string>(realm, { keyOf: (row) => row, name: "rows" });
    const $unnamed = Collection.make<string, string>(realm, { keyOf: (row) => row });
    const $price = Box.make(realm, 1, { name: "price" });
    const $readOnly = Collection.make<string, string>(realm, { keyOf: (row) => row });
    const $first = Box.make(realm, 0);
    const $second = Box.make(realm, 0);
    const stage = Stage.make(realm, { name: "save", conflicts: "fail" });
    Stage.update(stage, (read, write) => {
      write($a, 2);
      write($anonymous, 2);
      write.upsert($rows, "x");
      write.upsert($unnamed, "y");
      // Under "fail", each write records what it wrote; a later read of a
      // written box reads the stage alone.
      read($a);
      read($unnamed.keys);
      read($price);
      read($readOnly.keys);
      read($first);
      read($second);
    });
    const child = Stage.make(stage);
    expect(Stage.inspect(stage)).toEqual({
      name: "save",
      realm: "app",
      parent: undefined,
      status: "open",
      conflicts: "fail",
      boxes: ["a", "<anonymous>"],
      collections: ["rows", "a collection"],
      // One entry for the collection's two boxes; one for each unnamed box.
      read: [
        "a",
        "<anonymous>",
        "rows",
        "a collection",
        "price",
        "a collection",
        "<anonymous>",
        "<anonymous>",
      ],
      recipes: 1,
      children: 1,
      visible: false,
      showing: false,
      failure: undefined,
    });
    expect(Stage.inspect(child)).toMatchObject({ name: undefined, parent: "save", recipes: 0 });
    Stage.drop(stage);
    expect(Stage.inspect(stage)).toMatchObject({
      status: "dropped",
      boxes: [],
      read: [],
      recipes: 0,
    });
    using unchecked = testRealm();
    const $zero = Box.make(unchecked, 0);
    const plain = Stage.make(unchecked);
    Stage.read(plain, (read) => read($zero));
    expect(Stage.inspect(plain).read).toEqual([]);
    Stage.drop(plain);
  });
});
