import { describe, expect, test } from "bun:test";
import {
  Atom,
  Box,
  Collection,
  Computed,
  Realm,
  Source,
  Stage,
  StageConflictError,
} from "../src/index.ts";
import { record, testRealm } from "../src/testing/index.ts";

/**
 * `{ conflicts: "fail" }`: `Stage.apply` refuses when something the stage
 * read or wrote changed in the realm since, and lands nothing (`docs/api.md`,
 * ruling 53, amended by ruling 68: a write without a read conflicts too).
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
  test("two observed versions conflict even after the first version is restored", () => {
    using realm = testRealm();
    const value = Box.make(realm, 0);
    const stage = Stage.make(realm, { conflicts: "fail" });
    try {
      Stage.read(stage, (read) => read(value));
      expect(() =>
        Realm.update(realm, (_read, write) => {
          write(value, 1);
          Stage.read(stage, (read) => read(value));
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(() => Stage.apply(stage)).toThrow(StageConflictError);
    } finally {
      Stage.drop(stage);
    }
  });

  test("failed child replay restores a parent's first version after observing another", () => {
    using realm = testRealm();
    const value = Box.make(realm, 0);
    const parent = Stage.make(realm, { conflicts: "fail" });
    const child = Stage.make(parent);
    let fail = false;
    Stage.read(parent, (read) => read(value));
    Stage.update(child, (read) => {
      read(value);
      if (fail) throw new Error("child replay");
    });
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write(value, 1);
        fail = true;
        expect(() => Stage.apply(child)).toThrow("child replay");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    Stage.apply(parent);
    expect(Stage.status(parent)).toBe("applied");
  });

  for (const child of [false, true]) {
    test(`a restored version cannot erase a first read (${child ? "child" : "root"})`, () => {
      using realm = testRealm();
      const source = Box.make(realm, 0, { name: "source" });
      const result = Box.make(realm, -1);
      const root = Stage.make(realm, { conflicts: "fail" });
      const stage = child ? Stage.make(root) : root;
      try {
        expect(() =>
          Realm.update(realm, (_read, write) => {
            write(source, 1);
            Stage.update(stage, (read, stagedWrite) => stagedWrite(result, read(source)));
            throw new Error("rollback");
          }),
        ).toThrow("rollback");
        if (child) Stage.apply(stage);
        expect(Stage.read(root, (read) => read(source))).toBe(0);
        const conflict = conflictOf(() => Stage.apply(root));
        expect(conflict.changed).toEqual(["source"]);
        expect(conflict.observables).toEqual([source]);
        expect(Stage.status(root)).toBe("dropped");
        expect(Realm.untracked(realm, (read) => read(result))).toBe(-1);
      } finally {
        Stage.drop(root);
      }
    });
  }

  test("copied-row provenance cannot erase a read of a rolled-back version", () => {
    using realm = testRealm();
    const rows = Collection.make<number, number>(realm, { keyOf: (value) => value, name: "rows" });
    const stage = Stage.make(realm, { conflicts: "fail" });
    try {
      expect(() =>
        Realm.update(realm, (_read, write) => {
          write.upsert(rows, 1);
          expect(Stage.read(stage, (read) => read(rows.rows))).toEqual([1]);
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      Stage.update(stage, (_read, write) => write.upsert(rows, 2));
      expect(Stage.read(stage, (read) => read(rows.rows))).toEqual([2]);
      expect(conflictOf(() => Stage.apply(stage)).changed).toEqual(["rows"]);
      expect(Realm.untracked(realm, (read) => read(rows.rows))).toEqual([]);
    } finally {
      Stage.drop(stage);
    }
  });

  test("modify reads its realm base before a decision on the drafted result", () => {
    using realm = testRealm();
    const list = Box.make<ReadonlyArray<string>>(realm, ["a"], { name: "list" });
    const stage = Stage.make(realm, { conflicts: "fail" });
    try {
      Stage.update(stage, (_read, write) =>
        write.modify(list, (draft) => {
          draft.push("staged");
        }),
      );
      expect(Stage.read(stage, (read) => read(list).length)).toBe(2);
      Realm.update(realm, (_read, write) =>
        write.modify(list, (draft) => {
          draft.push("other");
        }),
      );
      expect(conflictOf(() => Stage.apply(stage)).changed).toEqual(["list"]);
      expect(Realm.untracked(realm, (read) => read(list))).toEqual(["a", "other"]);
    } finally {
      Stage.drop(stage);
    }
  });

  for (const child of [false, true]) {
    test(`modify of an overlay value records no realm read (${child ? "child" : "root"})`, () => {
      using realm = testRealm();
      const list = Box.make<ReadonlyArray<string>>(realm, ["a"]);
      const root = Stage.make(realm, { conflicts: "fail" });
      const stage = child ? Stage.make(root) : root;
      try {
        Stage.update(root, (_read, write) => write(list, ["own"]));
        Stage.update(stage, (_read, write) =>
          write.modify(list, (draft) => {
            draft.push("staged");
          }),
        );
        // The child read the root's value, not the realm's: it records nothing.
        expect(Stage.inspect(stage).read).toEqual(child ? [] : ["<anonymous>"]);
        // The root wrote the box without reading it; under "fail" that write is checked.
        expect(Stage.inspect(root).read).toEqual(["<anonymous>"]);
        Realm.update(realm, (_read, write) => write(list, ["other"]));
        if (child) Stage.apply(stage);
        expect(() => Stage.apply(root)).toThrow(StageConflictError);
        expect(Realm.untracked(realm, (read) => read(list))).toEqual(["other"]);
      } finally {
        Stage.drop(root);
      }
    });
  }

  for (const location of ["root", "child", "ancestor"] as const) {
    for (const access of ["read.row", "row", "rows", "keys"] as const) {
      for (const changedBeforeRead of [false, true]) {
        test(`copied collection provenance: ${location}, ${access}, realm changes ${changedBeforeRead ? "before" : "after"} read`, () => {
          using realm = testRealm();
          const $rows = Collection.make<string, { id: string; value: number }>(realm, {
            keyOf: (row) => row.id,
            name: "rows",
          });
          Realm.update(realm, (_read, write) => {
            write.replaceAll($rows, [
              { id: "a", value: 1 },
              { id: "b", value: 2 },
            ]);
          });
          const root = Stage.make(realm, { conflicts: "fail" });
          const stage = location === "root" ? root : Stage.make(root);
          try {
            Stage.update(location === "ancestor" ? root : stage, (_read, write) => {
              write.upsert($rows, { id: "a", value: 3 });
            });
            const changeRealm = () =>
              Realm.update(realm, (_read, write) => {
                write.upsert($rows, { id: "b", value: 20 });
                write.upsert($rows, { id: "z", value: 30 });
              });
            if (changedBeforeRead) changeRealm();
            if (location === "ancestor") {
              // This copy inherits the ancestor's versions, even after the realm moved.
              Stage.update(stage, (_read, write) => {
                write.upsert($rows, { id: "c", value: 4 });
              });
            }
            Stage.read(stage, (read) => {
              if (access === "read.row") expect(read.row($rows, "b")?.value).toBe(2);
              if (access === "row") expect(read($rows.row("b"))?.value).toBe(2);
              if (access === "rows")
                expect(read($rows.rows).find((row) => row.id === "b")?.value).toBe(2);
              if (access === "keys") expect(read($rows.keys)).not.toContain("z");
            });
            if (!changedBeforeRead) changeRealm();
            if (stage !== root) Stage.apply(stage);
            expect(conflictOf(() => Stage.apply(root)).changed).toEqual(["rows"]);
          } finally {
            Stage.drop(root);
          }
        });
      }
    }
  }

  for (const child of [false, true]) {
    test(`a copied collection's blind writes conflict, and written row reads record nothing more (${child ? "child" : "root"})`, () => {
      using realm = testRealm();
      const $rows = Collection.make<string, { id: string; value: number }>(realm, {
        keyOf: (row) => row.id,
      });
      Realm.update(realm, (_read, write) => {
        write.replaceAll($rows, [
          { id: "a", value: 1 },
          { id: "b", value: 2 },
        ]);
      });
      const root = Stage.make(realm, { conflicts: "fail" });
      const stage = child ? Stage.make(root) : root;
      try {
        Stage.update(root, (_read, write) => {
          write.upsert($rows, { id: "a", value: 3 });
        });
        Stage.update(stage, (_read, write) => {
          write.remove($rows, "b");
        });
        expect(Stage.read(stage, (read) => read.row($rows, "a")?.value)).toBe(3);
        expect(Stage.read(stage, (read) => read($rows.row("b")))).toBeUndefined();
        expect(Stage.inspect(stage).read).toEqual(["a collection"]);
        expect(Stage.inspect(root).read).toEqual(["a collection"]);
        Realm.update(realm, (_read, write) => {
          write.upsert($rows, { id: "a", value: 10 });
          write.upsert($rows, { id: "b", value: 20 });
        });
        if (child) Stage.apply(stage);
        expect(() => Stage.apply(root)).toThrow(StageConflictError);
        expect(Realm.untracked(realm, (read) => read($rows.rows))).toEqual([
          { id: "a", value: 10 },
          { id: "b", value: 20 },
        ]);
      } finally {
        Stage.drop(root);
      }
    });
  }

  test("replaceAll clears copied provenance and a failed recipe restores it", () => {
    using realm = testRealm();
    const $rows = Collection.make<number, number>(realm, { keyOf: (row) => row, name: "rows" });
    Realm.update(realm, (_read, write) => {
      write.replaceAll($rows, [1, 2]);
    });
    const stage = Stage.make(realm, { conflicts: "fail" });
    try {
      Stage.update(stage, (_read, write) => {
        write.upsert($rows, 3);
      });
      expect(() =>
        Stage.update(stage, (_read, write) => {
          write.replaceAll($rows, [4]);
          throw new Error("refused");
        }),
      ).toThrow("refused");
      Realm.update(realm, (_read, write) => {
        write.remove($rows, 2);
      });
      expect(Stage.read(stage, (read) => read.row($rows, 2))).toBe(2);
      expect(conflictOf(() => Stage.apply(stage)).changed).toEqual(["rows"]);
    } finally {
      Stage.drop(stage);
    }
    const blind = Stage.make(realm, { conflicts: "fail" });
    try {
      Stage.update(blind, (_read, write) => {
        write.upsert($rows, 3);
        write.replaceAll($rows, [4]);
      });
      Stage.read(blind, (read) => [read($rows.keys), read($rows.rows), read.row($rows, 1)]);
      // The writes recorded the collection; the reads of its replaced rows add nothing.
      expect(Stage.inspect(blind).read).toEqual(["rows"]);
      Realm.update(realm, (_read, write) => {
        write.upsert($rows, 5);
      });
      expect(conflictOf(() => Stage.apply(blind)).changed).toEqual(["rows"]);
    } finally {
      Stage.drop(blind);
    }
  });

  test("a box it read that changed since: applyStage throws, nothing lands, the stage is dropped", () => {
    using realm = testRealm();
    const $price = Box.make(realm, 10, { name: "price" });
    const $total = Box.make(realm, 0, { name: "total" });
    using totals = record(realm, (read) => read($total));
    const stage = Stage.make(realm, { name: "checkout", conflicts: "fail" });
    Stage.update(stage, (read, write) => {
      write($total, read($price) * 2);
    });
    Realm.update(realm, (_read, write) => {
      write($price, 11);
    });
    const conflict = conflictOf(() => Stage.apply(stage));
    expect(conflict.message).toBe(
      'pinna: price changed since the stage "checkout" read it; nothing lands',
    );
    expect(conflict.stage).toBe("checkout");
    expect(conflict.changed).toEqual(["price"]);
    expect(conflict.observables).toEqual([$price]);
    expect(Stage.status(stage)).toBe("dropped");
    expect(totals.values).toEqual([]);
  });

  test("a box it wrote without reading conflicts, as one it read does", () => {
    using realm = testRealm();
    const $status = Box.make(realm, "idle", { name: "status" });
    const stage = Stage.make(realm, { conflicts: "fail" });
    Stage.update(stage, (_read, write) => {
      write($status, "saved");
    });
    expect(Stage.inspect(stage).read).toEqual(["status"]);
    Realm.update(realm, (_read, write) => {
      write($status, "busy");
    });
    expect(conflictOf(() => Stage.apply(stage)).changed).toEqual(["status"]);
    expect(Realm.untracked(realm, (read) => read($status))).toBe("busy");
  });

  test('under "replay", a box it wrote without reading is the last writer\'s', () => {
    using realm = testRealm();
    const $status = Box.make(realm, "idle");
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write($status, "saved");
    });
    Realm.update(realm, (_read, write) => {
      write($status, "busy");
    });
    Stage.apply(stage);
    expect(Realm.untracked(realm, (read) => read($status))).toBe("saved");
  });

  test("a collection it wrote without reading conflicts on a base write to it", () => {
    using realm = testRealm();
    const $rows = Collection.make<string, string>(realm, { keyOf: (row) => row, name: "rows" });
    const stage = Stage.make(realm, { conflicts: "fail" });
    Stage.update(stage, (_read, write) => {
      write.upsert($rows, "a");
    });
    Realm.update(realm, (_read, write) => {
      write.upsert($rows, "b");
    });
    expect(conflictOf(() => Stage.apply(stage)).changed).toEqual(["rows"]);
    const replay = Stage.make(realm);
    Stage.update(replay, (_read, write) => {
      write.upsert($rows, "a");
    });
    Realm.update(realm, (_read, write) => {
      write.upsert($rows, "c");
    });
    Stage.apply(replay);
    expect(Realm.untracked(realm, (read) => read($rows.keys))).toEqual(["a", "c", "b"]);
  });

  test("a box read after the stage wrote it reads the stage; the write is what is checked", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 0);
    const stage = Stage.make(realm, { conflicts: "fail" });
    Stage.update(stage, (_read, write) => {
      write($count, 5);
    });
    Stage.read(stage, (read) => read($count));
    expect(Stage.inspect(stage).read).toEqual(["<anonymous>"]);
    Realm.update(realm, (_read, write) => {
      write($count, 1);
    });
    expect(() => Stage.apply(stage)).toThrow(StageConflictError);
    expect(Realm.untracked(realm, (read) => read($count))).toBe(1);
  });

  test("a read through a computed value checks the boxes underneath", () => {
    using realm = testRealm();
    const $rate = Box.make(realm, 2, { name: "rate" });
    const $converted = Computed.make(realm, (read) => read($rate) * 100);
    const $amount = Box.make(realm, 0);
    const stage = Stage.make(realm, { conflicts: "fail" });
    Stage.update(stage, (read, write) => {
      write($amount, read($converted));
    });
    Realm.update(realm, (_read, write) => {
      write($rate, 3);
    });
    expect(conflictOf(() => Stage.apply(stage)).changed).toEqual(["rate"]);
  });

  test("a read of a collection's rows checks the collection", () => {
    using realm = testRealm();
    const $rows = Collection.make<string, string>(realm, { keyOf: (row) => row });
    const $count = Box.make(realm, 0);
    const stage = Stage.make(realm, { conflicts: "fail" });
    Stage.update(stage, (read, write) => {
      write($count, read($rows.keys).length);
    });
    Realm.update(realm, (_read, write) => {
      write.upsert($rows, "a");
    });
    const conflict = conflictOf(() => Stage.apply(stage));
    expect(conflict.changed).toEqual(["a collection"]);
    expect(conflict.observables).toEqual([$rows]);
  });

  test("an atom it read that changed since conflicts", () => {
    using realm = testRealm();
    const $outside = Atom.make(realm);
    const $count = Box.make(realm, 0);
    const stage = Stage.make(realm, { conflicts: "fail" });
    Stage.update(stage, (read, write) => {
      read($outside);
      write($count, 1);
    });
    Realm.update(realm, (_read, write) => write.changed($outside));
    const conflict = conflictOf(() => Stage.apply(stage));
    expect(conflict.changed).toEqual(["<anonymous>"]);
    expect(conflict.observables).toEqual([$outside]);
    expect(Realm.untracked(realm, (read) => read($count))).toBe(0);
  });

  test("an atom read beneath a computed value names the computed value", () => {
    using realm = testRealm();
    const $outside = Atom.make(realm);
    let held = 1;
    const $held = Computed.make(
      realm,
      (read) => {
        read($outside);
        return held;
      },
      { name: "held" },
    );
    const $copy = Box.make(realm, 0);
    const stage = Stage.make(realm, { conflicts: "fail" });
    Stage.update(stage, (read, write) => write($copy, read($held)));
    expect(Stage.inspect(stage).read).toEqual(["held", "<anonymous>"]);
    Realm.update(realm, (_read, write) => {
      held = 2;
      write.changed($outside);
    });
    const conflict = conflictOf(() => Stage.apply(stage));
    expect(conflict.changed).toEqual(["held"]);
    expect(conflict.observables).toEqual([$held]);
  });

  test("an atom it read and nothing changed applies", () => {
    using realm = testRealm();
    const $outside = Atom.make(realm);
    const $count = Box.make(realm, 0);
    const stage = Stage.make(realm, { conflicts: "fail" });
    Stage.update(stage, (read, write) => {
      read($outside);
      write($count, 1);
    });
    Stage.apply(stage);
    expect(Realm.untracked(realm, (read) => read($count))).toBe(1);
  });

  test("an atom a child read is checked when its root applies", () => {
    using realm = testRealm();
    const $outside = Atom.make(realm);
    const $out = Box.make(realm, 0);
    const root = Stage.make(realm, { conflicts: "fail" });
    const child = Stage.make(root);
    Stage.update(child, (read, write) => {
      read($outside);
      write($out, 1);
    });
    Stage.apply(child);
    Realm.update(realm, (_read, write) => write.changed($outside));
    expect(() => Stage.apply(root)).toThrow(StageConflictError);
  });

  test("a child's reads are checked when its root applies", () => {
    using realm = testRealm();
    const $flag = Box.make(realm, false, { name: "flag" });
    const $out = Box.make(realm, 0);
    const root = Stage.make(realm, { conflicts: "fail" });
    const child = Stage.make(root);
    Stage.update(child, (read, write) => {
      write($out, read($flag) ? 1 : 2);
    });
    Stage.apply(child);
    Realm.update(realm, (_read, write) => {
      write($flag, true);
    });
    expect(conflictOf(() => Stage.apply(root)).changed).toEqual(["flag"]);
  });

  test("a named collection is named in the conflict, and in inspect", () => {
    using realm = testRealm();
    const $orders = Collection.make<string, string>(realm, { keyOf: (row) => row, name: "orders" });
    const $count = Box.make(realm, 0);
    expect(Source.inspect($orders.keys).name).toBe("orders.keys");
    expect(Source.inspect($orders.rows).name).toBe("orders.rows");
    const stage = Stage.make(realm, { conflicts: "fail" });
    Stage.update(stage, (read, write) => {
      write($count, read($orders.rows).length);
    });
    Realm.update(realm, (_read, write) => {
      write.upsert($orders, "a");
    });
    expect(conflictOf(() => Stage.apply(stage)).changed).toEqual(["orders"]);
  });

  test("a child keeps the version it read: a change before the child applies is caught", () => {
    using realm = testRealm();
    const $flag = Box.make(realm, false, { name: "flag" });
    const $out = Box.make(realm, 0);
    const root = Stage.make(realm, { conflicts: "fail" });
    const child = Stage.make(root);
    // The child decides on what it read, and its recipe reads the same box.
    const flagged = Stage.read(child, (read) => read($flag));
    Stage.update(child, (read, write) => {
      write($out, read($flag) === flagged ? 1 : 2);
    });
    Realm.update(realm, (_read, write) => {
      write($flag, true);
    });
    // The replay into the root reads $flag at its new version; the child read the old one.
    Stage.apply(child);
    expect(conflictOf(() => Stage.apply(root)).changed).toEqual(["flag"]);
  });

  test("a conflicts value other than replay or fail throws", () => {
    using realm = testRealm();
    expect(() =>
      Stage.make(realm, { conflicts: "fails" } as unknown as { conflicts: "fail" }),
    ).toThrow('pinna: conflicts is "replay" or "fail", not "fails"');
  });

  test("without the option, the replay lands over the new value", () => {
    using realm = testRealm();
    const $price = Box.make(realm, 10);
    const $total = Box.make(realm, 0);
    const stage = Stage.make(realm);
    Stage.update(stage, (read, write) => {
      write($total, read($price) * 2);
    });
    Realm.update(realm, (_read, write) => {
      write($price, 11);
    });
    Stage.apply(stage);
    expect(Realm.untracked(realm, (read) => read($total))).toBe(22);
  });

  test("a conflict check inside an open update sees the update's own writes", () => {
    using realm = testRealm();
    const $price = Box.make(realm, 10, { name: "price" });
    const stage = Stage.make(realm, { conflicts: "fail" });
    Stage.read(stage, (read) => read($price));
    const $failed = Box.make(realm, false);
    Realm.update(realm, (_read, write) => {
      write($price, 12);
      try {
        Stage.apply(stage);
      } catch (error) {
        write($failed, error instanceof StageConflictError);
      }
    });
    expect(Realm.untracked(realm, (read) => [read($price), read($failed)])).toEqual([12, true]);
  });
});
