import type { LogEntry } from "../src/transport.ts";

interface OraclePair {
  readonly symbol: string;
  readonly baseCurrency: string;
  readonly termsCurrency: string;
  readonly pricePrecision: number;
}

interface OraclePrice {
  readonly symbol: string;
  readonly bid: string;
  readonly ask: string;
  readonly time: string;
}

interface OracleState {
  readonly pair: OraclePair | null;
  readonly prices: {
    readonly current: OraclePrice | null;
    readonly previous: OraclePrice | null;
    readonly error: string | null;
  };
  readonly trades: ReadonlyArray<OracleTrade>;
  readonly execution: "idle" | "pending" | "done" | "rejected" | "timed out";
}

interface OracleTrade {
  readonly id: string;
  readonly symbol: string;
  readonly direction: string;
  readonly notional: string;
  readonly rate: string;
  readonly status: "pending" | "done" | "rejected";
  readonly desk: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** An independent wire-log fold: no client decoder, reducer, or Pinna. */
export function foldLog(
  log: ReadonlyArray<LogEntry>,
  nowMilliseconds = Date.parse(log.at(-1)?.time ?? "1970-01-01T00:00:00.000Z"),
): OracleState {
  let state: OracleState = {
    pair: null,
    prices: { current: null, previous: null, error: null },
    trades: [],
    execution: "idle",
  };
  const trades = new Map<string, OracleTrade>();
  let request: { readonly id: string; readonly time: number } | undefined;
  let resetAt = Number.POSITIVE_INFINITY;
  const advance = (time: number) => {
    if (request !== undefined && state.execution === "pending" && time >= request.time + 2000) {
      trades.delete(request.id);
      state = { ...state, execution: "timed out" };
      resetAt = request.time + 5000;
    }
    if (time >= resetAt) {
      state = { ...state, execution: "idle" };
      resetAt = Number.POSITIVE_INFINITY;
    }
  };
  const receive = (trade: OracleTrade, optimistic = false) => {
    const previous = trades.get(trade.id);
    if (
      previous &&
      (Date.parse(previous.updatedAt) > Date.parse(trade.updatedAt) ||
        (previous.status !== "pending" && trade.status === "pending"))
    )
      return;
    if (trade.desk === "local" && trade.status === "rejected") {
      trades.delete(trade.id);
    } else if (!(trade.desk === "local" && trade.status === "pending" && !previous && !optimistic))
      trades.set(trade.id, trade);
  };
  for (const entry of log) {
    const time = Date.parse(entry.time);
    advance(time);
    if (
      entry.direction === "client-to-exchange" &&
      entry.kind === "request" &&
      entry.address === "/execute"
    ) {
      const payload = JSON.parse(entry.raw);
      request = { id: payload.id, time };
      resetAt = Number.POSITIVE_INFINITY;
      state = { ...state, execution: "pending" };
      receive(
        {
          ...payload,
          desk: "local",
          status: "pending",
          createdAt: entry.time,
          updatedAt: entry.time,
        },
        true,
      );
    }
    if (entry.direction !== "exchange-to-client") continue;
    if (entry.kind === "response" && entry.address === "/trades") {
      for (const trade of JSON.parse(entry.raw) as Array<OracleTrade>) receive(trade);
    }
    if (entry.kind === "trade") receive(JSON.parse(entry.raw));
    if (
      entry.kind === "response" &&
      entry.address === "/execute" &&
      state.execution === "pending"
    ) {
      const trade: OracleTrade = JSON.parse(entry.raw);
      receive(trade);
      state = { ...state, execution: trade.status === "done" ? "done" : "rejected" };
      resetAt = time + 3000;
    }
    if (entry.kind === "error" && entry.address === "/execute" && state.execution === "pending") {
      if (request) {
        trades.delete(request.id);
      }
      state = { ...state, execution: "rejected" };
      resetAt = time + 3000;
    }
    if (entry.kind === "response" && entry.address === "/pairs") {
      const pairs: Array<OraclePair> = JSON.parse(entry.raw);
      state = { ...state, pair: pairs[0] ?? null };
    }
    if (entry.kind === "price" && entry.address === "prices/EURUSD") {
      const current: OraclePrice = JSON.parse(entry.raw);
      state = {
        ...state,
        prices: { current, previous: state.prices.current, error: null },
      };
    }
  }
  advance(nowMilliseconds);
  return {
    ...state,
    trades: [...trades.values()].sort(
      (left, right) =>
        (right.createdAt < left.createdAt ? -1 : right.createdAt > left.createdAt ? 1 : 0) ||
        (left.id < right.id ? 1 : left.id > right.id ? -1 : 0),
    ),
  };
}

export interface OracleView {
  readonly sort: {
    readonly column: "time" | "pair" | "direction" | "notional" | "rate" | "status" | "desk";
    readonly direction: "ascending" | "descending";
  };
  readonly filter: string;
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly selection: readonly string[];
}

/** Deliberately slow: materialize, filter, sort, slice; share no index code with the client. */
export function foldBlotter(log: readonly LogEntry[], view: OracleView, nowMilliseconds?: number) {
  const trades = foldLog(log, nowMilliseconds).trades;
  const decimal = (value: string) => {
    const [whole = "0", fraction = ""] = value.split(".");
    return { integer: BigInt(whole + fraction), places: fraction.length };
  };
  const compareDecimal = (left: string, right: string) => {
    const first = decimal(left);
    const second = decimal(right);
    const difference =
      first.integer * 10n ** BigInt(second.places) - second.integer * 10n ** BigInt(first.places);
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  };
  const text = (left: string, right: string) => (left === right ? 0 : left < right ? -1 : 1);
  const matching = trades.filter((trade) =>
    [
      trade.createdAt.slice(11, 23),
      trade.symbol,
      trade.direction,
      trade.notional,
      trade.rate,
      trade.status,
      trade.desk,
    ].some((value) => value.toLowerCase().includes(view.filter.toLowerCase())),
  );
  const field = (trade: OracleTrade) =>
    view.sort.column === "time"
      ? trade.createdAt
      : view.sort.column === "pair"
        ? trade.symbol
        : trade[view.sort.column];
  matching.sort((left, right) => {
    const order =
      view.sort.column === "notional" || view.sort.column === "rate"
        ? compareDecimal(field(left), field(right))
        : text(field(left), field(right));
    return (
      order * (view.sort.direction === "ascending" ? 1 : -1) ||
      text(right.createdAt, left.createdAt) ||
      text(right.id, left.id)
    );
  });
  const scrollTop = Math.min(
    view.scrollTop,
    Math.max(0, matching.length * 36 - view.viewportHeight),
  );
  const start = Math.max(0, Math.floor(scrollTop / 36) - 3);
  const end =
    view.viewportHeight === 0
      ? start
      : Math.min(matching.length, Math.ceil((scrollTop + view.viewportHeight) / 36) + 3);
  const selected = trades.filter((trade) => view.selection.includes(trade.id));
  const total = (direction: string) => {
    const amounts = selected
      .filter((trade) => trade.direction === direction)
      .map((trade) => decimal(trade.notional));
    const places = Math.max(0, ...amounts.map((amount) => amount.places));
    const sum = amounts
      .reduce((sum, amount) => sum + amount.integer * 10n ** BigInt(places - amount.places), 0n)
      .toString()
      .padStart(places + 1, "0");
    return places === 0 ? sum : `${sum.slice(0, -places)}.${sum.slice(-places)}`;
  };
  return {
    heldCount: trades.length,
    matchingCount: matching.length,
    window: {
      start,
      count: matching.length,
      ids: matching.slice(start, end).map((trade) => trade.id),
    },
    selectionSummary: { count: selected.length, buy: total("buy"), sell: total("sell") },
  };
}

export function oracleDisplay(state: OracleState) {
  const { current, previous, error } = state.prices;
  if (current === null) {
    return { bid: "—", ask: "—", spreadPips: "—", movement: "unchanged", error };
  }
  // Different arithmetic from the client: integer points and ordinary numbers.
  const points = (decimal: string) => Math.round(Number(decimal) * 100000);
  const movement =
    previous === null
      ? 0
      : points(current.bid) + points(current.ask) - points(previous.bid) - points(previous.ask);
  return {
    bid: current.bid,
    ask: current.ask,
    spreadPips: ((points(current.ask) - points(current.bid)) / 10).toFixed(1),
    movement: movement > 0 ? "up" : movement < 0 ? "down" : "unchanged",
    error,
  };
}

interface Exact {
  readonly numerator: bigint;
  readonly denominator: bigint;
}
function exact(numerator: bigint, denominator = 1n): Exact {
  if (denominator < 0n) return exact(-numerator, -denominator);
  let divisor = numerator < 0n ? -numerator : numerator;
  let remainder = denominator;
  while (remainder !== 0n) [divisor, remainder] = [remainder, divisor % remainder];
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}
const plus = (left: Exact, right: Exact) =>
  exact(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
const times = (left: Exact, right: Exact) =>
  exact(left.numerator * right.numerator, left.denominator * right.denominator);
const quotient = (left: Exact, right: Exact) =>
  exact(left.numerator * right.denominator, left.denominator * right.numerator);
const amount = (value: string) => {
  const parts = value.split(".");
  return exact(BigInt(parts.join("")), 10n ** BigInt(parts[1]?.length ?? 0));
};

/** Plain prefix fold. No client imports; rebuild aggregates from held done trades on every read. */
interface PositionObservation {
  readonly open: readonly string[];
  readonly shown: boolean;
}
export class PositionOracle {
  private prefix = 0;
  private readonly trades = new Map<string, OracleTrade>();
  private readonly prices = new Map<string, OraclePrice>();
  private pairs: readonly OraclePair[] = [];
  advance(log: readonly LogEntry[], observation?: PositionObservation) {
    for (; this.prefix < log.length; this.prefix++) {
      const entry = log[this.prefix];
      if (!entry) continue;
      const receive = (trade: OracleTrade, optimistic = false) => {
        const previous = this.trades.get(trade.id);
        if (
          previous &&
          (previous.updatedAt > trade.updatedAt ||
            (previous.status !== "pending" && trade.status === "pending"))
        )
          return;
        if (trade.desk === "local" && trade.status === "rejected") this.trades.delete(trade.id);
        else if (previous || trade.desk !== "local" || trade.status !== "pending" || optimistic)
          this.trades.set(trade.id, trade);
      };
      if (
        entry.direction === "client-to-exchange" &&
        entry.kind === "request" &&
        entry.address === "/execute"
      ) {
        receive(
          {
            ...JSON.parse(entry.raw),
            status: "pending",
            desk: "local",
            createdAt: entry.time,
            updatedAt: entry.time,
          },
          true,
        );
      }
      if (entry.kind === "unsubscribe" && entry.address.startsWith("prices/"))
        this.prices.delete(entry.address.slice(7));
      if (entry.direction !== "exchange-to-client") continue;
      if (entry.kind === "response" && entry.address === "/pairs")
        this.pairs = JSON.parse(entry.raw);
      if (entry.kind === "response" && entry.address === "/trades")
        for (const trade of JSON.parse(entry.raw)) receive(trade);
      if (entry.kind === "trade" || (entry.kind === "response" && entry.address === "/execute"))
        receive(JSON.parse(entry.raw));
      if (entry.kind === "price") {
        const price: OraclePrice = JSON.parse(entry.raw);
        this.prices.set(price.symbol, price);
      }
    }
    return this.snapshot(observation);
  }
  private snapshot(observation?: PositionObservation) {
    // Scale all notionals together; rates use five places (JPY's three are padded).
    const trades = [...this.trades.values()].filter((trade) => trade.status === "done");
    // Visibility drops demand synchronously, before the transport logs async cleanup.
    // A panel also owns the marks and dollar converters for its held positions.
    const needed = new Set(observation?.open ?? this.pairs.map((pair) => pair.symbol));
    if (observation?.shown) {
      for (const trade of trades) {
        needed.add(trade.symbol);
        const pair = this.pairs.find((pair) => pair.symbol === trade.symbol);
        if (pair?.termsCurrency === "GBP") needed.add("GBPUSD");
        if (pair?.termsCurrency === "JPY") needed.add("USDJPY");
      }
    }
    const livePrice = (symbol: string) =>
      needed.has(symbol) ? this.prices.get(symbol) : undefined;
    const places = trades.reduce(
      (maximum, trade) => Math.max(maximum, trade.notional.split(".")[1]?.length ?? 0),
      0,
    );
    const scale = 10n ** BigInt(places);
    const aggregates = new Map<string, { net: bigint; cost: bigint }>();
    for (const trade of trades) {
      const [whole = "0", fraction = ""] = trade.notional.split(".");
      const signed =
        BigInt(whole + fraction.padEnd(places, "0")) * (trade.direction === "buy" ? 1n : -1n);
      const [rateWhole = "0", rateFraction = ""] = trade.rate.split(".");
      const aggregate = aggregates.get(trade.symbol) ?? { net: 0n, cost: 0n };
      aggregate.net += signed;
      aggregate.cost += signed * BigInt(rateWhole + rateFraction.padEnd(5, "0"));
      aggregates.set(trade.symbol, aggregate);
    }
    const mid = (symbol: string) => {
      const price = livePrice(symbol);
      return price ? quotient(plus(amount(price.bid), amount(price.ask)), exact(2n)) : null;
    };
    const positions = this.pairs.flatMap((pair) => {
      const aggregate = aggregates.get(pair.symbol);
      if (!aggregate) return [];
      const net = exact(aggregate.net, scale);
      const cost = exact(aggregate.cost, scale * 100000n);
      const mark = mid(pair.symbol);
      const profitLoss = mark
        ? plus(times(net, mark), exact(-cost.numerator, cost.denominator))
        : null;
      const conversion =
        pair.termsCurrency === "GBP"
          ? mid("GBPUSD")
          : pair.termsCurrency === "JPY"
            ? mid("USDJPY")
            : exact(1n);
      const converted =
        profitLoss && conversion
          ? pair.termsCurrency === "JPY"
            ? quotient(profitLoss, conversion)
            : times(profitLoss, conversion)
          : null;
      let dollars: bigint | null = null;
      if (converted) {
        const absolute =
          (converted.numerator < 0n ? -converted.numerator : converted.numerator) * 100n;
        const integer = absolute / converted.denominator;
        const comparison = (absolute % converted.denominator) * 2n - converted.denominator;
        dollars =
          (integer + BigInt(comparison > 0n || (comparison === 0n && integer % 2n === 1n))) *
          (converted.numerator < 0n ? -1n : 1n);
      }
      return [
        {
          symbol: pair.symbol,
          net,
          average: net.numerator === 0n ? null : quotient(cost, net),
          mark,
          profitLoss,
          dollars,
        },
      ];
    });
    return {
      prices: Object.fromEntries(
        this.pairs.map((pair) => [pair.symbol, livePrice(pair.symbol) ?? null]),
      ),
      positions,
      total: {
        cents: positions.reduce((sum, row) => sum + (row.dollars ?? 0n), 0n),
        complete: positions.every((row) => row.dollars !== null),
      },
    };
  }
}
export const foldPositions = (log: readonly LogEntry[], observation?: PositionObservation) =>
  new PositionOracle().advance(log, observation);
