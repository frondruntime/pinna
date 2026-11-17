import {
  box,
  type Computed,
  computed,
  computedFunction,
  Model,
  onRowChange,
  type Realm,
  update,
} from "@frondruntime/pinna";
import {
  CollectionField,
  fromStream,
  RealmService,
  SchemaModel,
  schemaBox,
} from "@frondruntime/pinna-effect";
import { Effect, Schema, Stream } from "effect";
import type { Transport } from "../transport.ts";
import { PositionBook } from "./position-book.ts";
import {
  addDecimal,
  buildIndex,
  columns,
  compareTrades,
  filterIndex,
  indexTrades,
  insert,
  matches,
  range,
  remove,
  rowHeight,
  type Sort,
  size,
  type TradeIndex,
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

class TradeStore extends SchemaModel<TradeStore>("Desk.TradeStore")({
  $trades: CollectionField(Trade, { keyOf: (trade) => trade.id }),
}) {}

export class TradeBook extends Model implements Disposable {
  readonly $positionSymbols = computed(
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
  readonly $sort = schemaBox(this.realm, SortSchema, { column: "time", direction: "descending" });
  readonly $filter = schemaBox(this.realm, Schema.String, "");
  readonly $scrollTop = schemaBox(this.realm, Position, 0);
  readonly $viewportHeight = schemaBox(this.realm, Position, 360);
  readonly $selection = box<readonly string[]>(this.realm, [], { equals: sameKeys });
  private readonly $index = box<TradeIndex | undefined>(this.realm, undefined);
  private readonly $order = box<TradeIndex | undefined>(this.realm, undefined);
  readonly $heldCount = box(this.realm, 0);
  readonly $loaded = box(this.realm, false);
  readonly $matchingCount = computed(this.realm, (read) => size(read(this.$index)));
  // Legacy full-order read for headless callers. The UI never materializes this list.
  readonly $keys = computed(
    this.realm,
    (read) => {
      read(this.$feed);
      const tree = read(this.$index);
      return range(tree, 0, size(tree));
    },
    { equals: sameKeys, name: "TradeBook.keys" },
  );
  readonly $window = computed(
    this.realm,
    (read) => {
      read(this.$feed);
      const tree = read(this.$index);
      const count = size(tree);
      const height = read(this.$viewportHeight);
      const scrollTop = Math.min(read(this.$scrollTop), Math.max(0, count * rowHeight - height));
      const start = Math.max(0, Math.floor(scrollTop / rowHeight) - windowMargin);
      const end =
        height === 0
          ? start
          : Math.min(count, Math.ceil((scrollTop + height) / rowHeight) + windowMargin);
      return { start, count, ids: range(tree, start, end) };
    },
    {
      name: "TradeBook.window",
      equals: (left, right) =>
        left.start === right.start && left.count === right.count && sameKeys(left.ids, right.ids),
    },
  );
  readonly $isSelected = computedFunction(this.realm, (read, id: string) =>
    read(this.$selection).includes(id),
  );
  readonly $selectionSummary = computed(this.realm, (read) => {
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

  private readonly stopIndex: () => void;
  constructor(
    realm: Realm,
    private readonly $feed: Computed<number>,
  ) {
    super(realm);
    this.stopIndex = onRowChange(this.$trades, ({ key, before, after }, read, write) => {
      const compare = compareTrades(read(this.$sort));
      const filter = read(this.$filter);
      let tree = read(this.$index);
      let order = read(this.$order);
      if (before) {
        order = remove(order, before, compare);
        if (filter && matches(before, filter)) tree = remove(tree, before, compare);
      }
      if (after) {
        order = insert(order, after, compare);
        if (filter && matches(after, filter)) tree = insert(tree, after, compare);
      } else {
        write(
          this.$selection,
          read(this.$selection).filter((id) => id !== key),
        );
      }
      write(this.$heldCount, read(this.$heldCount) + (before ? 0 : 1) - (after ? 0 : 1));
      write(this.$order, order);
      write(this.$index, filter ? tree : order);
    });
  }

  [Symbol.dispose]() {
    this.stopIndex();
    this.positions[Symbol.dispose]();
  }

  setSort(sort: Sort) {
    update(this.realm, (read, write) => {
      write(this.$sort, sort);
      const tree = buildIndex(indexTrades(read(this.$order)), compareTrades(read(this.$sort)));
      write(this.$order, tree);
      write(this.$index, filterIndex(tree, read(this.$filter)));
    });
  }

  setFilter(filter: string) {
    update(this.realm, (read, write) => {
      write(this.$filter, filter);
      write(this.$index, filterIndex(read(this.$order), filter));
    });
  }

  setScrollTop(position: number) {
    update(this.realm, (_read, write) => write(this.$scrollTop, position));
  }

  setViewportHeight(height: number) {
    update(this.realm, (_read, write) => write(this.$viewportHeight, height));
  }

  setSelection(ids: readonly string[]) {
    update(this.realm, (read, write) =>
      write(
        this.$selection,
        [...new Set(ids)].filter((id) => read.row(this.$trades, id) !== undefined),
      ),
    );
  }

  select(id: string, additive = false) {
    update(this.realm, (read, write) => {
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
          update(this.realm, (read, write) => {
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
      update(book.realm, (read, write) => {
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
    update(this.realm, (_read, write) => write.remove(this.$trades, id));
  }
}

export const makeTradeBook = (transport: Transport) =>
  Effect.gen(function* () {
    const realm = yield* RealmService;
    const $feed: Computed<number> = yield* fromStream(
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
