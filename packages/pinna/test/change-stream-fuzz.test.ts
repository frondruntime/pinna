import { describe, expect, test } from "bun:test";
import {
  Atom,
  Box,
  Collection,
  isPinnaError,
  type OrderedView,
  Realm,
  Stage,
  type UpdateRecord,
  View,
  type Write,
} from "../src/index.ts";
import { testRealm } from "../src/testing/index.ts";
import { expectNothingHeld, expectRealmAtRest } from "./rest.ts";

/**
 * Random updates over boxes, a collection, an atom, a watch that writes,
 * caught nested failures, failed updates, and visible stages: the records
 * chain (each one's `before` is the previous state), reverting them all in
 * reverse brings the start back, key order included, and replaying them
 * all brings the end back (ruling 69).
 */

interface Row {
  readonly id: number;
  readonly value: number;
}

/** A small seeded generator: the same seed, the same run. */
const random = (seed: number) => {
  let state = seed >>> 0 || 1;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  return {
    below: (count: number): number => Math.floor(next() * count),
    chance: (probability: number): boolean => next() < probability,
  };
};

const runSeed = (seed: number) => {
  const pick = random(seed);
  using realm = testRealm({ onError: () => undefined });
  const boxes = [Box.make(realm, 0), Box.make(realm, 0), Box.make(realm, 0)];
  const $sum = Box.make(realm, 0);
  const $rows = Collection.make(realm, { keyOf: (row: Row) => row.id, name: "rows" });
  const $mark = Atom.make(realm);
  const stopWatch = Realm.watch(
    realm,
    (read) => (read(boxes[0] as Box<number>) + read(boxes[1] as Box<number>)) % 7,
    (sum) => {
      Realm.update(realm, (_read, write) => write($sum, sum));
    },
  );
  const state = () =>
    Realm.untracked(realm, (read) => ({
      boxes: boxes.map((box) => read(box)),
      sum: read($sum),
      keys: read($rows.keys),
      rows: read($rows.rows),
    }));
  const records: Array<UpdateRecord> = [];
  const stopListener = Realm.onUpdate(realm, (record) => {
    records.push(record);
  });
  const operation = (write: Write): void => {
    const roll = pick.below(7);
    const id = pick.below(6);
    if (roll <= 1) write(boxes[pick.below(3)] as Box<number>, pick.below(4));
    else if (roll === 2)
      write.upsert(
        $rows,
        { id, value: pick.below(3) },
        pick.chance(0.5) ? { at: "end" } : undefined,
      );
    else if (roll === 3) write.remove($rows, id);
    else if (roll === 4) {
      const count = pick.below(4);
      const rows: Array<Row> = [];
      for (let index = 0; index < count; index++) {
        const key = pick.below(6);
        if (!rows.some((row) => row.id === key)) rows.push({ id: key, value: pick.below(3) });
      }
      write.replaceAll($rows, rows);
    } else if (roll === 5) write.changed($mark);
    else write(boxes[pick.below(3)] as Box<number>, pick.below(4));
  };
  const start = state();
  let guess: Stage | undefined;
  for (let step = 0; step < 40; step++) {
    expectNothingHeld(realm, [$rows]);
    const kind = pick.below(10);
    if (kind === 0 && guess === undefined) {
      guess = Stage.make(realm, { visible: true });
      Stage.update(guess, (_read, write) => {
        operation(write);
        operation(write);
      });
      continue;
    }
    if (kind === 1 && guess !== undefined) {
      if (pick.chance(0.5)) Stage.apply(guess);
      else Stage.drop(guess);
      guess = undefined;
      continue;
    }
    const fails = kind === 2;
    try {
      Realm.update(realm, (_read, write) => {
        const count = 1 + pick.below(4);
        for (let index = 0; index < count; index++) operation(write);
        if (pick.chance(0.3)) {
          try {
            Realm.update(realm, (_inner, inner) => {
              operation(inner);
              throw new Error("nested");
            });
          } catch {
            // Caught: the outer update keeps its own writes.
          }
        }
        if (fails) throw new Error("outer");
      });
    } catch (error) {
      if (!fails) throw error;
    }
  }
  expectNothingHeld(realm, [$rows]);
  if (guess !== undefined) Stage.drop(guess);
  const end = state();
  // Each record starts where the one before it ended.
  const current = new Map<unknown, unknown>([
    ...boxes.map((box, index) => [box, start.boxes[index]] as const),
    [$sum, start.sum],
  ]);
  for (const record of records) {
    for (const change of record.boxes) {
      expect(change.before).toEqual(current.get(change.box));
      current.set(change.box, change.after);
    }
  }
  stopListener();
  const landed = [...records];
  Realm.update(realm, (_read, write) => {
    for (const record of [...landed].reverse()) write.revert(record);
  });
  expectNothingHeld(realm, [$rows]);
  expect(state()).toEqual(start);
  Realm.update(realm, (_read, write) => {
    for (const record of landed) write.replay(record);
  });
  expectNothingHeld(realm, [$rows]);
  expect(state()).toEqual(end);
  stopWatch();
  expectRealmAtRest(realm);
  return landed.length;
};

/**
 * The plain-data model of the undo fuzz: three boxes, a sum box a row
 * listener keeps and recipes also write, and the rows of collection `a` in
 * key order. Collection `b` (a listener on `a` writes each row's value
 * times ten), an ordered view of `a`, and a count a later listener keeps
 * follow from the rows.
 */
interface Model {
  readonly boxes: Array<number>;
  sum: number;
  readonly rows: Map<number, Row>;
  keys: Array<number>;
}

const copyModel = (model: Model): Model => ({
  boxes: [...model.boxes],
  sum: model.sum,
  rows: new Map(model.rows),
  keys: [...model.keys],
});

/** One update of the history: the model before and after it, and its record. */
interface Step {
  readonly before: Model;
  readonly after: Model;
  readonly record: UpdateRecord;
  /** The update added a listener to `a`: its restore throws. */
  readonly refused: boolean;
}

const sameKeys = (left: ReadonlyArray<number>, right: ReadonlyArray<number>): boolean =>
  left.length === right.length && left.every((key, index) => Object.is(key, right[index]));

/** True when `model` holds what `step` left on the side a restore starts from. */
const holds = (model: Model, step: Step, forward: boolean): boolean => {
  const from = forward ? step.before : step.after;
  const other = forward ? step.after : step.before;
  for (let index = 0; index < 3; index++) {
    if (from.boxes[index] !== other.boxes[index] && model.boxes[index] !== from.boxes[index]) {
      return false;
    }
  }
  if (from.sum !== other.sum && model.sum !== from.sum) return false;
  const ids = new Set([...from.rows.keys(), ...other.rows.keys()]);
  for (const id of ids) {
    if (from.rows.get(id) !== other.rows.get(id) && model.rows.get(id) !== from.rows.get(id)) {
      return false;
    }
  }
  if (!sameKeys(from.keys, other.keys) && !sameKeys(model.keys, from.keys)) return false;
  return true;
};

/** `step` applied to `model`, forward or backward, field by field. */
const restoreModel = (model: Model, step: Step, forward: boolean): Model => {
  const from = forward ? step.before : step.after;
  const to = forward ? step.after : step.before;
  const next = copyModel(model);
  for (let index = 0; index < 3; index++) {
    if (from.boxes[index] !== to.boxes[index]) next.boxes[index] = to.boxes[index] as number;
  }
  if (from.sum !== to.sum) next.sum = to.sum;
  for (const id of new Set([...from.rows.keys(), ...to.rows.keys()])) {
    const row = to.rows.get(id);
    if (from.rows.get(id) === row) continue;
    if (row === undefined) next.rows.delete(id);
    else next.rows.set(id, row);
  }
  if (!sameKeys(from.keys, to.keys)) next.keys = [...to.keys];
  return next;
};

const runUndoSeed = (
  seed: number,
): { readonly restores: number; readonly refusals: number; readonly limits: number } => {
  const pick = random(seed);
  using realm = testRealm();
  const boxes = [Box.make(realm, 0), Box.make(realm, 0), Box.make(realm, 0)];
  const $sum = Box.make(realm, 0);
  // An object, so a restore it hears gives it a new identity (a limit).
  const $count = Box.make(realm, { rows: 0 });
  const $a = Collection.make(realm, { keyOf: (row: Row) => row.id, name: "a" });
  const $b = Collection.make(realm, { keyOf: (row: Row) => row.id, name: "b" });
  const stops: Array<() => void> = [];
  stops.push(
    Collection.onRowChange($a, (change, read, write) => {
      write($sum, read($sum) + (change.after?.value ?? 0) - (change.before?.value ?? 0));
    }),
  );
  stops.push(
    Collection.onRowChange($a, (change, _read, write) => {
      if (change.after === undefined) write.remove($b, change.key);
      else write.upsert($b, { id: change.key, value: change.after.value * 10 });
    }),
  );
  const view = View.ordered($a, {
    compare: () => (left: Row, right: Row) => left.value - right.value,
  });
  let counting = false;
  const listenCount = (): void => {
    counting = true;
    stops.push(
      Collection.onRowChange($a, (change, read, write) => {
        const delta = (change.after === undefined ? 0 : 1) - (change.before === undefined ? 0 : 1);
        write($count, { rows: read($count).rows + delta });
      }),
    );
  };
  const records: Array<UpdateRecord> = [];
  const stopListener = Realm.onUpdate(realm, (record) => {
    records.push(record);
  });
  let model: Model = { boxes: [0, 0, 0], sum: 0, rows: new Map(), keys: [] };
  const expected = (from: Model) => {
    const rows = from.keys.map((id) => from.rows.get(id) as Row);
    return {
      boxes: from.boxes,
      sum: from.sum,
      keys: from.keys,
      rows,
      b: rows.map((row) => ({ id: row.id, value: row.value * 10 })).sort((l, r) => l.id - r.id),
      view: [...rows].sort((l, r) => l.value - r.value || l.id - r.id).map((row) => row.id),
      late:
        late === undefined
          ? []
          : [...rows].sort((l, r) => r.value - l.value || l.id - r.id).map((row) => row.id),
      count: counting ? rows.length : 0,
    };
  };
  const actual = () =>
    Realm.untracked(realm, (read) => ({
      boxes: boxes.map((box) => read(box)),
      sum: read($sum),
      keys: [...read($a.keys)],
      rows: [...read($a.rows)],
      b: [...read($b.rows)].sort((l, r) => l.id - r.id),
      view: [...read(view.keys)],
      late: late === undefined ? [] : [...read(late.keys)],
      count: read($count).rows,
    }));
  /** One random write, to the realm and to the model alike. */
  const operation = (write: Write, next: Model): void => {
    const roll = pick.below(6);
    const id = pick.below(6);
    const total = () => [...next.rows.values()].reduce((sum, row) => sum + row.value, 0);
    if (roll === 0) {
      const index = pick.below(3);
      const value = pick.below(4);
      write(boxes[index] as Box<number>, value);
      next.boxes[index] = value;
    } else if (roll === 1) {
      const value = pick.below(9);
      write($sum, value);
      next.sum = value;
    } else if (roll === 2) {
      const row = { id, value: pick.below(4) };
      const atEnd = pick.chance(0.5);
      write.upsert($a, row, atEnd ? { at: "end" } : undefined);
      const before = next.rows.get(id);
      next.sum += row.value - (before?.value ?? 0);
      if (before === undefined) next.keys = atEnd ? [...next.keys, id] : [id, ...next.keys];
      next.rows.set(id, row);
    } else if (roll === 3) {
      write.remove($a, id);
      const before = next.rows.get(id);
      if (before !== undefined) {
        next.sum -= before.value;
        next.rows.delete(id);
        next.keys = next.keys.filter((key) => key !== id);
      }
    } else {
      const rows: Array<Row> = [];
      for (let index = pick.below(4); index > 0; index--) {
        const key = pick.below(6);
        if (rows.some((row) => row.id === key)) continue;
        // Half the time the row held, so a replaceAll also keeps rows.
        const held = next.rows.get(key);
        rows.push(
          held !== undefined && pick.chance(0.5) ? held : { id: key, value: pick.below(4) },
        );
      }
      write.replaceAll($a, rows);
      const old = total();
      next.rows.clear();
      for (const row of rows) next.rows.set(row.id, row);
      next.keys = rows.map((row) => row.id);
      next.sum += total() - old;
    }
  };
  let late: OrderedView<number> | undefined;
  const history: Array<Step> = [];
  /** Drops the steps after the cursor for a new one. */
  const fork = (): void => {
    history.splice(cursor);
  };
  /** Adds a listener at rest; its update's record, when it makes one, is a step that changes no model field. */
  const atRest = (add: () => void): void => {
    const count = records.length;
    add();
    if (records.length > count) {
      fork();
      const record = records[records.length - 1] as UpdateRecord;
      history.push({ before: model, after: model, record, refused: false });
      cursor = history.length;
    }
  };
  let cursor = 0;
  let restores = 0;
  let refusals = 0;
  let limits = 0;
  const restore = (step: Step, forward: boolean): unknown => {
    try {
      Realm.update(realm, (_read, write) => {
        if (forward) write.replay(step.record);
        else write.revert(step.record);
      });
      return undefined;
    } catch (error) {
      expect(isPinnaError(error, "PinnaUsageError")).toBe(true);
      expect((error as { code: string }).code).toBe("pinna/record-not-applicable");
      return error;
    }
  };
  for (let action = 0; action < 60; action++) {
    const kind = pick.below(10);
    if (kind <= 1 && cursor > 0) {
      // Undo, in order: the state is the step's after.
      const step = history[cursor - 1] as Step;
      const thrown = restore(step, false);
      if (step.refused) {
        expect(thrown).toBeDefined();
        refusals++;
        // Nothing before a refused step can be undone in order.
        history.splice(0, cursor);
        cursor = 0;
      } else {
        expect(thrown).toBeUndefined();
        model = copyModel(step.before);
        cursor--;
        restores++;
      }
    } else if (kind === 2 && cursor < history.length) {
      // Redo, in order: the state is the step's before.
      const step = history[cursor] as Step;
      const before = actual();
      if (restore(step, true) === undefined) {
        model = copyModel(step.after);
        cursor++;
        restores++;
      } else {
        // The limit: the count listener, added after older records, built a
        // new object hearing their restore, and no record of its
        // registration put back the one this step holds.
        expect(counting).toBe(true);
        expect(actual()).toEqual(before);
        history.length = 0;
        cursor = 0;
        limits++;
      }
    } else if (kind === 3 && history.length > 1) {
      // Out of order: a revert or a replay of any step.
      const index = pick.below(history.length);
      const step = history[index] as Step;
      const forward = index >= cursor;
      const before = actual();
      const thrown = restore(step, forward);
      if (thrown !== undefined) {
        // A refusal writes nothing.
        expect(actual()).toEqual(before);
        refusals++;
      } else {
        expect(step.refused).toBe(false);
        expect(holds(model, step, forward)).toBe(true);
        model = restoreModel(model, step, forward);
        // The history no longer chains from here.
        history.length = 0;
        cursor = 0;
        restores++;
      }
    } else if (kind === 6 && late === undefined) {
      // A view made lazily, at rest, partway through the history.
      atRest(() => {
        late = View.ordered($a, {
          compare: () => (left: Row, right: Row) => right.value - left.value,
        });
      });
    } else if (kind === 4 && !counting) {
      if (pick.chance(0.5)) {
        // Added at rest, in an update of its own: its record restores the
        // listener's first state, and older restores report to it.
        atRest(listenCount);
      } else {
        // Added in an update with other writes: its record is refused,
        // whether or not the rows changed.
        const next = copyModel(model);
        const count = records.length;
        Realm.update(realm, (_read, write) => {
          operation(write, next);
          listenCount();
          operation(write, next);
        });
        const record = records.length > count ? records[records.length - 1] : undefined;
        if (record !== undefined) {
          fork();
          history.push({ before: model, after: next, record, refused: true });
          cursor = history.length;
        }
        model = next;
      }
    } else {
      const next = copyModel(model);
      const fails = kind === 5;
      const count = records.length;
      try {
        Realm.update(realm, (_read, write) => {
          for (let index = 1 + pick.below(3); index > 0; index--) operation(write, next);
          if (fails) throw new Error("fails");
        });
      } catch (error) {
        if (!fails) throw error;
      }
      if (!fails) {
        const record = records.length > count ? records[records.length - 1] : undefined;
        if (record !== undefined) {
          fork();
          history.push({ before: model, after: next, record, refused: false });
          cursor = history.length;
        }
        model = next;
      }
    }
    expect(actual()).toEqual(expected(model));
  }
  stopListener();
  for (const stop of stops) stop();
  View.dispose(view);
  if (late !== undefined) View.dispose(late);
  expectRealmAtRest(realm);
  return { restores, refusals, limits };
};

describe("the change stream under random updates", () => {
  test("records chain, revert to the start, and replay to the end", () => {
    let records = 0;
    for (let seed = 1; seed <= 200; seed++) {
      records += runSeed(seed);
    }
    expect(records).toBeGreaterThan(2000);
  });

  test("undo, redo, and out-of-order restores match a plain-data model", () => {
    let restores = 0;
    let refusals = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const counts = runUndoSeed(seed);
      restores += counts.restores;
      refusals += counts.refusals;
    }
    expect(restores).toBeGreaterThan(1000);
    expect(refusals).toBeGreaterThan(100);
  });
});
