/**
 * The Legend State store, written as Legend State 3 documents it:
 *
 * - Three observables, the list of ids, the rows by id, and the open id: the
 *   "many atoms" shape of the patterns guide,
 *   https://legendapp.com/open-source/state/v3/guides/patterns/.
 * - The rows by id as a record keyed by id, Legend's own shape for a keyed
 *   collection: `syncedCrud` stores one as `as: 'object'` by default
 *   (`node_modules/@legendapp/state/sync-plugins/crud.d.ts`). The first load
 *   into the empty record is one `rows$.set` of the whole record: with no
 *   key held before, `updateNodes` (`node_modules/@legendapp/state/index.js`)
 *   walks the new keys once and the record notifies once, where a `set` per
 *   key notifies once per row. Every later write changes one key,
 *   `rows$[id].set(...)` or `rows$[id].delete()`, as the observable guide
 *   says to instead of setting a cloned record,
 *   https://legendapp.com/open-source/state/v3/usage/observable/. Setting the
 *   whole record over keys already held looks up every held key in the new
 *   key list (`keys.includes` in `updateNodes`), work that grows with the
 *   square of the rows, so a replace sets key by key too.
 * - Only what the app writes is observable field by field: a row's price,
 *   diff24, and updatedAt. Everything else in a row never changes while the
 *   row lives, so it sits in `rest`, marked `ObservableHint.opaque`, which
 *   Legend treats as one value and never walks; a big.js decimal is marked
 *   the same way, the same as MobX's `observableRef`. The row object and the
 *   record are marked `ObservableHint.plain`: they hold no functions or
 *   observables, so Legend skips searching them,
 *   https://legendapp.com/open-source/state/v3/usage/helper-functions/
 *   ("Hints"), `ObservableHint` in `node_modules/@legendapp/state/index.d.ts`.
 *   A Date needs no hint: Legend holds a date as a primitive and compares it
 *   by time (`isPrimitive` and `equals` in `index.js`).
 * - Every write runs in one `batch`, as the performance guide says for
 *   several changes at once,
 *   https://legendapp.com/open-source/state/v3/guides/performance/.
 *
 * A tick field is set only when its value changed, with the same comparison
 * every store uses, so an opaque decimal is not replaced by an equal one.
 */
import {
  batch,
  type Observable,
  ObservableHint,
  type OpaqueObject,
  observable,
} from "@legendapp/state";
import type Big from "big.js";
import type { DetailsTexts, RowTexts } from "../data/format.ts";
import { detailsTexts, rowTexts } from "../data/format.ts";
import {
  equalBig,
  equalDate,
  type PlainRest,
  type PlainRow,
  type PlainTick,
  sameRest,
} from "../data/plain.ts";
import type { Store } from "../harness/store.ts";

/**
 * A row as Legend holds it: the fields a tick writes, each its own
 * observable, and the rest as one opaque value.
 */
export interface LegendRow {
  readonly rest: OpaqueObject<PlainRest>;
  readonly price: OpaqueObject<Big>;
  readonly diff24: OpaqueObject<Big>;
  readonly updatedAt: Date;
}

/** A row as `get` and `peek` return it: Legend's types drop the hints. */
export interface HeldRow {
  readonly rest: PlainRest;
  readonly price: Big;
  readonly diff24: Big;
  readonly updatedAt: Date;
}

// The plain row is held whole as `rest`, typed as what a tick does not write,
// so its first price and time are never read once a tick moves them.
const toLegendRow = (row: PlainRow): LegendRow =>
  ObservableHint.plain({
    rest: ObservableHint.opaque<PlainRest>(row),
    price: ObservableHint.opaque(row.price),
    diff24: ObservableHint.opaque(row.diff24),
    updatedAt: row.updatedAt,
  });

/** The values `rowTexts` and `detailsTexts` format, from a held row. */
export const rowValues = (row: HeldRow) => ({
  ...row.rest,
  price: row.price,
  diff24: row.diff24,
  updatedAt: row.updatedAt,
});

export const makeLegendStore = () => {
  const ids$ = observable<Array<string>>([]);
  const rows$: Observable<Record<string, LegendRow>> = observable<Record<string, LegendRow>>(
    ObservableHint.plain({}),
  );
  const selected$ = observable<string | undefined>(undefined);

  const writeTick = (row$: Observable<LegendRow>, current: HeldRow, next: PlainTick): void => {
    if (!equalBig(current.price, next.price)) {
      row$.price.set(ObservableHint.opaque(next.price));
    }
    if (!equalBig(current.diff24, next.diff24)) {
      row$.diff24.set(ObservableHint.opaque(next.diff24));
    }
    if (!equalDate(current.updatedAt, next.updatedAt)) {
      row$.updatedAt.set(next.updatedAt);
    }
  };

  const setAll = (rows: ReadonlyArray<PlainRow>): void => {
    const incoming = new Set(rows.map((row) => row.id));
    for (const id of ids$.peek()) {
      if (!incoming.has(id)) {
        rows$[id]?.delete();
      }
    }
    for (const row of rows) {
      rows$[row.id]?.set(toLegendRow(row));
    }
    ids$.set(rows.map((row) => row.id));
  };

  // Into the empty record, one set of the whole record; over held rows, as a replace.
  const load = (rows: ReadonlyArray<PlainRow>): void => {
    if (ids$.peek().length > 0) {
      setAll(rows);
      return;
    }
    const record: Record<string, LegendRow> = {};
    for (const row of rows) {
      record[row.id] = toLegendRow(row);
    }
    rows$.set(ObservableHint.plain(record));
    ids$.set(rows.map((row) => row.id));
  };

  const store: Store = {
    load: (rows) => batch(() => load(rows)),
    replace: (rows) => batch(() => setAll(rows)),
    tick: (updates) =>
      batch(() => {
        for (const update of updates) {
          const row$ = rows$[update.id];
          const current = row$?.peek();
          if (row$ !== undefined && current !== undefined) {
            writeTick(row$, current, update);
          }
        }
      }),
    merge: (rows) =>
      batch(() => {
        const incoming = new Set(rows.map((row) => row.id));
        for (const id of ids$.peek()) {
          if (!incoming.has(id)) {
            rows$[id]?.delete();
          }
        }
        for (const row of rows) {
          const row$ = rows$[row.id];
          const current = row$?.peek();
          if (row$ !== undefined && current !== undefined && sameRest(current.rest, row)) {
            writeTick(row$, current, row);
          } else {
            row$?.set(toLegendRow(row));
          }
        }
        // Legend compares the array by index and notifies only on a change.
        ids$.set(rows.map((row) => row.id));
      }),
    insert: (rows) =>
      batch(() => {
        for (const row of rows) {
          rows$[row.id]?.set(toLegendRow(row));
        }
        ids$.set([...rows.map((row) => row.id), ...ids$.peek()]);
      }),
    remove: (ids) =>
      batch(() => {
        const gone = new Set(ids);
        for (const id of ids) {
          rows$[id]?.delete();
        }
        ids$.set(ids$.peek().filter((id) => !gone.has(id)));
      }),
    select: (id) => selected$.set(id),
    size: () => ids$.peek().length,
    idAt: (index) => ids$.peek()[index] as string,
    shownRow: (id): RowTexts | undefined => {
      const row = rows$[id]?.peek();
      return row === undefined ? undefined : rowTexts(rowValues(row));
    },
    shownDetails: (id): DetailsTexts | undefined => {
      const row = rows$[id]?.peek();
      return row === undefined ? undefined : detailsTexts(rowValues(row));
    },
  };

  return { ids$, rows$, selected$, store };
};
