/**
 * What a write notifies in the MobX store, observed with MobX's own
 * `reaction` over what the row components read: a row's tick fields, which
 * its cells read, and its place in the list, which the list reads and which
 * mounts a new row or unmounts a gone one. A row is notified when either
 * fires for it.
 */
import { describe, expect, test } from "bun:test";
import { reaction } from "mobx";
import { toPlainRows, toPlainTicks } from "../src/data/plain.ts";
import { makeRefetch, makeRows, makeTicks } from "../src/data/wire.ts";
import { makeMobxStore } from "../src/mobx/store.ts";

const rows = makeRows(500, 1);
const plainRows = (wire: ReadonlyArray<unknown>) => toPlainRows(JSON.parse(JSON.stringify(wire)));

/** The ids of the rows a write notifies. */
const touchedBy = (write: (store: ReturnType<typeof makeMobxStore>["store"]) => void) => {
  const { market, store } = makeMobxStore();
  store.load(plainRows(rows));
  const initial = new Map(market.byId);
  const touched = new Set<string>();
  const stops = [...initial].map(([id, item]) =>
    reaction(
      () => [item.price, item.diff24, item.updatedAt],
      () => {
        touched.add(id);
      },
    ),
  );
  stops.push(
    reaction(
      () => market.items.slice(),
      (list) => {
        const present = new Map(list.map((item) => [item.id, item]));
        for (const [id, item] of initial) {
          if (present.get(id) !== item) {
            touched.add(id);
          }
        }
      },
    ),
  );
  write(store);
  for (const stop of stops) {
    stop();
  }
  return touched;
};

describe("what a write notifies in MobX", () => {
  test("a merge of the same rows notifies no row", () => {
    expect(touchedBy((store) => store.merge(plainRows(rows))).size).toBe(0);
  });

  test("a tick notifies exactly the rows it moves", () => {
    const ticks = toPlainTicks(JSON.parse(JSON.stringify(makeTicks(rows, 1, 100, 6)[0] ?? [])));
    const moved = new Set(ticks.map((tick) => tick.id));
    const touched = touchedBy((store) => store.tick(ticks));
    expect(touched.size).toBe(moved.size);
    expect(touched).toEqual(moved);
  });

  // A refetch changes a field outside the tick fields in 5% of 500 rows (25),
  // which are new instances, and removes 1% (5); the rest are unchanged, so
  // 30 rows are notified, as in every other store.
  test("a merge of a refetch notifies the changed, new, and removed rows", () => {
    expect(touchedBy((store) => store.merge(plainRows(makeRefetch(rows, 2)))).size).toBe(30);
  });
});
