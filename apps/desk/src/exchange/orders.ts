import { Clock, Effect, Queue, Schema, Stream } from "effect";

// Deliberately independent of client schemas and Pinna.
const symbols = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "EURGBP"] as const;
const amount = Schema.String.check(
  Schema.isPattern(/^\d+(?:\.\d{1,2})?$/),
  Schema.makeFilter((value) => /[1-9]/.test(value)),
);
const date = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
  ),
);
const terms = {
  symbol: Schema.Literals(symbols),
  side: Schema.Literals(["buy", "sell"]),
  notional: amount,
  limitPrice: Schema.String.check(
    Schema.isPattern(/^\d+(?:\.\d{1,5})?$/),
    Schema.makeFilter((value) => /[1-9]/.test(value)),
  ),
  timeInForce: Schema.Literals(["day", "date", "immediate"]),
  expiry: Schema.String,
  note: Schema.String.check(Schema.makeFilter((value) => value.length <= 200)),
};
const Request = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^limit-(?:local|exchange)-\d+$/)),
  ...terms,
});
type Request = typeof Request.Type;
interface Order {
  readonly id: string;
  readonly value: Omit<Request, "id"> & {
    readonly filled: string;
    readonly status: "working" | "partial" | "filled" | "cancelled" | "expired";
    readonly revision: number;
  };
}
interface Fill {
  readonly id: string;
  readonly symbol: Request["symbol"];
  readonly direction: "buy" | "sell";
  readonly notional: string;
  readonly rate: string;
  readonly status: "done";
  readonly desk: "local";
  readonly createdAt: string;
  readonly updatedAt: string;
}
interface Market {
  readonly symbol: string;
  readonly bid: string;
  readonly ask: string;
}
export interface OrderExchangeOptions {
  readonly initialWorkingOrders?: number;
  readonly malformedOrderProbability?: number;
  readonly initialAccountSettings?: unknown;
}
function randomFrom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
const cents = (value: string) => {
  const [whole = "0", places = ""] = value.split(".");
  return BigInt(whole + places.padEnd(2, "0"));
};
const fromCents = (value: bigint) =>
  `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
const defaults = {
  displayName: "Trader",
  defaultNotionals: {
    EURUSD: "100000",
    GBPUSD: "100000",
    USDJPY: "100000",
    AUDUSD: "100000",
    EURGBP: "100000",
  },
  confirmationThreshold: "1000000",
};
const Settings = Schema.Struct({
  displayName: Schema.String.check(
    Schema.makeFilter((value) => value === value.trim() && value.length > 0 && value.length <= 40),
  ),
  defaultNotionals: Schema.Struct({
    EURUSD: amount,
    GBPUSD: amount,
    USDJPY: amount,
    AUDUSD: amount,
    EURGBP: amount,
  }),
  confirmationThreshold: amount,
});

export const makeOrderExchange = (
  options: OrderExchangeOptions & {
    readonly seed: number;
    readonly intervalMilliseconds: number;
    readonly rejectionProbability: number;
    readonly latency: number;
  },
  marketFor: (symbol: string) => Market,
  publishFill: (fill: Fill) => void,
) =>
  Effect.gen(function* () {
    const probability = options.malformedOrderProbability ?? 0.04;
    const initialCount = options.initialWorkingOrders ?? 0;
    if (
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1 ||
      !Number.isSafeInteger(initialCount) ||
      initialCount < 0
    )
      throw new Error("invalid order exchange options");
    const random = randomFrom(options.seed ^ 0x5f3759df);
    const listeners = new Set<(raw: string) => void>();
    const orders = new Map<string, Order>();
    const days = new Map<string, string>();
    let sequence = 0;
    let settings: unknown = options.initialAccountSettings ?? defaults;
    const now = () => Effect.map(Clock.currentTimeMillis, (time) => new Date(time).toISOString());
    const emit = (message: unknown) => {
      const raw = JSON.stringify(message);
      for (const listener of listeners) listener(raw);
    };
    const publish = (kind: string, order: Order, fill: Fill | null = null) => {
      orders.set(order.id, order);
      emit({ kind, order, fill });
      if (fill) publishFill(fill);
    };
    const seedOrder = (today: string): Order => {
      const symbol = symbols[sequence % symbols.length] ?? "EURUSD";
      const market = marketFor(symbol);
      const order: Order = {
        id: `limit-exchange-${++sequence}`,
        value: {
          symbol,
          side: "buy",
          notional: "100000.00",
          limitPrice: market.ask,
          timeInForce: "day",
          expiry: "",
          note: "Seeded order",
          filled: "0.00",
          status: "working",
          revision: 0,
        },
      };
      days.set(order.id, today);
      return order;
    };
    const origin = (yield* now()).slice(0, 10);
    for (let index = 0; index < initialCount; index++) {
      const order = seedOrder(origin);
      orders.set(order.id, order);
    }
    const applyFill = (order: Order, timestamp: string) => {
      const remaining = cents(order.value.notional) - cents(order.value.filled);
      const quantity = remaining > 1n ? 1n : remaining;
      const filled = cents(order.value.filled) + quantity;
      const market = marketFor(order.value.symbol);
      const next: Order = {
        ...order,
        value: {
          ...order.value,
          revision: order.value.revision + 1,
          filled: fromCents(filled),
          status: filled === cents(order.value.notional) ? "filled" : "partial",
        },
      };
      const fill: Fill = {
        id: `${order.id}-fill-${next.value.revision}`,
        symbol: order.value.symbol,
        direction: order.value.side,
        notional: fromCents(quantity),
        rate: order.value.side === "buy" ? market.ask : market.bid,
        status: "done",
        desk: "local",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      publish(next.value.status, next, fill);
    };
    const malformed = (order: Order) => {
      const choice = Math.floor(random() * 6);
      const next = { ...order, value: { ...order.value, revision: order.value.revision + 1 } };
      if (choice === 0)
        emit({
          kind: "amended",
          order: { id: order.id, value: { ...next.value, note: undefined } },
          fill: null,
        });
      if (choice === 1)
        emit({
          kind: "amended",
          order: { ...next, value: { ...next.value, notional: "-1" } },
          fill: null,
        });
      if (choice === 2)
        emit({
          kind: "amended",
          order: { ...next, value: { ...next.value, notional: "1e6" } },
          fill: null,
        });
      if (choice === 3)
        emit({
          kind: "amended",
          order: { ...next, value: { ...next.value, status: "unknown" } },
          fill: null,
        });
      if (choice === 4)
        emit({ kind: "amended", order: { ...next, id: "unknown-order" }, fill: null });
      if (choice === 5) {
        const timestamp = "2000-01-01T00:00:00.000Z";
        emit({
          kind: "partial",
          order: {
            ...next,
            value: {
              ...next.value,
              status: "partial",
              filled: fromCents(cents(order.value.filled) + 1n),
            },
          },
          fill: {
            id: `invalid-${next.value.revision}-${sequence}`,
            symbol: order.value.symbol,
            direction: order.value.side,
            notional: fromCents(cents(order.value.notional) + 1n),
            rate: marketFor(order.value.symbol).ask,
            status: "done",
            desk: "local",
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        });
      }
    };
    const tick = Effect.gen(function* () {
      yield* Effect.sleep(options.intervalMilliseconds);
      const timestamp = yield* now();
      for (const order of [...orders.values()]) {
        if (["filled", "cancelled", "expired"].includes(order.value.status)) continue;
        if (random() < probability) malformed(order);
        if (
          (order.value.timeInForce === "date" && timestamp.slice(0, 10) >= order.value.expiry) ||
          (order.value.timeInForce === "day" && timestamp.slice(0, 10) !== days.get(order.id))
        ) {
          publish("expired", {
            ...order,
            value: { ...order.value, status: "expired", revision: order.value.revision + 1 },
          });
          continue;
        }
        const market = marketFor(order.value.symbol);
        const executable =
          order.value.side === "buy"
            ? Number(order.value.limitPrice) >= Number(market.ask)
            : Number(order.value.limitPrice) <= Number(market.bid);
        if (executable) applyFill(order, timestamp);
        else if (random() < 0.04)
          publish("amended", {
            ...order,
            value: { ...order.value, revision: order.value.revision + 1 },
          });
      }
    });
    yield* tick.pipe(Effect.forever, Effect.forkScoped);
    const request = (path: string, body: string): Effect.Effect<string, unknown> =>
      Effect.gen(function* () {
        if (path === "/orders") return JSON.stringify([...orders.values()]);
        if (path === "/settings") return JSON.stringify(settings);
        if (path === "/settings/save") {
          const received = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Settings))(body);
          const rejected =
            received.displayName.toLowerCase() === "exchange" ||
            random() < options.rejectionProbability;
          yield* Effect.sleep(options.latency);
          if (rejected)
            return JSON.stringify({
              ok: false,
              errors: { displayName: "The exchange reserves this name." },
            });
          settings = received;
          return JSON.stringify({ ok: true, settings });
        }
        if (path !== "/orders/place" && path !== "/orders/amend")
          return yield* Effect.fail("unknown order endpoint");
        const received = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            path === "/orders/amend"
              ? Schema.Struct({ ...Request.fields, revision: Schema.Int })
              : Request,
          ),
        )(body);
        const rejected = random() < options.rejectionProbability;
        yield* Effect.sleep(options.latency);
        const timestamp = yield* now();
        const market = marketFor(received.symbol);
        const precision = received.symbol === "USDJPY" ? 3 : 5;
        const mid = (Number(market.bid) + Number(market.ask)) / 2;
        if (
          (received.limitPrice.split(".")[1]?.length ?? 0) > precision ||
          Math.abs(Number(received.limitPrice) - mid) > mid * 0.1 ||
          (received.timeInForce === "date"
            ? !Schema.is(date)(received.expiry) || received.expiry <= timestamp.slice(0, 10)
            : received.expiry !== "")
        )
          return JSON.stringify({ ok: false, reason: "Price or expiry is no longer valid." });
        if (rejected)
          return JSON.stringify({ ok: false, reason: "Exchange risk limit refused this request." });
        if (path === "/orders/amend") {
          const previous = orders.get(received.id);
          if (!previous || ["filled", "cancelled", "expired"].includes(previous.value.status))
            return JSON.stringify({ ok: false, reason: "Order is no longer working." });
          const raw = JSON.parse(body) as { readonly revision: number };
          if (raw.revision !== previous.value.revision)
            return JSON.stringify({
              ok: false,
              reason: "Order changed; review the latest exchange values.",
            });
          if (
            received.symbol !== previous.value.symbol ||
            received.side !== previous.value.side ||
            received.timeInForce !== previous.value.timeInForce ||
            received.expiry !== previous.value.expiry ||
            received.note !== previous.value.note ||
            cents(received.notional) <= cents(previous.value.filled)
          )
            return JSON.stringify({ ok: false, reason: "Invalid amendment." });
          // The exchange rounds amendments to one fewer decimal place.
          const roundedPrice = Number(received.limitPrice).toFixed(precision - 1);
          const next: Order = {
            id: previous.id,
            value: {
              ...previous.value,
              notional: received.notional,
              limitPrice: Number(roundedPrice) > 0 ? roundedPrice : received.limitPrice,
              revision: previous.value.revision + 1,
            },
          };
          publish("amended", next);
          return JSON.stringify({
            ok: true,
            message: { kind: "amended", order: next, fill: null },
          });
        }
        if (orders.has(received.id))
          return JSON.stringify({ ok: false, reason: "Duplicate order identifier." });
        const { id, ...value } = received;
        const order: Order = {
          id,
          value: { ...value, filled: "0.00", status: "working", revision: 0 },
        };
        days.set(id, timestamp.slice(0, 10));
        publish("accepted", order);
        if (received.timeInForce === "immediate") {
          const executable =
            received.side === "buy"
              ? Number(received.limitPrice) >= Number(market.ask)
              : Number(received.limitPrice) <= Number(market.bid);
          if (executable) applyFill(order, timestamp);
          const latest = orders.get(id) ?? order;
          if (latest.value.status !== "filled")
            publish("cancelled", {
              ...latest,
              value: { ...latest.value, status: "cancelled", revision: latest.value.revision + 1 },
            });
        }
        return JSON.stringify({ ok: true, message: { kind: "accepted", order, fill: null } });
      });
    return {
      request,
      subscribe: () =>
        Stream.callback<string>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const listener = (raw: string) => {
                Queue.offerUnsafe(queue, raw);
              };
              listeners.add(listener);
              return listener;
            }),
            (listener) => Effect.sync(() => listeners.delete(listener)),
          ),
        ),
      subscriptionCount: () => listeners.size,
    };
  });
