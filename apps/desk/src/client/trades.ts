import { Collection, Computed, Realm, View } from "@frondruntime/pinna";
import { Box, Model, Program, RealmService } from "@frondruntime/pinna-effect";
import { Effect, Schema, Stream } from "effect";
import type { Transport } from "../transport.ts";
import { PositionBook } from "./position-book.ts";
import {
  addDecimal,
  columns,
  compareTrades,
  matches,
  rowHeight,
  type Sort,
  windowMargin,
} from "./trade-index.ts";
import { decodeTrade, decodeTradeSnapshot, Trade, tradesEqual } from "./wire.ts";

export const SortSchema = Schema.Struct({
  column: Schema.Literals(columns),
  direction: Schema.Literals(["ascending", "descending"]),
});
export const Position = Schema.Number.check(
  Schema.makeFilter((value) => Number.isFinite(value) && value >= 0),
);
const sameKeys = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((key, index) => key === right[index]);

class TradeStore extends Model.Schema<TradeStore>("Desk.TradeStore")({
  $trades: Model.collectionField(Trade, { keyOf: (trade) => trade.id }),
}) {}

export class TradeBook extends Model.Class implements Disposable {
  readonly $positionSymbols = Computed.make(
    this.realm,
    (read) => {
      read(this.$feed);
      return this.positions.ledgers
        .filter((ledger) => read(ledger.$aggregate).count > 0)
        .map((ledger) => ledger.symbol);
    },
    { equals: sameKeys, name: "TradeBook.positionSymbols" },
  );
  private readonly store = TradeStore.make({ realm: this.realm, trades: [] });
  readonly $trades = this.store.$trades;
  readonly positions = new PositionBook(this.realm, this.$trades);
  readonly $sort = Box.schema(this.realm, SortSchema, { column: "time", direction: "descending" });
  readonly $filter = Box.schema(this.realm, Schema.String, "");
  readonly $scrollTop = Box.schema(this.realm, Position, 0);
  readonly $viewportHeight = Box.schema(this.realm, Position, 360);
  readonly $selection = Box.make<readonly string[]>(this.realm, [], { equals: sameKeys });
  readonly $loaded = Box.make(this.realm, false);
  /** The blotter's order: sorted by `$sort`, filtered by `$filter`, kept a trade at a time. */
  readonly blotter = View.ordered(this.$trades, {
    compare: (read) => compareTrades(read(this.$sort)),
    filter: (read) => {
      const filter = read(this.$filter);
      return filter ? (trade) => matches(trade, filter) : undefined;
    },
    name: "TradeBook.blotter",
  });
  readonly $heldCount = this.blotter.totalSize;
  readonly $matchingCount = this.blotter.size;
  // Legacy full-order read for headless callers. The UI never materializes this list.
  readonly $keys = Computed.make(
    this.realm,
    (read) => {
      read(this.$feed);
      return read(this.blotter.keys);
    },
    { equals: sameKeys, name: "TradeBook.keys" },
  );
  readonly $window = Computed.make(
    this.realm,
    (read) => {
      read(this.$feed);
      const count = read(this.blotter.size);
      const height = read(this.$viewportHeight);
      const scrollTop = Math.min(read(this.$scrollTop), Math.max(0, count * rowHeight - height));
      const start = Math.max(0, Math.floor(scrollTop / rowHeight) - windowMargin);
      const end =
        height === 0
          ? start
          : Math.min(count, Math.ceil((scrollTop + height) / rowHeight) + windowMargin);
      return { start, count, ids: read(this.blotter.range(start, end)) };
    },
    {
      name: "TradeBook.window",
      equals: (left, right) =>
        left.start === right.start && left.count === right.count && sameKeys(left.ids, right.ids),
    },
  );
  readonly $isSelected = Computed.fn(this.realm, (read, id: string) =>
    read(this.$selection).includes(id),
  );
  readonly $selectionSummary = Computed.make(this.realm, (read) => {
    const selected = read(this.$selection);
    let buy = "0";
    let sell = "0";
    for (const id of selected) {
      const trade = read.row(this.$trades, id);
      if (trade?.direction === "buy") buy = addDecimal(buy, trade.notional);
      if (trade?.direction === "sell") sell = addDecimal(sell, trade.notional);
    }
    return { count: selected.length, buy, sell };
  });

  private readonly stopSelection: () => void;
  constructor(
    realm: Realm,
    private readonly $feed: Computed<number>,
  ) {
    super(realm);
    // A withdrawn trade leaves the selection.
    this.stopSelection = Collection.onRowChange(this.$trades, ({ key, after }, read, write) => {
      if (after === undefined && read(this.$selection).includes(key)) {
        write(
          this.$selection,
          read(this.$selection).filter((id) => id !== key),
        );
      }
    });
  }

  [Symbol.dispose]() {
    this.stopSelection();
    View.dispose(this.blotter);
    this.positions[Symbol.dispose]();
  }

  setSort(sort: Sort) {
    Realm.update(this.realm, (_read, write) => write(this.$sort, sort));
  }

  setFilter(filter: string) {
    Realm.update(this.realm, (_read, write) => write(this.$filter, filter));
  }

  setScrollTop(position: number) {
    Realm.update(this.realm, (_read, write) => write(this.$scrollTop, position));
  }

  setViewportHeight(height: number) {
    Realm.update(this.realm, (_read, write) => write(this.$viewportHeight, height));
  }

  setSelection(ids: readonly string[]) {
    Realm.update(this.realm, (read, write) =>
      write(
        this.$selection,
        [...new Set(ids)].filter((id) => read.row(this.$trades, id) !== undefined),
      ),
    );
  }

  select(id: string, additive = false) {
    Realm.update(this.realm, (read, write) => {
      if (read.row(this.$trades, id) === undefined) return;
      const previous = read(this.$selection);
      write(
        this.$selection,
        !additive
          ? [id]
          : previous.includes(id)
            ? previous.filter((key) => key !== id)
            : [...previous, id],
      );
    });
  }

  /** Unknown local pending rows are echoes, never new orders. Only execute introduces one. */
  private merge(previous: Trade | undefined, trade: Trade, optimistic: boolean) {
    if (
      previous &&
      (previous.updatedAt > trade.updatedAt ||
        (previous.status !== "pending" && trade.status === "pending"))
    )
      return previous;
    if (trade.desk === "local" && trade.status === "rejected") return undefined;
    if (!previous && trade.desk === "local" && trade.status === "pending" && !optimistic)
      return undefined;
    return previous && tradesEqual(previous, trade) ? previous : trade;
  }

  /** All paths into the collection, including optimistic rows, pass this check. */
  accept(value: unknown, optimistic = false) {
    return decodeTrade(value).pipe(
      Effect.tap((trade) =>
        Effect.sync(() => {
          Realm.update(this.realm, (read, write) => {
            const previous = read.row(this.$trades, trade.id);
            const next = this.merge(previous, trade, optimistic);
            if (previous === next) return;
            if (next) {
              write.upsert(this.$trades, next);
            } else {
              write.remove(this.$trades, trade.id);
            }
          });
        }),
      ),
      Effect.asVoid,
      Effect.catch((error) => Effect.logWarning("desk: dropped invalid trade", error)),
    );
  }

  /** Decode individually, merge once: repeated upserts would copy the key order quadratically. */
  acceptSnapshot(values: readonly unknown[]) {
    const book = this;
    return Effect.gen(function* () {
      const checked: Trade[] = [];
      for (const value of values) {
        const trade = yield* decodeTrade(value).pipe(
          Effect.catch((error) =>
            Effect.logWarning("desk: dropped invalid trade", error).pipe(Effect.as(undefined)),
          ),
        );
        if (trade) checked.push(trade);
      }
      Realm.update(book.realm, (read, write) => {
        const held = new Map(read(book.$trades.rows).map((trade) => [trade.id, trade]));
        for (const trade of checked) {
          const next = book.merge(held.get(trade.id), trade, false);
          if (next) held.set(trade.id, next);
          else held.delete(trade.id);
        }
        const trades = [...held.values()];
        write.replaceAll(book.$trades, trades);
        write(book.$loaded, true);
      });
    });
  }

  withdraw(id: string) {
    Realm.update(this.realm, (_read, write) => write.remove(this.$trades, id));
  }
}

export const makeTradeBook = (transport: Transport) =>
  Effect.gen(function* () {
    const realm = yield* RealmService;
    const $feed: Computed<number> = yield* Program.fromStream(
      realm,
      Stream.callback<number>(() =>
        Effect.gen(function* () {
          // Subscribe first; snapshot merging preserves newer topic updates.
          yield* transport.subscribe("trades").pipe(
            Stream.runForEach((raw) =>
              Effect.try({ try: () => JSON.parse(raw) as unknown, catch: String }).pipe(
                Effect.flatMap((value) => book.accept(value)),
                Effect.catch((error) => Effect.logWarning("desk: dropped invalid trade", error)),
              ),
            ),
            Effect.catch((error) => Effect.logWarning("desk: trade topic failed", error)),
            Effect.forkScoped({ startImmediately: true }),
          );
          const snapshot = yield* transport.request("/trades", "").pipe(
            Effect.flatMap((raw) => decodeTradeSnapshot(raw)),
            Effect.catch((error) =>
              Effect.logWarning("desk: trade snapshot failed", error).pipe(Effect.as([])),
            ),
          );
          yield* book.acceptSnapshot(snapshot);
        }),
      ),
      0,
      { name: "TradeBook.feed" },
    );
    const book = yield* Effect.acquireRelease(
      Effect.sync(() => new TradeBook(realm, $feed)),
      (book) => Effect.sync(() => book[Symbol.dispose]()),
    );
    return book;
  });
