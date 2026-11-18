import { describe, expect, test } from "bun:test";
import {
  type Box,
  box,
  type Collection,
  collection,
  computed,
  createRealm,
  onRowChange,
  type Realm,
  type RowChange,
  untracked,
  update,
  type Write,
  watch,
} from "../src/index.ts";
import { testRealm } from "../src/testing/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * `onRowChange` reports every row a write adds, replaces, or removes, inside
 * the writer's update. These tests keep a count of rows per group in a box,
 * as an application keeps an index, and check it against the rows after
 * every write, failed writes included.
 */

interface Row {
  readonly id: string;
  readonly group: string;
}

const keyOf = (row: Row): string => row.id;

const groupCounts = (rows: ReadonlyArray<Row>): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.group] = (counts[row.group] ?? 0) + 1;
  }
  return counts;
};

/**
 * A collection holding `held`, a count of rows per group kept by a listener
 * added after them, and every change it saw.
 */
const counted = (realm: Realm, held: ReadonlyArray<Row> = []) => {
  const rows = collection(realm, { keyOf });
  if (held.length > 0) {
    update(realm, (_read, write) => {
      write.replaceAll(rows, held);
      return undefined;
    });
  }
  const counts = box<Record<string, number>>(realm, {});
  const changes: Array<RowChange<string, Row>> = [];
  const stop = onRowChange(rows, (change, read, write) => {
    changes.push(change);
    const next = { ...read(counts) };
    if (change.before !== undefined) {
      next[change.before.group] = (next[change.before.group] ?? 0) - 1;
      if (next[change.before.group] === 0) {
        delete next[change.before.group];
      }
    }
    if (change.after !== undefined) {
      next[change.after.group] = (next[change.after.group] ?? 0) + 1;
    }
    write(counts, next);
    return undefined;
  });
  return { rows, counts, changes, stop };
};

const rowsOf = (realm: Realm, rows: Collection<string, Row>) =>
  untracked(realm, (read) => read(rows.rows));

const expectInStep = (
  realm: Realm,
  rows: Collection<string, Row>,
  counts: Box<Record<string, number>>,
): void => {
  expect(untracked(realm, (read) => read(counts))).toEqual(groupCounts(rowsOf(realm, rows)));
};

const a1 = { id: "a", group: "one" };
const a2 = { id: "a", group: "two" };
const b1 = { id: "b", group: "one" };
const c2 = { id: "c", group: "two" };

describe("onRowChange", () => {
  test("reports an added, a replaced, and a removed row, with the row before and after", () => {
    const realm = createRealm();
    const { rows, changes, counts } = counted(realm);
    update(realm, (_read, write) => {
      write.upsert(rows, a1);
      return undefined;
    });
    update(realm, (_read, write) => {
      write.upsert(rows, a2);
      return undefined;
    });
    update(realm, (_read, write) => {
      write.remove(rows, "a");
      return undefined;
    });
    expect(changes).toEqual([
      { key: "a", before: undefined, after: a1 },
      { key: "a", before: a1, after: a2 },
      { key: "a", before: a2, after: undefined },
    ]);
    expectInStep(realm, rows, counts);
    expectRealmAtRest(realm);
  });

  test("a write that leaves the row as it was reports nothing", () => {
    const realm = createRealm();
    const rows = collection(realm, {
      keyOf,
      equals: (previous: Row, next: Row) => previous.group === next.group,
    });
    const changes: Array<RowChange<string, Row>> = [];
    update(realm, (_read, write) => {
      write.upsert(rows, a1);
      return undefined;
    });
    onRowChange(rows, (change) => {
      changes.push(change);
      return undefined;
    });
    update(realm, (_read, write) => {
      write.upsert(rows, a1);
      write.upsert(rows, { id: "a", group: "one" });
      write.remove(rows, "missing");
      write.replaceAll(rows, [a1]);
      return undefined;
    });
    expect(changes).toEqual([{ key: "a", before: undefined, after: a1 }]);
  });

  test("a key a reader reads reports the row its cell kept", () => {
    const realm = createRealm();
    const rows = collection(realm, {
      keyOf,
      equals: (previous: Row, next: Row) => previous.group === next.group,
    });
    update(realm, (_read, write) => {
      write.upsert(rows, a1);
      return undefined;
    });
    const stopWatch = watch(
      realm,
      (read) => read(rows.row("a")),
      () => undefined,
    );
    const changes: Array<RowChange<string, Row>> = [];
    onRowChange(rows, (change) => {
      changes.push(change);
      return undefined;
    });
    update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", group: "one" });
      write.upsert(rows, a2);
      return undefined;
    });
    expect(changes).toEqual([
      { key: "a", before: undefined, after: a1 },
      { key: "a", before: a1, after: a2 },
    ]);
    stopWatch();
  });

  test("replaceAll reports a row at a time: removed and replaced rows, then added ones", () => {
    const realm = createRealm();
    const { rows, changes, counts } = counted(realm);
    update(realm, (_read, write) => {
      write.replaceAll(rows, [a1, b1]);
      return undefined;
    });
    changes.length = 0;
    update(realm, (_read, write) => {
      write.replaceAll(rows, [c2, a2]);
      return undefined;
    });
    expect(changes).toEqual([
      { key: "a", before: a1, after: a2 },
      { key: "b", before: b1, after: undefined },
      { key: "c", before: undefined, after: c2 },
    ]);
    changes.length = 0;
    update(realm, (_read, write) => {
      write.replaceAll(rows, [a2, c2]);
      return undefined;
    });
    expect(changes).toEqual([]);
    expectInStep(realm, rows, counts);
  });

  test("replaceAll reports held rows in key order, after an upsert put a key first", () => {
    const realm = createRealm();
    const { rows, changes } = counted(realm, [a1]);
    update(realm, (_read, write) => {
      write.upsert(rows, b1);
      return undefined;
    });
    changes.length = 0;
    update(realm, (_read, write) => {
      write.replaceAll(rows, []);
      return undefined;
    });
    expect(changes.map((change) => change.key)).toEqual(["b", "a"]);
  });

  test("the listener reads the rows as the write left them", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    const seen: Array<unknown> = [];
    onRowChange(rows, (change, read) => {
      seen.push([read.row(rows, change.key), read(rows.keys)]);
      return undefined;
    });
    update(realm, (_read, write) => {
      write.upsert(rows, a1);
      write.upsert(rows, b1, { at: "end" });
      return undefined;
    });
    expect(seen).toEqual([
      [a1, ["a"]],
      [b1, ["a", "b"]],
    ]);
  });

  test("a watcher sees the rows and the listener's writes in one delivery", () => {
    const realm = createRealm();
    const { rows, counts } = counted(realm);
    const seen: Array<unknown> = [];
    const stop = watch(
      realm,
      (read) => [read(rows.keys).length, read(counts)["one"] ?? 0],
      (value) => {
        seen.push(value);
      },
    );
    update(realm, (_read, write) => {
      write.upsert(rows, a1);
      write.upsert(rows, b1);
      return undefined;
    });
    expect(seen).toEqual([[2, 2]]);
    stop();
  });

  test("a listener added to held rows hears each as added, in key order", () => {
    const realm = createRealm();
    const { rows, changes, counts } = counted(realm, [b1, a1, c2]);
    expect(changes).toEqual([
      { key: "b", before: undefined, after: b1 },
      { key: "a", before: undefined, after: a1 },
      { key: "c", before: undefined, after: c2 },
    ]);
    expectInStep(realm, rows, counts);
    expectRealmAtRest(realm);
  });

  test("a listener added later replays to itself alone", () => {
    const realm = createRealm();
    const { rows, changes } = counted(realm, [a1]);
    const later: Array<RowChange<string, Row>> = [];
    onRowChange(rows, (change) => {
      later.push(change);
      return undefined;
    });
    expect(changes).toEqual([{ key: "a", before: undefined, after: a1 }]);
    expect(later).toEqual([{ key: "a", before: undefined, after: a1 }]);
  });

  test("added inside an update, the listener hears the rows that update wrote", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    const changes: Array<RowChange<string, Row>> = [];
    update(realm, (_read, write) => {
      write.upsert(rows, a1);
      onRowChange(rows, (change) => {
        changes.push(change);
        return undefined;
      });
      write.upsert(rows, b1, { at: "end" });
      return undefined;
    });
    expect(changes).toEqual([
      { key: "a", before: undefined, after: a1 },
      { key: "b", before: undefined, after: b1 },
    ]);
  });

  test("a watcher sees what the replay wrote once", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    const counts = box(realm, 0);
    update(realm, (_read, write) => {
      write.replaceAll(rows, [a1, b1]);
      return undefined;
    });
    const seen: Array<number> = [];
    const stopWatch = watch(
      realm,
      (read) => read(counts),
      (value) => {
        seen.push(value);
      },
    );
    const stop = onRowChange(rows, (_change, read, write) => {
      write(counts, read(counts) + 1);
      return undefined;
    });
    expect(seen).toEqual([2]);
    stop();
    stopWatch();
  });

  test("a listener added while another reports throws", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    onRowChange(rows, () => {
      onRowChange(rows, () => undefined);
      return undefined;
    });
    expect(() =>
      update(realm, (_read, write) => {
        write.upsert(rows, a1);
        return undefined;
      }),
    ).toThrow("onRowChange on the collection an onRowChange listener is reporting");
    expect(rowsOf(realm, rows)).toEqual([]);
  });
});

describe("onRowChange and a failed write", () => {
  test("an update that throws after the write puts back the rows and the listener's writes", () => {
    const realm = createRealm();
    const { rows, counts } = counted(realm);
    update(realm, (_read, write) => {
      write.upsert(rows, a1);
      return undefined;
    });
    expect(() =>
      update(realm, (_read, write) => {
        write.upsert(rows, a2);
        write.upsert(rows, c2);
        write.remove(rows, "a");
        throw new Error("later");
      }),
    ).toThrow("later");
    expect(rowsOf(realm, rows)).toEqual([a1]);
    expectInStep(realm, rows, counts);
    expectRealmAtRest(realm);
  });

  test("a listener that throws fails the write: the row is put back and the error reaches the writer", () => {
    const realm = createRealm();
    const { rows, counts } = counted(realm);
    onRowChange(rows, (change) => {
      if (change.after?.group === "two") {
        throw new Error("refused");
      }
      return undefined;
    });
    update(realm, (_read, write) => {
      write.upsert(rows, a1);
      return undefined;
    });
    expect(() =>
      update(realm, (_read, write) => {
        write.upsert(rows, b1);
        write.upsert(rows, c2);
        return undefined;
      }),
    ).toThrow("refused");
    expect(rowsOf(realm, rows)).toEqual([a1]);
    expectInStep(realm, rows, counts);
    expectRealmAtRest(realm);
  });

  test("a caught listener error puts back that write alone, the earlier listener's writes included", () => {
    const realm = createRealm();
    const { rows, counts } = counted(realm);
    onRowChange(rows, (change) => {
      if (change.after?.group === "two") {
        throw new Error("refused");
      }
      return undefined;
    });
    for (const write of [
      (write: Write) => write.upsert(rows, c2),
      (write: Write) => write.replaceAll(rows, [b1, c2]),
    ]) {
      update(realm, (_read, writer) => {
        writer.upsert(rows, a1);
        expect(() => write(writer)).toThrow("refused");
        return undefined;
      });
      expect(rowsOf(realm, rows)).toEqual([a1]);
      expectInStep(realm, rows, counts);
    }
    expectRealmAtRest(realm);
  });

  test("a caught listener error on remove keeps the row", () => {
    const realm = createRealm();
    const { rows, counts } = counted(realm);
    update(realm, (_read, write) => {
      write.upsert(rows, a1);
      return undefined;
    });
    onRowChange(rows, (change) => {
      if (change.after === undefined) {
        throw new Error("refused");
      }
      return undefined;
    });
    update(realm, (_read, write) => {
      expect(() => write.remove(rows, "a")).toThrow("refused");
      return undefined;
    });
    expect(rowsOf(realm, rows)).toEqual([a1]);
    expectInStep(realm, rows, counts);
  });

  test("a listener added inside a failed update is removed with it", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    const changes: Array<RowChange<string, Row>> = [];
    expect(() =>
      update(realm, () => {
        onRowChange(rows, (change) => {
          changes.push(change);
          return undefined;
        });
        throw new Error("later");
      }),
    ).toThrow("later");
    update(realm, (_read, write) => {
      write.upsert(rows, a1);
      return undefined;
    });
    expect(changes).toEqual([]);
  });

  test("a replay that throws adds no listener and puts back what it wrote", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    const seen = box(realm, 0);
    update(realm, (_read, write) => {
      write.replaceAll(rows, [a1, b1]);
      return undefined;
    });
    let calls = 0;
    expect(() =>
      onRowChange(rows, (change, read, write) => {
        calls++;
        write(seen, read(seen) + 1);
        if (change.key === "b") {
          throw new Error("no b");
        }
        return undefined;
      }),
    ).toThrow("no b");
    expect(untracked(realm, (read) => read(seen))).toBe(0);
    update(realm, (_read, write) => {
      write.upsert(rows, c2);
      return undefined;
    });
    expect(calls).toBe(2);
    expectRealmAtRest(realm);
  });

  test("a replay that throws inside an update the caller goes on with undoes only the replay", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    const seen = box(realm, 0);
    update(realm, (_read, write) => {
      write.upsert(rows, a1);
      expect(() =>
        onRowChange(rows, (_change, read, write) => {
          write(seen, read(seen) + 1);
          throw new Error("no rows");
        }),
      ).toThrow("no rows");
      write.upsert(rows, b1);
      return undefined;
    });
    expect(untracked(realm, (read) => read(seen))).toBe(0);
    expect(rowsOf(realm, rows)).toEqual([b1, a1]);
  });
});

describe("onRowChange's limits", () => {
  test("a listener that writes the collection it listens to throws", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    onRowChange(rows, (change, _read, write) => {
      write.upsert(rows, { id: `${change.key}!`, group: "one" });
      return undefined;
    });
    expect(() =>
      update(realm, (_read, write) => {
        write.upsert(rows, a1);
        return undefined;
      }),
    ).toThrow("never its own");
    expect(rowsOf(realm, rows)).toEqual([]);
  });

  test("a listener that removes itself, then writes its collection, throws", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    const stop = onRowChange(rows, (change, _read, write) => {
      stop();
      write.upsert(rows, { id: `${change.key}!`, group: "one" });
      return undefined;
    });
    expect(() =>
      update(realm, (_read, write) => {
        write.upsert(rows, a1);
        return undefined;
      }),
    ).toThrow("never its own");
    expect(rowsOf(realm, rows)).toEqual([]);
  });

  test("onRowChange in a computed value throws, naming onRowChange", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    const adds = computed(realm, () => onRowChange(rows, () => undefined));
    expect(() => untracked(realm, (read) => read(adds))).toThrow(
      "pinna: onRowChange cannot run in a computed value",
    );
  });

  test("untracked cannot install a row listener inside a computed value", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    let calls = 0;
    const adds = computed(realm, () =>
      untracked(realm, () =>
        onRowChange(rows, () => {
          calls++;
        }),
      ),
    );
    expect(() => untracked(realm, (read) => read(adds))).toThrow(
      "pinna: onRowChange cannot run in a computed value",
    );
    update(realm, (_read, write) => write.upsert(rows, a1));
    expect(calls).toBe(0);
    expectRealmAtRest(realm);
  });

  test("a listener that returns a value throws", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    onRowChange(rows, (async () => undefined) as unknown as () => undefined);
    expect(() =>
      update(realm, (_read, write) => {
        write.upsert(rows, a1);
        return undefined;
      }),
    ).toThrow("synchronous and returns nothing");
  });

  test("the returned function removes the listener, and a second call does nothing", () => {
    const realm = createRealm();
    const { rows, changes, stop } = counted(realm);
    stop();
    stop();
    update(realm, (_read, write) => {
      write.upsert(rows, a1);
      return undefined;
    });
    expect(changes).toEqual([]);
  });

  test("one function added twice is two listeners", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    let calls = 0;
    const listener = () => {
      calls++;
      return undefined;
    };
    const stop = onRowChange(rows, listener);
    onRowChange(rows, listener);
    stop();
    update(realm, (_read, write) => {
      write.upsert(rows, a1);
      return undefined;
    });
    expect(calls).toBe(1);
  });

  test("a collection Pinna did not make throws", () => {
    const realm = createRealm();
    const rows = collection(realm, { keyOf });
    const copy = { row: rows.row.bind(rows), keys: rows.keys, rows: rows.rows };
    expect(() => onRowChange(copy, () => undefined)).toThrow("made by Pinna");
  });

  test("a test realm reports a listener left running, and removes it", () => {
    const realm = testRealm();
    const rows = collection(realm, { keyOf });
    onRowChange(rows, () => undefined);
    expect(() => realm[Symbol.dispose]()).toThrow("onRowChange still running");
  });
});
