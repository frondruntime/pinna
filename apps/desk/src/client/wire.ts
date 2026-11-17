import { Schema } from "effect";

export const symbols = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "EURGBP"] as const;
export const PairSymbol = Schema.Literals(symbols);
export type PairSymbol = typeof PairSymbol.Type;
export const Pair = Schema.Struct({
  symbol: PairSymbol,
  baseCurrency: Schema.Literals(["EUR", "GBP", "USD", "AUD"]),
  termsCurrency: Schema.Literals(["USD", "JPY", "GBP"]),
  pricePrecision: Schema.Literals([3, 5]),
}).check(
  Schema.makeFilter(
    (pair) =>
      pair.symbol === pair.baseCurrency + pair.termsCurrency &&
      pair.pricePrecision === (pair.symbol === "USDJPY" ? 3 : 5),
  ),
);
export type Pair = typeof Pair.Type;

const Decimal = Schema.String.check(Schema.isPattern(/^\d+\.(?:\d{3}|\d{5})$/));
const hasPrecision = (value: { readonly symbol: PairSymbol; readonly rate: string }) =>
  value.rate.split(".")[1]?.length === (value.symbol === "USDJPY" ? 3 : 5);
const IsoTime = Schema.String.check(
  Schema.makeFilter((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value;
  }),
);

export const Price = Schema.Struct({
  symbol: PairSymbol,
  bid: Decimal,
  ask: Decimal,
  time: IsoTime,
}).check(
  Schema.makeFilter(
    (price) =>
      hasPrecision({ symbol: price.symbol, rate: price.bid }) &&
      hasPrecision({ symbol: price.symbol, rate: price.ask }) &&
      BigInt(price.bid.replace(".", "")) > 0n &&
      BigInt(price.ask.replace(".", "")) >= BigInt(price.bid.replace(".", "")),
  ),
);
export type Price = typeof Price.Type;

export const decodePairs = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(Pair).check(
      Schema.makeFilter(
        (pairs) =>
          pairs.length > 0 && new Set(pairs.map((pair) => pair.symbol)).size === pairs.length,
      ),
    ),
  ),
);
export const decodePrice = Schema.decodeUnknownEffect(Schema.fromJsonString(Price));

// Keep decimal input as text: Number would round large or very small notionals.
export const PositiveDecimal = Schema.String.check(
  Schema.isPattern(/^\d+(?:\.\d+)?$/),
  Schema.makeFilter((value) => /[1-9]/.test(value)),
);
export const isPositiveDecimal = Schema.is(PositiveDecimal);
export const ExecutionState = Schema.Literals(["idle", "pending", "done", "rejected", "timed out"]);
export type ExecutionState = typeof ExecutionState.Type;
export type Direction = "buy" | "sell";

const Identifier = Schema.String.check(Schema.isPattern(/^\S+$/));
export const Trade = Schema.Struct({
  id: Identifier,
  symbol: PairSymbol,
  direction: Schema.Literals(["buy", "sell"]),
  notional: PositiveDecimal,
  rate: Decimal.check(Schema.makeFilter((value) => /[1-9]/.test(value))),
  status: Schema.Literals(["pending", "done", "rejected"]),
  desk: Identifier,
  createdAt: IsoTime,
  updatedAt: IsoTime,
}).check(
  Schema.makeFilter(
    (trade) => hasPrecision(trade) && Date.parse(trade.updatedAt) >= Date.parse(trade.createdAt),
  ),
);
export type Trade = typeof Trade.Type;
export const decodeTrade = Schema.decodeUnknownEffect(Trade);
export const decodeTradeMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(Trade));
// Decode the envelope separately: one bad row must not discard its valid neighbors.
export const decodeTradeSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);
export const tradesEqual = Schema.toEquivalence(Trade);
