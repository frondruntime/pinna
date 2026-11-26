import { expect, test } from "bun:test";
import { Box, Collection, Realm, Stage, type UpdateRecord, View } from "../../src/index.ts";

test("reverting an add restores a count kept by a row listener", () => {
  const realm = Realm.make();
  const rows = Collection.make(realm, { keyOf: (row: number) => row });
  const count = Box.make(realm, 0);
  Collection.onRowChange(rows, ({ before, after }, read, write) => {
    write(count, read(count) + Number(after !== undefined) - Number(before !== undefined));
  });
  const records: UpdateRecord[] = [];
  Realm.onUpdate(realm, (record) => {
    records.push(record);
  });
  Realm.update(realm, (_read, write) => write.upsert(rows, 1));
  expect(Realm.untracked(realm, (read) => read(count))).toBe(1);
  const addition = records[0]!;
  Realm.update(realm, (_read, write) => write.revert(addition));
  expect(Realm.untracked(realm, (read) => [read(rows.keys), read(count)])).toEqual([[], 0]);
});

test("reverting an add leaves the ordered view empty", () => {
  const realm = Realm.make();
  const rows = Collection.make(realm, { keyOf: (row: number) => row });
  const order = View.ordered(rows, { compare: () => (a, b) => a - b });
  const records: UpdateRecord[] = [];
  Realm.onUpdate(realm, (record) => {
    records.push(record);
  });
  Realm.update(realm, (_read, write) => write.upsert(rows, 1));
  const addition = records[0]!;
  Realm.update(realm, (_read, write) => write.revert(addition));
  expect(Realm.untracked(realm, (read) => read(order.keys))).toEqual([]);
});

test("a disposed ordered view cannot publish discarded staged rows", () => {
  const realm = Realm.make();
  const rows = Collection.make(realm, { keyOf: (row: number) => row });
  const direction = Box.make(realm, 1);
  const view = View.ordered(rows, {
    compare: (read) => {
      const sign = read(direction);
      return (a, b) => sign * (a - b);
    },
  });
  Realm.update(realm, (_read, write) => write.upsert(rows, 1));
  const keys = view.keys;
  expect(Realm.untracked(realm, (read) => read(keys))).toEqual([1]);
  const stage = Stage.make(realm);
  Stage.update(stage, (_read, write) => write.upsert(rows, 2));
  expect(Stage.read(stage, (read) => read(keys))).toEqual([1, 2]);
  Stage.drop(stage);
  View.dispose(view);
  Realm.update(realm, (_read, write) => write(direction, -1));
  expect(Realm.untracked(realm, (read) => read(keys))).toEqual([1]);
});

test("committed key order changes release removed object keys across updates", async () => {
  const realm = Realm.make();
  const rows = Collection.make(realm, { keyOf: (row: object) => row });
  const removed: WeakRef<object>[] = [];
  const controls: WeakRef<object>[] = [];
  for (let round = 0; round < 12; round++) {
    Realm.update(realm, (read, write) => {
      read(rows.keys);
      const first = {};
      const second = {};
      const control = {};
      controls.push(new WeakRef(control));
      removed.push(new WeakRef(second));
      write.upsert(rows, first);
      write.upsert(rows, second);
      write.remove(rows, second);
      write.remove(rows, first);
    });
  }
  for (let pass = 0; pass < 3; pass++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    Bun.gc(true);
  }
  expect(controls.filter((key) => key.deref() !== undefined).length).toBe(0);
  expect(removed.filter((key) => key.deref() !== undefined).length).toBe(0);
  expect(Realm.untracked(realm, (read) => read(rows.keys))).toEqual([]);
});
