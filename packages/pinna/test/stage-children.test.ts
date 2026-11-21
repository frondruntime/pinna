import { describe, expect, test } from "bun:test";
import {
  applyStage,
  box,
  collection,
  computed,
  dropStage,
  inspectStage,
  openStage,
  stageRead,
  stageStatus,
  stageUpdate,
  untracked,
  update,
} from "../src/index.ts";
import { record, testRealm } from "../src/testing/index.ts";

/**
 * A child stage, opened over a stage, is a savepoint: it reads through its
 * parent, applies into the parent, and drops without touching it
 * (`docs/api.md`, ruling 53).
 */

describe("a child stage", () => {
  test("reads through its parent, and applies into the parent, not the realm", () => {
    using realm = testRealm();
    const $a = box(realm, 1);
    const $b = box(realm, 1);
    const $sum = computed(realm, (read) => read($a) + read($b));
    const parent = openStage(realm, { name: "call" });
    stageUpdate(parent, (_read, write) => {
      write($a, 2);
    });
    const child = openStage(parent, { name: "section" });
    expect(stageRead(child, (read) => read($a))).toBe(2);
    stageUpdate(child, (read, write) => {
      write($b, read($a) * 10);
    });
    expect(stageRead(child, (read) => read($sum))).toBe(22);
    expect(stageRead(parent, (read) => read($sum))).toBe(3);
    applyStage(child);
    expect(stageStatus(child)).toBe("applied");
    expect(stageRead(parent, (read) => read($sum))).toBe(22);
    expect(untracked(realm, (read) => read($sum))).toBe(2);
    applyStage(parent);
    expect(untracked(realm, (read) => read($sum))).toBe(22);
  });

  test("dropped, it leaves the parent as it was: a caught section leaks nothing", () => {
    using realm = testRealm();
    const $a = box(realm, 1);
    const parent = openStage(realm);
    const child = openStage(parent);
    stageUpdate(child, (_read, write) => {
      write($a, 99);
    });
    dropStage(child);
    expect(stageRead(parent, (read) => read($a))).toBe(1);
    applyStage(parent);
    expect(untracked(realm, (read) => read($a))).toBe(1);
  });

  test("replays into the parent's current values, and a throw on replay leaves the parent as it was", () => {
    using realm = testRealm();
    const $a = box(realm, 1);
    const $b = box(realm, 0);
    const parent = openStage(realm);
    const child = openStage(parent);
    stageUpdate(child, (read, write) => {
      if (read($a) > 1) {
        throw new Error("the parent moved");
      }
      write($b, 1);
    });
    stageUpdate(parent, (_read, write) => {
      write($a, 2);
    });
    expect(() => applyStage(child)).toThrow("the parent moved");
    expect(stageStatus(child)).toBe("dropped");
    expect(stageRead(parent, (read) => [read($a), read($b)])).toEqual([2, 0]);
    dropStage(parent);
  });

  test("a parent with an open child does not apply; dropping the parent drops the child", () => {
    using realm = testRealm();
    const parent = openStage(realm);
    const child = openStage(parent);
    const grandchild = openStage(child);
    expect(inspectStage(parent).children).toBe(1);
    expect(() => applyStage(parent)).toThrow(
      "pinna: applyStage runs on a stage while a child stage of it is open",
    );
    dropStage(parent);
    expect([stageStatus(parent), stageStatus(child), stageStatus(grandchild)]).toEqual([
      "dropped",
      "dropped",
      "dropped",
    ]);
  });

  test("grandchildren apply up the chain, and collections follow", () => {
    using realm = testRealm();
    const $rows = collection<string, string>(realm, { keyOf: (row) => row });
    using keys = record(realm, (read) => read($rows.keys));
    const root = openStage(realm);
    const child = openStage(root);
    const grandchild = openStage(child);
    stageUpdate(grandchild, (_read, write) => {
      write.upsert($rows, "c");
    });
    stageUpdate(child, (_read, write) => {
      write.upsert($rows, "b");
    });
    applyStage(grandchild);
    expect(stageRead(child, (read) => read($rows.keys))).toEqual(["c", "b"]);
    applyStage(child);
    expect(stageRead(root, (read) => read($rows.keys))).toEqual(["c", "b"]);
    expect(keys.values).toEqual([]);
    applyStage(root);
    expect(keys.values).toEqual([["c", "b"]]);
  });

  test("takes no conflicts option: its root checks what it read", () => {
    using realm = testRealm();
    const parent = openStage(realm);
    expect(() => openStage(parent, { conflicts: "fail" })).toThrow(
      "pinna: a child stage takes no conflicts option",
    );
    dropStage(parent);
  });
});

describe("several stages", () => {
  test("two stages that write one box: the second applied builds on the first", () => {
    using realm = testRealm();
    const $count = box(realm, 0);
    const first = openStage(realm);
    const second = openStage(realm);
    stageUpdate(first, (read, write) => {
      write($count, read($count) + 1);
    });
    stageUpdate(second, (read, write) => {
      write($count, read($count) + 10);
    });
    applyStage(second);
    applyStage(first);
    expect(untracked(realm, (read) => read($count))).toBe(11);
  });

  test("several stages in one update land in apply order, and watchers see the end state once", () => {
    using realm = testRealm();
    const $log = box<ReadonlyArray<string>>(realm, []);
    using logs = record(realm, (read) => read($log));
    const first = openStage(realm);
    const second = openStage(realm);
    stageUpdate(first, (_read, write) => {
      write.modify($log, (log) => {
        log.push("first");
      });
    });
    stageUpdate(second, (_read, write) => {
      write.modify($log, (log) => {
        log.push("second");
      });
    });
    update(realm, () => {
      applyStage(second);
      applyStage(first);
    });
    expect(logs.values).toEqual([["second", "first"]]);
  });
});

describe("inspectStage", () => {
  test("reports the name, realm, parent, status, and what the stage holds", () => {
    using realm = testRealm({ name: "app" });
    const $a = box(realm, 1, { name: "a" });
    const $anonymous = box(realm, 1);
    const $rows = collection<string, string>(realm, { keyOf: (row) => row });
    const stage = openStage(realm, { name: "save", conflicts: "fail" });
    stageUpdate(stage, (_read, write) => {
      write($a, 2);
      write($anonymous, 2);
      write.upsert($rows, "x");
    });
    const child = openStage(stage);
    expect(inspectStage(stage)).toEqual({
      name: "save",
      realm: "app",
      parent: undefined,
      status: "open",
      conflicts: "fail",
      boxes: ["a", "<anonymous>"],
      collections: 1,
      recipes: 1,
      children: 1,
    });
    expect(inspectStage(child)).toMatchObject({ name: undefined, parent: "save", recipes: 0 });
    dropStage(stage);
    expect(inspectStage(stage)).toMatchObject({ status: "dropped", boxes: [], recipes: 0 });
  });
});
