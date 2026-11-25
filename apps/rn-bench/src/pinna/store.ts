/**
 * The Pinna store, on the plain entry `@frondruntime/pinna`: no schema and
 * no Effect, since the harness hands it trusted rows it already converted.
 *
 * Followed:
 * - packages/pinna/AGENTS.md, "The rules": rule 1, a `$` name is
 *   observable and every other field is plain, readonly data; rule 3, every
 *   write goes through the `write` a `Realm.update` hands out; rule 4, trusted
 *   data that is written often takes a plain `Box.make`, which checks nothing.
 * - docs/public/state/collections.md: a collection holds a box for each key
 *   a reader reads, made on its first read, and one for the order of the
 *   keys, so a write to one row reruns that row's readers only;
 *   `Collection.make(realm, { keyOf })` outside a schema model; many new rows go
 *   in through one `write.replaceAll`. A tick and `shown` read through
 *   `read.row`, which where nothing tracks makes no box for the keys they
 *   look up.
 * - docs/public/state/updates.md: an event handler, and a test, read through
 *   `Realm.untracked`.
 * - docs/public/start/index.md: `Realm.make`; a named realm names itself in
 *   errors.
 * - packages/pinna/src/box.ts, `ValueOptions.equals`: a box that keeps
 *   its value and notifies nobody when `equals` holds.
 *
 * Rows and the market are plain objects, not `Model` subclasses, as the
 * alien-signals and Legend State stores are: under babel-preset-expo's
 * default `@babel/runtime` helpers, every subclass construction runs
 * `callSuper`, which in @babel/runtime 7.29.13 redoes its setup on each
 * call (docs/performance.md, "Pinna's rows without a subclass").
 *
 * Reactive: the three fields a tick writes (`$price`, `$diff24`,
 * `$updatedAt`), the rows (`$rows`), and the open id (`$selected`). Inert:
 * every other field of a row, held as the plain value it was given, since
 * nothing writes it; a merge that finds one changed makes a new row.
 *
 * `Collection.reconcile` is not used: it keeps a previous item where `equals` holds on
 * two items of one type, so a merge would first build a new row with three
 * boxes for every incoming row, and a kept row would still need its boxes
 * written. The merge below compares the plain row with the held one instead.
 */
import { Box, Collection, Realm, type Write } from "@frondruntime/pinna";
import type Big from "big.js";
import {
  type DetailsTexts,
  type DetailsValues,
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

// The options of a tick box, made once: an options object written inline
// would be one more allocation for each of the three boxes of every row.
const bigOptions = { equals: equalBig };
const dateOptions = { equals: equalDate };

/** One market row: plain fields that never change, and a box per tick field. */
export interface Instrument extends PlainRest {
  readonly $price: Box<Big>;
  readonly $diff24: Box<Big>;
  readonly $updatedAt: Box<Date>;
}

const instrumentOf = (realm: Realm, row: PlainRow): Instrument => ({
  id: row.id,
  ticker: row.ticker,
  name: row.name,
  status: row.status,
  tags: row.tags,
  volume: row.volume,
  listedAt: row.listedAt,
  network: row.network,
  limits: row.limits,
  history: row.history,
  $price: Box.make(realm, row.price, bigOptions),
  $diff24: Box.make(realm, row.diff24, bigOptions),
  $updatedAt: Box.make(realm, row.updatedAt, dateOptions),
});

/** Writes the tick fields; a box whose value is equal notifies nobody. */
const writeTick = (write: Write, instrument: Instrument, tick: PlainTick): void => {
  write(instrument.$price, tick.price);
  write(instrument.$diff24, tick.diff24);
  write(instrument.$updatedAt, tick.updatedAt);
};

/** What a row shows, given the tick values its component read. */
export const instrumentValues = (
  instrument: Instrument,
  [price, diff24, updatedAt]: readonly [Big, Big, Date],
): DetailsValues => ({
  ticker: instrument.ticker,
  name: instrument.name,
  status: instrument.status,
  volume: instrument.volume,
  listedAt: instrument.listedAt,
  tags: instrument.tags,
  network: instrument.network,
  limits: instrument.limits,
  price,
  diff24,
  updatedAt,
});

/** The rows in list order and the open row, written through its functions. */
export interface Market {
  readonly realm: Realm;
  readonly $rows: Collection<string, Instrument>;
  readonly $selected: Box<string | undefined>;
  /** Every row new: the first fetch, or a refetch swapped in whole. */
  readonly replace: (rows: ReadonlyArray<PlainRow>) => void;
  readonly tick: (ticks: ReadonlyArray<PlainTick>) => void;
  /**
   * A held row whose other fields agree stays, with its tick fields
   * written; any other row is new; a row the refetch lacks goes. A kept row
   * notifies only the readers of a box whose value changed.
   */
  readonly merge: (rows: ReadonlyArray<PlainRow>) => void;
  /** New rows on top, in one write to the list. */
  readonly insert: (rows: ReadonlyArray<PlainRow>) => void;
  /** Rows gone, in one write to the list. */
  readonly remove: (ids: ReadonlyArray<string>) => void;
  /** New rows on top, one `upsert` per row in one update. */
  readonly insertEach: (rows: ReadonlyArray<PlainRow>) => void;
  /** Rows gone, one `remove` per row in one update. */
  readonly removeEach: (ids: ReadonlyArray<string>) => void;
  readonly select: (id: string | undefined) => void;
}

const makeMarket = (realm: Realm): Market => {
  const $rows = Collection.make(realm, { keyOf: (row: Instrument) => row.id });
  const $selected = Box.make<string | undefined>(realm, undefined, { name: "Market.selected" });
  const fresh = (row: PlainRow): Instrument => instrumentOf(realm, row);

  const replace = (rows: ReadonlyArray<PlainRow>): void => {
    Realm.update(realm, (_read, write) => {
      write.replaceAll($rows, rows.map(fresh));
    });
  };

  return {
    realm,
    $rows,
    $selected,
    replace,
    tick: (ticks) => {
      Realm.update(realm, (read, write) => {
        for (const tick of ticks) {
          const instrument = read.row($rows, tick.id);
          if (instrument !== undefined) {
            writeTick(write, instrument, tick);
          }
        }
      });
    },
    merge: (rows) => {
      Realm.update(realm, (read, write) => {
        const held = new Map(read($rows.rows).map((row) => [row.id, row]));
        const merged = rows.map((next) => {
          const current = held.get(next.id);
          if (current === undefined || !sameRest(current, next)) {
            return fresh(next);
          }
          writeTick(write, current, next);
          return current;
        });
        write.replaceAll($rows, merged);
      });
    },
    insert: (rows) => {
      Realm.update(realm, (read, write) => {
        write.replaceAll($rows, [...rows.map(fresh), ...read($rows.rows)]);
      });
    },
    remove: (ids) => {
      const gone = new Set(ids);
      Realm.update(realm, (read, write) => {
        write.replaceAll(
          $rows,
          read($rows.rows).filter((row) => !gone.has(row.id)),
        );
      });
    },
    insertEach: (rows) => {
      Realm.update(realm, (_read, write) => {
        for (let index = rows.length - 1; index >= 0; index--) {
          write.upsert($rows, fresh(rows[index] as PlainRow));
        }
      });
    },
    removeEach: (ids) => {
      Realm.update(realm, (_read, write) => {
        for (const id of ids) {
          write.remove($rows, id);
        }
      });
    },
    select: (id) => {
      Realm.update(realm, (_read, write) => {
        write($selected, id);
      });
    },
  };
};

export const makePinnaStore = () => {
  const market = makeMarket(Realm.make({ name: "market" }));
  const { realm, $rows } = market;

  /** What the row components read, read once outside React. */
  const shown = (id: string): DetailsValues | undefined =>
    Realm.untracked(realm, (read) => {
      const instrument = read.row($rows, id);
      return instrument === undefined
        ? undefined
        : instrumentValues(instrument, [
            read(instrument.$price),
            read(instrument.$diff24),
            read(instrument.$updatedAt),
          ]);
    });

  const store: Store = {
    load: (rows) => market.replace(rows),
    tick: (ticks) => market.tick(ticks),
    replace: (rows) => market.replace(rows),
    merge: (rows) => market.merge(rows),
    insert: (rows) => market.insert(rows),
    remove: (ids) => market.remove(ids),
    insertEach: (rows) => market.insertEach(rows),
    removeEach: (ids) => market.removeEach(ids),
    select: (id) => market.select(id),
    size: () => Realm.untracked(realm, (read) => read($rows.keys).length),
    idAt: (index) => Realm.untracked(realm, (read) => read($rows.keys)[index] as string),
    shownRow: (id): RowTexts | undefined => {
      const values: RowValues | undefined = shown(id);
      return values === undefined ? undefined : rowTexts(values);
    },
    shownDetails: (id): DetailsTexts | undefined => {
      const values = shown(id);
      return values === undefined ? undefined : detailsTexts(values);
    },
  };

  return { market, store };
};
