import { expect, test } from "bun:test";
import { Box, Collection, Realm, Stage } from "../../src/index.ts";
import { retainedKeys } from "../../src/testing/index.ts";

test("dropping a visible-only row releases its lookup from the collection", () => {
  using realm = Realm.make();
  const rows = Collection.make<number, number>(realm, { keyOf: (row) => row });
  for (const key of [1, 2, 3]) {
    const stage = Stage.make(realm, { visible: true });
    Stage.update(stage, (_read, write) => write.upsert(rows, key));
    expect(Realm.untracked(realm, (read) => read(rows.row(key)))).toBe(key);
    Stage.drop(stage);
  }
  expect(Realm.untracked(realm, (read) => read(rows.keys))).toEqual([]);
  expect([...retainedKeys(rows)]).toEqual([]);
});

test("a fail stage cannot overwrite a rival write after its replay adds a target", () => {
  using realm = Realm.make();
  const skip = Box.make(realm, false);
  const amount = Box.make(realm, 3);
  const lower = Stage.make(realm, { visible: true });
  Stage.update(lower, (_read, write) => write(skip, true));
  const upper = Stage.make(realm, { visible: true, conflicts: "fail" });
  Stage.update(upper, (read, write) => {
    if (!read(skip)) write(amount, 4);
  });
  Stage.drop(lower);
  expect(Realm.untracked(realm, (read) => read(amount))).toBe(4);
  Realm.update(realm, (_read, write) => write(amount, 7));
  try {
    Stage.apply(upper);
  } catch {}
  expect(Realm.untracked(realm, (read) => [read(amount), Stage.status(upper)])).toEqual([
    7,
    "dropped",
  ]);
});
