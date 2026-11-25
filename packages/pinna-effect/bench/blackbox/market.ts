/**
 * A trading app's state, built only from the public API: markets with live
 * prices, positions priced from them, balances, and chart series. The wire is plain
 * JSON, as a REST snapshot or a socket message would carry it.
 */

import { Schema } from "effect";
import { Computed, Model, type Read, type Write } from "../../src/index.ts";

export class Market extends Model.Schema<Market>("Market")({
  id: Schema.String,
  base: Schema.String,
  quote: Schema.String,
  decimals: Schema.Number,
  $price: Model.boxField(Schema.Number),
  $open: Model.boxField(Schema.Number),
  $volume: Model.boxField(Schema.Number),
  $bid: Model.boxField(Schema.Number),
  $ask: Model.boxField(Schema.Number),
  $favorite: Model.boxField(Schema.Boolean),
}) {
  readonly $change = Computed.make(this.realm, (read) => {
    const open = read(this.$open);
    return open === 0 ? 0 : (read(this.$price) - open) / open;
  });
  readonly $priceText = Computed.make(this.realm, (read) =>
    read(this.$price).toFixed(this.decimals),
  );
  readonly $changeText = Computed.make(this.realm, (read) => {
    const change = read(this.$change) * 100;
    return `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
  });
  readonly $spread = Computed.make(this.realm, (read) => read(this.$ask) - read(this.$bid));
}

export class Markets extends Model.Schema<Markets>("Markets")({
  $items: Model.collectionField(Market, { keyOf: (market) => market.id }),
}) {}

export class Position extends Model.Schema<Position>("Position")({
  id: Schema.String,
  market: Schema.String,
  $amount: Model.boxField(Schema.Number),
  entry: Schema.Number,
}) {}

export class Portfolio extends Model.Schema<Portfolio>("Portfolio")({
  $positions: Model.collectionField(Position, { keyOf: (position) => position.id }),
}) {}

/** A chart candle: plain data, the way a chart series holds it. */
export const Candle = Schema.Struct({
  time: Schema.Number,
  open: Schema.Number,
  high: Schema.Number,
  low: Schema.Number,
  close: Schema.Number,
  volume: Schema.Number,
});
export type Candle = typeof Candle.Type;

/** A chart series as one box of candles. */
export class Series extends Model.Schema<Series>("Series")({
  market: Schema.String,
  $candles: Model.boxField(Schema.Array(Candle)),
}) {}

/** A chart candle as a row with boxes, for a series kept as a collection. */
export class CandleRow extends Model.Schema<CandleRow>("CandleRow")({
  time: Schema.Number,
  open: Schema.Number,
  $high: Model.boxField(Schema.Number),
  $low: Model.boxField(Schema.Number),
  $close: Model.boxField(Schema.Number),
  $volume: Model.boxField(Schema.Number),
}) {}

export class RowSeries extends Model.Schema<RowSeries>("RowSeries")({
  market: Schema.String,
  $candles: Model.collectionField(CandleRow, { keyOf: (candle) => candle.time }),
}) {}

export class Balance extends Model.Schema<Balance>("Balance")({
  token: Schema.String,
  $amount: Model.boxField(Schema.Number),
}) {}

export class Balances extends Model.Schema<Balances>("Balances")({
  $items: Model.collectionField(Balance, { keyOf: (balance) => balance.token }),
}) {}

export const candleAt = (time: number, price: number, random: () => number): Candle => {
  const close = price * (0.995 + random() * 0.01);
  return {
    time,
    open: price,
    high: Math.max(price, close) * (1 + random() * 0.002),
    low: Math.min(price, close) * (1 - random() * 0.002),
    close,
    volume: random() * 1e6,
  };
};

export const candlesWire = (count: number, random: () => number): Array<Candle> => {
  const candles: Array<Candle> = [];
  let price = 100;
  for (let index = 0; index < count; index++) {
    const candle = candleAt(index * 900, price, random);
    candles.push(candle);
    price = candle.close;
  }
  return candles;
};

export interface MarketWire {
  readonly id: string;
  readonly base: string;
  readonly quote: string;
  readonly decimals: number;
  readonly price: number;
  readonly open: number;
  readonly volume: number;
  readonly bid: number;
  readonly ask: number;
  readonly favorite: boolean;
}

const marketWire = (index: number, random: () => number): MarketWire => {
  const price = 0.01 + random() * 50_000;
  return {
    id: `M${index}`,
    base: `B${index}`,
    quote: index % 3 === 0 ? "USDT" : "USD",
    decimals: price < 1 ? 6 : price < 100 ? 4 : 2,
    price,
    open: price * (0.9 + random() * 0.2),
    volume: random() * 1e9,
    bid: price * 0.999,
    ask: price * 1.001,
    favorite: index % 25 === 0,
  };
};

export const marketsWire = (count: number, random: () => number): { items: Array<MarketWire> } => {
  const items: Array<MarketWire> = [];
  for (let index = 0; index < count; index++) {
    items.push(marketWire(index, random));
  }
  return { items };
};

/** A ticker message: a new price, bid, ask and volume for one market. */
export const tick = (read: Read, write: Write, market: Market, random: () => number): void => {
  const price = read(market.$price) * (0.995 + random() * 0.01);
  write(market.$price, price);
  write(market.$bid, price * 0.999);
  write(market.$ask, price * 1.001);
  write(market.$volume, read(market.$volume) + random() * 1000);
};
