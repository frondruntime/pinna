/**
 * The wire: what a server sends, generated from a seed so every variant and
 * every round decodes the same bytes. Decimals travel as strings and dates
 * as ISO strings, as a typical trading API sends them.
 */

export type Status = "active" | "halted" | "delisted";

interface WireNetwork {
  readonly network: string;
  readonly name: string;
  readonly contract: string;
  readonly decimals: number;
}

interface WireLimits {
  readonly min: string;
  readonly max: string;
}

interface WirePoint {
  readonly at: string;
  readonly price: string;
}

export interface WireRow {
  readonly id: string;
  readonly ticker: string;
  readonly name: string;
  readonly status: Status;
  readonly tags: ReadonlyArray<string>;
  readonly price: string;
  readonly diff24: string;
  readonly volume: string;
  readonly updatedAt: string;
  readonly listedAt: string;
  readonly network: WireNetwork;
  readonly limits: WireLimits;
  readonly history: ReadonlyArray<WirePoint>;
}

export interface WireTick {
  readonly id: string;
  readonly price: string;
  readonly diff24: string;
  readonly updatedAt: string;
}

/** The clock the data is generated against, so relative times never drift. */
export const now = Date.UTC(2026, 10, 7, 12, 0, 0);
const historyLength = 12;
/** The rows on screen at the top of the list: every tick moves them. */
const visibleRows = 10;

const networks = ["ethereum", "tron", "solana", "bitcoin", "polygon", "arbitrum"] as const;
const tagPool = ["defi", "layer1", "layer2", "meme", "stable", "gaming", "ai", "rwa"] as const;
const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** mulberry32: small, fast, and the same on every engine. */
const random = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};

const pick = <Item>(next: () => number, items: ReadonlyArray<Item>): Item =>
  items[Math.floor(next() * items.length)] as Item;

const decimal = (value: number, places: number): string => value.toFixed(places);

const iso = (time: number): string => new Date(time).toISOString();

const tickerOf = (index: number): string => {
  let rest = index;
  let ticker = "";
  for (let place = 0; place < 4; place++) {
    ticker = letters[rest % 26] + ticker;
    rest = Math.floor(rest / 26);
  }
  return ticker;
};

const historyOf = (next: () => number, price: number, end: number): Array<WirePoint> => {
  const points: Array<WirePoint> = [];
  let value = price;
  for (let index = historyLength - 1; index >= 0; index--) {
    value = value * (0.97 + next() * 0.06);
    points.push({ at: iso(end - index * 3_600_000), price: decimal(value, 8) });
  }
  return points;
};

const makeRow = (next: () => number, index: number): WireRow => {
  const price = 0.01 + next() * 60_000;
  const updatedAt = now - Math.floor(next() * 600_000);
  const tagCount = 1 + Math.floor(next() * 3);
  const tags: Array<string> = [];
  for (let tag = 0; tag < tagCount; tag++) {
    tags.push(pick(next, tagPool));
  }
  const network = pick(next, networks);
  return {
    id: `instrument-${index}`,
    ticker: tickerOf(index),
    name: `Instrument ${index}`,
    status: next() < 0.9 ? "active" : next() < 0.5 ? "halted" : "delisted",
    tags,
    price: decimal(price, 8),
    diff24: decimal(price * (next() * 0.2 - 0.1), 8),
    volume: decimal(next() * 1e10, 2),
    updatedAt: iso(updatedAt),
    listedAt: iso(now - Math.floor(next() * 3e11)),
    network: {
      network,
      name: `${network} mainnet`,
      contract: `0x${Math.floor(next() * 2 ** 48)
        .toString(16)
        .padStart(12, "0")}`,
      decimals: pick(next, [6, 8, 18]),
    },
    limits: { min: decimal(next() * 10, 4), max: decimal(1000 + next() * 1e6, 2) },
    history: historyOf(next, price, updatedAt),
  };
};

export const makeRows = (count: number, seed: number, firstIndex = 0): Array<WireRow> => {
  const next = random(seed);
  const rows: Array<WireRow> = [];
  for (let index = 0; index < count; index++) {
    rows.push(makeRow(next, firstIndex + index));
  }
  return rows;
};

/** A share of rows, chosen by the seed, always including the rows on screen. */
const chosen = (next: () => number, count: number, share: number): Set<number> => {
  const picked = new Set<number>();
  for (let index = 0; index < Math.min(visibleRows, count); index++) {
    picked.add(index);
  }
  const wanted = Math.max(picked.size, Math.round(count * share));
  while (picked.size < wanted) {
    picked.add(Math.floor(next() * count));
  }
  return picked;
};

/**
 * A refetch of the same list: `changed` of the rows have new top-level values
 * (price, change, volume, time, status), `added` new rows arrive at the top,
 * and `removed` rows are gone.
 */
export const makeRefetch = (rows: ReadonlyArray<WireRow>, seed: number): Array<WireRow> => {
  const next = random(seed);
  const changed = chosen(next, rows.length, 0.05);
  const removed = new Set<number>();
  const removing = Math.round(rows.length * 0.01);
  while (removed.size < removing) {
    const index = visibleRows + Math.floor(next() * (rows.length - visibleRows));
    if (!changed.has(index)) {
      removed.add(index);
    }
  }
  const result: Array<WireRow> = makeRows(Math.round(rows.length * 0.01), seed + 1, rows.length);
  rows.forEach((row, index) => {
    if (removed.has(index)) {
      return;
    }
    if (!changed.has(index)) {
      result.push(row);
      return;
    }
    const price = Number(row.price) * (0.98 + next() * 0.04);
    result.push({
      ...row,
      price: decimal(price, 8),
      diff24: decimal(price * (next() * 0.2 - 0.1), 8),
      volume: decimal(next() * 1e10, 2),
      updatedAt: iso(now + Math.floor(next() * 60_000)),
      status: next() < 0.95 ? row.status : "halted",
    });
  });
  return result;
};

/**
 * A refetch whose changes are nested: a renamed network, a new upper limit,
 * and a new history point that pushes the oldest out. Top-level values stay.
 */
export const makeDeepRefetch = (rows: ReadonlyArray<WireRow>, seed: number): Array<WireRow> => {
  const next = random(seed);
  const changed = chosen(next, rows.length, 0.05);
  return rows.map((row, index) => {
    if (!changed.has(index)) {
      return row;
    }
    const last = row.history[row.history.length - 1] as WirePoint;
    return {
      ...row,
      network: { ...row.network, name: `${row.network.network} v${1 + Math.floor(next() * 9)}` },
      limits: { ...row.limits, max: decimal(1000 + next() * 1e6, 2) },
      history: [
        ...row.history.slice(1),
        {
          at: iso(Date.parse(last.at) + 3_600_000),
          price: decimal(Number(last.price) * (0.97 + next() * 0.06), 8),
        },
      ],
    };
  });
};

/** `count` ticks of `perTick` price updates each, as a socket sends them. */
export const makeTicks = (
  rows: ReadonlyArray<WireRow>,
  count: number,
  perTick: number,
  seed: number,
): Array<Array<WireTick>> => {
  const next = random(seed);
  const ticks: Array<Array<WireTick>> = [];
  const prices = rows.map((row) => Number(row.price));
  for (let tick = 0; tick < count; tick++) {
    const updates: Array<WireTick> = [];
    for (const index of chosen(next, rows.length, perTick / rows.length)) {
      const price = (prices[index] as number) * (0.999 + next() * 0.002);
      prices[index] = price;
      updates.push({
        id: (rows[index] as WireRow).id,
        price: decimal(price, 8),
        diff24: decimal(price * (next() * 0.2 - 0.1), 8),
        updatedAt: iso(now + tick * 1000),
      });
    }
    ticks.push(updates);
  }
  return ticks;
};

/** Ids of `count` rows below the screen, chosen by the seed. */
export const pickRemovals = (
  rows: ReadonlyArray<WireRow>,
  count: number,
  seed: number,
): Array<string> => {
  const next = random(seed);
  const picked = new Set<number>();
  while (picked.size < count) {
    picked.add(visibleRows + Math.floor(next() * (rows.length - visibleRows)));
  }
  return [...picked].map((index) => (rows[index] as WireRow).id);
};
