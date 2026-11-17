/**
 * What the alien-signals store notifies, observed with alien-signals' own
 * `effect` over what a row component reads (`readRow`): an effect reruns when
 * a signal it read changed, which is when the component's computed value
 * changes and the row rerenders.
 */
import { describe, expect, test } from "bun:test";
import { effect } from "alien-signals";
import { makeAlienStore } from "../src/alien/store.ts";
import { toPlainRows, toPlainTicks } from "../src/data/plain.ts";
import { makeRefetch, makeRows, makeTicks } from "../src/data/wire.ts";

const rows = makeRows(500, 1);
const plain = (wire: ReadonlyArray<unknown>) => toPlainRows(JSON.parse(JSON.stringify(wire)));

/** The ids whose row read reran while `write` ran. */
const touchedBy = (write: (store: ReturnType<typeof makeAlienStore>["store"]) => void) => {
  const { readRow, store } = makeAlienStore();
  store.load(plain(rows));
  const touched = new Set<string>();
  const stops = Array.from({ length: store.size() }, (_, index) => {
    const id = store.idAt(index);
    let first = true;
    return effect(() => {
      readRow(id);
      if (first) {
        first = false;
      } else {
        touched.add(id);
      }
    });
  });
  write(store);
  for (const stop of stops) {
    stop();
  }
  return touched;
};

describe("alien-signals store notifications", () => {
  test("a merge of the same rows notifies no row", () => {
    expect(touchedBy((store) => store.merge(plain(rows))).size).toBe(0);
  });

  test("a tick notifies exactly the rows it moves", () => {
    const ticks = toPlainTicks(JSON.parse(JSON.stringify(makeTicks(rows, 1, 100, 6)[0] ?? [])));
    const moved = new Set(ticks.map((tick) => tick.id));
    expect(touchedBy((store) => store.tick(ticks))).toEqual(moved);
  });

  // A refetch changes a value outside the tick fields in 5% of 500 rows (25),
  // so those rows get a new slot value, and removes 1% (5): 30 rows.
  test("a merge notifies the changed and removed rows", () => {
    expect(touchedBy((store) => store.merge(plain(makeRefetch(rows, 2)))).size).toBe(30);
  });
});
