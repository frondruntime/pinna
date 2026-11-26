import { expect, test } from "bun:test";
import { Collection, type Read, Realm, View, type Write } from "../../src/index.ts";

test("rolling back remove with an equivalent lookup key restores the stored key", () => {
  const realm = Realm.make();
  const rows = Collection.make(realm, { keyOf: (value: number) => value });
  Realm.update(realm, (_read, write) => write.upsert(rows, -0));
  expect(() =>
    Realm.update(realm, (_read, write) => {
      write.remove(rows, 0);
      throw Error("cancel");
    }),
  ).toThrow("cancel");
  // Slice 3 stores `-0` as the Map does, as `0`: the stored key comes back.
  Realm.untracked(realm, (read) => {
    expect(Object.is(read.row(rows, 0), -0)).toBe(true);
    expect(Object.is(read(rows.keys)[0], 0)).toBe(true);
  });
});

test("a kept ordered-view handle stays at its final base order on disposal", () => {
  const realm = Realm.make();
  const rows = Collection.make(realm, { keyOf: (value: number) => value });
  const view = View.ordered(rows, { compare: () => (left, right) => left - right });
  const keys = view.keys;
  Realm.update(realm, (_read, write) => write.upsert(rows, 1));
  expect(Realm.untracked(realm, (read) => read(keys))).toEqual([1]);
  Realm.update(realm, (_read, write) => {
    write.upsert(rows, 2);
    write.upsert(rows, 3);
  });
  View.dispose(view);
  expect(Realm.untracked(realm, (read) => read(keys))).toEqual([1, 2, 3]);
});

test("retained orders and incremental views agree with a reference across nested aborts", () => {
  const realm = Realm.make();
  type Row = { key: number; value: number };
  const source = Collection.make(realm, { keyOf: (row: Row) => row.key });
  const ordered = View.ordered(source, {
    compare: () => (left, right) => left.value - right.value,
  });
  const grouped = View.grouped(source, { groupOf: (row) => row.value % 3 });
  const totals = View.totals(source, {
    project: (row) => ({ group: row.value % 3, value: row.value }),
    arithmetic: {
      zero: 0,
      add: (left: number, right) => left + right,
      subtract: (left, right) => left - right,
    },
  });
  let rows: Row[] = [];
  const saved: { keys: readonly number[]; expected: number[] }[] = [];
  let seed = 413;
  function next(limit: number) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 12) % limit;
  }
  function change(read: Read, write: Write) {
    const key = next(8);
    const index = rows.findIndex((row) => row.key === key);
    switch (next(5)) {
      case 0:
        write.remove(source, key);
        if (index >= 0) rows.splice(index, 1);
        break;
      case 1:
        rows.reverse();
        write.replaceAll(source, rows.slice());
        break;
      case 2:
        saved.push({ keys: read(source.keys), expected: rows.map((row) => row.key) });
        break;
      default: {
        const row = { key, value: next(20) };
        const at = next(2) ? "start" : "end";
        write.upsert(source, row, { at });
        if (index >= 0) rows[index] = row;
        else if (at === "start") rows.unshift(row);
        else rows.push(row);
      }
    }
  }
  function verify(read: Read) {
    expect(read(source.keys)).toEqual(rows.map((row) => row.key));
    expect(read(source.rows)).toEqual(rows);
    expect(read(ordered.keys)).toEqual(
      [...rows].sort((a, b) => a.value - b.value || a.key - b.key).map((row) => row.key),
    );
    for (let group = 0; group < 3; group++) {
      const members = rows.filter((row) => row.value % 3 === group);
      expect([...read(grouped.group(group))].sort()).toEqual(members.map((row) => row.key).sort());
      expect(read(totals.group(group))).toEqual({
        count: members.length,
        total: members.reduce((sum, row) => sum + row.value, 0),
      });
    }
  }
  const abort = new Error("abort");
  for (let round = 0; round < 80; round++) {
    const original = rows.slice();
    try {
      Realm.update(realm, (read, write) => {
        for (let i = 0; i < 3; i++) change(read, write);
        const beforeInner = rows.slice();
        try {
          Realm.update(realm, (nestedRead, nestedWrite) => {
            for (let i = 0; i < 3; i++) change(nestedRead, nestedWrite);
            if (next(2)) throw abort;
          });
        } catch (error) {
          if (error !== abort) throw error;
          rows = beforeInner;
        }
        for (let i = 0; i < 2; i++) change(read, write);
        if (!next(4)) throw abort;
      });
    } catch (error) {
      if (error !== abort) throw error;
      rows = original;
    }
    Realm.untracked(realm, verify);
    for (const item of saved) expect(item.keys).toEqual(item.expected);
  }
});
