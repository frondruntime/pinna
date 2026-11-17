/**
 * The alien-signals store. A row holds a `signal` for each field a tick
 * writes and plain values for the rest, which no write changes; the list is a
 * signal of keys, the selection a signal, and each key a reader asks for gets
 * a slot, a signal of its row, so a component reads one row and not the list.
 *
 * Followed:
 * - README "Basic APIs" (`signal`, `computed`, `effect`): a signal is called
 *   to read and called with a value to write, and a write of a value `!==`
 *   the held one notifies nobody, so a tick field is written only where the
 *   value changed by `equalBig` / `equalDate`, as the harness contract asks.
 * - `startBatch` / `endBatch`: the README does not document them; they are
 *   exported and typed in node_modules/alien-signals/types/index.d.ts and
 *   defined in node_modules/alien-signals/esm/index.mjs, and a write that
 *   changes many signals runs inside them so effects run once at the end.
 * - Upstream: https://github.com/stackblitz/alien-signals
 */

import { endBatch, signal, startBatch } from "alien-signals";
import type Big from "big.js";
import {
  type DetailsTexts,
  detailsTexts,
  type RowTexts,
  type RowValues,
  rowTexts,
} from "../data/format.ts";
import {
  equalBig,
  equalDate,
  type PlainRest,
  type PlainRow,
  type PlainTick,
  sameRest,
} from "../data/plain.ts";
import type { Store } from "../harness/store.ts";

type Signal<T> = { (): T; (value: T): void };

export interface AlienRow extends PlainRest {
  readonly price: Signal<Big>;
  readonly diff24: Signal<Big>;
  readonly updatedAt: Signal<Date>;
}

const rowOf = (plain: PlainRow): AlienRow => ({
  id: plain.id,
  ticker: plain.ticker,
  name: plain.name,
  status: plain.status,
  tags: plain.tags,
  volume: plain.volume,
  listedAt: plain.listedAt,
  network: plain.network,
  limits: plain.limits,
  history: plain.history,
  price: signal(plain.price),
  diff24: signal(plain.diff24),
  updatedAt: signal(plain.updatedAt),
});

const writeTick = (row: AlienRow, next: PlainTick): void => {
  if (!equalBig(row.price(), next.price)) {
    row.price(next.price);
  }
  if (!equalBig(row.diff24(), next.diff24)) {
    row.diff24(next.diff24);
  }
  if (!equalDate(row.updatedAt(), next.updatedAt)) {
    row.updatedAt(next.updatedAt);
  }
};

const rowValues = (row: AlienRow): RowValues => ({
  ticker: row.ticker,
  name: row.name,
  status: row.status,
  volume: row.volume,
  price: row.price(),
  diff24: row.diff24(),
  updatedAt: row.updatedAt(),
});

const sameKeys = (previous: ReadonlyArray<string>, next: ReadonlyArray<string>): boolean =>
  previous.length === next.length && previous.every((key, index) => key === next[index]);

const batched = (write: () => void): void => {
  startBatch();
  try {
    write();
  } finally {
    endBatch();
  }
};

export const makeAlienStore = () => {
  let held = new Map<string, AlienRow>();
  const keys = signal<ReadonlyArray<string>>([]);
  const selected = signal<string | undefined>(undefined);
  const slots = new Map<string, Signal<AlienRow | undefined>>();

  /** The signal of a key's row, made the first time a reader asks. */
  const slotOf = (id: string): Signal<AlienRow | undefined> => {
    let slot = slots.get(id);
    if (slot === undefined) {
      slot = signal(held.get(id));
      slots.set(id, slot);
    }
    return slot;
  };

  /** What a row shows, for the harness to check; the components format in their render. */
  const readRow = (id: string): RowTexts | undefined => {
    const row = slotOf(id)();
    return row === undefined ? undefined : rowTexts(rowValues(row));
  };

  const readDetails = (id: string): DetailsTexts | undefined => {
    const row = slotOf(id)();
    return row === undefined
      ? undefined
      : detailsTexts({
          ...rowValues(row),
          listedAt: row.listedAt,
          tags: row.tags,
          network: row.network,
          limits: row.limits,
        });
  };

  /** Holds `rows`, notifying the keys if their order changed and each slot whose row changed. */
  const hold = (rows: ReadonlyArray<AlienRow>): void => {
    const next = new Map(rows.map((row) => [row.id, row]));
    const order = rows.map((row) => row.id);
    held = next;
    if (!sameKeys(keys(), order)) {
      keys(order);
    }
    for (const [id, slot] of slots) {
      const row = next.get(id);
      if (slot() !== row) {
        slot(row);
      }
    }
  };

  const store: Store = {
    load: (rows) => batched(() => hold(rows.map(rowOf))),
    tick: (ticks) =>
      batched(() => {
        for (const tick of ticks) {
          const row = held.get(tick.id);
          if (row !== undefined) {
            writeTick(row, tick);
          }
        }
      }),
    replace: (rows) => batched(() => hold(rows.map(rowOf))),
    merge: (rows) =>
      batched(() =>
        hold(
          rows.map((next) => {
            const current = held.get(next.id);
            if (current === undefined || !sameRest(current, next)) {
              return rowOf(next);
            }
            writeTick(current, next);
            return current;
          }),
        ),
      ),
    insert: (rows) => batched(() => hold([...rows.map(rowOf), ...held.values()])),
    remove: (ids) => {
      const gone = new Set(ids);
      batched(() => hold([...held.values()].filter((row) => !gone.has(row.id))));
    },
    select: (id) => selected(id),
    size: () => keys().length,
    idAt: (index) => keys()[index] as string,
    shownRow: (id) => readRow(id),
    shownDetails: (id) => readDetails(id),
  };

  return { keys, selected, slotOf, readRow, readDetails, store };
};
