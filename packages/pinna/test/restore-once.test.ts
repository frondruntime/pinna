import { describe, expect, test } from "bun:test";
import {
  Box,
  Collection,
  Computed,
  isPinnaError,
  type OrderedView,
  Realm,
  Source,
  Stage,
  type UpdateRecord,
  View,
} from "../src/index.ts";
import { testRealm } from "../src/testing/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * Restore once (ruling 74, amending 69): `write.revert` and `write.replay`
 * check the record against the state before the first write, a row
 * listener registered when the record's update ended does not run again,
 * and one registered later hears the restore as any write. Probes P1 to P4
 * are the 0.2.0 review's.
 */

interface Row {
  readonly key: string;
  readonly value: number;
}

const keyOf = (row: Row): string => row.key;

const setup = () => {
  const realm = testRealm();
  const rows = Collection.make(realm, { keyOf, name: "rows" });
  const records: Array<UpdateRecord> = [];
  const stopRecords = Realm.onUpdate(realm, (record) => {
    records.push(record);
  });
  return { realm, rows, records, stopRecords };
};

/** The error `run` throws, checked to be `pinna/record-not-applicable`. */
const notApplicable = (run: () => void): Error => {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(isPinnaError(thrown, "PinnaUsageError")).toBe(true);
  expect((thrown as { code: string }).code).toBe("pinna/record-not-applicable");
  return thrown as Error;
};

const sumOf = (realm: Realm, rows: Collection<string, Row>): number =>
  Realm.untracked(realm, (read) => read(rows.rows).reduce((sum, row) => sum + row.value, 0));

const keepSum = (rows: Collection<string, Row>, sum: Box<number>) =>
  Collection.onRowChange(rows, (change, read, write) => {
    write(sum, read(sum) + (change.after?.value ?? 0) - (change.before?.value ?? 0));
  });

describe("the 0.2.0 review's probes", () => {
  test("P1: an out-of-order revert under a listener-kept sum throws and writes nothing", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    const sum = Box.make(realm, 0, { name: "sum" });
    const stop = keepSum(rows, sum);
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { key: "a", value: 1 });
      write.upsert(rows, { key: "b", value: 5 });
    });
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "a", value: 2 }));
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "b", value: 6 }));
    const error = notApplicable(() =>
      Realm.update(realm, (_read, write) => write.revert(records[1] as UpdateRecord)),
    );
    expect(error.message).toBe(
      `pinna: write.revert needs the box "sum" to hold the record's after, and it changed since; apply records in the order they landed, each to the state the previous one left`,
    );
    expect(Source.peek(sum)).toBe(8);
    expect(Source.peek(sum)).toBe(sumOf(realm, rows));
    expect(records).toHaveLength(3);
    stop();
    stopRecords();
  });

  test("P2: an out-of-order revert under an ordered view keeps the view in step with the rows", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    const view = View.ordered(rows, { compare: () => (left, right) => left.value - right.value });
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { key: "a", value: 1 });
      write.upsert(rows, { key: "b", value: 5 });
    });
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "a", value: 9 }));
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "b", value: 0 }));
    // The view's state is in no record, so the record holds row "a" alone,
    // which still holds its after: the revert applies, and the view hears it.
    Realm.update(realm, (_read, write) => write.revert(records[1] as UpdateRecord));
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual(["b", "a"]);
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "b", value: 3 }));
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual(["a", "b"]);
    View.dispose(view);
    stopRecords();
  });

  test("P3: a listener on one collection writes another the recipe wrote first; revert restores it", () => {
    using realm = testRealm();
    const a = Collection.make(realm, { keyOf });
    const b = Collection.make(realm, { keyOf });
    const stop = Collection.onRowChange(a, (change, _read, write) => {
      if (change.after !== undefined)
        write.upsert(b, { key: change.key, value: change.after.value * 10 });
      else write.remove(b, change.key);
    });
    const records: Array<UpdateRecord> = [];
    const stopRecords = Realm.onUpdate(realm, (record) => {
      records.push(record);
    });
    Realm.update(realm, (_read, write) => write.upsert(b, { key: "x", value: 7 }));
    Realm.update(realm, (_read, write) => {
      write.upsert(b, { key: "x", value: 8 });
      write.upsert(a, { key: "x", value: 1 });
    });
    expect(Realm.untracked(realm, (read) => read.row(b, "x"))).toEqual({ key: "x", value: 10 });
    Realm.update(realm, (_read, write) => write.revert(records[1] as UpdateRecord));
    expect(Realm.untracked(realm, (read) => read.row(b, "x"))).toEqual({ key: "x", value: 7 });
    expect(Realm.untracked(realm, (read) => read.row(a, "x"))).toBeUndefined();
    Realm.update(realm, (_read, write) => write.replay(records[1] as UpdateRecord));
    expect(Realm.untracked(realm, (read) => read.row(b, "x"))).toEqual({ key: "x", value: 10 });
    stop();
    stopRecords();
  });

  test("P4: in-order undo and redo with a view, a listener-kept sum, and a direct write", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    const sum = Box.make(realm, 0);
    const view = View.ordered(rows, { compare: () => (left, right) => left.value - right.value });
    const stop = keepSum(rows, sum);
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { key: "a", value: 4 });
      write(sum, 99);
    });
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "b", value: 1 }));
    const landed = records.length;
    Realm.update(realm, (_read, write) => write.revert(records[1] as UpdateRecord));
    Realm.update(realm, (_read, write) => write.revert(records[0] as UpdateRecord));
    expect([Source.peek(sum), Realm.untracked(realm, (read) => read(view.keys))]).toEqual([0, []]);
    Realm.update(realm, (_read, write) => write.replay(records[0] as UpdateRecord));
    Realm.update(realm, (_read, write) => write.replay(records[1] as UpdateRecord));
    expect([Source.peek(sum), Realm.untracked(realm, (read) => read(view.keys))]).toEqual([
      100,
      ["b", "a"],
    ]);
    expect(landed).toBe(2);
    stop();
    View.dispose(view);
    stopRecords();
  });
});

describe("a listener the record predates stays silent", () => {
  test("a listener that writes only while a box is off adds nothing on revert or replay", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    const enabled = Box.make(realm, false);
    const other = Collection.make(realm, { keyOf, name: "other" });
    const stop = Collection.onRowChange(rows, (change, read, write) => {
      if (!read(enabled) && change.after !== undefined) {
        write.upsert(other, { key: change.key, value: change.after.value });
      }
    });
    Realm.update(realm, (_read, write) => {
      write(enabled, true);
      write.upsert(rows, { key: "a", value: 1 });
    });
    expect(Realm.untracked(realm, (read) => read(other.keys))).toEqual([]);
    Realm.update(realm, (_read, write) => write.revert(records[0] as UpdateRecord));
    expect(
      Realm.untracked(realm, (read) => [read(enabled), read(rows.keys), read(other.keys)]),
    ).toEqual([false, [], []]);
    Realm.update(realm, (_read, write) => write.replay(records[0] as UpdateRecord));
    expect(
      Realm.untracked(realm, (read) => [read(enabled), read(rows.keys), read(other.keys)]),
    ).toEqual([true, ["a"], []]);
    stop();
    stopRecords();
  });
});

describe("a listener or a view added after the record hears the restore", () => {
  test("a later listener and a later view follow a revert and a replay", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { key: "a", value: 3 });
      write.upsert(rows, { key: "b", value: 1 });
    });
    const count = Box.make(realm, 0);
    const stop = Collection.onRowChange(rows, (change, read, write) => {
      write(
        count,
        read(count) + (change.after === undefined ? 0 : 1) - (change.before === undefined ? 0 : 1),
      );
    });
    const view = View.ordered(rows, { compare: () => (left, right) => left.value - right.value });
    expect(Source.peek(count)).toBe(2);
    Realm.update(realm, (_read, write) => write.revert(records[0] as UpdateRecord));
    expect([Source.peek(count), Realm.untracked(realm, (read) => read(view.keys))]).toEqual([
      0,
      [],
    ]);
    Realm.update(realm, (_read, write) => write.replay(records[0] as UpdateRecord));
    expect([Source.peek(count), Realm.untracked(realm, (read) => read(view.keys))]).toEqual([
      2,
      ["b", "a"],
    ]);
    stop();
    View.dispose(view);
    stopRecords();
  });
});

describe("a record whose update added a listener is refused", () => {
  test("a listener added beside row writes", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    const sum = Box.make(realm, 0);
    let stop: () => void = () => undefined;
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { key: "a", value: 2 });
      stop = keepSum(rows, sum);
      write.upsert(rows, { key: "b", value: 3 });
    });
    const error = notApplicable(() =>
      Realm.update(realm, (_read, write) => write.revert(records[0] as UpdateRecord)),
    );
    expect(error.message).toBe(
      'pinna: write.revert cannot apply a record whose update added a Collection.onRowChange listener to the collection "rows": the record holds what that listener wrote and its state from before it existed',
    );
    expect(Source.peek(sum)).toBe(5);
    notApplicable(() =>
      Realm.update(realm, (_read, write) => write.replay(records[0] as UpdateRecord)),
    );
    stop();
    stopRecords();
  });

  test("a listener added in an update over held rows, with no row change", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "a", value: 2 }));
    const sum = Box.make(realm, 0);
    const other = Box.make(realm, 0);
    let stop: () => void = () => undefined;
    Realm.update(realm, (_read, write) => {
      write(other, 1);
      stop = keepSum(rows, sum);
    });
    notApplicable(() =>
      Realm.update(realm, (_read, write) => write.revert(records[1] as UpdateRecord)),
    );
    expect([Source.peek(sum), Source.peek(other)]).toEqual([2, 1]);
    stop();
    stopRecords();
  });

  test("a listener added to another collection leaves this one's record alone", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    const other = Collection.make(realm, { keyOf, name: "other" });
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "a", value: 2 }));
    let stop: () => void = () => undefined;
    Realm.update(realm, () => {
      stop = Collection.onRowChange(other, () => undefined);
    });
    Realm.update(realm, (_read, write) => write.revert(records[0] as UpdateRecord));
    expect(Realm.untracked(realm, (read) => read(rows.keys))).toEqual([]);
    stop();
    stopRecords();
  });
});

describe("a record of a listener added at rest", () => {
  test("restores without running the listener", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "a", value: 2 }));
    const sum = Box.make(realm, 0);
    const stop = keepSum(rows, sum);
    // The listener heard the held row in an update of its own: its record.
    expect(records).toHaveLength(2);
    expect((records[1] as UpdateRecord).boxes.map((change) => change.after)).toEqual([2]);
    Realm.update(realm, (_read, write) => write.revert(records[1] as UpdateRecord));
    expect(Source.peek(sum)).toBe(2);
    expect(records).toHaveLength(2);
    // The record before it applies, and the listener hears its restore.
    Realm.update(realm, (_read, write) => write.revert(records[0] as UpdateRecord));
    expect(Source.peek(sum)).toBe(0);
    Realm.update(realm, (_read, write) => write.replay(records[0] as UpdateRecord));
    Realm.update(realm, (_read, write) => write.replay(records[1] as UpdateRecord));
    expect(Source.peek(sum)).toBe(2);
    // Over other rows than the ones it heard, it throws.
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "b", value: 1 }));
    notApplicable(() =>
      Realm.update(realm, (_read, write) => write.replay(records[1] as UpdateRecord)),
    );
    stop();
    stopRecords();
  });

  test("undo and redo across a listener that keeps an object, three records deep", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "a", value: 3 }));
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "b", value: 1 }));
    const $keys = Box.make(realm, { keys: [] as ReadonlyArray<string> });
    const stop = Collection.onRowChange(rows, (change, read, write) => {
      const kept = read($keys).keys.filter((key) => key !== change.key);
      write($keys, { keys: change.after === undefined ? kept : [...kept, change.key] });
    });
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "c", value: 2 }));
    expect(records).toHaveLength(4);
    const state = () =>
      Realm.untracked(realm, (read) => [read(rows.keys), [...read($keys).keys].sort()]);
    Realm.update(realm, (_read, write) => {
      for (let index = 3; index >= 0; index--) write.revert(records[index] as UpdateRecord);
    });
    expect(state()).toEqual([[], []]);
    Realm.update(realm, (_read, write) => write.replay(records[0] as UpdateRecord));
    expect(state()).toEqual([["a"], ["a"]]);
    // Its registration's record puts back the object it first built, which
    // the record after it holds.
    Realm.update(realm, (_read, write) => {
      for (let index = 1; index <= 3; index++) write.replay(records[index] as UpdateRecord);
    });
    expect(state()).toEqual([
      ["c", "b", "a"],
      ["a", "b", "c"],
    ]);
    stop();
    stopRecords();
  });
});

describe("a view is in no record and hears every restore", () => {
  const walk = (
    make: (rows: Collection<string, Row>) => {
      readonly shown: () => unknown;
      readonly dispose: () => void;
    },
  ) => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "a", value: 1 }));
    Realm.update(realm, (_read, write) => write.remove(rows, "a"));
    // Made at rest over no row: no record.
    const view = make(rows);
    expect(records).toHaveLength(2);
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "b", value: 2 }));
    const made = records[2] as UpdateRecord;
    expect(made.boxes).toEqual([]);
    expect(made.collections.map((change) => change.collection)).toEqual([rows]);
    const atEnd = view.shown();
    Realm.update(realm, (_read, write) => {
      write.revert(made);
      write.revert(records[1] as UpdateRecord);
      write.revert(records[0] as UpdateRecord);
    });
    const atStart = view.shown();
    Realm.update(realm, (_read, write) => {
      write.replay(records[0] as UpdateRecord);
      write.replay(records[1] as UpdateRecord);
      write.replay(made);
    });
    expect(view.shown()).toEqual(atEnd);
    view.dispose();
    stopRecords();
    return atStart;
  };

  test("an ordered view made at rest on an empty collection, undone and redone past", () => {
    const atStart = walk((rows) => {
      const view = View.ordered(rows, { compare: () => (left, right) => left.value - right.value });
      return { shown: () => Source.peek(view.keys), dispose: () => View.dispose(view) };
    });
    expect(atStart).toEqual([]);
  });

  test("a grouped view made at rest on an empty collection, undone and redone past", () => {
    const atStart = walk((rows) => {
      const view = View.grouped(rows, { groupOf: (row) => row.value % 2 });
      return {
        shown: () => [Source.peek(view.groups), Source.peek(view.group(0))],
        dispose: () => View.dispose(view),
      };
    });
    expect(atStart).toEqual([[], []]);
  });

  test("a totals view made at rest on an empty collection, undone and redone past", () => {
    const atStart = walk((rows) => {
      const view = View.totals(rows, {
        project: (row) => ({ group: "all", value: row.value }),
        arithmetic: { zero: 0, add: (a, b) => a + b, subtract: (a, b) => a - b },
      });
      return {
        shown: () => [Source.peek(view.groups), Source.peek(view.group("all"))],
        dispose: () => View.dispose(view),
      };
    });
    expect(atStart).toEqual([[], { count: 0, total: 0 }]);
  });

  test("a view made inside a recorded update is undone and redone with it", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    let view: OrderedView<string> | undefined;
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { key: "a", value: 2 });
      view = View.ordered(rows, { compare: () => (left, right) => left.value - right.value });
      write.upsert(rows, { key: "b", value: 1 });
    });
    const keys = () => Realm.untracked(realm, (read) => read((view as OrderedView<string>).keys));
    expect(keys()).toEqual(["b", "a"]);
    Realm.update(realm, (_read, write) => write.revert(records[0] as UpdateRecord));
    expect(keys()).toEqual([]);
    Realm.update(realm, (_read, write) => write.replay(records[0] as UpdateRecord));
    expect(keys()).toEqual(["b", "a"]);
    View.dispose(view as OrderedView<string>);
    stopRecords();
  });

  test("a record never names a view's box or collection", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    const ordered = View.ordered(rows, {
      compare: () => (left, right) => left.value - right.value,
      name: "ordered",
    });
    const grouped = View.grouped(rows, { groupOf: (row) => row.value % 2, name: "grouped" });
    const totals = View.totals(rows, {
      project: (row) => ({ group: row.value % 2, value: row.value }),
      arithmetic: { zero: 0, add: (a, b) => a + b, subtract: (a, b) => a - b },
      name: "totals",
    });
    const sum = Box.make(realm, 0);
    const stop = keepSum(rows, sum);
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { key: "a", value: 2 });
      write.upsert(rows, { key: "b", value: 3 });
    });
    const last = records[records.length - 1] as UpdateRecord;
    expect(last.boxes.map((change) => change.box)).toEqual([sum]);
    expect(last.collections.map((change) => change.collection)).toEqual([rows]);
    stop();
    View.dispose(ordered);
    View.dispose(grouped);
    View.dispose(totals);
    stopRecords();
  });
});

describe("limits", () => {
  test("a listener added to an empty collection that keeps an object throws on a later replay", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "a", value: 1 }));
    Realm.update(realm, (_read, write) => write.remove(rows, "a"));
    const $keys = Box.make(realm, { keys: [] as ReadonlyArray<string> }, { name: "keys" });
    // It hears no row as it is added: no record holds its first object.
    const stop = Collection.onRowChange(rows, (change, read, write) => {
      const kept = read($keys).keys.filter((key) => key !== change.key);
      write($keys, { keys: change.after === undefined ? kept : [...kept, change.key] });
    });
    expect(records).toHaveLength(2);
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "b", value: 2 }));
    const made = records[2] as UpdateRecord;
    Realm.update(realm, (_read, write) => {
      write.revert(made);
      write.revert(records[1] as UpdateRecord);
      write.revert(records[0] as UpdateRecord);
    });
    // It hears these restores and builds new objects.
    Realm.update(realm, (_read, write) => {
      write.replay(records[0] as UpdateRecord);
      write.replay(records[1] as UpdateRecord);
    });
    const error = notApplicable(() => Realm.update(realm, (_read, write) => write.replay(made)));
    expect(error.message).toContain('the box "keys"');
    expect(Realm.untracked(realm, (read) => [read(rows.keys), read($keys).keys])).toEqual([[], []]);
    stop();
    stopRecords();
  });
});

describe("only a record the realm handed out restores", () => {
  test("a copy of a record throws, and writes nothing", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    const sum = Box.make(realm, 0);
    const stop = keepSum(rows, sum);
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "a", value: 2 }));
    const copy = { ...(records[1] as UpdateRecord), name: "undo" };
    const error = notApplicable(() => Realm.update(realm, (_read, write) => write.revert(copy)));
    expect(error.message).toBe(
      "pinna: write.revert takes a record Realm.onUpdate handed out, and this is not one: a copy or a record made by hand loses what the realm kept beside it, such as which listeners its update had",
    );
    expect([Source.peek(sum), sumOf(realm, rows)]).toEqual([2, 2]);
    // A copy of a registration's record, and of a refused one, throw the same.
    notApplicable(() =>
      Realm.update(realm, (_read, write) => write.replay({ ...(records[0] as UpdateRecord) })),
    );
    stop();
    stopRecords();
  });

  test("a record a Realm.onUpdate listener makes while a registration settles is its own", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "a", value: 2 }));
    const unrelated = Box.make(realm, 0);
    let answered = false;
    const stopAnswer = Realm.onUpdate(realm, () => {
      if (answered) return;
      answered = true;
      Realm.update(realm, (_read, write) => write(unrelated, 42));
    });
    const sum = Box.make(realm, 0);
    const stop = keepSum(rows, sum);
    const answer = records[records.length - 1] as UpdateRecord;
    expect(answer.boxes.map((change) => change.box)).toEqual([unrelated]);
    Realm.update(realm, (_read, write) => write.revert(answer));
    expect(Source.peek(unrelated)).toBe(0);
    stop();
    stopAnswer();
    stopRecords();
  });

  test("a listener added in a nested update that fails does not refuse the outer record", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "a", value: 2 }));
    const other = Box.make(realm, 0);
    Realm.update(realm, (_read, write) => {
      try {
        Realm.update(realm, () => {
          Collection.onRowChange(rows, () => undefined);
          throw new Error("nested");
        });
      } catch {
        // The nested update's listener goes with it.
      }
      write(other, 1);
      write.upsert(rows, { key: "b", value: 1 });
    });
    const outer = records[records.length - 1] as UpdateRecord;
    Realm.update(realm, (_read, write) => write.revert(outer));
    expect([Source.peek(other), Realm.untracked(realm, (read) => read(rows.keys))]).toEqual([
      0,
      ["a"],
    ]);
    stopRecords();
  });

  test("a listener of a failed nested update hears nothing afterwards, and leaves no marker", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    let calls = 0;
    Realm.update(realm, (_read, write) => {
      try {
        Realm.update(realm, () => {
          Collection.onRowChange(rows, () => {
            calls++;
          });
          throw new Error("nested");
        });
      } catch {
        // The nested update's listener goes with it.
      }
      write.upsert(rows, { key: "a", value: 1 });
    });
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "b", value: 2 }));
    expect(calls).toBe(0);
    // A record made after it has no registration marker: it reverts and replays as any record.
    const later = records[records.length - 1] as UpdateRecord;
    Realm.update(realm, (_read, write) => write.revert(later));
    expect(Realm.untracked(realm, (read) => read(rows.keys))).toEqual(["a"]);
    Realm.update(realm, (_read, write) => write.replay(later));
    expect(Realm.untracked(realm, (read) => read(rows.keys))).toEqual(["b", "a"]);
    expect(calls).toBe(0);
    stopRecords();
  });
});

describe("a registration's marks end with its own update", () => {
  test("a listener whose replay throws inside an update, caught, does not refuse the update's record", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "a", value: 2 }));
    const other = Box.make(realm, 0);
    let caught: unknown;
    Realm.update(realm, (_read, write) => {
      try {
        Collection.onRowChange(rows, () => {
          throw new Error("replay");
        });
      } catch (error) {
        caught = error;
      }
      write(other, 1);
      write.upsert(rows, { key: "b", value: 1 });
    });
    expect((caught as Error).message).toBe("replay");
    const outer = records[records.length - 1] as UpdateRecord;
    Realm.update(realm, (_read, write) => write.revert(outer));
    expect([Source.peek(other), Realm.untracked(realm, (read) => read(rows.keys))]).toEqual([
      0,
      ["a"],
    ]);
    Realm.update(realm, (_read, write) => write.replay(outer));
    expect([Source.peek(other), Realm.untracked(realm, (read) => read(rows.keys))]).toEqual([
      1,
      ["b", "a"],
    ]);
    stopRecords();
  });

  test("a listener whose replay throws at rest leaves the next record restorable", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "a", value: 2 }));
    const other = Box.make(realm, 0);
    expect(() =>
      Collection.onRowChange(rows, () => {
        throw new Error("replay");
      }),
    ).toThrow("replay");
    Realm.update(realm, (_read, write) => {
      write(other, 1);
      write.upsert(rows, { key: "b", value: 1 });
    });
    const next = records[records.length - 1] as UpdateRecord;
    Realm.update(realm, (_read, write) => write.revert(next));
    expect([Source.peek(other), Realm.untracked(realm, (read) => read(rows.keys))]).toEqual([
      0,
      ["a"],
    ]);
    stopRecords();
  });

  test("a record an autorun makes while a registration at rest settles is its own", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "a", value: 2 }));
    const sum = Box.make(realm, 0);
    const unrelated = Box.make(realm, 0);
    const stopAutorun = Realm.autorun(realm, (read) => {
      const now = read(sum);
      if (now !== 0) Realm.update(realm, (_inner, write) => write(unrelated, now * 10));
    });
    const stop = keepSum(rows, sum);
    expect(Source.peek(unrelated)).toBe(20);
    const answer = records[records.length - 1] as UpdateRecord;
    expect(answer.boxes.map((change) => change.box)).toEqual([unrelated]);
    Realm.update(realm, (_read, write) => write.revert(answer));
    expect(Source.peek(unrelated)).toBe(0);
    Realm.update(realm, (_read, write) => write.replay(answer));
    expect(Source.peek(unrelated)).toBe(20);
    stopAutorun();
    stop();
    stopRecords();
  });
});

describe("a later listener that writes a recorded collection", () => {
  test("one that writes another row of the collection it hears is refused, and the rows stay", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { key: "a", value: 1 });
      write.upsert(rows, { key: "b", value: 5 });
    });
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "a", value: 2 }));
    let armed = false;
    const stop = Collection.onRowChange(rows, (change, _read, write) => {
      if (armed && change.key === "a") write.upsert(rows, { key: "b", value: 99 });
    });
    armed = true;
    let thrown: unknown;
    try {
      Realm.update(realm, (_read, write) => write.revert(records[1] as UpdateRecord));
    } catch (error) {
      thrown = error;
    }
    expect(isPinnaError(thrown, "PinnaUsageError")).toBe(true);
    expect((thrown as { code: string }).code).toBe("pinna/row-listener-reentrant");
    expect(Realm.untracked(realm, (read) => [read(rows.keys), read(rows.rows)])).toEqual([
      ["b", "a"],
      [
        { key: "b", value: 5 },
        { key: "a", value: 2 },
      ],
    ]);
    expect(records).toHaveLength(2);
    stop();
    stopRecords();
  });

  test("a revert it would leave wrong throws and writes nothing", () => {
    using realm = testRealm();
    const a = Collection.make(realm, { keyOf, name: "a" });
    const b = Collection.make(realm, { keyOf, name: "b" });
    const records: Array<UpdateRecord> = [];
    const stopRecords = Realm.onUpdate(realm, (record) => {
      records.push(record);
    });
    Realm.update(realm, (_read, write) => write.upsert(b, { key: "x", value: 7 }));
    Realm.update(realm, (_read, write) => {
      write.upsert(b, { key: "x", value: 8 });
      write.upsert(a, { key: "x", value: 1 });
    });
    // Added after the record: it hears the revert's removal of a's row.
    const stop = Collection.onRowChange(a, (change, _read, write) => {
      if (change.after === undefined) write.remove(b, change.key);
    });
    const state = () => Realm.untracked(realm, (read) => [read.row(a, "x"), read.row(b, "x")]);
    const error = notApplicable(() =>
      Realm.update(realm, (_read, write) => write.revert(records[1] as UpdateRecord)),
    );
    expect(error.message).toBe(
      `pinna: write.revert wrote the row under "x" of the collection "b", and a Collection.onRowChange listener added after the record changed it as it heard the restore of another collection; stop that listener first, or apply the change with Realm.update`,
    );
    expect(state()).toEqual([
      { key: "x", value: 1 },
      { key: "x", value: 8 },
    ]);
    expect(records).toHaveLength(2);
    stop();
    // Without the listener, the revert lands the record's before.
    Realm.update(realm, (_read, write) => write.revert(records[1] as UpdateRecord));
    expect(state()).toEqual([undefined, { key: "x", value: 7 }]);
    stopRecords();
  });

  test("a replay it would leave wrong throws and puts back every write", () => {
    using realm = testRealm();
    const a = Collection.make(realm, { keyOf, name: "a" });
    const b = Collection.make(realm, { keyOf, name: "b" });
    const records: Array<UpdateRecord> = [];
    const stopRecords = Realm.onUpdate(realm, (record) => {
      records.push(record);
    });
    Realm.update(realm, (_read, write) => {
      write.upsert(b, { key: "x", value: 8 });
      write.upsert(a, { key: "x", value: 1 });
    });
    Realm.update(realm, (_read, write) => write.revert(records[0] as UpdateRecord));
    const stop = Collection.onRowChange(a, (change, _read, write) => {
      if (change.after !== undefined) write.upsert(b, { key: "x", value: 10 });
    });
    const state = () => Realm.untracked(realm, (read) => [read.row(a, "x"), read.row(b, "x")]);
    const error = notApplicable(() =>
      Realm.update(realm, (_read, write) => write.replay(records[0] as UpdateRecord)),
    );
    expect(error.message).toContain(
      `pinna: write.replay wrote the row under "x" of the collection "b"`,
    );
    expect(state()).toEqual([undefined, undefined]);
    stop();
    Realm.update(realm, (_read, write) => write.replay(records[0] as UpdateRecord));
    expect(state()).toEqual([
      { key: "x", value: 1 },
      { key: "x", value: 8 },
    ]);
    stopRecords();
  });
});

describe("a restore is an ordinary write", () => {
  test("in a stage recipe, the stage shows the restore and lands it", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    const sum = Box.make(realm, 0);
    const stop = keepSum(rows, sum);
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "a", value: 2 }));
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "b", value: 3 }));
    const stage = Stage.make(realm, { name: "undo" });
    Stage.update(stage, (_read, write) => write.revert(records[1] as UpdateRecord));
    Stage.read(stage, (read) => {
      expect(read(sum)).toBe(2);
      expect(read(rows.keys)).toEqual(["a"]);
    });
    expect(Source.peek(sum)).toBe(5);
    Stage.apply(stage);
    expect([Source.peek(sum), Realm.untracked(realm, (read) => read(rows.keys))]).toEqual([
      2,
      ["a"],
    ]);
    expect((records[2] as UpdateRecord).stages).toEqual(["undo"]);
    // The restore's own record undoes it.
    Realm.update(realm, (_read, write) => write.revert(records[2] as UpdateRecord));
    expect([Source.peek(sum), sumOf(realm, rows)]).toEqual([5, 5]);
    stop();
    stopRecords();
  });

  test("in a stage recipe, a refused record throws from the recipe", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "a", value: 2 }));
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "a", value: 3 }));
    const stage = Stage.make(realm);
    notApplicable(() =>
      Stage.update(stage, (_read, write) => write.revert(records[0] as UpdateRecord)),
    );
    Stage.drop(stage);
    stopRecords();
  });

  test("a throw mid-restore, caught, puts back every write of it", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    const sum = Box.make(realm, 0);
    const stopSum = keepSum(rows, sum);
    const other = Box.make(realm, 0);
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { key: "a", value: 1 });
      write.upsert(rows, { key: "b", value: 2 });
      write(other, 1);
    });
    let heard = 0;
    const stopThrowing = Collection.onRowChange(rows, (change) => {
      if (change.after === undefined && ++heard === 2) throw new Error("second row");
    });
    heard = 0;
    let caught: unknown;
    Realm.update(realm, (_read, write) => {
      try {
        write.revert(records[0] as UpdateRecord);
      } catch (error) {
        caught = error;
      }
      write(other, 5);
    });
    expect((caught as Error).message).toBe("second row");
    expect(heard).toBe(2);
    expect(Realm.untracked(realm, (read) => [read(rows.keys), read(sum), read(other)])).toEqual([
      ["b", "a"],
      3,
      5,
    ]);
    stopThrowing();
    stopSum();
    stopRecords();
  });

  test("a nested update, an autorun, and a computed value see the record's values once", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    const sum = Box.make(realm, 0);
    const stop = keepSum(rows, sum);
    const double = Computed.make(realm, (read) => read(sum) * 2);
    const seen: Array<number> = [];
    const stopAutorun = Realm.autorun(realm, (read) => {
      seen.push(read(double));
    });
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "a", value: 2 }));
    Realm.update(realm, () => {
      Realm.update(realm, (_inner, inner) => inner.revert(records[0] as UpdateRecord));
    });
    expect(seen).toEqual([0, 4, 0]);
    expect(records).toHaveLength(2);
    expect(
      (records[1] as UpdateRecord).boxes.map((change) => [change.before, change.after]),
    ).toEqual([[2, 0]]);
    stopAutorun();
    stop();
    stopRecords();
  });

  test("a record of another realm throws and writes nothing", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    using otherRealm = testRealm();
    const otherRows = Collection.make(otherRealm, { keyOf });
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "a", value: 2 }));
    expect(() =>
      Realm.update(otherRealm, (_read, write) => write.revert(records[0] as UpdateRecord)),
    ).toThrow();
    expect(Realm.untracked(otherRealm, (read) => read(otherRows.keys))).toEqual([]);
    expect(Realm.untracked(realm, (read) => read(rows.keys))).toEqual(["a"]);
    stopRecords();
  });

  test("leaves the realm at rest", () => {
    const { realm, rows, records, stopRecords } = setup();
    using _realm = realm;
    const sum = Box.make(realm, 0);
    const stop = keepSum(rows, sum);
    Realm.update(realm, (_read, write) => write.upsert(rows, { key: "a", value: 2 }));
    Realm.update(realm, (_read, write) => write.revert(records[0] as UpdateRecord));
    stop();
    stopRecords();
    expectRealmAtRest(realm);
  });
});
