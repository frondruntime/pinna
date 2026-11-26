/**
 * A sample trading-positions model, to check that Pinna covers what an
 * application's server model needs: decimals and dates decoded from strings,
 * optional nested classes, a list of classes, and a date formatter that
 * decoding takes from the caller's context.
 *
 * - Fields are plain `readonly` data, so a position holds no observables and
 *   is a plain `Schema.Class`. A live snapshot decodes into a new instance
 *   that replaces the old one in its box.
 * - `calculate` is a plain method of the position and the rates; a computed
 *   value that reads the boxes holding them makes it reactive.
 * - The formatted dates are methods that take `read` and hand it to the
 *   formatter, whose output may follow reactive state such as a locale.
 */
import { BigDecimal, Context, Schema } from "effect";
import { Model, type Read } from "../../src/index.ts";

/**
 * The date formatter the caller passes in the decode context. It takes the
 * caller's `read`, so a formatter that reads a box tracks it there.
 */
export interface DateFormatting {
  readonly formatDateTime: (read: Read, value: Date) => string;
}

/** The decode context's date formatter. */
export class Dates extends Context.Service<Dates, DateFormatting>()("positions/Dates") {}

const Decimal = Schema.BigDecimalFromString;
const Instant = Schema.DateFromString;

/**
 * The server's close estimate of an open position, as of when it was sent.
 * Only the accrued funding is used; the profit goes stale as the rates move.
 */
export class Estimate extends Schema.Class<Estimate>("Estimate")({
  profit: Decimal,
  accruedFunding: Decimal,
}) {}

/** The settled result of a closed position. */
export class Settlement extends Schema.Class<Settlement>("Settlement")({
  profit: Decimal,
  percent: Decimal,
  payout: Decimal,
}) {}

export class ChartPoint extends Schema.Class<ChartPoint>("ChartPoint")({
  at: Instant,
  price: Decimal,
}) {}

export const Rates = Schema.Record(
  Schema.String,
  Schema.Record(
    Schema.String,
    Schema.Struct({ price: Schema.Number, bid: Schema.Number, ask: Schema.Number }),
  ),
);
export type Rates = typeof Rates.Type;

/** Profit and payout in the collateral currency. */
export interface Projection {
  readonly profit: BigDecimal.BigDecimal;
  readonly percent: BigDecimal.BigDecimal;
  readonly payout: BigDecimal.BigDecimal;
}

const zero = BigDecimal.fromNumberUnsafe(0);
const hundred = BigDecimal.fromNumberUnsafe(100);

export class Position extends Schema.Class<Position>("Position")({
  id: Schema.String,
  account: Schema.String,
  isShort: Schema.Boolean,
  collateralTicker: Schema.String,
  baseTicker: Schema.String,
  quoteTicker: Schema.String,
  collateral: Decimal,
  size: Decimal,
  entryPrice: Decimal,
  leverage: Schema.Number,
  status: Schema.String,
  openedAt: Instant,
  nextFundingAt: Instant,
  nextFundingFee: Decimal,
  closedAt: Schema.optionalKey(Schema.NullOr(Instant)),
  openFee: Schema.optionalKey(Decimal),
  closeFee: Schema.optionalKey(Decimal),
  estimate: Schema.optionalKey(Estimate),
  settlement: Schema.optionalKey(Settlement),
  chart: Schema.optionalKey(Schema.Array(ChartPoint)),
  dates: Model.context(Dates),
}) {
  openedAtFormatted(read: Read): string {
    return this.dates.formatDateTime(read, this.openedAt);
  }

  nextFundingAtFormatted(read: Read): string {
    return this.dates.formatDateTime(read, this.nextFundingAt);
  }

  closedAtFormatted(read: Read): string | undefined {
    return this.closedAt == null ? undefined : this.dates.formatDateTime(read, this.closedAt);
  }

  get isOpen(): boolean {
    return this.status === "open";
  }

  /**
   * The settled result of a closed position, or the live projection of an
   * open one at the closing side of the current quote: the bid for a long,
   * the ask for a short.
   */
  calculate(rates: Rates): Projection | undefined {
    if (!this.isOpen) {
      return this.settlement === undefined
        ? undefined
        : {
            profit: this.settlement.profit,
            percent: this.settlement.percent,
            payout: this.settlement.payout,
          };
    }
    if (this.estimate === undefined) {
      return undefined;
    }
    const quote = rates[this.baseTicker]?.[this.quoteTicker];
    const closingPrice = this.isShort ? quote?.ask : quote?.bid;
    const collateralPrice =
      this.collateralTicker === this.quoteTicker
        ? 1
        : rates[this.collateralTicker]?.[this.quoteTicker]?.price;
    if (
      closingPrice === undefined ||
      closingPrice <= 0 ||
      collateralPrice === undefined ||
      collateralPrice <= 0
    ) {
      return undefined;
    }
    return project(this, this.estimate, closingPrice, collateralPrice);
  }
}

/** Profit in the collateral currency, net of the open and close fees and the accrued funding. */
const project = (
  position: Position,
  estimate: Estimate,
  closingPrice: number,
  collateralPrice: number,
): Projection => {
  const move = BigDecimal.subtract(BigDecimal.fromNumberUnsafe(closingPrice), position.entryPrice);
  const profitInQuote = BigDecimal.multiply(
    position.isShort ? BigDecimal.negate(move) : move,
    position.size,
  );
  const profitInCollateral = BigDecimal.divideUnsafe(
    profitInQuote,
    BigDecimal.fromNumberUnsafe(collateralPrice),
  );
  const fees = BigDecimal.sum(
    BigDecimal.sum(position.openFee ?? zero, position.closeFee ?? zero),
    estimate.accruedFunding,
  );
  const profit = BigDecimal.subtract(profitInCollateral, fees);
  return {
    profit,
    percent: BigDecimal.multiply(BigDecimal.divideUnsafe(profit, position.collateral), hundred),
    payout: BigDecimal.sum(position.collateral, profit),
  };
};
