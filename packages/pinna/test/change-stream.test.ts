import { describe, expect, test } from "bun:test";
import {
  Atom,
  Box,
  Collection,
  Computed,
  isPinnaError,
  Realm,
  Source,
  Stage,
  type UpdateRecord,
  View,
  type Write,
} from "../src/index.ts";
import { testRealm } from "../src/testing/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * The change stream (ruling 69): `Realm.onUpdate` hands one record per
 * landed outermost update, net per box, row, key order, and atom, in base
 * values; `write.replay` and `write.revert` apply one forward and backward.
 */

interface Row {
  readonly id: string;
  readonly label: string;
}

const keyOf = (row: Row): string => row.id;

/** A realm with a listener that keeps every record. */
const listening = (realm: Realm) => {
  const records: Array<UpdateRecord> = [];
  const stop = Realm.onUpdate(realm, (record) => {
    records.push(record);
  });
  return { records, stop };
};

/** A collection holding `rows`, written before anything listens. */
const rowsOf = (realm: Realm, rows: ReadonlyArray<Row>) => {
  const $rows = Collection.make(realm, { keyOf, name: "rows" });
  Realm.update(realm, (_read, write) => write.replaceAll($rows, rows));
  return $rows;
};

const keysOf = (realm: Realm, $rows: Collection<string, Row>) =>
  Realm.untracked(realm, (read) => read($rows.keys));

const heldOf = (realm: Realm, $rows: Collection<string, Row>) =>
  Realm.untracked(realm, (read) => read($rows.rows));

describe("Realm.onUpdate alone", () => {
  test("hands one frozen record per landed update, with each box's value before and after", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $b = Box.make(realm, "x");
    const { records, stop } = listening(realm);
    Realm.update(realm, (_read, write) => {
      write($b, "y");
      write($a, 2);
    });
    expect(records).toHaveLength(1);
    const [record] = records as [UpdateRecord];
    expect(record.name).toBeUndefined();
    expect(record.stages).toEqual([]);
    expect(record.boxes).toEqual([
      { box: $b, before: "x", after: "y" },
      { box: $a, before: 1, after: 2 },
    ]);
    expect(record.collections).toEqual([]);
    expect(record.atoms).toEqual([]);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.boxes)).toBe(true);
    expect(Object.isFrozen(record.boxes[0])).toBe(true);
    stop();
    expectRealmAtRest(realm);
  });

  test("is net per box: three writes are one entry, and a box written back makes none", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $b = Box.make(realm, 10);
    const { records, stop } = listening(realm);
    Realm.update(realm, (_read, write) => {
      write($a, 2);
      write($a, 3);
      write($a, 4);
      write($b, 11);
      write($b, 10);
    });
    expect(records).toHaveLength(1);
    expect((records[0] as UpdateRecord).boxes).toEqual([{ box: $a, before: 1, after: 4 }]);
    stop();
  });

  test("makes no record for an update that changed nothing, or one that threw", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const { records, stop } = listening(realm);
    Realm.update(realm, () => undefined);
    Realm.update(realm, (_read, write) => {
      write($a, 2);
      write($a, 1);
    });
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write($a, 5);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(records).toEqual([]);
    stop();
  });

  test("carries the outermost update's name, ignores a nested one's, and throws for an empty one", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const { records, stop } = listening(realm);
    Realm.update(
      realm,
      (_read, write) => {
        write($a, 2);
        Realm.update(realm, (_inner, innerWrite) => innerWrite($a, 3), { name: "inner" });
      },
      { name: "outer" },
    );
    Realm.update(realm, (_read, write) => write($a, 4));
    expect(records.map((record) => record.name)).toEqual(["outer", undefined]);
    expect(() => Realm.update(realm, () => undefined, { name: "" })).toThrow(
      "pinna: a name is a non-empty string",
    );
    stop();
    expectRealmAtRest(realm);
  });

  test("carries no name an update stored before the listener was added", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    Realm.update(realm, (_read, write) => write($a, 2), { name: "before anyone listened" });
    const { records, stop } = listening(realm);
    Realm.update(realm, (_read, write) => write($a, 3));
    expect(records.map((record) => record.name)).toEqual([undefined]);
    stop();
  });

  test("leaves out what a nested update wrote and then rolled back when it threw and was caught", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $b = Box.make(realm, 1);
    const $rows = rowsOf(realm, [{ id: "a", label: "A" }]);
    const $atom = Atom.make(realm);
    const { records, stop } = listening(realm);
    Realm.update(realm, (_read, write) => {
      write($a, 2);
      try {
        Realm.update(realm, (_inner, inner) => {
          inner($b, 2);
          inner.upsert($rows, { id: "b", label: "B" });
          inner.changed($atom);
          throw new Error("inner");
        });
      } catch {
        // The outer update goes on.
      }
    });
    expect(records).toHaveLength(1);
    const [record] = records as [UpdateRecord];
    expect(record.boxes).toEqual([{ box: $a, before: 1, after: 2 }]);
    expect(record.collections).toEqual([]);
    expect(record.atoms).toEqual([]);
    stop();
  });

  test("records an atom's change, once per update, and replays it as a change", () => {
    using realm = testRealm();
    const $atom = Atom.make(realm);
    let runs = 0;
    const stopWatch = Realm.watch(
      realm,
      (read) => {
        read($atom);
        return ++runs;
      },
      () => undefined,
    );
    const { records, stop } = listening(realm);
    Realm.update(realm, (_read, write) => {
      write.changed($atom);
      write.changed($atom);
    });
    expect(records).toHaveLength(1);
    expect((records[0] as UpdateRecord).atoms).toEqual([$atom]);
    const before = runs;
    Realm.update(realm, (_read, write) => write.replay(records[0] as UpdateRecord));
    expect(runs).toBe(before + 1);
    stopWatch();
    stop();
  });
});

describe("Realm.onUpdate and collections", () => {
  test("reports each row's net change and the key order when it moved", () => {
    using realm = testRealm();
    const $rows = rowsOf(realm, [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ]);
    const { records, stop } = listening(realm);
    Realm.update(realm, (_read, write) => {
      write.upsert($rows, { id: "a", label: "A2" });
      write.upsert($rows, { id: "c", label: "C" }, { at: "end" });
      write.remove($rows, "b");
    });
    expect(records).toHaveLength(1);
    const [record] = records as [UpdateRecord];
    expect(record.boxes).toEqual([]);
    expect(record.collections).toEqual([
      {
        collection: $rows,
        rows: [
          { key: "a", before: { id: "a", label: "A" }, after: { id: "a", label: "A2" } },
          { key: "c", before: undefined, after: { id: "c", label: "C" } },
          { key: "b", before: { id: "b", label: "B" }, after: undefined },
        ],
        keys: { before: ["a", "b"], after: ["a", "c"] },
      },
    ]);
    stop();
  });

  test("leaves out the key order when only rows changed in place", () => {
    using realm = testRealm();
    const $rows = rowsOf(realm, [{ id: "a", label: "A" }]);
    const { records, stop } = listening(realm);
    Realm.update(realm, (_read, write) => write.upsert($rows, { id: "a", label: "A2" }));
    expect((records[0] as UpdateRecord).collections[0]?.keys).toBeUndefined();
    stop();
  });

  test("makes no entry for a row added and removed in one update", () => {
    using realm = testRealm();
    const $rows = rowsOf(realm, [{ id: "a", label: "A" }]);
    const { records, stop } = listening(realm);
    Realm.update(realm, (_read, write) => {
      write.upsert($rows, { id: "b", label: "B" });
      write.remove($rows, "b");
    });
    expect(records).toEqual([]);
    stop();
  });

  test("reports a replaceAll that reorders the same rows as a key order alone", () => {
    using realm = testRealm();
    const a = { id: "a", label: "A" };
    const b = { id: "b", label: "B" };
    const $rows = rowsOf(realm, [a, b]);
    const { records, stop } = listening(realm);
    Realm.update(realm, (_read, write) => write.replaceAll($rows, [b, a]));
    expect((records[0] as UpdateRecord).collections).toEqual([
      { collection: $rows, rows: [], keys: { before: ["a", "b"], after: ["b", "a"] } },
    ]);
    stop();
  });

  test("never lists a collection's own boxes, even for rows a reader read", () => {
    using realm = testRealm();
    const $rows = rowsOf(realm, [{ id: "a", label: "A" }]);
    const stopWatch = Realm.watch(
      realm,
      (read) => [read($rows.row("a")), read($rows.rows)],
      () => undefined,
    );
    const { records, stop } = listening(realm);
    Realm.update(realm, (_read, write) => {
      write.upsert($rows, { id: "a", label: "A2" });
      write.remove($rows, "a");
    });
    const [record] = records as [UpdateRecord];
    expect(record.boxes).toEqual([]);
    expect(record.collections[0]?.rows).toEqual([
      { key: "a", before: { id: "a", label: "A" }, after: undefined },
    ]);
    stopWatch();
    stop();
  });
});

describe("delivery", () => {
  test("runs after the update's watchers, outside any update", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const seen: Array<string> = [];
    const stopWatch = Realm.watch(
      realm,
      (read) => read($a),
      () => {
        seen.push("watch");
      },
    );
    const stop = Realm.onUpdate(realm, () => {
      seen.push("record");
      expectRealmAtRest(realm);
    });
    Realm.update(realm, (_read, write) => write($a, 2));
    expect(seen).toEqual(["watch", "record"]);
    stopWatch();
    stop();
  });

  test("queues a watch effect's update behind the update that ran it", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $double = Box.make(realm, 2);
    const stopWatch = Realm.watch(
      realm,
      (read) => read($a),
      (value) => {
        Realm.update(realm, (_read, write) => write($double, value * 2), { name: "double" });
      },
    );
    const { records, stop } = listening(realm);
    Realm.update(realm, (_read, write) => write($a, 5), { name: "set" });
    expect(records.map((record) => record.name)).toEqual(["set", "double"]);
    expect((records[1] as UpdateRecord).boxes).toEqual([{ box: $double, before: 2, after: 10 }]);
    stopWatch();
    stop();
  });

  test("lets a listener update, and hands that record out after the current one, to every listener", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $log = Box.make(realm, 0);
    const order: Array<string> = [];
    const stopFirst = Realm.onUpdate(realm, (record) => {
      order.push(`first ${record.name}`);
      if (record.name === "set") {
        Realm.update(realm, (read, write) => write($log, read($log) + 1), { name: "log" });
      }
    });
    const stopSecond = Realm.onUpdate(realm, (record) => {
      order.push(`second ${record.name}`);
    });
    Realm.update(realm, (_read, write) => write($a, 2), { name: "set" });
    expect(order).toEqual(["first set", "second set", "first log", "second log"]);
    stopFirst();
    stopSecond();
    expectRealmAtRest(realm);
  });

  test("hands an autorun's first-run update out as the autorun starts", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $b = Box.make(realm, 0);
    const { records, stop } = listening(realm);
    const stopAutorun = Realm.autorun(realm, (read) => {
      const value = read($a);
      Realm.update(realm, (_read, write) => write($b, value));
      return undefined;
    });
    expect(records).toHaveLength(1);
    expect((records[0] as UpdateRecord).boxes).toEqual([{ box: $b, before: 0, after: 1 }]);
    stopAutorun();
    stop();
  });

  test("hands a hook's update out by a microtask when no update encloses it", async () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $loaded = Box.make(realm, false);
    const stopHook = Source.onObserved($a, () => {
      Realm.update(realm, (_read, write) => write($loaded, true));
      return undefined;
    });
    const { records, stop } = listening(realm);
    const release = Source.observe($a);
    await Promise.resolve();
    expect(records).toHaveLength(1);
    expect((records[0] as UpdateRecord).boxes).toEqual([
      { box: $loaded, before: false, after: true },
    ]);
    release();
    stopHook();
    stop();
  });

  test("sends a listener's error to onError and still runs the other listeners", () => {
    const errors: Array<unknown> = [];
    using realm = testRealm({ onError: (error) => errors.push(error) });
    const $a = Box.make(realm, 1);
    const stopThrowing = Realm.onUpdate(realm, () => {
      throw new Error("listener");
    });
    const { records, stop } = listening(realm);
    Realm.update(realm, (_read, write) => write($a, 2));
    expect(records).toHaveLength(1);
    expect(errors).toEqual([new Error("listener")]);
    Realm.untracked(realm, (read) => expect(read($a)).toBe(2));
    stopThrowing();
    stop();
  });

  test("starts a listener added inside an update at the next update", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const records: Array<UpdateRecord> = [];
    let stop: () => void = () => undefined;
    Realm.update(realm, (_read, write) => {
      write($a, 2);
      stop = Realm.onUpdate(realm, (record) => {
        records.push(record);
      });
    });
    expect(records).toEqual([]);
    Realm.update(realm, (_read, write) => write($a, 3));
    expect(records).toHaveLength(1);
    expect((records[0] as UpdateRecord).boxes).toEqual([{ box: $a, before: 2, after: 3 }]);
    stop();
  });

  test("starts a listener added inside an update at the next update while another listener takes this one", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const { records: first, stop: stopFirst } = listening(realm);
    const late: Array<UpdateRecord> = [];
    let stopLate: () => void = () => undefined;
    Realm.update(realm, (_read, write) => {
      write($a, 2);
      stopLate = Realm.onUpdate(realm, (record) => {
        late.push(record);
      });
    });
    expect(first).toHaveLength(1);
    expect(late).toEqual([]);
    Realm.update(realm, (_read, write) => write($a, 3));
    expect(first).toHaveLength(2);
    expect(late.map((record) => record.boxes[0]?.after)).toEqual([3]);
    stopFirst();
    stopLate();
  });

  test("hands out the record when the settle throws to the writer, because onError threw", () => {
    using realm = testRealm({
      onError: (error) => {
        throw error;
      },
    });
    const $a = Box.make(realm, 1);
    const stopWatch = Realm.watch(
      realm,
      (read) => read($a),
      () => {
        throw new Error("watcher");
      },
    );
    const { records, stop } = listening(realm);
    expect(() => Realm.update(realm, (_read, write) => write($a, 2))).toThrow("watcher");
    expect(records).toHaveLength(1);
    expect((records[0] as UpdateRecord).boxes).toEqual([{ box: $a, before: 1, after: 2 }]);
    stopWatch();
    stop();
  });

  test("hands a queued record to no listener stopped before it went out", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $b = Box.make(realm, 1);
    const late: Array<UpdateRecord> = [];
    let stopLate: () => void = () => undefined;
    const stopFirst = Realm.onUpdate(realm, (record) => {
      if (record.name === "first") {
        Realm.update(realm, (_read, write) => write($b, 2), { name: "second" });
        stopLate();
      }
    });
    stopLate = Realm.onUpdate(realm, (record) => {
      late.push(record);
    });
    Realm.update(realm, (_read, write) => write($a, 2), { name: "first" });
    // Stopped by the first listener before its turn for "first", and before "second" went out.
    expect(late).toEqual([]);
    stopFirst();
  });

  test("keeps nothing after a listener stops inside an update", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $rows = rowsOf(realm, []);
    const { records, stop } = listening(realm);
    Realm.update(realm, (_read, write) => {
      write.upsert($rows, { id: "a", label: "A" });
      stop();
    });
    const { records: later, stop: stopLater } = listening(realm);
    Realm.update(realm, (_read, write) => write($a, 2));
    expect(records).toEqual([]);
    expect(later).toHaveLength(1);
    expect((later[0] as UpdateRecord).collections).toEqual([]);
    stopLater();
  });

  test("stops once: a second stop does nothing", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const { records, stop } = listening(realm);
    stop();
    stop();
    Realm.update(realm, (_read, write) => write($a, 2));
    expect(records).toEqual([]);
  });
});

describe("Realm.onUpdate refusals and lifecycle", () => {
  test("throws in a computed value, a watch's select, and a stage recipe", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const listener = () => undefined;
    const $bad = Computed.make(realm, (read) => {
      Realm.onUpdate(realm, listener);
      return read($a);
    });
    expect(() => Realm.untracked(realm, (read) => read($bad))).toThrow("Realm.onUpdate");
    const errors: Array<unknown> = [];
    using other = testRealm({ onError: (error) => errors.push(error) });
    expect(() =>
      Realm.watch(
        other,
        () => Realm.onUpdate(other, listener),
        () => undefined,
      ),
    ).toThrow("Realm.onUpdate");
    const stage = Stage.make(realm);
    expect(() =>
      Stage.update(stage, () => {
        Realm.onUpdate(realm, listener);
      }),
    ).toThrow("Realm.onUpdate");
    Stage.drop(stage);
  });

  test("is stopped by Realm.dispose, which drops records not yet handed out", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 1);
    const records: Array<UpdateRecord> = [];
    Realm.onUpdate(realm, (record) => {
      records.push(record);
    });
    Realm.dispose(realm);
    expect(() => Realm.onUpdate(realm, () => undefined)).toThrow(
      "pinna: a Realm.onUpdate listener cannot start in the disposed realm",
    );
    expect(records).toEqual([]);
    expect(Realm.status(realm)).toBe("disposed");
    expect(Realm.untracked(realm, (read) => read($a))).toBe(1);
  });

  test("refuses Realm.dispose from a listener", () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const $a = Box.make(realm, 1);
    Realm.onUpdate(realm, () => {
      Realm.dispose(realm);
    });
    Realm.update(realm, (_read, write) => write($a, 2));
    expect(errors).toHaveLength(1);
    expect(isPinnaError(errors[0], "PinnaUsageError")).toBe(true);
    expect((errors[0] as Error).message).toContain("Realm.onUpdate listener");
    expect(Realm.status(realm)).toBe("open");
    Realm.dispose(realm);
  });

  test("is counted by testRealm until stopped", () => {
    const realm = testRealm();
    Realm.onUpdate(realm, () => undefined);
    expect(() => realm[Symbol.dispose]()).toThrow("Realm.onUpdate still running");
  });

  test("hands out nothing from another realm", () => {
    using realm = testRealm();
    using other = testRealm();
    const $other = Box.make(other, 1);
    const { records, stop } = listening(realm);
    Realm.update(other, (_read, write) => write($other, 2));
    expect(records).toEqual([]);
    stop();
  });
});

describe("write.replay and write.revert", () => {
  const scene = (realm: Realm) => {
    const $count = Box.make(realm, 1);
    const $name = Box.make(realm, "a");
    const $rows = rowsOf(realm, [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ]);
    const $inPlace = rowsOf(realm, [{ id: "x", label: "X" }]);
    return { $count, $name, $rows, $inPlace };
  };

  test("revert in reverse order returns every box and collection to its start, order included, and replay comes back", () => {
    using realm = testRealm();
    const { $count, $name, $rows, $inPlace } = scene(realm);
    const { records, stop } = listening(realm);
    Realm.update(realm, (_read, write) => {
      write($count, 2);
      write.remove($rows, "b");
      write.upsert($rows, { id: "d", label: "D" });
      write.upsert($inPlace, { id: "x", label: "X2" });
    });
    Realm.update(realm, (_read, write) => {
      write($name, "b");
      write.replaceAll($rows, [
        { id: "c", label: "C2" },
        { id: "a", label: "A" },
      ]);
    });
    stop();
    const landed = [...records];
    const end = {
      count: Realm.untracked(realm, (read) => read($count)),
      keys: keysOf(realm, $rows),
      rows: heldOf(realm, $rows),
      inPlace: heldOf(realm, $inPlace),
    };
    Realm.update(realm, (_read, write) => {
      for (const record of [...landed].reverse()) write.revert(record);
    });
    Realm.untracked(realm, (read) => {
      expect(read($count)).toBe(1);
      expect(read($name)).toBe("a");
    });
    expect(keysOf(realm, $rows)).toEqual(["a", "b", "c"]);
    expect(heldOf(realm, $rows)).toEqual([
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ]);
    expect(heldOf(realm, $inPlace)).toEqual([{ id: "x", label: "X" }]);
    Realm.update(realm, (_read, write) => {
      for (const record of landed) write.replay(record);
    });
    Realm.untracked(realm, (read) => {
      expect(read($count)).toBe(end.count);
      expect(read($name)).toBe("b");
    });
    expect(keysOf(realm, $rows)).toEqual(end.keys);
    expect(heldOf(realm, $rows)).toEqual(end.rows);
    expect(heldOf(realm, $inPlace)).toEqual(end.inPlace);
    expectRealmAtRest(realm);
  });

  test("records as any write: a revert makes a record of its own, the reverse of the one it applied", () => {
    using realm = testRealm();
    const { $count } = scene(realm);
    const { records, stop } = listening(realm);
    Realm.update(realm, (_read, write) => write($count, 5));
    Realm.update(realm, (_read, write) => write.revert(records[0] as UpdateRecord), {
      name: "undo",
    });
    expect(records[1]).toEqual({
      name: "undo",
      stages: [],
      boxes: [{ box: $count, before: 5, after: 1 }],
      collections: [],
      atoms: [],
    });
    stop();
  });

  test("throws outside an update, and for another realm's record, writing nothing", () => {
    using realm = testRealm();
    using other = testRealm();
    const $mine = Box.make(realm, 1);
    const $theirs = Box.make(other, 1);
    const { records, stop } = listening(realm);
    const { records: otherRecords, stop: stopOther } = listening(other);
    Realm.update(other, (_read, write) => write($theirs, 2));
    Realm.update(realm, (_read, write) => write($mine, 2));
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write($mine, 3);
        try {
          write.revert(otherRecords[0] as UpdateRecord);
        } catch (error) {
          Realm.untracked(realm, (read) => expect(read($mine)).toBe(3));
          throw error;
        }
      }),
    ).toThrow("of another realm");
    Realm.untracked(realm, (read) => expect(read($mine)).toBe(2));
    Realm.untracked(other, (read) => expect(read($theirs)).toBe(2));
    let kept: Write | undefined;
    Realm.update(realm, (_read, write) => {
      kept = write;
    });
    expect(() => kept?.replay(records[0] as UpdateRecord)).toThrow(
      "pinna: write inside Realm.update",
    );
    stop();
    stopOther();
  });

  test("throws pinna/record-not-applicable when the key order moved since", () => {
    using realm = testRealm();
    const { $rows } = scene(realm);
    const { records, stop } = listening(realm);
    Realm.update(realm, (_read, write) => write.remove($rows, "b"));
    Realm.update(realm, (_read, write) => write.remove($rows, "a"));
    let thrown: unknown;
    Realm.update(realm, (_read, write) => {
      try {
        write.revert(records[0] as UpdateRecord);
      } catch (error) {
        thrown = error;
      }
    });
    expect(isPinnaError(thrown, "PinnaUsageError")).toBe(true);
    expect((thrown as { code: string }).code).toBe("pinna/record-not-applicable");
    expect((thrown as Error).message).toBe(
      'pinna: write.revert needs the key order of the collection "rows" to be the record\'s after, and it changed since; apply records in the order they landed, each to the state the previous one left',
    );
    expect(keysOf(realm, $rows)).toEqual(["c"]);
    stop();
  });

  test("stages inside a stage recipe, and lands with Stage.apply", () => {
    using realm = testRealm();
    const { $count, $rows } = scene(realm);
    const { records, stop } = listening(realm);
    Realm.update(realm, (_read, write) => {
      write($count, 7);
      write.remove($rows, "a");
    });
    const stage = Stage.make(realm, { name: "undo" });
    Stage.update(stage, (_read, write) => write.revert(records[0] as UpdateRecord));
    Realm.untracked(realm, (read) => expect(read($count)).toBe(7));
    Stage.read(stage, (read) => {
      expect(read($count)).toBe(1);
      expect(read($rows.keys)).toEqual(["a", "b", "c"]);
    });
    Stage.apply(stage);
    expect(keysOf(realm, $rows)).toEqual(["a", "b", "c"]);
    expect((records[1] as UpdateRecord).stages).toEqual(["undo"]);
    stop();
  });
});

describe("Realm.onUpdate and stages", () => {
  test("names each stage Stage.apply landed, in order, in one outermost update", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $b = Box.make(realm, 1);
    const answer = Stage.make(realm, { name: "answer" });
    const other = Stage.make(realm);
    Stage.update(answer, (_read, write) => write($a, 2));
    Stage.update(other, (_read, write) => write($b, 2));
    const { records, stop } = listening(realm);
    Realm.update(
      realm,
      () => {
        Stage.apply(answer);
        Stage.apply(other);
      },
      { name: "settle" },
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      name: "settle",
      stages: ["answer", undefined],
      boxes: [
        { box: $a, before: 1, after: 2 },
        { box: $b, before: 1, after: 2 },
      ],
    });
    stop();
  });

  test("never reports a visible stage's shown values: showing, updating, and dropping one makes no record", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $rows = rowsOf(realm, [{ id: "a", label: "A" }]);
    const $mark = Atom.make(realm);
    const { records, stop } = listening(realm);
    const guess = Stage.make(realm, { visible: true, name: "guess" });
    Stage.update(guess, (_read, write) => {
      write($a, 99);
      write.upsert($rows, { id: "g", label: "Guess" });
      write.changed($mark);
    });
    Stage.update(guess, (_read, write) => write($a, 98));
    Realm.untracked(realm, (read) => expect(read($a)).toBe(98));
    Stage.drop(guess);
    expect(records).toEqual([]);
    stop();
  });

  test("reports base values while a visible stage shows its own over them", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $rows = rowsOf(realm, [{ id: "a", label: "A" }]);
    const { records, stop } = listening(realm);
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (_read, write) => {
      write($a, 99);
      write.upsert($rows, { id: "a", label: "Guess" });
    });
    Realm.update(realm, (_read, write) => {
      write($a, 2);
      write.upsert($rows, { id: "a", label: "A2" });
      write.upsert($rows, { id: "b", label: "B" }, { at: "end" });
    });
    Realm.untracked(realm, (read) => {
      expect(read($a)).toBe(99);
      expect(read.row($rows, "a")).toEqual({ id: "a", label: "Guess" });
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      boxes: [{ box: $a, before: 1, after: 2 }],
      collections: [
        {
          collection: $rows,
          rows: [
            { key: "a", before: { id: "a", label: "A" }, after: { id: "a", label: "A2" } },
            { key: "b", before: undefined, after: { id: "b", label: "B" } },
          ],
          keys: { before: ["a"], after: ["a", "b"] },
        },
      ],
    });
    Stage.drop(guess);
    expect(records).toHaveLength(1);
    stop();
  });

  test("reports a visible stage's landing as base values, and its shown atom as landed", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $mark = Atom.make(realm);
    const { records, stop } = listening(realm);
    const guess = Stage.make(realm, { visible: true, name: "guess" });
    Stage.update(guess, (_read, write) => {
      write($a, 5);
      write.changed($mark);
    });
    Stage.apply(guess);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      name: undefined,
      stages: ["guess"],
      boxes: [{ box: $a, before: 1, after: 5 }],
      collections: [],
      atoms: [$mark],
    });
    stop();
  });
});

describe("Realm.onUpdate and other writes", () => {
  test("records write.restore as the writes it makes", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 1);
    const $rows = rowsOf(realm, [{ id: "a", label: "A" }]);
    const shape = { $count, $rows };
    const { records, stop } = listening(realm);
    Realm.update(realm, (_read, write) =>
      write.restore(shape, { $count: 2, $rows: [{ id: "b", label: "B" }] }),
    );
    expect(records[0]).toMatchObject({
      boxes: [{ box: $count, before: 1, after: 2 }],
      collections: [
        {
          collection: $rows,
          keys: { before: ["a"], after: ["b"] },
        },
      ],
    });
    stop();
  });

  test("records a Computed.fromPromise value as its atom alone, never the value", async () => {
    using realm = testRealm();
    let resolve: (value: number) => void = () => undefined;
    const $value = Computed.fromPromise(
      realm,
      () =>
        new Promise<number>((settle) => {
          resolve = settle;
        }),
      0,
    );
    const { records, stop } = listening(realm);
    const release = Source.observe($value);
    resolve(42);
    await Promise.resolve();
    await Promise.resolve();
    const landed = records.filter((record) => record.atoms.length > 0);
    expect(landed.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.boxes).toEqual([]);
      expect(record.collections).toEqual([]);
      expect(record.atoms).toHaveLength(1);
    }
    release();
    stop();
  });
});

describe("revert and replay with row listeners", () => {
  const setUp = () => {
    const realm = Realm.make();
    const $rows = Collection.make(realm, { keyOf: (row: number) => row });
    const $count = Box.make(realm, 0);
    const $index = Collection.make(realm, { keyOf: (row: { readonly key: number }) => row.key });
    Collection.onRowChange($rows, (change, read, write) => {
      write(
        $count,
        read($count) + Number(change.after !== undefined) - Number(change.before !== undefined),
      );
      if (change.after === undefined) {
        write.remove($index, change.key);
      } else {
        write.upsert($index, { key: change.key });
      }
    });
    const ordered = View.ordered($rows, { compare: () => (a, b) => a - b });
    const records: Array<UpdateRecord> = [];
    Realm.onUpdate(realm, (record) => {
      records.push(record);
    });
    const state = () =>
      Realm.untracked(realm, (read) => ({
        keys: read($rows.keys),
        count: read($count),
        index: read($index.keys),
        ordered: read(ordered.keys),
      }));
    return { realm, $rows, records, state };
  };

  test("a count and a collection a listener keeps land at the record's values, and a view follows", () => {
    const { realm, $rows, records, state } = setUp();
    Realm.update(realm, (_read, write) => {
      write.upsert($rows, 2);
    });
    Realm.update(realm, (_read, write) => {
      write.upsert($rows, 1);
    });
    const [first, second] = records as [UpdateRecord, UpdateRecord];
    expect(state()).toEqual({ keys: [1, 2], count: 2, index: [1, 2], ordered: [1, 2] });
    Realm.update(realm, (_read, write) => {
      write.revert(second);
    });
    expect(state()).toEqual({ keys: [2], count: 1, index: [2], ordered: [2] });
    Realm.update(realm, (_read, write) => {
      write.revert(first);
    });
    expect(state()).toEqual({ keys: [], count: 0, index: [], ordered: [] });
    Realm.update(realm, (_read, write) => {
      write.replay(first);
      write.replay(second);
    });
    expect(state()).toEqual({ keys: [1, 2], count: 2, index: [1, 2], ordered: [1, 2] });
    Realm.dispose(realm);
  });

  test("a stage recipe reverts and replays the same way", () => {
    const { realm, $rows, records, state } = setUp();
    Realm.update(realm, (_read, write) => {
      write.upsert($rows, 1);
    });
    const [record] = records as [UpdateRecord];
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write.revert(record);
    });
    Stage.apply(stage);
    expect(state()).toEqual({ keys: [], count: 0, index: [], ordered: [] });
    Realm.dispose(realm);
  });
});
