/**
 * The sample positions model of `packages/pinna-effect/test/positions`:
 * `Position`, `Positions`, and the update stream's message. The server sends
 * decimals and dates as strings; the date formatter is the caller's, passed
 * to `decode` as the `Dates` service. The transport, the rate feed, and the
 * update stream are the host's, and the playground mocks them.
 */
import {
  type Box,
  CollectionField,
  type Computed,
  FromContext,
  type Read,
  type Realm,
  SchemaModel,
  schemaBox,
  update,
} from "@frondruntime/pinna-effect";
import { BigDecimal, Context, Schema } from "effect";

export const locales = ["en-US", "de-DE", "ja-JP"] as const;
export type Locale = (typeof locales)[number];

/**
 * The application's date formatter: a runtime service, not data. Its locale
 * is a box, so every read that formats through it follows the locale.
 */
export class DateFormatting {
  readonly $locale: Box<Locale>;

  constructor(private readonly realm: Realm) {
    this.$locale = schemaBox(realm, Schema.Literals(locales), "en-US");
  }

  formatDateTime(read: Read, value: Date): string {
    return new Intl.DateTimeFormat(read(this.$locale), {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(value);
  }

  setLocale(locale: Locale): void {
    update(this.realm, (_read, write) => {
      write(this.$locale, locale);
    });
  }
}

/** The service every decode in this module takes: the caller's date formatter. */
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
  dates: FromContext(Dates),
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

export class Positions extends SchemaModel<Positions>("Positions")({
  $items: CollectionField(Position, { keyOf: (position) => position.id }),
}) {
  getById(id: string): Computed<Position | undefined> {
    return this.$items.row(id);
  }

  /** Replaces the position with the same id, or puts a new one first. */
  upsert(position: Position): void {
    update(this.realm, (_read, write) => {
      write.upsert(this.$items, position);
    });
  }

  remove(id: string): void {
    update(this.realm, (_read, write) => {
      write.remove(this.$items, id);
    });
  }
}

/** One message of the server's update stream. */
export const PositionUpdate = Schema.Union([
  Schema.Struct({ type: Schema.Literal("upsert"), position: Position }),
  Schema.Struct({ type: Schema.Literal("delete"), id: Schema.String }),
]);

// The sample positions as the server sends them, with decimals and dates as strings.

export type PositionJson = Record<string, unknown>;

const positionJson = (overrides: PositionJson = {}): PositionJson => ({
  id: "position-42",
  account: "account-7",
  isShort: false,
  collateralTicker: "USDT",
  baseTicker: "BTC",
  quoteTicker: "USDT",
  collateral: "100.25",
  size: "0.0016",
  entryPrice: "62000",
  leverage: 2,
  status: "open",
  openedAt: "2026-08-25T08:01:00.000Z",
  nextFundingAt: "2026-08-26T08:01:00.000Z",
  nextFundingFee: "0.1",
  ...overrides,
});

export const livePositionJson = (overrides: PositionJson = {}): PositionJson =>
  positionJson({
    collateral: "120",
    size: "2",
    entryPrice: "100",
    openFee: "0.25",
    closeFee: "0.25",
    nextFundingFee: "0.25",
    estimate: { profit: "999", accruedFunding: "0.25" },
    ...overrides,
  });

/** The first response of the positions endpoint: two live positions and a closed one. */
export const positionsJson = {
  items: [
    livePositionJson({ id: "position-long" }),
    livePositionJson({
      id: "position-short",
      isShort: true,
      entryPrice: "104",
      openedAt: "2026-08-27T15:20:00.000Z",
      nextFundingAt: "2026-08-28T15:20:00.000Z",
    }),
    positionJson({
      id: "position-closed",
      status: "closed",
      entryPrice: "96",
      closedAt: "2026-08-30T11:45:00.000Z",
      settlement: { profit: "41.37", percent: "41.27", payout: "141.62" },
    }),
  ],
};

/** One message of the rate feed, with a spread around the price. */
export const ratesJson = (price: number): Rates => ({
  BTC: { USDT: { price, bid: price - 0.5, ask: price + 0.5 } },
});
