import { expect, test } from "bun:test";
import { Box, Collection, Realm, Stage } from "../../src/index.ts";
import { type BoxCell, baseOf } from "../../src/internal/index.ts";
import { testRealm } from "../../src/testing/index.ts";

/**
 * How the window keeps the base under a visible stage (ruling 68): the cell
 * a recipe writes records the base value and version as its value before,
 * and `baseOf` reads them for the change stream. The public twin is in
 * `test/stage-visible.test.ts`, "the base, records, and rollbacks".
 */

test("a covered box written by a recipe records the base as its value before", () => {
  using realm = testRealm();
  const $count = Box.make(realm, 10);
  const guess = Stage.make(realm, { visible: true });
  Stage.update(guess, (read, write) => write($count, read($count) + 1));
  const base = baseOf($count as unknown as BoxCell<unknown>);
  expect(base.value).toBe(10);
  let before: unknown;
  expect(() =>
    Realm.update(realm, (_read, write) => {
      write($count, 50);
      const cell = $count as unknown as BoxCell<unknown>;
      before = cell.valueBefore;
      expect(cell.versionBefore).toBe(base.version);
      throw new Error("roll back");
    }),
  ).toThrow("roll back");
  expect(before).toBe(10);
  expect(baseOf($count as unknown as BoxCell<unknown>)).toEqual(base);
  expect(Realm.untracked(realm, (read) => read($count))).toBe(11);
  Stage.drop(guess);
  expect(Realm.untracked(realm, (read) => read($count))).toBe(10);
  expect(($count as unknown as BoxCell<unknown>).source.version).toBe(base.version);
});

test("a covered collection is patched in place, and what a patch reads through is the base", () => {
  using realm = testRealm();
  const rows = Collection.make<number, { readonly id: number; readonly v: number }>(realm, {
    keyOf: (row) => row.id,
  });
  Realm.update(realm, (_read, write) => {
    write.replaceAll(rows, [
      { id: 1, v: 1 },
      { id: 2, v: 2 },
      { id: 3, v: 3 },
    ]);
  });
  const held = (rows as unknown as { heldRows(): ReadonlyMap<number, unknown> }).heldRows();
  const guess = Stage.make(realm, { visible: true });
  Stage.update(guess, (_read, write) => {
    write.upsert(rows, { id: 1, v: 10 });
    write.remove(rows, 2);
  });
  Realm.update(realm, (_read, write) => {
    write.upsert(rows, { id: 3, v: 30 });
  });
  // The map held is the one the base filled: no copy, no swap.
  expect((rows as unknown as { heldRows(): ReadonlyMap<number, unknown> }).heldRows()).toBe(held);
  expect(Realm.untracked(realm, (read) => read(rows.rows))).toEqual([
    { id: 1, v: 10 },
    { id: 3, v: 30 },
  ]);
  // What a stage's patch reads through at rest: the base, in the order held.
  const base = (rows as unknown as { rowsNow(): ReadonlyMap<number, unknown> }).rowsNow();
  expect([...base]).toEqual([
    [1, { id: 1, v: 1 }],
    [3, { id: 3, v: 30 }],
    [2, { id: 2, v: 2 }],
  ]);
  expect(base.size).toBe(3);
  expect(base.get(2)).toEqual({ id: 2, v: 2 });
  Stage.drop(guess);
  expect(Realm.untracked(realm, (read) => read(rows.rows))).toEqual([
    { id: 1, v: 1 },
    { id: 2, v: 2 },
    { id: 3, v: 30 },
  ]);
});
