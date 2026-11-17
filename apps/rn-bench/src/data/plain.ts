/**
 * The rows as plain values: big.js decimals and dates, converted from the
 * wire once by the harness and timed apart from every store. Each store
 * builds its own model from these, so the store column measures the library
 * and not the conversion. Every store compares rows with the functions here,
 * so a merge measures the library and not its equality code.
 */
import Big from "big.js";
import type { Status, WireRow, WireTick } from "./wire.ts";

export interface PlainNetwork {
  readonly network: string;
  readonly name: string;
  readonly contract: string;
  readonly decimals: number;
}

export interface PlainLimits {
  readonly min: Big;
  readonly max: Big;
}

export interface PlainPoint {
  readonly at: Date;
  readonly price: Big;
}

/** What a tick writes: the fields each library holds as its own observable. */
export interface PlainTick {
  readonly id: string;
  readonly price: Big;
  readonly diff24: Big;
  readonly updatedAt: Date;
}

/** What a row holds besides the fields a tick writes. */
export interface PlainRest {
  readonly id: string;
  readonly ticker: string;
  readonly name: string;
  readonly status: Status;
  readonly tags: ReadonlyArray<string>;
  readonly volume: Big;
  readonly listedAt: Date;
  readonly network: PlainNetwork;
  readonly limits: PlainLimits;
  readonly history: ReadonlyArray<PlainPoint>;
}

export interface PlainRow extends PlainRest, PlainTick {}

const toRow = (wire: WireRow): PlainRow => ({
  id: wire.id,
  ticker: wire.ticker,
  name: wire.name,
  status: wire.status,
  tags: wire.tags,
  price: new Big(wire.price),
  diff24: new Big(wire.diff24),
  volume: new Big(wire.volume),
  updatedAt: new Date(wire.updatedAt),
  listedAt: new Date(wire.listedAt),
  network: wire.network,
  limits: { min: new Big(wire.limits.min), max: new Big(wire.limits.max) },
  history: wire.history.map((point) => ({ at: new Date(point.at), price: new Big(point.price) })),
});

/** Parsed wire rows as plain rows. Trusts the wire: it checks nothing. */
export const toPlainRows = (json: unknown): ReadonlyArray<PlainRow> =>
  (json as ReadonlyArray<WireRow>).map(toRow);

export const toPlainTicks = (json: unknown): ReadonlyArray<PlainTick> =>
  (json as ReadonlyArray<WireTick>).map((tick) => ({
    id: tick.id,
    price: new Big(tick.price),
    diff24: new Big(tick.diff24),
    updatedAt: new Date(tick.updatedAt),
  }));

export const equalBig = (previous: Big, next: Big): boolean => previous.eq(next);

export const equalDate = (previous: Date, next: Date): boolean =>
  previous.getTime() === next.getTime();

export const equalNetwork = (previous: PlainNetwork, next: PlainNetwork): boolean =>
  previous.network === next.network &&
  previous.name === next.name &&
  previous.contract === next.contract &&
  previous.decimals === next.decimals;

export const equalLimits = (previous: PlainLimits, next: PlainLimits): boolean =>
  previous.min.eq(next.min) && previous.max.eq(next.max);

export const equalHistory = (
  previous: ReadonlyArray<PlainPoint>,
  next: ReadonlyArray<PlainPoint>,
): boolean =>
  previous.length === next.length &&
  previous.every(
    (point, index) =>
      equalDate(point.at, (next[index] as PlainPoint).at) &&
      point.price.eq((next[index] as PlainPoint).price),
  );

export const equalTags = (previous: ReadonlyArray<string>, next: ReadonlyArray<string>): boolean =>
  previous.length === next.length && previous.every((tag, index) => tag === next[index]);

/** Two rows agree on every field a tick does not write. */
export const sameRest = (previous: PlainRest, next: PlainRest): boolean =>
  previous.ticker === next.ticker &&
  previous.name === next.name &&
  previous.status === next.status &&
  equalTags(previous.tags, next.tags) &&
  equalBig(previous.volume, next.volume) &&
  equalDate(previous.listedAt, next.listedAt) &&
  equalNetwork(previous.network, next.network) &&
  equalLimits(previous.limits, next.limits) &&
  equalHistory(previous.history, next.history);
