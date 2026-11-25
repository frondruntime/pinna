import { describe, expect, test } from "bun:test";
import { Collection, Computed, type Read, Realm, Source, type Write } from "../src/index.ts";
import { keptRead, keptWrite } from "./kept.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * The plain `Collection.make` has no schema and compares rows by `equals`, or by
 * identity without one. Its tracking is pinna-effect's `Model.collectionField`'s,
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
    return Realm.watch(realm, selects[name], (value) => {
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
  Realm.untracked(realm, (read) => read(rows.keys));
const priceOf = (realm: Realm, rows: Collection<string, Row>, id: string) =>
  Realm.untracked(realm, (read) => read(rows.row(id))?.price);

describe("collection", () => {
  for (const wasRead of [false, true]) {
    for (const operation of ["upsert", "replaceAll"] as const) {
      test(`${operation} rejects undefined and rolls back ${wasRead ? "on a row that was read" : "on a row never read"}`, () => {
        const realm = Realm.make();
        const rows = Collection.make<number, number | undefined>(realm, { keyOf: () => 1 });
        Realm.update(realm, (_read, write) => {
          write.upsert(rows, 7);
        });
        if (wasRead) {
          Realm.untracked(realm, (read) => read(rows.row(1)));
        }

        expect(() =>
          Realm.update(realm, (_read, write) => {
            write.upsert(rows, 8);
            if (operation === "upsert") {
              write.upsert(rows, undefined);
            } else {
              write.replaceAll(rows, [undefined]);
            }
          }),
        ).toThrow("pinna: a collection row cannot be undefined");
        expect(Realm.untracked(realm, (read) => read(rows.rows))).toEqual([7]);
        expect(Realm.untracked(realm, (read) => read.row(rows, 1))).toBe(7);
        expectRealmAtRest(realm);
      });
    }
  }

  test("replaceAll rejects undefined before changing rows when caught inside the update", () => {
    const realm = Realm.make();
    const rows = Collection.make<number, number | undefined>(realm, {
      keyOf: (value) => value ?? 0,
    });
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, 7);
    });
    Realm.update(realm, (read, write) => {
      expect(() => write.replaceAll(rows, [8, undefined])).toThrow(
        "pinna: a collection row cannot be undefined",
      );
      expect(read(rows.rows)).toEqual([7]);
      expect(read(rows.keys)).toEqual([7]);
    });
    expectRealmAtRest(realm);
  });

  test("starts empty and takes rows from upsert, remove, and replaceAll", () => {
    const realm = Realm.make();
    const rows = Collection.make(realm, { keyOf });
    expect(keysOf(realm, rows)).toEqual([]);

    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", price: 1 });
      write.upsert(rows, { id: "b", price: 2 }, { at: "end" });
    });
    expect(keysOf(realm, rows)).toEqual(["a", "b"]);

    Realm.update(realm, (_read, write) => {
      write.remove(rows, "a");
    });
    expect(keysOf(realm, rows)).toEqual(["b"]);

    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows, [
        { id: "c", price: 3 },
        { id: "b", price: 4 },
      ]);
    });
    expect(keysOf(realm, rows)).toEqual(["c", "b"]);
    expect(priceOf(realm, rows, "b")).toBe(4);
    expect(Realm.untracked(realm, (read) => read(rows.rows).map((row) => row.price))).toEqual([
      3, 4,
    ]);
    expectRealmAtRest(realm);
  });

  test("a write to one key notifies that key's readers only", () => {
    const realm = Realm.make();
    const rows = Collection.make(realm, { keyOf });
    Realm.update(realm, (_read, write) => {
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

    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", price: 10 });
    });

    expect(seen).toEqual({ a: [10], b: [], keys: [] });
    stop();
  });

  test("without equals, a new object under a key notifies its readers", () => {
    const realm = Realm.make();
    const rows = Collection.make(realm, { keyOf });
    const a = { id: "a", price: 1 };
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, a);
    });
    const { seen, stop } = watchAll(realm, { a: (read) => read(rows.row("a")) });

    Realm.update(realm, (_read, write) => {
      write.upsert(rows, a);
    });
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", price: 1 });
    });

    expect(seen.a).toEqual([{ id: "a", price: 1 }]);
    stop();
  });

  test("with equals, an equal row notifies nobody and the collection keeps the row it holds", () => {
    const realm = Realm.make();
    const rows = Collection.make(realm, {
      keyOf,
      equals: (previous, next) => previous.price === next.price,
    });
    const a = { id: "a", price: 1 };
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, a);
    });
    const { seen, stop } = watchAll(realm, { a: (read) => read(rows.row("a")) });

    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", price: 1 });
      write.replaceAll(rows, [{ id: "a", price: 1 }]);
    });

    expect(seen.a).toEqual([]);
    expect(Realm.untracked(realm, (read) => read(rows.row("a")))).toBe(a);
    stop();
  });

  test("a repeated key throws from replaceAll and writes nothing", () => {
    const realm = Realm.make();
    const rows = Collection.make(realm, { keyOf });
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", price: 1 });
    });

    expect(() =>
      Realm.update(realm, (_read, write) => {
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
    const realm = Realm.make();
    const rows = Collection.make(realm, { keyOf });
    Realm.update(realm, (_read, write) => {
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
      Realm.update(realm, (_read, write) => {
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
    const realm = Realm.make();
    const rows = Collection.make(realm, { keyOf });
    const { seen, stop } = watchAll(realm, { c: (read) => read(rows.row("c"))?.price });

    expect(() =>
      Realm.update(realm, (read, write) => {
        write.upsert(rows, { id: "c", price: 3 });
        expect(read(rows.row("c"))?.price).toBe(3);
        throw new Error("the recipe fails");
      }),
    ).toThrow("the recipe fails");

    expect(priceOf(realm, rows, "c")).toBeUndefined();
    expect(keysOf(realm, rows)).toEqual([]);
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { id: "c", price: 4 });
    });
    expect(priceOf(realm, rows, "c")).toBe(4);
    expect(seen).toEqual({ c: [4] });
    stop();
    expectRealmAtRest(realm);
  });

  test("a row first read inside a failed update after a write reads its old value after", () => {
    const realm = Realm.make();
    const rows = Collection.make(realm, { keyOf });
    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows, [{ id: "a", price: 1 }]);
    });

    expect(() =>
      Realm.update(realm, (read, write) => {
        write.upsert(rows, { id: "a", price: 10 });
        expect(read(rows.row("a"))?.price).toBe(10);
        throw new Error("the recipe fails");
      }),
    ).toThrow("the recipe fails");

    expect(priceOf(realm, rows, "a")).toBe(1);
    const { seen, stop } = watchAll(realm, { a: (read) => read(rows.row("a"))?.price });
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", price: 5 });
    });
    expect(seen).toEqual({ a: [5] });
    stop();
    expectRealmAtRest(realm);
  });

  test("a failed replaceAll puts back a row first read inside it", () => {
    const realm = Realm.make();
    const rows = Collection.make(realm, { keyOf });
    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows, [{ id: "a", price: 1 }]);
    });

    expect(() =>
      Realm.update(realm, (read, write) => {
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
    expect(Realm.untracked(realm, (read) => read(rows.rows))).toEqual([{ id: "a", price: 1 }]);
    expectRealmAtRest(realm);
  });

  test("a failed update puts back a removed row its readers read", () => {
    const realm = Realm.make();
    const rows = Collection.make(realm, { keyOf });
    Realm.update(realm, (_read, write) => {
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
        Realm.update(realm, (_read, write) => {
          remove(write);
          throw new Error("the recipe fails");
        }),
      ).toThrow("the recipe fails");
    }

    expect(seen).toEqual({ b: [] });
    expect(priceOf(realm, rows, "b")).toBe(2);
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { id: "b", price: 7 });
    });
    expect(seen).toEqual({ b: [7] });
    stop();
    expectRealmAtRest(realm);
  });

  test("a reader of every row reruns on a write to a row nobody reads alone", () => {
    const realm = Realm.make();
    const rows = Collection.make(realm, { keyOf });
    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows, [
        { id: "a", price: 1 },
        { id: "b", price: 2 },
      ]);
    });
    const { seen, stop } = watchAll(realm, {
      prices: (read) => read(rows.rows).map((row) => row.price),
    });

    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { id: "b", price: 5 });
    });
    Realm.update(realm, (_read, write) => {
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
    const realm = Realm.make();
    const rows = Collection.make(realm, { keyOf });
    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows, [{ id: "a", price: 1 }]);
    });
    const row = rows.row("a");

    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.remove(rows, "a");
        throw new Error("the recipe fails");
      }),
    ).toThrow("the recipe fails");
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.replaceAll(rows, []);
        throw new Error("the recipe fails");
      }),
    ).toThrow("the recipe fails");

    expect(rows.row("a")).toBe(row);
    expect(Realm.untracked(realm, (read) => read(row))?.price).toBe(1);
    expectRealmAtRest(realm);
  });

  test("a write kept past its update throws", () => {
    const realm = Realm.make();
    const rows = Collection.make(realm, { keyOf });
    const write = keptWrite(realm);

    expect(() => write.upsert(rows, { id: "a", price: 1 })).toThrow("inside Realm.update");
    expect(() => write.remove(rows, "a")).toThrow("inside Realm.update");
    expect(() => write.replaceAll(rows, [])).toThrow("inside Realm.update");
    expectRealmAtRest(realm);
  });
});

describe("a collection's keys", () => {
  test("are observed while anything reads the collection, so a feed can run for exactly that long", () => {
    const realm = Realm.make();
    const rows = Collection.make<string, Row>(realm, { keyOf: (row) => row.id });
    const log: Array<string> = [];
    Source.onObserved(rows.keys, () => {
      log.push("start");
      return () => log.push("stop");
    });
    for (const reader of [rows.keys, rows.rows, rows.row("a")]) {
      const release = Source.observe(reader);
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
  test("where nothing tracks, an untracked read of a held row starts nothing", () => {
    const realm = Realm.make();
    const rows = Collection.make(realm, { keyOf });
    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows, [
        { id: "a", price: 1 },
        { id: "b", price: 2 },
      ]);
    });

    expect(Realm.untracked(realm, (read) => read.row(rows, "a")?.price)).toBe(1);
    expect(Realm.untracked(realm, (read) => read.row(rows, "c"))).toBeUndefined();
    Realm.update(realm, (read, write) => {
      const row = read.row(rows, "b");
      if (row !== undefined) {
        write.upsert(rows, { ...row, price: row.price + 1 });
      }
      expect(read.row(rows, "b")?.price).toBe(3);
    });

    expect(Realm.untracked(realm, (read) => read.row(rows, "b")?.price)).toBe(3);
    expect(keptBy(rows)).toEqual({ cells: 0, rows: 0 });
    expectRealmAtRest(realm);
  });

  test("with equals, it reads the row the collection kept", () => {
    const realm = Realm.make();
    const rows = Collection.make(realm, {
      keyOf,
      equals: (left: Row, right: Row) => left.price === right.price,
    });
    const first = { id: "a", price: 1 };
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, first);
      write.upsert(rows, { id: "a", price: 1 });
    });

    expect(Realm.untracked(realm, (read) => read.row(rows, "a"))).toBe(first);
    expectRealmAtRest(realm);
  });

  test("after a failed update, it reads every row as it was before", () => {
    const realm = Realm.make();
    const rows = Collection.make(realm, { keyOf });
    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows, [
        { id: "a", price: 1 },
        { id: "b", price: 2 },
      ]);
    });

    expect(() =>
      Realm.update(realm, (read, write) => {
        write.upsert(rows, { id: "a", price: 10 });
        write.remove(rows, "b");
        write.upsert(rows, { id: "c", price: 3 });
        expect(read.row(rows, "a")?.price).toBe(10);
        expect(read.row(rows, "b")).toBeUndefined();
        expect(read.row(rows, "c")?.price).toBe(3);
        throw new Error("the recipe fails");
      }),
    ).toThrow("the recipe fails");

    expect(Realm.untracked(realm, (read) => read.row(rows, "a")?.price)).toBe(1);
    expect(Realm.untracked(realm, (read) => read.row(rows, "b")?.price)).toBe(2);
    expect(Realm.untracked(realm, (read) => read.row(rows, "c"))).toBeUndefined();
    expect(keptBy(rows)).toEqual({ cells: 0, rows: 0 });
    expectRealmAtRest(realm);
  });

  test("in a tracked place, it tracks that key alone", () => {
    const realm = Realm.make();
    const rows = Collection.make(realm, { keyOf });
    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows, [
        { id: "a", price: 1 },
        { id: "b", price: 2 },
      ]);
    });
    const { seen, stop } = watchAll(realm, {
      a: (read) => read.row(rows, "a")?.price,
      c: (read) => read.row(rows, "c")?.price,
    });

    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { id: "b", price: 20 });
    });
    expect(seen).toEqual({ a: [], c: [] });
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", price: 10 });
      write.upsert(rows, { id: "c", price: 3 });
    });
    expect(seen).toEqual({ a: [10], c: [3] });
    Realm.update(realm, (_read, write) => {
      write.remove(rows, "a");
    });
    expect(seen).toEqual({ a: [10, undefined], c: [3] });
    stop();
    expectRealmAtRest(realm);
  });

  test("a reader that comes after an untracked read.row of a key still reruns on its writes", () => {
    const realm = Realm.make();
    const rows = Collection.make(realm, { keyOf });
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", price: 1 });
    });
    expect(Realm.untracked(realm, (read) => read.row(rows, "a")?.price)).toBe(1);
    const { seen, stop } = watchAll(realm, {
      a: (read) => read(rows.row("a"))?.price,
      rowA: (read) => read.row(rows, "a")?.price,
    });

    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", price: 2 });
    });
    expect(seen).toEqual({ a: [2], rowA: [2] });
    stop();
    expectRealmAtRest(realm);
  });

  test("it throws outside every place, and for a collection of another realm", () => {
    const realm = Realm.make();
    const other = Realm.make({ name: "other" });
    const rows = Collection.make(realm, { keyOf });
    const read = keptRead(realm);

    expect(() => read.row(rows, "a")).toThrow("read.row($collection, key) runs outside a place");
    expect(() => Realm.untracked(other, (read) => read.row(rows, "a"))).toThrow(
      "read.row($observable) is handed an observable of another realm",
    );
    expect(Realm.untracked(realm, () => read.row(rows, "a"))).toBeUndefined();
    expectRealmAtRest(realm);
    expectRealmAtRest(other);
  });

  test("in a computed value nothing observes, it reads the row as of each read", () => {
    const realm = Realm.make();
    const rows = Collection.make(realm, { keyOf });
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", price: 1 });
    });
    const price = Computed.make(realm, (read) => read.row(rows, "a")?.price);
    const priceOf = Computed.fn(realm, (read, id: string) => read.row(rows, id)?.price);

    expect(Realm.untracked(realm, (read) => [read(price), read(priceOf("a"))])).toEqual([1, 1]);
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", price: 2 });
    });
    expect(Realm.untracked(realm, (read) => [read(price), read(priceOf("a"))])).toEqual([2, 2]);
    const { seen, stop } = watchAll(realm, { price: (read) => read(price) });
    Realm.update(realm, (_read, write) => {
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

/** The value a computed value keeps between reads. */
const keptValueOf = (value: unknown): unknown =>
  (value as { readonly source: { readonly value: unknown } }).source.value;

describe("a collection's rows", () => {
  test("nothing observing them, a write that changes the rows lets go of the rows read before", () => {
    const realm = Realm.make();
    const rows = Collection.make<string, Row>(realm, { keyOf });
    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows, [
        { id: "a", price: 1 },
        { id: "b", price: 2 },
      ]);
    });
    const reader = rows.rows;
    const before = Realm.untracked(realm, (read) => read(reader));
    expect(keptRowsOf(rows)).toBe(before);

    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows, [
        { id: "a", price: 3 },
        { id: "c", price: 4 },
      ]);
    });
    // A `replaceAll` would otherwise keep the whole earlier generation alive.
    expect(keptRowsOf(rows)).toBeUndefined();
    expect(rows.rows).toBe(reader);
    expect(Realm.untracked(realm, (read) => read(reader))).toEqual([
      { id: "a", price: 3 },
      { id: "c", price: 4 },
    ]);

    for (const write of [
      (w: Write) => w.upsert(rows, { id: "d", price: 5 }),
      (w: Write) => w.upsert(rows, { id: "a", price: 6 }),
      (w: Write) => w.remove(rows, "c"),
    ]) {
      Realm.untracked(realm, (read) => read(reader));
      Realm.update(realm, (_read, w) => {
        write(w);
      });
      expect(keptRowsOf(rows)).toBeUndefined();
    }
    expect(Realm.untracked(realm, (read) => read(reader).map((row) => row.price))).toEqual([5, 6]);
    expectRealmAtRest(realm);
  });

  test("nothing observing it, a key's row lets go of the row a write replaced", () => {
    const realm = Realm.make();
    const rows = Collection.make<string, Row>(realm, { keyOf });
    Realm.update(realm, (_read, write) => {
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
    Realm.untracked(realm, (read) => [read(a), read(b)]);
    // A row read while observed and then released keeps its value as well.
    Source.observe(b)();
    expect(keptRowOf("a")).toEqual({ id: "a", price: 1 });

    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows, [
        { id: "a", price: 3 },
        { id: "b", price: 2 },
      ]);
    });
    // Same key, new row: the row computed would otherwise keep the old one.
    expect(keptRowOf("a")).toBeUndefined();
    expect(Realm.untracked(realm, (read) => read(a))).toEqual({ id: "a", price: 3 });
    expect(keptRowOf("b")).toBeUndefined();

    Realm.untracked(realm, (read) => read(b));
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { id: "b", price: 4 });
    });
    expect(keptRowOf("b")).toBeUndefined();
    expect(keptRowOf("a")).toEqual({ id: "a", price: 3 });
    expect(Realm.untracked(realm, (read) => read(b))).toEqual({ id: "b", price: 4 });
    expectRealmAtRest(realm);
  });

  test("a write that changes nothing keeps the rows read before", () => {
    const realm = Realm.make();
    const rows = Collection.make<string, Row>(realm, { keyOf });
    const row = { id: "a", price: 1 };
    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows, [row]);
    });
    const before = Realm.untracked(realm, (read) => read(rows.rows));
    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows, [row]);
      write.upsert(rows, row);
    });
    expect(keptRowsOf(rows)).toBe(before);
    expect(Realm.untracked(realm, (read) => read(rows.rows))).toBe(before);
  });

  test("observed, they keep their value and report each write", () => {
    const realm = Realm.make();
    const rows = Collection.make<string, Row>(realm, { keyOf });
    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows, [{ id: "a", price: 1 }]);
    });
    const { seen, stop } = watchAll(realm, {
      prices: (read) => read(rows.rows).map((row) => row.price),
    });
    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows, [{ id: "b", price: 2 }]);
    });
    expect(keptRowsOf(rows)).toEqual([{ id: "b", price: 2 }]);
    expect(seen).toEqual({ prices: [[2]] });
    stop();
    expectRealmAtRest(realm);
  });

  test("a failed update that let go of them reads the rows it put back", () => {
    const realm = Realm.make();
    const rows = Collection.make<string, Row>(realm, { keyOf });
    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows, [{ id: "a", price: 1 }]);
    });
    Realm.untracked(realm, (read) => read(rows.rows));
    let inside: ReadonlyArray<Row> = [];
    expect(() =>
      Realm.update(realm, (read, write) => {
        write.replaceAll(rows, [{ id: "b", price: 2 }]);
        inside = read(rows.rows);
        write.upsert(rows, { id: "c", price: 3 });
        throw new Error("the recipe fails");
      }),
    ).toThrow("the recipe fails");
    expect(inside).toEqual([{ id: "b", price: 2 }]);
    expect(Realm.untracked(realm, (read) => read(rows.rows))).toEqual([{ id: "a", price: 1 }]);
    expectRealmAtRest(realm);
  });

  test("a row computed a caller holds lets go of the row of a key that left", () => {
    const realm = Realm.make();
    const rows = Collection.make<string, Row>(realm, { keyOf });
    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows, [
        { id: "a", price: 1 },
        { id: "b", price: 2 },
      ]);
    });
    const a = rows.row("a");
    const b = rows.row("b");
    Realm.untracked(realm, (read) => [read(a), read(b)]);
    Realm.update(realm, (_read, write) => {
      write.remove(rows, "a");
    });
    expect(keptValueOf(a)).toBeUndefined();
    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows, [{ id: "c", price: 3 }]);
    });
    expect(keptValueOf(b)).toBeUndefined();
    expect(Realm.untracked(realm, (read) => [read(a), read(b)])).toEqual([undefined, undefined]);
    expectRealmAtRest(realm);
  });

  test("a failed update lets go of the rows read inside it", () => {
    const realm = Realm.make();
    const rows = Collection.make<string, Row>(realm, { keyOf });
    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows, [{ id: "a", price: 1 }]);
    });
    const a = rows.row("a");
    for (const write of [
      (w: Write) => w.upsert(rows, { id: "a", price: 2 }),
      (w: Write) => w.replaceAll(rows, [{ id: "a", price: 2 }]),
      (w: Write) => w.remove(rows, "a"),
    ]) {
      expect(() =>
        Realm.update(realm, (read, w) => {
          write(w);
          read(a);
          read(rows.rows);
          throw new Error("the recipe fails");
        }),
      ).toThrow("the recipe fails");
      // The rolled-back rows would otherwise stay reachable until the next read.
      expect(keptValueOf(a)).toBeUndefined();
      expect(keptRowsOf(rows)).toBeUndefined();
      expect(Realm.untracked(realm, (read) => [read(a), read(rows.rows)])).toEqual([
        { id: "a", price: 1 },
        [{ id: "a", price: 1 }],
      ]);
    }
    expectRealmAtRest(realm);
  });
});

describe("prototype-named keys", () => {
  const names = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"] as const;

  test("a key named like an Object.prototype member is held, read, and removed as any other", () => {
    const realm = Realm.make();
    const rows = Collection.make<string, Row>(realm, { keyOf });
    Realm.update(realm, (_read, write) => {
      for (const [index, id] of names.entries()) {
        write.upsert(rows, { id, price: index }, { at: "end" });
      }
    });
    expect(keysOf(realm, rows)).toEqual([...names]);
    expect(names.map((id) => priceOf(realm, rows, id))).toEqual([0, 1, 2, 3, 4]);
    expect(priceOf(realm, rows, "missing")).toBeUndefined();

    Realm.update(realm, (_read, write) => {
      write.remove(rows, "__proto__");
    });
    expect(keysOf(realm, rows)).toEqual(names.slice(1));
    expect(Realm.untracked(realm, (read) => read(rows.row("__proto__")))).toBeUndefined();
    expectRealmAtRest(realm);
  });

  test("a row read under a prototype-named key it does not hold is undefined, and follows a later upsert", () => {
    const realm = Realm.make();
    const rows = Collection.make<string, Row>(realm, { keyOf });
    const seen: Array<number | undefined> = [];
    const stop = Realm.watch(
      realm,
      (read) => read(rows.row("constructor"))?.price,
      (price) => {
        seen.push(price);
      },
    );
    expect(Realm.untracked(realm, (read) => read(rows.row("toString")))).toBeUndefined();
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { id: "constructor", price: 9 });
    });
    expect(seen).toEqual([9]);
    stop();
    expectRealmAtRest(realm);
  });
});
