/**
 * What a write notifies in the Legend State store, observed with Legend's own
 * `observe` over what the row components read: a row's rest and its three
 * tick fields, which its cells read, and the list of ids, which the list
 * reads and which mounts a new row or unmounts a gone one. A row is notified
 * when either runs again for it.
 */
import { describe, expect, test } from "bun:test";
import { observe } from "@legendapp/state";
import { toPlainRows, toPlainTicks } from "../src/data/plain.ts";
import { makeRefetch, makeRows, makeTicks } from "../src/data/wire.ts";
import { makeLegendStore } from "../src/legend/store.ts";

const rows = makeRows(500, 1);
const plainRows = (wire: ReadonlyArray<unknown>) => toPlainRows(JSON.parse(JSON.stringify(wire)));

/** Runs `read` now and `changed` each time it runs again; returns the dispose. */
const watch = (read: () => void, changed: () => void) => {
  let first = true;
  return observe(() => {
    read();
    if (first) {
      first = false;
      return;
    }
    changed();
  });
};

/** The ids of the rows a write notifies. */
const touchedBy = (write: (store: ReturnType<typeof makeLegendStore>["store"]) => void) => {
  const { ids$, rows$, store } = makeLegendStore();
  store.load(plainRows(rows));
  const initial = ids$.peek().slice();
  const touched = new Set<string>();
  const stops = initial.map((id) => {
    const row$ = rows$[id];
    return watch(
      () => {
        row$?.rest.get();
        row$?.price.get();
        row$?.diff24.get();
        row$?.updatedAt.get();
      },
      () => {
        touched.add(id);
      },
    );
  });
  stops.push(
    watch(
      () => ids$.get(),
      () => {
        const present = new Set(ids$.peek());
        for (const id of initial) {
          if (!present.has(id)) {
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

describe("what a write notifies in Legend State", () => {
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

  // The row component reads only `rest` besides the cells, so a row whose
  // other fields change must notify through `rest` alone.
  test("a merge that changes only a row's status notifies that row through its rest", () => {
    const changed = new Set(rows.slice(0, 3).map((row) => row.id));
    const next = rows.map((row) =>
      changed.has(row.id)
        ? { ...row, status: row.status === "halted" ? ("active" as const) : ("halted" as const) }
        : row,
    );
    const { rows$, store } = makeLegendStore();
    store.load(plainRows(rows));
    const touched = new Set<string>();
    const stops = rows.map((row) =>
      watch(
        () => rows$[row.id]?.rest.get(),
        () => {
          touched.add(row.id);
        },
      ),
    );
    store.merge(plainRows(next));
    for (const stop of stops) {
      stop();
    }
    expect(touched).toEqual(changed);
  });

  // A refetch changes a field outside the tick fields in 5% of 500 rows (25),
  // which are new rows, and removes 1% (5); the rest are unchanged, so 30
  // rows are notified, as in every other store.
  test("a merge of a refetch notifies the changed, new, and removed rows", () => {
    expect(touchedBy((store) => store.merge(plainRows(makeRefetch(rows, 2)))).size).toBe(30);
  });
});
