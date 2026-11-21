import { describe, expect, test } from "bun:test";
import {
  type Collection,
  collection,
  computed,
  computedFunction,
  createRealm,
  observe,
  onObserved,
  type Read,
  type Realm,
  untracked,
  update,
  type Write,
  watch,
} from "../src/index.ts";
import { keptRead, keptWrite } from "./kept.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * The plain `collection` has no schema and compares rows by `equals`, or by
 * identity without one. Its tracking is pinna-effect's `CollectionField`'s,
 * tested there in full; these tests cover what the plain entry adds.
 */

interface Row {
  readonly id: string;
  readonly price: number;
}

const keyOf = (row: Row): string => row.id;

/** Every value each watch's effect saw, by name. */
const watchAll = <Name extends string>(
  realm: Realm,
  selects: Record<Name, (read: Read) => unknown>,
) => {
  const seen = {} as Record<Name, Array<unknown>>;
  const stops = (Object.keys(selects) as Array<Name>).map((name) => {
    const values: Array<unknown> = [];
    seen[name] = values;
    return watch(realm, selects[name], (value) => {
      values.push(value);
    });
  });
  return {
    seen,
    stop: () => {
      for (const stop of stops) {
        stop();
      }
    },
  };
};

const keysOf = (realm: Realm, rows: Collection<string, Row>) =>
  untracked(realm, (read) => read(rows.keys));
const priceOf = (realm: Realm, rows: Collection<string, Row>, id: string) =>
  untracked(realm, (read) => read(rows.row(id))?.price);

describe("collection", () => {
  for (const materialized of [false, true]) {
    for (const operation of ["upsert", "replaceAll"] as const) {
      test(`${operation} rejects undefined and rolls back with a cell ${materialized}`, () => {
        const realm = createRealm();
        const rows = collection<number, number | undefined>(realm, { keyOf: () => 1 });
        update(realm, (_read, write) => {
          write.upsert(rows, 7);
        });
        if (materialized) {
          untracked(realm, (read) => read(rows.row(1)));
        }

        expect(() =>
          update(realm, (_read, write) => {
            write.upsert(rows, 8);
            if (operation === "upsert") {
              write.upsert(rows, undefined);
            } else {
              write.replaceAll(rows, [undefined]);
            }
          }),
        ).toThrow("pinna: a collection row cannot be undefined");
        expect(untracked(realm, (read) => read(rows.rows))).toEqual([7]);
        expect(untracked(realm, (read) => read.row(rows, 1))).toBe(7);
        expectRealmAtRest(realm);
      });
    }
  }

  test("replaceAll rejects undefined before changing rows when caught inside the update", () => {
    const realm = createRealm();
    const rows = collection<number, number | undefined>(realm, { keyOf: (value) => value ?? 0 });
    update(realm, (_read, write) => {
      write.upsert(rows, 7);
    });
    update(realm, (read, write) => {
      expect(() => write.replaceAll(rows, [8, undefined])).toThrow(
        "pinna: a collection row cannot be undefined",
      );
      expect(read(rows.rows)).toEqual([7]);
      expect(read(rows.keys)).toEqual([7]);
    });
    expectRealmAtRest(realm);
  });

  test("starts empty and takes rows from upsert, remove, and replaceAll", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    expect(keysOf(realm, rows)).toEqual([]);

    update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", price: 1 });
      write.upsert(rows, { id: "b", price: 2 }, { at: "end" });
    });
    expect(keysOf(realm, rows)).toEqual(["a", "b"]);

    update(realm, (_read, write) => {
      write.remove(rows, "a");
    });
    expect(keysOf(realm, rows)).toEqual(["b"]);

    update(realm, (_read, write) => {
      write.replaceAll(rows, [
        { id: "c", price: 3 },
        { id: "b", price: 4 },
      ]);
    });
    expect(keysOf(realm, rows)).toEqual(["c", "b"]);
    expect(priceOf(realm, rows, "b")).toBe(4);
    expect(untracked(realm, (read) => read(rows.rows).map((row) => row.price))).toEqual([3, 4]);
    expectRealmAtRest(realm);
  });

  test("a write to one key notifies that key's readers only", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    update(realm, (_read, write) => {
      write.replaceAll(rows, [
        { id: "a", price: 1 },
        { id: "b", price: 2 },
      ]);
    });
    const { seen, stop } = watchAll(realm, {
      a: (read) => read(rows.row("a"))?.price,
      b: (read) => read(rows.row("b"))?.price,
      keys: (read) => read(rows.keys),
    });

    update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", price: 10 });
    });

    expect(seen).toEqual({ a: [10], b: [], keys: [] });
    stop();
  });

  test("without equals, a new object under a key notifies its readers", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    const a = { id: "a", price: 1 };
    update(realm, (_read, write) => {
      write.upsert(rows, a);
    });
    const { seen, stop } = watchAll(realm, { a: (read) => read(rows.row("a")) });

    update(realm, (_read, write) => {
      write.upsert(rows, a);
    });
    update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", price: 1 });
    });

    expect(seen.a).toEqual([{ id: "a", price: 1 }]);
    stop();
  });

  test("with equals, an equal row notifies nobody and the collection keeps the row it holds", () => {
    const realm = createRealm();
    const rows = collection(realm, {
      keyOf,
      equals: (previous, next) => previous.price === next.price,
    });
    const a = { id: "a", price: 1 };
    update(realm, (_read, write) => {
      write.upsert(rows, a);
    });
    const { seen, stop } = watchAll(realm, { a: (read) => read(rows.row("a")) });

    update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", price: 1 });
      write.replaceAll(rows, [{ id: "a", price: 1 }]);
    });

    expect(seen.a).toEqual([]);
    expect(untracked(realm, (read) => read(rows.row("a")))).toBe(a);
    stop();
  });

  test("a repeated key throws from replaceAll and writes nothing", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", price: 1 });
    });

    expect(() =>
      update(realm, (_read, write) => {
        write.replaceAll(rows, [
          { id: "b", price: 1 },
          { id: "b", price: 2 },
        ]);
      }),
    ).toThrow("appears twice");
    expect(keysOf(realm, rows)).toEqual(["a"]);
    expectRealmAtRest(realm);
  });

  test("a failed update puts back the keys and every row", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    update(realm, (_read, write) => {
      write.replaceAll(rows, [
        { id: "a", price: 1 },
        { id: "b", price: 2 },
      ]);
    });
    const { seen, stop } = watchAll(realm, {
      a: (read) => read(rows.row("a"))?.price,
      keys: (read) => read(rows.keys),
    });

    expect(() =>
      update(realm, (_read, write) => {
        write.upsert(rows, { id: "a", price: 10 });
        write.remove(rows, "b");
        write.upsert(rows, { id: "c", price: 3 });
        throw new Error("the recipe fails");
      }),
    ).toThrow("the recipe fails");

    expect(seen).toEqual({ a: [], keys: [] });
    expect(keysOf(realm, rows)).toEqual(["a", "b"]);
    expect(priceOf(realm, rows, "a")).toBe(1);
    expect(priceOf(realm, rows, "c")).toBeUndefined();
    stop();
    expectRealmAtRest(realm);
  });

  test("a row read inside a failed update for a key the update added reads as missing after", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    const { seen, stop } = watchAll(realm, { c: (read) => read(rows.row("c"))?.price });

    expect(() =>
      update(realm, (read, write) => {
        write.upsert(rows, { id: "c", price: 3 });
        expect(read(rows.row("c"))?.price).toBe(3);
        throw new Error("the recipe fails");
      }),
    ).toThrow("the recipe fails");

    expect(priceOf(realm, rows, "c")).toBeUndefined();
    expect(keysOf(realm, rows)).toEqual([]);
    update(realm, (_read, write) => {
      write.upsert(rows, { id: "c", price: 4 });
    });
    expect(priceOf(realm, rows, "c")).toBe(4);
    expect(seen).toEqual({ c: [4] });
    stop();
    expectRealmAtRest(realm);
  });

  test("a row first read inside a failed update after a write reads its old value after", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    update(realm, (_read, write) => {
      write.replaceAll(rows, [{ id: "a", price: 1 }]);
    });

    expect(() =>
      update(realm, (read, write) => {
        write.upsert(rows, { id: "a", price: 10 });
        expect(read(rows.row("a"))?.price).toBe(10);
        throw new Error("the recipe fails");
      }),
    ).toThrow("the recipe fails");

    expect(priceOf(realm, rows, "a")).toBe(1);
    const { seen, stop } = watchAll(realm, { a: (read) => read(rows.row("a"))?.price });
    update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", price: 5 });
    });
    expect(seen).toEqual({ a: [5] });
    stop();
    expectRealmAtRest(realm);
  });

  test("a failed replaceAll puts back a row first read inside it", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    update(realm, (_read, write) => {
      write.replaceAll(rows, [{ id: "a", price: 1 }]);
    });

    expect(() =>
      update(realm, (read, write) => {
        write.replaceAll(rows, [
          { id: "a", price: 10 },
          { id: "b", price: 2 },
        ]);
        expect(read(rows.row("a"))?.price).toBe(10);
        expect(read(rows.row("b"))?.price).toBe(2);
        throw new Error("the recipe fails");
      }),
    ).toThrow("the recipe fails");

    expect(priceOf(realm, rows, "a")).toBe(1);
    expect(priceOf(realm, rows, "b")).toBeUndefined();
    expect(untracked(realm, (read) => read(rows.rows))).toEqual([{ id: "a", price: 1 }]);
    expectRealmAtRest(realm);
  });

  test("a failed update puts back a removed row its readers read", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    update(realm, (_read, write) => {
      write.replaceAll(rows, [
        { id: "a", price: 1 },
        { id: "b", price: 2 },
      ]);
    });
    const { seen, stop } = watchAll(realm, { b: (read) => read(rows.row("b"))?.price });

    for (const remove of [
      (write: Write) => write.remove(rows, "b"),
      (write: Write) => write.replaceAll(rows, [{ id: "a", price: 1 }]),
    ]) {
      expect(() =>
        update(realm, (_read, write) => {
          remove(write);
          throw new Error("the recipe fails");
        }),
      ).toThrow("the recipe fails");
    }

    expect(seen).toEqual({ b: [] });
    expect(priceOf(realm, rows, "b")).toBe(2);
    update(realm, (_read, write) => {
      write.upsert(rows, { id: "b", price: 7 });
    });
    expect(seen).toEqual({ b: [7] });
    stop();
    expectRealmAtRest(realm);
  });

  test("a reader of every row reruns on a write to a row nobody reads alone", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    update(realm, (_read, write) => {
      write.replaceAll(rows, [
        { id: "a", price: 1 },
        { id: "b", price: 2 },
      ]);
    });
    const { seen, stop } = watchAll(realm, {
      prices: (read) => read(rows.rows).map((row) => row.price),
    });

    update(realm, (_read, write) => {
      write.upsert(rows, { id: "b", price: 5 });
    });
    update(realm, (_read, write) => {
      write.replaceAll(rows, [
        { id: "a", price: 6 },
        { id: "b", price: 5 },
      ]);
    });

    expect(seen).toEqual({
      prices: [
        [1, 5],
        [6, 5],
      ],
    });
    stop();
    expectRealmAtRest(realm);
  });

  test("a key's row keeps its identity through a failed update", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    update(realm, (_read, write) => {
      write.replaceAll(rows, [{ id: "a", price: 1 }]);
    });
    const row = rows.row("a");

    expect(() =>
      update(realm, (_read, write) => {
        write.remove(rows, "a");
        throw new Error("the recipe fails");
      }),
    ).toThrow("the recipe fails");
    expect(() =>
      update(realm, (_read, write) => {
        write.replaceAll(rows, []);
        throw new Error("the recipe fails");
      }),
    ).toThrow("the recipe fails");

    expect(rows.row("a")).toBe(row);
    expect(untracked(realm, (read) => read(row))?.price).toBe(1);
    expectRealmAtRest(realm);
  });

  test("a write kept past its update throws", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    const write = keptWrite(realm);

    expect(() => write.upsert(rows, { id: "a", price: 1 })).toThrow("inside update");
    expect(() => write.remove(rows, "a")).toThrow("inside update");
    expect(() => write.replaceAll(rows, [])).toThrow("inside update");
    expectRealmAtRest(realm);
  });
});

describe("a collection's keys", () => {
  test("are observed while anything reads the collection, so a feed can run for exactly that long", () => {
    const realm = createRealm();
    const rows = collection<string, Row>(realm, { keyOf: (row) => row.id });
    const log: Array<string> = [];
    onObserved(rows.keys, () => {
      log.push("start");
      return () => log.push("stop");
    });
    for (const reader of [rows.keys, rows.rows, rows.row("a")]) {
      const release = observe(reader);
      expect(log.at(-1)).toBe("start");
      release();
      expect(log.at(-1)).toBe("stop");
    }
    expect(log).toEqual(["start", "stop", "start", "stop", "start", "stop"]);
  });
});

/** The cells and row computed values a collection keeps, for `read.row`'s tests. */
interface Kept {
  readonly cells: ReadonlyMap<unknown, unknown>;
  readonly rowsByKey: ReadonlyMap<unknown, unknown>;
}

const keptBy = (rows: Collection<string, Row>) => {
  const kept = rows as unknown as Kept;
  return { cells: kept.cells.size, rows: kept.rowsByKey.size };
};

describe("read.row", () => {
  test("where nothing tracks, it reads the held row and makes no cell or row computed", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    update(realm, (_read, write) => {
      write.replaceAll(rows, [
        { id: "a", price: 1 },
        { id: "b", price: 2 },
      ]);
    });

    expect(untracked(realm, (read) => read.row(rows, "a")?.price)).toBe(1);
    expect(untracked(realm, (read) => read.row(rows, "c"))).toBeUndefined();
    update(realm, (read, write) => {
      const row = read.row(rows, "b");
      if (row !== undefined) {
        write.upsert(rows, { ...row, price: row.price + 1 });
      }
      expect(read.row(rows, "b")?.price).toBe(3);
    });

    expect(untracked(realm, (read) => read.row(rows, "b")?.price)).toBe(3);
    expect(keptBy(rows)).toEqual({ cells: 0, rows: 0 });
    expectRealmAtRest(realm);
  });

  test("with equals, it reads the row the collection kept", () => {
    const realm = createRealm();
    const rows = collection(realm, {
      keyOf,
      equals: (left: Row, right: Row) => left.price === right.price,
    });
    const first = { id: "a", price: 1 };
    update(realm, (_read, write) => {
      write.upsert(rows, first);
      write.upsert(rows, { id: "a", price: 1 });
    });

    expect(untracked(realm, (read) => read.row(rows, "a"))).toBe(first);
    expectRealmAtRest(realm);
  });

  test("after a failed update, it reads every row as it was before", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    update(realm, (_read, write) => {
      write.replaceAll(rows, [
        { id: "a", price: 1 },
        { id: "b", price: 2 },
      ]);
    });

    expect(() =>
      update(realm, (read, write) => {
        write.upsert(rows, { id: "a", price: 10 });
        write.remove(rows, "b");
        write.upsert(rows, { id: "c", price: 3 });
        expect(read.row(rows, "a")?.price).toBe(10);
        expect(read.row(rows, "b")).toBeUndefined();
        expect(read.row(rows, "c")?.price).toBe(3);
        throw new Error("the recipe fails");
      }),
    ).toThrow("the recipe fails");

    expect(untracked(realm, (read) => read.row(rows, "a")?.price)).toBe(1);
    expect(untracked(realm, (read) => read.row(rows, "b")?.price)).toBe(2);
    expect(untracked(realm, (read) => read.row(rows, "c"))).toBeUndefined();
    expect(keptBy(rows)).toEqual({ cells: 0, rows: 0 });
    expectRealmAtRest(realm);
  });

  test("in a tracked place, it tracks that key alone", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    update(realm, (_read, write) => {
      write.replaceAll(rows, [
        { id: "a", price: 1 },
        { id: "b", price: 2 },
      ]);
    });
    const { seen, stop } = watchAll(realm, {
      a: (read) => read.row(rows, "a")?.price,
      c: (read) => read.row(rows, "c")?.price,
    });

    update(realm, (_read, write) => {
      write.upsert(rows, { id: "b", price: 20 });
    });
    expect(seen).toEqual({ a: [], c: [] });
    update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", price: 10 });
      write.upsert(rows, { id: "c", price: 3 });
    });
    expect(seen).toEqual({ a: [10], c: [3] });
    update(realm, (_read, write) => {
      write.remove(rows, "a");
    });
    expect(seen).toEqual({ a: [10, undefined], c: [3] });
    stop();
    expectRealmAtRest(realm);
  });

  test("a reader that comes after an untracked read.row of a key still reruns on its writes", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", price: 1 });
    });
    expect(untracked(realm, (read) => read.row(rows, "a")?.price)).toBe(1);
    const { seen, stop } = watchAll(realm, {
      a: (read) => read(rows.row("a"))?.price,
      rowA: (read) => read.row(rows, "a")?.price,
    });

    update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", price: 2 });
    });
    expect(seen).toEqual({ a: [2], rowA: [2] });
    stop();
    expectRealmAtRest(realm);
  });

  test("it throws outside every place, and for a collection of another realm", () => {
    const realm = createRealm();
    const other = createRealm({ name: "other" });
    const rows = collection(realm, { keyOf });
    const read = keptRead(realm);

    expect(() => read.row(rows, "a")).toThrow("read.row($collection, key) runs outside a place");
    expect(() => untracked(other, (read) => read.row(rows, "a"))).toThrow(
      "read.row($observable) is handed an observable of another realm",
    );
    expect(untracked(realm, () => read.row(rows, "a"))).toBeUndefined();
    expectRealmAtRest(realm);
    expectRealmAtRest(other);
  });

  test("in a computed value nothing observes, it reads the row as of each read", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", price: 1 });
    });
    const price = computed(realm, (read) => read.row(rows, "a")?.price);
    const priceOf = computedFunction(realm, (read, id: string) => read.row(rows, id)?.price);

    expect(untracked(realm, (read) => [read(price), read(priceOf("a"))])).toEqual([1, 1]);
    update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", price: 2 });
    });
    expect(untracked(realm, (read) => [read(price), read(priceOf("a"))])).toEqual([2, 2]);
    const { seen, stop } = watchAll(realm, { price: (read) => read(price) });
    update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", price: 3 });
    });
    expect(seen).toEqual({ price: [3] });
    stop();
    expectRealmAtRest(realm);
  });
});

/** The value `rows` keeps between reads, for the retention tests below. */
const keptRowsOf = (rows: Collection<string, Row>): unknown =>
  (rows as unknown as { readonly allRows: { readonly source: { readonly value: unknown } } })
    .allRows.source.value;

describe("a collection's rows", () => {
  test("nothing observing them, a write that changes the rows lets go of the rows read before", () => {
    const realm = createRealm();
    const rows = collection<string, Row>(realm, { keyOf });
    update(realm, (_read, write) => {
      write.replaceAll(rows, [
        { id: "a", price: 1 },
        { id: "b", price: 2 },
      ]);
    });
    const reader = rows.rows;
    const before = untracked(realm, (read) => read(reader));
    expect(keptRowsOf(rows)).toBe(before);

    update(realm, (_read, write) => {
      write.replaceAll(rows, [
        { id: "a", price: 3 },
        { id: "c", price: 4 },
      ]);
    });
    // A `replaceAll` would otherwise keep the whole earlier generation alive.
    expect(keptRowsOf(rows)).toBeUndefined();
    expect(rows.rows).toBe(reader);
    expect(untracked(realm, (read) => read(reader))).toEqual([
      { id: "a", price: 3 },
      { id: "c", price: 4 },
    ]);

    for (const write of [
      (w: Write) => w.upsert(rows, { id: "d", price: 5 }),
      (w: Write) => w.upsert(rows, { id: "a", price: 6 }),
      (w: Write) => w.remove(rows, "c"),
    ]) {
      untracked(realm, (read) => read(reader));
      update(realm, (_read, w) => {
        write(w);
      });
      expect(keptRowsOf(rows)).toBeUndefined();
    }
    expect(untracked(realm, (read) => read(reader).map((row) => row.price))).toEqual([5, 6]);
    expectRealmAtRest(realm);
  });

  test("nothing observing it, a key's row lets go of the row a write replaced", () => {
    const realm = createRealm();
    const rows = collection<string, Row>(realm, { keyOf });
    update(realm, (_read, write) => {
      write.replaceAll(rows, [
        { id: "a", price: 1 },
        { id: "b", price: 2 },
      ]);
    });
    const keptRowOf = (key: string): unknown =>
      (
        rows as unknown as {
          readonly rowsByKey: ReadonlyMap<string, { readonly source: { readonly value: unknown } }>;
        }
      ).rowsByKey.get(key)?.source.value;
    const a = rows.row("a");
    const b = rows.row("b");
    untracked(realm, (read) => [read(a), read(b)]);
    // A row read while observed and then released keeps its value as well.
    observe(b)();
    expect(keptRowOf("a")).toEqual({ id: "a", price: 1 });

    update(realm, (_read, write) => {
      write.replaceAll(rows, [
        { id: "a", price: 3 },
        { id: "b", price: 2 },
      ]);
    });
    // Same key, new row: the row computed would otherwise keep the old one.
    expect(keptRowOf("a")).toBeUndefined();
    expect(untracked(realm, (read) => read(a))).toEqual({ id: "a", price: 3 });
    expect(keptRowOf("b")).toBeUndefined();

    untracked(realm, (read) => read(b));
    update(realm, (_read, write) => {
      write.upsert(rows, { id: "b", price: 4 });
    });
    expect(keptRowOf("b")).toBeUndefined();
    expect(keptRowOf("a")).toEqual({ id: "a", price: 3 });
    expect(untracked(realm, (read) => read(b))).toEqual({ id: "b", price: 4 });
    expectRealmAtRest(realm);
  });

  test("a write that changes nothing keeps the rows read before", () => {
    const realm = createRealm();
    const rows = collection<string, Row>(realm, { keyOf });
    const row = { id: "a", price: 1 };
    update(realm, (_read, write) => {
      write.replaceAll(rows, [row]);
    });
    const before = untracked(realm, (read) => read(rows.rows));
    update(realm, (_read, write) => {
      write.replaceAll(rows, [row]);
      write.upsert(rows, row);
    });
    expect(keptRowsOf(rows)).toBe(before);
    expect(untracked(realm, (read) => read(rows.rows))).toBe(before);
  });

  test("observed, they keep their value and report each write", () => {
    const realm = createRealm();
    const rows = collection<string, Row>(realm, { keyOf });
    update(realm, (_read, write) => {
      write.replaceAll(rows, [{ id: "a", price: 1 }]);
    });
    const { seen, stop } = watchAll(realm, {
      prices: (read) => read(rows.rows).map((row) => row.price),
    });
    update(realm, (_read, write) => {
      write.replaceAll(rows, [{ id: "b", price: 2 }]);
    });
    expect(keptRowsOf(rows)).toEqual([{ id: "b", price: 2 }]);
    expect(seen).toEqual({ prices: [[2]] });
    stop();
    expectRealmAtRest(realm);
  });

  test("a failed update that let go of them reads the rows it put back", () => {
    const realm = createRealm();
    const rows = collection<string, Row>(realm, { keyOf });
    update(realm, (_read, write) => {
      write.replaceAll(rows, [{ id: "a", price: 1 }]);
    });
    untracked(realm, (read) => read(rows.rows));
    let inside: ReadonlyArray<Row> = [];
    expect(() =>
      update(realm, (read, write) => {
        write.replaceAll(rows, [{ id: "b", price: 2 }]);
        inside = read(rows.rows);
        write.upsert(rows, { id: "c", price: 3 });
        throw new Error("the recipe fails");
      }),
    ).toThrow("the recipe fails");
    expect(inside).toEqual([{ id: "b", price: 2 }]);
    expect(untracked(realm, (read) => read(rows.rows))).toEqual([{ id: "a", price: 1 }]);
    expectRealmAtRest(realm);
  });
});
