/**
 * Formatting every variant shares, so a difference in time is the state
 * layer's and not the formatter's. The shapes are a market-stats screen's:
 * fixed decimals, a signed percent, market-cap units.
 */
import Big from "big.js";
import type { PlainLimits, PlainNetwork, PlainPoint } from "./plain.ts";
import type { Status } from "./wire.ts";
import { now } from "./wire.ts";

const grouping = /\B(?=(\d{3})+(?!\d))/g;

export const fixed = (value: Big, places: number): string => {
  const [whole, fraction] = value.toFixed(places).split(".");
  const grouped = (whole as string).replace(grouping, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
};

const zero = new Big(0);
const hundred = new Big(100);

export const percent = (price: Big, diff24: Big): string => {
  const before = price.minus(diff24);
  const ratio = before.eq(zero) ? zero : diff24.div(before);
  return `${ratio.gte(zero) ? "+" : "-"}${fixed(ratio.abs().times(hundred), 2)}%`;
};

const units = [
  { divisor: new Big("1000000000"), suffix: "Bn" },
  { divisor: new Big("1000000"), suffix: "M" },
  { divisor: new Big("1000"), suffix: "K" },
] as const;

export const compact = (value: Big): string => {
  const unit = units.find((item) => value.abs().gte(item.divisor));
  return unit === undefined
    ? fixed(value, 2)
    : `${fixed(value.div(unit.divisor), 2)} ${unit.suffix}`;
};

export const ago = (date: Date): string => {
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
};

export const day = (date: Date): string => date.toISOString().slice(0, 10);

export const statusLabel = (status: Status): string =>
  status === "active" ? "Trading" : status === "halted" ? "Halted" : "Delisted";

/** What a row shows, from the values a store holds for it. */
export interface RowValues {
  readonly ticker: string;
  readonly name: string;
  readonly status: Status;
  readonly price: Big;
  readonly diff24: Big;
  readonly volume: Big;
  readonly updatedAt: Date;
}

export interface RowTexts {
  readonly ticker: string;
  readonly name: string;
  readonly price: string;
  readonly change: string;
  readonly volume: string;
  readonly updated: string;
  readonly status: string;
}

/**
 * The row's texts. Every variant formats in the component's read, so no
 * store holds a computed value per row and the formatting costs the same.
 */
export const rowTexts = (row: RowValues): RowTexts => ({
  ticker: row.ticker,
  name: row.name,
  price: fixed(row.price, 2),
  change: percent(row.price, row.diff24),
  volume: compact(row.volume),
  updated: ago(row.updatedAt),
  status: statusLabel(row.status),
});

export interface DetailsValues extends RowValues {
  readonly listedAt: Date;
  readonly tags: ReadonlyArray<string>;
  readonly network: PlainNetwork;
  readonly limits: PlainLimits;
}

export interface DetailsTexts extends RowTexts {
  readonly listed: string;
  readonly tags: string;
  readonly network: string;
  readonly contract: string;
  readonly decimals: string;
  readonly limits: string;
}

export const detailsTexts = (row: DetailsValues): DetailsTexts => ({
  ...rowTexts(row),
  listed: day(row.listedAt),
  tags: row.tags.join(", "),
  network: row.network.name,
  contract: row.network.contract,
  decimals: String(row.network.decimals),
  limits: `${fixed(row.limits.min, 4)} – ${fixed(row.limits.max, 2)}`,
});

export interface PointText {
  readonly at: string;
  readonly price: string;
}

export const historyTexts = (history: ReadonlyArray<PlainPoint>): ReadonlyArray<PointText> =>
  history.map((point) => ({
    at: point.at.toISOString().slice(0, 16),
    price: fixed(point.price, 2),
  }));
