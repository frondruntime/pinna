import { describe, expect, test } from "bun:test";
import { Collection, Realm, Source } from "../../src/index.ts";

interface Row {
  readonly id: number;
}

/** The key order's array, read without handing it out: what the collection holds. */
const held = (rows: Collection<number, Row>): ReadonlyArray<number> =>
  (rows as unknown as { order: { source: { value: ReadonlyArray<number> } } }).order.source.value;

const filled = (count: number) => {
  const realm = Realm.make();
  const rows = Collection.make<number, Row>(realm, { keyOf: (row) => row.id });
  Realm.update(realm, (_read, write) => {
    write.replaceAll(
      rows,
      Array.from({ length: count }, (_, id) => ({ id })),
    );
  });
  return { realm, rows };
};

describe("the key order, changed in place", () => {
  test("an add and a remove nobody reads keep the array", () => {
    const { realm, rows } = filled(3);
    const array = held(rows);
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { id: 3 }, { at: "end" });
    });
    Realm.update(realm, (_read, write) => {
      write.remove(rows, 0);
    });
    expect(held(rows)).toBe(array);
    expect([...held(rows)]).toEqual([1, 2, 3]);
  });

  test("a read hands the array out, and the next write copies it", () => {
    const { realm, rows } = filled(2);
    const seen = Source.peek(rows.keys);
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { id: 2 }, { at: "end" });
    });
    expect(seen).toEqual([0, 1]);
    expect(held(rows)).not.toBe(seen);
    expect([...held(rows)]).toEqual([0, 1, 2]);
  });

  test("an update that adds and removes one key reruns no reader of keys", () => {
    const { realm, rows } = filled(2);
    let runs = 0;
    const stop = Realm.autorun(realm, (read) => {
      read(rows.keys);
      runs++;
    });
    // The autorun holds the array: the first write copies, the next ones change the copy.
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { id: 5 }, { at: "end" });
      write.upsert(rows, { id: 6 }, { at: "start" });
      write.remove(rows, 5);
      write.remove(rows, 6);
    });
    expect(runs).toBe(1);
    stop();
  });

  test("an add then a remove in place puts the version back", () => {
    const { realm, rows } = filled(2);
    const version = (rows as unknown as { order: { source: { version: number } } }).order.source
      .version;
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { id: 7 }, { at: "start" });
      write.remove(rows, 7);
    });
    const after = (rows as unknown as { order: { source: { version: number } } }).order.source
      .version;
    expect(after).toBe(version);
  });

  test("a nested update that throws takes back its changes in place", () => {
    const { realm, rows } = filled(3);
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { id: 3 }, { at: "end" });
      try {
        Realm.update(realm, (_read, write) => {
          write.remove(rows, 1);
          write.upsert(rows, { id: 4 }, { at: "start" });
          throw new Error("inner");
        });
      } catch {}
    });
    expect(Source.peek(rows.keys)).toEqual([0, 1, 2, 3]);
  });

  test("an update that throws after a read of keys puts the order back", () => {
    const { realm, rows } = filled(2);
    let inside: ReadonlyArray<number> = [];
    expect(() =>
      Realm.update(realm, (read, write) => {
        write.upsert(rows, { id: 2 }, { at: "end" });
        inside = read(rows.keys);
        write.remove(rows, 0);
        throw new Error("outer");
      }),
    ).toThrow("outer");
    expect(Source.peek(rows.keys)).toEqual([0, 1]);
    // The array read inside is the one it read: the remove copied it.
    expect(inside).toEqual([0, 1, 2]);
  });
});
