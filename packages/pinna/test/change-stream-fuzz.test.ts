import { describe, expect, test } from "bun:test";
import {
  Atom,
  Box,
  Collection,
  Realm,
  Stage,
  type UpdateRecord,
  type Write,
} from "../src/index.ts";
import { testRealm } from "../src/testing/index.ts";
import { expectRealmAtRest } from "./rest.ts";

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
  expect(state()).toEqual(start);
  Realm.update(realm, (_read, write) => {
    for (const record of landed) write.replay(record);
  });
  expect(state()).toEqual(end);
  stopWatch();
  expectRealmAtRest(realm);
  return landed.length;
};

describe("the change stream under random updates", () => {
  test("records chain, revert to the start, and replay to the end", () => {
    let records = 0;
    for (let seed = 1; seed <= 200; seed++) {
      records += runSeed(seed);
    }
    expect(records).toBeGreaterThan(2000);
  });
});
