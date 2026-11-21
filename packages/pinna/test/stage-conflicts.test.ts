import { describe, expect, test } from "bun:test";
import {
  applyStage,
  box,
  collection,
  computed,
  dropStage,
  inspect,
  inspectStage,
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
  for (const location of ["root", "child", "ancestor"] as const) {
    for (const access of ["read.row", "row", "rows", "keys"] as const) {
      for (const changedBeforeRead of [false, true]) {
        test(`copied collection provenance: ${location}, ${access}, realm changes ${changedBeforeRead ? "before" : "after"} read`, () => {
          using realm = testRealm();
          const $rows = collection<string, { id: string; value: number }>(realm, {
            keyOf: (row) => row.id,
            name: "rows",
          });
          update(realm, (_read, write) => {
            write.replaceAll($rows, [
              { id: "a", value: 1 },
              { id: "b", value: 2 },
            ]);
          });
          const root = openStage(realm, { conflicts: "fail" });
          const stage = location === "root" ? root : openStage(root);
          try {
            stageUpdate(location === "ancestor" ? root : stage, (_read, write) => {
              write.upsert($rows, { id: "a", value: 3 });
            });
            const changeRealm = () =>
              update(realm, (_read, write) => {
                write.upsert($rows, { id: "b", value: 20 });
                write.upsert($rows, { id: "z", value: 30 });
              });
            if (changedBeforeRead) changeRealm();
            if (location === "ancestor") {
              // This copy inherits the ancestor's versions, even after the realm moved.
              stageUpdate(stage, (_read, write) => {
                write.upsert($rows, { id: "c", value: 4 });
              });
            }
            stageRead(stage, (read) => {
              if (access === "read.row") expect(read.row($rows, "b")?.value).toBe(2);
              if (access === "row") expect(read($rows.row("b"))?.value).toBe(2);
              if (access === "rows")
                expect(read($rows.rows).find((row) => row.id === "b")?.value).toBe(2);
              if (access === "keys") expect(read($rows.keys)).not.toContain("z");
            });
            if (!changedBeforeRead) changeRealm();
            if (stage !== root) applyStage(stage);
            expect(conflictOf(() => applyStage(root)).changed).toEqual(["rows"]);
          } finally {
            dropStage(root);
          }
        });
      }
    }
  }

  for (const child of [false, true]) {
    test(`a copied collection's blind writes and written row reads do not conflict (${child ? "child" : "root"})`, () => {
      using realm = testRealm();
      const $rows = collection<string, { id: string; value: number }>(realm, {
        keyOf: (row) => row.id,
      });
      update(realm, (_read, write) => {
        write.replaceAll($rows, [
          { id: "a", value: 1 },
          { id: "b", value: 2 },
        ]);
      });
      const root = openStage(realm, { conflicts: "fail" });
      const stage = child ? openStage(root) : root;
      try {
        stageUpdate(root, (_read, write) => {
          write.upsert($rows, { id: "a", value: 3 });
        });
        stageUpdate(stage, (_read, write) => {
          write.remove($rows, "b");
        });
        expect(stageRead(stage, (read) => read.row($rows, "a")?.value)).toBe(3);
        expect(stageRead(stage, (read) => read($rows.row("b")))).toBeUndefined();
        expect(inspectStage(stage).read).toEqual([]);
        expect(inspectStage(root).read).toEqual([]);
        update(realm, (_read, write) => {
          write.upsert($rows, { id: "a", value: 10 });
          write.upsert($rows, { id: "b", value: 20 });
        });
        if (child) applyStage(stage);
        applyStage(root);
        expect(untracked(realm, (read) => read($rows.rows))).toEqual([{ id: "a", value: 3 }]);
      } finally {
        dropStage(root);
      }
    });
  }

  test("replaceAll clears copied provenance and a failed recipe restores it", () => {
    using realm = testRealm();
    const $rows = collection<number, number>(realm, { keyOf: (row) => row, name: "rows" });
    update(realm, (_read, write) => {
      write.replaceAll($rows, [1, 2]);
    });
    const stage = openStage(realm, { conflicts: "fail" });
    try {
      stageUpdate(stage, (_read, write) => {
        write.upsert($rows, 3);
      });
      expect(() =>
        stageUpdate(stage, (_read, write) => {
          write.replaceAll($rows, [4]);
          throw new Error("refused");
        }),
      ).toThrow("refused");
      update(realm, (_read, write) => {
        write.remove($rows, 2);
      });
      expect(stageRead(stage, (read) => read.row($rows, 2))).toBe(2);
      expect(conflictOf(() => applyStage(stage)).changed).toEqual(["rows"]);
    } finally {
      dropStage(stage);
    }
    const blind = openStage(realm, { conflicts: "fail" });
    try {
      stageUpdate(blind, (_read, write) => {
        write.upsert($rows, 3);
        write.replaceAll($rows, [4]);
      });
      stageRead(blind, (read) => [read($rows.keys), read($rows.rows), read.row($rows, 1)]);
      expect(inspectStage(blind).read).toEqual([]);
      update(realm, (_read, write) => {
        write.upsert($rows, 5);
      });
      applyStage(blind);
    } finally {
      dropStage(blind);
    }
  });

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

  test("a named collection is named in the conflict, and in inspect", () => {
    using realm = testRealm();
    const $orders = collection<string, string>(realm, { keyOf: (row) => row, name: "orders" });
    const $count = box(realm, 0);
    expect(inspect($orders.keys).name).toBe("orders.keys");
    expect(inspect($orders.rows).name).toBe("orders.rows");
    const stage = openStage(realm, { conflicts: "fail" });
    stageUpdate(stage, (read, write) => {
      write($count, read($orders.rows).length);
    });
    update(realm, (_read, write) => {
      write.upsert($orders, "a");
    });
    expect(conflictOf(() => applyStage(stage)).changed).toEqual(["orders"]);
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
