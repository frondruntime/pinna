/**
 * What the Pinna store notifies, observed with Pinna's own `watch` over what
 * a row's components read: the row of its key, then that row's three tick
 * boxes (src/pinna/variant.tsx, `RowById` and `InstrumentRow`).
 */
import { expect, test } from "bun:test";
import { watch } from "@frondruntime/pinna";
import { rowTexts } from "../src/data/format.ts";
import { type PlainRow, type PlainTick, toPlainRows, toPlainTicks } from "../src/data/plain.ts";
import {
  makeDeepRefetch,
  makeRefetch,
  makeRows,
  makeTicks,
  type WireRow,
} from "../src/data/wire.ts";
import { instrumentValues, makePinnaStore } from "../src/pinna/store.ts";

const plainRows = (rows: ReadonlyArray<WireRow>): ReadonlyArray<PlainRow> =>
  toPlainRows(JSON.parse(JSON.stringify(rows)));

const rows = makeRows(500, 1);
const ticks = (): ReadonlyArray<PlainTick> =>
  toPlainTicks(JSON.parse(JSON.stringify(makeTicks(rows, 1, 100, 6)[0] ?? [])));

/** The ids among the loaded rows whose shown texts `write` notified. */
const touchedBy = (write: (store: ReturnType<typeof makePinnaStore>["store"]) => void) => {
  const { market, store } = makePinnaStore();
  store.load(plainRows(rows));
  const touched = new Set<string>();
  const stops = rows.map((row) =>
    watch(
      market.realm,
      (read) => {
        const instrument = read(market.$rows.row(row.id));
        return instrument === undefined
          ? undefined
          : rowTexts(
              instrumentValues(instrument, [
                read(instrument.$price),
                read(instrument.$diff24),
                read(instrument.$updatedAt),
              ]),
            );
      },
      () => {
        touched.add(row.id);
      },
    ),
  );
  write(store);
  for (const stop of stops) {
    stop();
  }
  return touched;
};

test("a merge of the same rows notifies no row", () => {
  expect(touchedBy((store) => store.merge(plainRows(rows))).size).toBe(0);
});

test("a tick notifies exactly the rows it moves", () => {
  const moved = new Set(ticks().map((tick) => tick.id));
  expect(touchedBy((store) => store.tick(ticks()))).toEqual(moved);
});

// A refetch changes a value outside the tick fields in 5% of 500 rows (25),
// so those rows are new, and removes 1% (5): 30 rows rerender. The 5 rows it
// adds were not loaded, so no watcher here reads them.
test("a merge of a refetch notifies the changed and removed rows", () => {
  expect(touchedBy((store) => store.merge(plainRows(makeRefetch(rows, 2)))).size).toBe(30);
});

// A deep refetch changes a nested value in 5% of the rows and nothing else.
test("a merge of a deep refetch notifies the rows with a nested change", () => {
  expect(touchedBy((store) => store.merge(plainRows(makeDeepRefetch(rows, 5)))).size).toBe(25);
});

test("a tick leaves the list's keys alone", () => {
  const { market, store } = makePinnaStore();
  store.load(plainRows(rows));
  let notified = 0;
  const stop = watch(
    market.realm,
    (read) => read(market.$rows.keys),
    () => {
      notified++;
    },
  );
  store.tick(ticks());
  stop();
  expect(notified).toBe(0);
});
