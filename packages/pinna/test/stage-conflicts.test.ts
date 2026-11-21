import { describe, expect, test } from "bun:test";
import {
  applyStage,
  box,
  collection,
  computed,
  openStage,
  StageConflictError,
  stageRead,
  stageStatus,
  stageUpdate,
  untracked,
  update,
} from "../src/index.ts";
import { record, testRealm } from "../src/testing/index.ts";

/**
 * `{ conflicts: "fail" }`: `applyStage` refuses when something the stage
 * read changed in the realm since, and lands nothing. What the stage wrote
 * without reading is the last writer's (`docs/api.md`, ruling 53).
 */

const conflictOf = (run: () => void): StageConflictError => {
  try {
    run();
  } catch (error) {
    if (error instanceof StageConflictError) {
      return error;
    }
    throw error;
  }
  throw new Error("applyStage did not throw");
};

describe("a stage that fails on conflicts", () => {
  test("a box it read that changed since: applyStage throws, nothing lands, the stage is dropped", () => {
    using realm = testRealm();
    const $price = box(realm, 10, { name: "price" });
    const $total = box(realm, 0, { name: "total" });
    using totals = record(realm, (read) => read($total));
    const stage = openStage(realm, { name: "checkout", conflicts: "fail" });
    stageUpdate(stage, (read, write) => {
      write($total, read($price) * 2);
    });
    update(realm, (_read, write) => {
      write($price, 11);
    });
    const conflict = conflictOf(() => applyStage(stage));
    expect(conflict.message).toBe(
      'pinna: applyStage finds that price changed since the stage "checkout" read it; nothing lands',
    );
    expect(conflict.stage).toBe("checkout");
    expect(conflict.changed).toEqual(["price"]);
    expect(conflict.observables).toEqual([$price]);
    expect(stageStatus(stage)).toBe("dropped");
    expect(totals.values).toEqual([]);
  });

  test("a box it wrote without reading is the last writer's", () => {
    using realm = testRealm();
    const $status = box(realm, "idle");
    const stage = openStage(realm, { conflicts: "fail" });
    stageUpdate(stage, (_read, write) => {
      write($status, "saved");
    });
    update(realm, (_read, write) => {
      write($status, "busy");
    });
    applyStage(stage);
    expect(untracked(realm, (read) => read($status))).toBe("saved");
  });

  test("a box read after the stage wrote it reads the stage, so it is not checked", () => {
    using realm = testRealm();
    const $count = box(realm, 0);
    const stage = openStage(realm, { conflicts: "fail" });
    stageUpdate(stage, (_read, write) => {
      write($count, 5);
    });
    stageRead(stage, (read) => read($count));
    update(realm, (_read, write) => {
      write($count, 1);
    });
    applyStage(stage);
    expect(untracked(realm, (read) => read($count))).toBe(5);
  });

  test("a read through a computed value checks the boxes underneath", () => {
    using realm = testRealm();
    const $rate = box(realm, 2, { name: "rate" });
    const $converted = computed(realm, (read) => read($rate) * 100);
    const $amount = box(realm, 0);
    const stage = openStage(realm, { conflicts: "fail" });
    stageUpdate(stage, (read, write) => {
      write($amount, read($converted));
    });
    update(realm, (_read, write) => {
      write($rate, 3);
    });
    expect(conflictOf(() => applyStage(stage)).changed).toEqual(["rate"]);
  });

  test("a read of a collection's rows checks the collection", () => {
    using realm = testRealm();
    const $rows = collection<string, string>(realm, { keyOf: (row) => row });
    const $count = box(realm, 0);
    const stage = openStage(realm, { conflicts: "fail" });
    stageUpdate(stage, (read, write) => {
      write($count, read($rows.keys).length);
    });
    update(realm, (_read, write) => {
      write.upsert($rows, "a");
    });
    const conflict = conflictOf(() => applyStage(stage));
    expect(conflict.changed).toEqual(["a collection"]);
    expect(conflict.observables).toEqual([$rows]);
  });

  test("a child's reads are checked when its root applies", () => {
    using realm = testRealm();
    const $flag = box(realm, false, { name: "flag" });
    const $out = box(realm, 0);
    const root = openStage(realm, { conflicts: "fail" });
    const child = openStage(root);
    stageUpdate(child, (read, write) => {
      write($out, read($flag) ? 1 : 2);
    });
    applyStage(child);
    update(realm, (_read, write) => {
      write($flag, true);
    });
    expect(conflictOf(() => applyStage(root)).changed).toEqual(["flag"]);
  });

  test("a child keeps the version it read: a change before the child applies is caught", () => {
    using realm = testRealm();
    const $flag = box(realm, false, { name: "flag" });
    const $out = box(realm, 0);
    const root = openStage(realm, { conflicts: "fail" });
    const child = openStage(root);
    // The child decides on what it read, and its recipe reads the same box.
    const flagged = stageRead(child, (read) => read($flag));
    stageUpdate(child, (read, write) => {
      write($out, read($flag) === flagged ? 1 : 2);
    });
    update(realm, (_read, write) => {
      write($flag, true);
    });
    // The replay into the root reads $flag at its new version; the child read the old one.
    applyStage(child);
    expect(conflictOf(() => applyStage(root)).changed).toEqual(["flag"]);
  });

  test("a conflicts value other than replay or fail throws", () => {
    using realm = testRealm();
    expect(() =>
      openStage(realm, { conflicts: "fails" } as unknown as { conflicts: "fail" }),
    ).toThrow('pinna: conflicts is "replay" or "fail", not "fails"');
  });

  test("without the option, the replay lands over the new value", () => {
    using realm = testRealm();
    const $price = box(realm, 10);
    const $total = box(realm, 0);
    const stage = openStage(realm);
    stageUpdate(stage, (read, write) => {
      write($total, read($price) * 2);
    });
    update(realm, (_read, write) => {
      write($price, 11);
    });
    applyStage(stage);
    expect(untracked(realm, (read) => read($total))).toBe(22);
  });

  test("a conflict check inside an open update sees the update's own writes", () => {
    using realm = testRealm();
    const $price = box(realm, 10, { name: "price" });
    const stage = openStage(realm, { conflicts: "fail" });
    stageRead(stage, (read) => read($price));
    const $failed = box(realm, false);
    update(realm, (_read, write) => {
      write($price, 12);
      try {
        applyStage(stage);
      } catch (error) {
        write($failed, error instanceof StageConflictError);
      }
    });
    expect(untracked(realm, (read) => [read($price), read($failed)])).toEqual([12, true]);
  });
});
