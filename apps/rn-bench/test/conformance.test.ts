/**
 * The contract every store keeps, checked off the device: after each write,
 * every store holds the same ids in the same order, and every row and its
 * details show the same texts as a reference over plain arrays. The stores
 * may differ in how they hold and render rows; what is on screen may not.
 * What each store notifies is checked in its own test file.
 */

import { describe, expect, test } from "bun:test";
import { makeAlienStore } from "../src/alien/store.ts";
import { detailsTexts, rowTexts } from "../src/data/format.ts";
import { type PlainRow, type PlainTick, toPlainRows, toPlainTicks } from "../src/data/plain.ts";
import {
  makeDeepRefetch,
  makeRefetch,
  makeRows,
  makeTicks,
  pickRemovals,
  type WireRow,
} from "../src/data/wire.ts";
import type { Store } from "../src/harness/store.ts";
import { makeLegendStore } from "../src/legend/store.ts";
import { makeMobxStore } from "../src/mobx/store.ts";
import { makePinnaStore } from "../src/pinna/store.ts";

const plainRows = (rows: ReadonlyArray<WireRow>): ReadonlyArray<PlainRow> =>
  toPlainRows(JSON.parse(JSON.stringify(rows)));

const rows = makeRows(500, 1);
const refetch = () => plainRows(makeRefetch(rows, 2));
const deepRefetch = () => plainRows(makeDeepRefetch(rows, 5));
// Past the ids a refetch adds, which start at 500.
const added = () => plainRows(makeRows(50, 3, 1000));
const removals = () => pickRemovals(rows, 50, 4);
const ticks = (): ReadonlyArray<PlainTick> =>
  toPlainTicks(JSON.parse(JSON.stringify(makeTicks(rows, 1, 100, 6)[0] ?? [])));

/** The rows on screen, as plain values: what every store must show. */
interface Reference {
  rows: ReadonlyArray<PlainRow>;
}

const writes: ReadonlyArray<
  readonly [string, (store: Store) => void, (reference: Reference) => void]
> = [
  ["load", () => {}, () => {}],
  [
    "replace",
    (store) => store.replace(refetch()),
    (reference) => {
      reference.rows = refetch();
    },
  ],
  [
    "merge",
    (store) => store.merge(refetch()),
    (reference) => {
      reference.rows = refetch();
    },
  ],
  [
    "deep merge",
    (store) => store.merge(deepRefetch()),
    (reference) => {
      reference.rows = deepRefetch();
    },
  ],
  ["merge of the same rows", (store) => store.merge(plainRows(rows)), () => {}],
  [
    "insert",
    (store) => store.insert(added()),
    (reference) => {
      reference.rows = [...added(), ...reference.rows];
    },
  ],
  [
    "remove",
    (store) => store.remove(removals()),
    (reference) => {
      const gone = new Set(removals());
      reference.rows = reference.rows.filter((row) => !gone.has(row.id));
    },
  ],
  [
    "tick",
    (store) => store.tick(ticks()),
    (reference) => {
      const byId = new Map(ticks().map((tick) => [tick.id, tick]));
      reference.rows = reference.rows.map((row) => {
        const tick = byId.get(row.id);
        return tick === undefined ? row : { ...row, ...tick };
      });
    },
  ],
];

const stores: ReadonlyArray<readonly [string, () => Store]> = [
  ["pinna", () => makePinnaStore().store],
  ["mobx", () => makeMobxStore().store],
  ["alien", () => makeAlienStore().store],
  ["legend", () => makeLegendStore().store],
];

const ids = (store: Store): Array<string> =>
  Array.from({ length: store.size() }, (_, index) => store.idAt(index));

describe("every store shows what the reference shows", () => {
  for (const [scenario, write, apply] of writes) {
    for (const [variant, make] of stores) {
      test(`${variant}: ${scenario}`, () => {
        const store = make();
        const reference: Reference = { rows: plainRows(rows) };
        store.load(plainRows(rows));
        write(store);
        apply(reference);
        expect(ids(store)).toEqual(reference.rows.map((row) => row.id));
        for (const row of reference.rows) {
          expect(store.shownRow(row.id)).toEqual(rowTexts(row));
          expect(store.shownDetails(row.id)).toEqual(detailsTexts(row));
        }
      });
    }
  }

  for (const [variant, make] of stores) {
    test(`${variant}: a removed row shows nothing`, () => {
      const store = make();
      store.load(plainRows(rows));
      const gone = removals()[0] as string;
      store.remove(removals());
      expect(store.shownRow(gone)).toBeUndefined();
      expect(store.shownDetails(gone)).toBeUndefined();
    });
  }
});

describe("the per-row writes agree with the list writes", () => {
  for (const [variant, make] of stores) {
    if (make().insertEach === undefined && make().removeEach === undefined) {
      continue;
    }
    test(variant, () => {
      const list = make();
      const each = make();
      for (const store of [list, each]) {
        store.load(plainRows(rows));
      }
      if (each.insertEach !== undefined) {
        list.insert(added());
        each.insertEach(added());
        expect(ids(each)).toEqual(ids(list));
      }
      if (each.removeEach !== undefined) {
        list.remove(removals());
        each.removeEach(removals());
        expect(ids(each)).toEqual(ids(list));
      }
    });
  }
});

test("every tick moves the rows on screen", () => {
  const all = makeTicks(rows, 3, 100, 6);
  expect(all).toHaveLength(3);
  for (const tick of all) {
    expect(tick.slice(0, 10).map((update) => update.id)).toEqual(
      rows.slice(0, 10).map((row) => row.id),
    );
  }
});
