import { describe, expect, test } from "bun:test";
import {
  deleteMember,
  deleteMembers,
  Journal,
  missing,
  restoreEntry,
  runUndo,
  type UndoTarget,
} from "../../src/journal.ts";

/** A target that logs each undo it runs. */
const logger = (log: Array<string>): UndoTarget => ({
  undo(a, b, c) {
    log.push(`${String(a)} ${String(b)} ${String(c)}`);
  },
});

describe("Journal", () => {
  test("a rollback undoes the steps after the savepoint, the last first", () => {
    const log: Array<string> = [];
    const target = logger(log);
    const journal = new Journal();
    journal.step(target, 1, "a", 0);
    const savepoint = journal.length;
    journal.step(target, 2, "b", 0);
    journal.step(target, 3, "c", 1);
    journal.rollback(savepoint);
    expect(log).toEqual(["3 c 1", "2 b 0"]);
    expect(journal.length).toBe(savepoint);
    journal.rollback(0);
    expect(log).toEqual(["3 c 1", "2 b 0", "1 a 0"]);
    expect(journal.length).toBe(0);
  });

  test("`before` runs ahead of each step with its last argument", () => {
    const log: Array<string> = [];
    const journal = new Journal();
    journal.step(logger(log), "x", "y", 4);
    journal.step(logger(log), "z", "w", 7);
    journal.rollback(0, (c) => log.push(`before ${String(c)}`));
    expect(log).toEqual(["before 7", "z w 7", "before 4", "x y 4"]);
  });

  test("a step an undo takes lands at the savepoint", () => {
    const journal = new Journal();
    const log: Array<string> = [];
    journal.step(logger(log), "kept", 0, 0);
    const savepoint = journal.length;
    journal.step(
      runUndo,
      () => {
        journal.step(logger(log), "taken", 0, 0);
      },
      undefined,
      0,
    );
    journal.rollback(savepoint);
    expect(journal.length).toBe(savepoint + 4);
    journal.rollback(0);
    expect(log).toEqual(["taken 0 0", "kept 0 0"]);
  });

  test("a throwing undo still leaves the journal at the savepoint", () => {
    const journal = new Journal();
    journal.step(logger([]), 0, 0, 0);
    journal.step(
      runUndo,
      () => {
        throw new Error("boom");
      },
      undefined,
      0,
    );
    expect(() => journal.rollback(0)).toThrow("boom");
    expect(journal.length).toBe(0);
  });

  test("forget drops the steps without running them", () => {
    const log: Array<string> = [];
    const journal = new Journal();
    journal.step(logger(log), 0, 0, 0);
    journal.forget();
    journal.rollback(0);
    expect(log).toEqual([]);
    expect(journal.length).toBe(0);
  });

  test("the entry targets put maps and sets back", () => {
    const map = new Map<string, number>([["a", 1]]);
    const set = new Set(["x"]);
    const journal = new Journal();
    journal.step(restoreEntry, map, "a", 1);
    map.set("a", 2);
    journal.step(restoreEntry, map, "b", missing);
    map.set("b", 3);
    journal.step(deleteMember, set, "y", undefined);
    set.add("y");
    journal.step(deleteMembers, set, ["z", "w"], undefined);
    set.add("z").add("w");
    journal.rollback(0);
    expect([...map]).toEqual([["a", 1]]);
    expect([...set]).toEqual(["x"]);
  });
});
