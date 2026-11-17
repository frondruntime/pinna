import { Clock, Data, Effect, Fiber, Queue, Schema, Stream } from "effect";
import { makeOrderExchange, type OrderExchangeOptions } from "./orders.ts";

class ExchangeError extends Data.TaggedError("ExchangeError")<{
  readonly message: string;
}> {}

export interface ExchangeOptions extends OrderExchangeOptions {
  readonly seed: number;
  readonly historyTradeCount?: number;
  /** Overrides per-tick probability; fractional trades carry into the next tick. */
  readonly otherDeskTradesPerSecond?: number;
  readonly intervalMilliseconds?: number;
  /** Probability of another desk placing a trade on each market tick. */
  readonly otherDeskTradeProbability?: number;
  readonly executionLatencyMilliseconds?: readonly [number, number];
  readonly rejectionProbability?: number;
  readonly longDelayProbability?: number;
  readonly longDelayMilliseconds?: number;
}

const pairs = [
  { symbol: "EURUSD", baseCurrency: "EUR", termsCurrency: "USD", pricePrecision: 5 },
  { symbol: "GBPUSD", baseCurrency: "GBP", termsCurrency: "USD", pricePrecision: 5 },
  { symbol: "USDJPY", baseCurrency: "USD", termsCurrency: "JPY", pricePrecision: 3 },
  { symbol: "AUDUSD", baseCurrency: "AUD", termsCurrency: "USD", pricePrecision: 5 },
  { symbol: "EURGBP", baseCurrency: "EUR", termsCurrency: "GBP", pricePrecision: 5 },
] as const;
// Mulberry32: order randomness and each pair's walk have independent seeded generators.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const ExecutionRequest = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^local-\d+$/)),
  symbol: Schema.Literals(["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "EURGBP"]),
  direction: Schema.Literals(["buy", "sell"]),
  notional: Schema.String.check(
    Schema.isPattern(/^\d+(?:\.\d+)?$/),
    Schema.makeFilter((value) => /[1-9]/.test(value)),
  ),
  rate: Schema.String.check(
    Schema.isPattern(/^\d+\.(?:\d{3}|\d{5})$/),
    Schema.makeFilter((value) => /[1-9]/.test(value)),
  ),
}).check(
  Schema.makeFilter(
    (request) => request.rate.split(".")[1]?.length === (request.symbol === "USDJPY" ? 3 : 5),
  ),
);
interface Trade extends Schema.Schema.Type<typeof ExecutionRequest> {
  readonly desk: string;
  readonly status: "pending" | "done" | "rejected";
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Market and accepted orders belong to the exchange scope, not its callers. */
export const makeExchange = (options: ExchangeOptions) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const intervalMilliseconds = options.intervalMilliseconds ?? 250;
    const historyTradeCount = options.historyTradeCount ?? 1000;
    const otherDeskTradesPerSecond = options.otherDeskTradesPerSecond;
    const otherDeskTradeProbability = options.otherDeskTradeProbability ?? 0.08;
    const [minimumLatency, maximumLatency] = options.executionLatencyMilliseconds ?? [100, 700];
    const rejectionProbability = options.rejectionProbability ?? 0.12;
    const longDelayProbability = options.longDelayProbability ?? 0.08;
    const longDelayMilliseconds = options.longDelayMilliseconds ?? 4000;
    if (
      !Number.isSafeInteger(intervalMilliseconds) ||
      intervalMilliseconds <= 0 ||
      !Number.isSafeInteger(historyTradeCount) ||
      historyTradeCount < 0 ||
      (otherDeskTradesPerSecond !== undefined &&
        (!Number.isFinite(otherDeskTradesPerSecond) ||
          otherDeskTradesPerSecond < 0 ||
          otherDeskTradesPerSecond > 1000)) ||
      !Number.isSafeInteger(minimumLatency) ||
      minimumLatency < 0 ||
      !Number.isSafeInteger(maximumLatency) ||
      maximumLatency < minimumLatency ||
      !Number.isSafeInteger(longDelayMilliseconds) ||
      longDelayMilliseconds <= 2000 ||
      [otherDeskTradeProbability, rejectionProbability, longDelayProbability].some(
        (probability) => !Number.isFinite(probability) || probability < 0 || probability > 1,
      )
    ) {
      return yield* Effect.fail(new ExchangeError({ message: "invalid exchange options" }));
    }
    const random = seededRandom(options.seed);
    const listeners = new Map<string, Set<(message: string) => void>>();
    listeners.set("trades", new Set());
    for (const pair of pairs) listeners.set(`prices/${pair.symbol}`, new Set());
    const trades = new Map<string, Trade>();
    const emit = (topic: string, value: unknown) => {
      const message = JSON.stringify(value);
      for (const listener of listeners.get(topic) ?? []) listener(message);
    };
    const publish = (trade: Trade) => {
      trades.set(trade.id, trade);
      emit("trades", trade);
    };
    const markets = pairs.map((pair, index) => ({
      pair,
      bidUnits: [108000, 127000, 152000, 66000, 85000][index] ?? 108000,
      spreadUnits: 10,
      interval: intervalMilliseconds + Math.max(1, Math.floor(intervalMilliseconds / 5)) * index,
      random: seededRandom(options.seed + Math.imul(index + 1, 104729)),
    }));
    const rate = (market: (typeof markets)[number], units: number) =>
      (units / 10 ** market.pair.pricePrecision).toFixed(market.pair.pricePrecision);
    let tradeSequence = 0;
    const origin = yield* Clock.currentTimeMillis;
    for (let index = 0; index < historyTradeCount; index++) {
      const created = origin - 1 - Math.floor(random() * 4 * 60 * 60 * 1000);
      const direction = random() < 0.5 ? "buy" : "sell";
      const status =
        (["pending", "done", "rejected"] as const)[Math.floor(random() * 3)] ?? "pending";
      const trade: Trade = {
        id: `trade-${++tradeSequence}`,
        symbol: markets[index % markets.length]?.pair.symbol ?? "EURUSD",
        direction,
        notional: `${1 + Math.floor(random() * 2000000)}.${Math.floor(random() * 100)
          .toString()
          .padStart(2, "0")}`,
        rate: (() => {
          const market = markets[index % markets.length] as (typeof markets)[number];
          return rate(market, market.bidUnits - 1000 + Math.floor(random() * 3000));
        })(),
        desk: `desk-${1 + Math.floor(random() * 4)}`,
        status,
        createdAt: new Date(created).toISOString(),
        updatedAt: new Date(Math.min(origin, created + Math.floor(random() * 1000))).toISOString(),
      };
      trades.set(trade.id, trade);
    }
    const place = (request: typeof ExecutionRequest.Type, desk: string) =>
      Effect.gen(function* () {
        const time = new Date(yield* Clock.currentTimeMillis).toISOString();
        const pending: Trade = {
          ...request,
          desk,
          status: "pending",
          createdAt: time,
          updatedAt: time,
        };
        publish(pending);
        // Draw every decision at placement, independent of completion order.
        const rejected = random() < rejectionProbability;
        const latency =
          minimumLatency + Math.floor(random() * (maximumLatency - minimumLatency + 1));
        const delayed = random() < longDelayProbability;
        const processing = Effect.gen(function* () {
          // A second pending revision exercises repeated changes before terminal settlement.
          const duration = delayed ? longDelayMilliseconds : latency;
          yield* Effect.sleep(Math.floor(duration / 2));
          if (duration > 1 && desk !== "local")
            publish({
              ...pending,
              updatedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
            });
          yield* Effect.sleep(duration - Math.floor(duration / 2));
          const trade: Trade = {
            ...pending,
            status: rejected ? "rejected" : "done",
            updatedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
          };
          publish(trade);
          return JSON.stringify(trade);
        });
        return yield* processing.pipe(Effect.forkIn(scope, { startImmediately: true }));
      });
    let tradeRemainder = 0;
    for (const market of markets) {
      const priceTick = Effect.gen(function* () {
        yield* Effect.sleep(market.interval);
        market.bidUnits = Math.max(1, market.bidUnits + Math.floor(market.random() * 7) - 3);
        market.spreadUnits = 8 + Math.floor(market.random() * 5);
        emit(`prices/${market.pair.symbol}`, {
          symbol: market.pair.symbol,
          bid: rate(market, market.bidUnits),
          ask: rate(market, market.bidUnits + market.spreadUnits),
          time: new Date(yield* Clock.currentTimeMillis).toISOString(),
        });
      });
      yield* priceTick.pipe(Effect.forever, Effect.forkScoped);
    }
    const tick = Effect.gen(function* () {
      yield* Effect.sleep(intervalMilliseconds);
      tradeRemainder +=
        otherDeskTradesPerSecond === undefined
          ? Number(random() < otherDeskTradeProbability)
          : (otherDeskTradesPerSecond * intervalMilliseconds) / 1000;
      const placements = Math.floor(tradeRemainder);
      tradeRemainder -= placements;
      for (let index = 0; index < placements; index++) {
        const market = markets[Math.floor(random() * markets.length)] as (typeof markets)[number];
        const direction = random() < 0.5 ? "buy" : "sell";
        yield* place(
          {
            id: `trade-${++tradeSequence}`,
            symbol: market.pair.symbol,
            direction,
            notional: String((1 + Math.floor(random() * 20)) * 100000),
            rate: rate(market, market.bidUnits + (direction === "buy" ? market.spreadUnits : 0)),
          },
          `desk-${1 + Math.floor(random() * 4)}`,
        );
      }
    });
    yield* tick.pipe(Effect.forever, Effect.forkScoped);

    const orderExchange = yield* makeOrderExchange(
      { ...options, intervalMilliseconds, rejectionProbability, latency: minimumLatency },
      (symbol) => {
        const market = markets.find((market) => market.pair.symbol === symbol);
        if (!market) throw new Error(`unknown market: ${symbol}`);
        return {
          symbol,
          bid: rate(market, market.bidUnits),
          ask: rate(market, market.bidUnits + market.spreadUnits),
        };
      },
      (fill) => {
        trades.set(fill.id, fill);
      },
    );

    return {
      request: (path: string, body: string): Effect.Effect<string, ExchangeError> => {
        if (path.startsWith("/orders") || path.startsWith("/settings"))
          return orderExchange
            .request(path, body)
            .pipe(Effect.mapError((error) => new ExchangeError({ message: String(error) })));
        if (path === "/pairs") return Effect.succeed(JSON.stringify(pairs));
        if (path === "/trades") return Effect.sync(() => JSON.stringify([...trades.values()]));
        if (path === "/execute")
          return Effect.gen(function* () {
            const request = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(ExecutionRequest),
            )(body).pipe(Effect.mapError((error) => new ExchangeError({ message: String(error) })));
            if (trades.has(request.id))
              return yield* Effect.fail(new ExchangeError({ message: "duplicate order id" }));
            const processing = yield* place(request, "local");
            return yield* Fiber.join(processing);
          });
        return Effect.fail(new ExchangeError({ message: `unknown path: ${path}` }));
      },
      subscribe: (topic: string): Stream.Stream<string, ExchangeError> => {
        if (topic === "orders") return orderExchange.subscribe();
        const subscribers = listeners.get(topic);
        return subscribers === undefined
          ? Stream.fail(new ExchangeError({ message: `unknown topic: ${topic}` }))
          : Stream.callback<string>((queue) =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  const listener = (message: string) => {
                    Queue.offerUnsafe(queue, message);
                  };
                  subscribers.add(listener);
                  return listener;
                }),
                (listener) => Effect.sync(() => subscribers.delete(listener)),
              ),
            );
      },
      subscriptionCount: () =>
        orderExchange.subscriptionCount() +
        [...listeners.values()].reduce((count, entries) => count + entries.size, 0),
    };
  });
