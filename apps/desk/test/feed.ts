import { Effect, Queue, Stream } from "effect";
import { inMemoryTransport } from "../src/transport.ts";

export const wireTrade = (id: string, milliseconds = 0) => ({
  id,
  symbol: "EURUSD",
  direction: "buy",
  notional: "100000.25",
  rate: "1.08010",
  status: "pending",
  desk: "another-desk",
  createdAt: new Date(milliseconds).toISOString(),
  updatedAt: new Date(milliseconds).toISOString(),
});

export const listedPairs = [
  { symbol: "EURUSD", baseCurrency: "EUR", termsCurrency: "USD", pricePrecision: 5 },
  { symbol: "GBPUSD", baseCurrency: "GBP", termsCurrency: "USD", pricePrecision: 5 },
  { symbol: "USDJPY", baseCurrency: "USD", termsCurrency: "JPY", pricePrecision: 3 },
  { symbol: "AUDUSD", baseCurrency: "AUD", termsCurrency: "USD", pricePrecision: 5 },
  { symbol: "EURGBP", baseCurrency: "EUR", termsCurrency: "GBP", pricePrecision: 5 },
] as const;

export function feed(snapshot: ReadonlyArray<unknown> = [], allPairs = false) {
  const listeners = new Map<string, (raw: string) => void>();
  const memory = inMemoryTransport({
    request: (path) =>
      path === "/pairs"
        ? Effect.succeed(JSON.stringify(allPairs ? listedPairs : listedPairs.slice(0, 1)))
        : Effect.succeed(JSON.stringify(snapshot)),
    subscribe: (topic) =>
      Stream.callback<string>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            listeners.set(topic, (raw) => {
              Queue.offerUnsafe(queue, raw);
            });
          }),
          () => Effect.sync(() => listeners.delete(topic)),
        ),
      ),
  });
  return {
    ...memory,
    send(topic: string, value: unknown) {
      const listener = listeners.get(topic);
      if (!listener) throw new Error(`not subscribed to ${topic}`);
      listener(JSON.stringify(value));
    },
    sendRaw(topic: string, raw: string) {
      const listener = listeners.get(topic);
      if (!listener) throw new Error(`not subscribed to ${topic}`);
      listener(raw);
    },
    subscriptionCount: () => listeners.size,
  };
}
