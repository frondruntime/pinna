import { computed, Model, type Realm } from "@frondruntime/pinna";
import {
  add,
  type Decimal,
  decimal,
  divide,
  fraction,
  multiply,
  rounded,
  subtract,
} from "./decimal.ts";
import type { Desk } from "./desk.ts";
import type { TradeBook } from "./trades.ts";
import type { PairSymbol } from "./wire.ts";

export interface PositionValue {
  readonly symbol: PairSymbol;
  readonly net: Decimal;
  readonly average: Decimal | null;
  readonly mark: Decimal | null;
  readonly profitLoss: Decimal | null;
  readonly dollars: bigint | null;
}
const mid = (price: { readonly bid: string; readonly ask: string } | null) =>
  price === null ? null : divide(add(decimal(price.bid), decimal(price.ask)), fraction(2n));

export class PositionRow extends Model {
  readonly $value = computed<PositionValue | null>(
    this.realm,
    (read) => {
      const aggregate = read(this.book.positions.ledger(this.tile.pair.symbol).$aggregate);
      if (!aggregate.count) return null;
      const mark = mid(read(this.tile.$prices).current);
      const converter =
        this.tile.pair.termsCurrency === "GBP"
          ? "GBPUSD"
          : this.tile.pair.termsCurrency === "JPY"
            ? "USDJPY"
            : null;
      const conversionTile =
        converter === null ? undefined : this.tiles.find((tile) => tile.pair.symbol === converter);
      const conversion =
        converter === null
          ? fraction(1n)
          : conversionTile
            ? mid(read(conversionTile.$prices).current)
            : null;
      const profitLoss =
        mark === null ? null : subtract(multiply(aggregate.net, mark), aggregate.cost);
      const dollars =
        profitLoss === null || conversion === null
          ? null
          : rounded(
              this.tile.pair.termsCurrency === "JPY"
                ? divide(profitLoss, conversion)
                : multiply(profitLoss, conversion),
              2,
            );
      return {
        symbol: this.tile.pair.symbol,
        net: aggregate.net,
        average: aggregate.net.numerator === 0n ? null : divide(aggregate.cost, aggregate.net),
        mark,
        profitLoss,
        dollars,
      };
    },
    { name: "Position.value" },
  );
  constructor(
    realm: Realm,
    readonly tile: Desk,
    private readonly tiles: readonly Desk[],
    private readonly book: TradeBook,
  ) {
    super(realm);
  }
}

export class Positions extends Model {
  readonly $symbols;
  readonly rows: readonly PositionRow[];
  readonly $total = computed(
    this.realm,
    (read) => {
      let cents = 0n;
      let complete = true;
      for (const symbol of read(this.$symbols)) {
        const value = read(this.row(symbol).$value);
        if (value?.dollars === null || value === null) complete = false;
        else cents += value.dollars;
      }
      return { cents, complete };
    },
    { name: "Positions.total" },
  );
  constructor(realm: Realm, tiles: readonly Desk[], book: TradeBook) {
    super(realm);
    this.$symbols = book.$positionSymbols;
    this.rows = tiles.map((tile) => new PositionRow(realm, tile, tiles, book));
  }
  row(symbol: PairSymbol) {
    const row = this.rows.find((row) => row.tile.pair.symbol === symbol);
    if (!row) throw new Error(`pair is not listed: ${symbol}`);
    return row;
  }
}
