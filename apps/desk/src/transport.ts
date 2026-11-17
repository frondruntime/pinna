import { Clock, Data, Effect, Stream } from "effect";

export class TransportError extends Data.TaggedError("TransportError")<{
  readonly message: string;
}> {}

export interface Transport {
  request(path: string, body: string): Effect.Effect<string, TransportError>;
  subscribe(topic: string): Stream.Stream<string, TransportError>;
}

/** The adapter knows only a string endpoint, not the exchange implementation. */
interface StringEndpoint {
  request(path: string, body: string): Effect.Effect<string, unknown>;
  subscribe(topic: string): Stream.Stream<string, unknown>;
}

export interface LogEntry {
  readonly direction: "client-to-exchange" | "exchange-to-client";
  readonly kind:
    | "request"
    | "response"
    | "subscribe"
    | "unsubscribe"
    | "price"
    | "trade"
    | "order"
    | "error";
  readonly address: string;
  readonly raw: string;
  readonly time: string;
}

export function inMemoryTransport(endpoint: StringEndpoint) {
  const log: Array<LogEntry> = [];
  const append = (
    direction: LogEntry["direction"],
    kind: LogEntry["kind"],
    address: string,
    raw: string,
  ) =>
    Effect.gen(function* () {
      const time = yield* Clock.currentTimeMillis;
      log.push({ direction, kind, address, raw, time: new Date(time).toISOString() });
    });
  const failure = (address: string, cause: unknown) => {
    const error = new TransportError({ message: String(cause) });
    return append(
      "exchange-to-client",
      "error",
      address,
      JSON.stringify({ error: error.message }),
    ).pipe(Effect.andThen(Effect.fail(error)));
  };
  const transport: Transport = {
    request: (path, body) =>
      Effect.gen(function* () {
        yield* append("client-to-exchange", "request", path, body);
        const response = yield* endpoint
          .request(path, body)
          .pipe(Effect.catch((cause) => failure(path, cause)));
        yield* append("exchange-to-client", "response", path, response);
        return response;
      }),
    subscribe: (topic) =>
      Stream.unwrap(
        Effect.acquireRelease(
          append("client-to-exchange", "subscribe", topic, JSON.stringify({ action: "subscribe" })),
          () =>
            append(
              "client-to-exchange",
              "unsubscribe",
              topic,
              JSON.stringify({ action: "unsubscribe" }),
            ),
        ).pipe(Effect.as(endpoint.subscribe(topic))),
      ).pipe(
        Stream.tap((raw) =>
          append(
            "exchange-to-client",
            topic === "trades" ? "trade" : topic === "orders" ? "order" : "price",
            topic,
            raw,
          ),
        ),
        Stream.catch((cause) => Stream.fromEffect(failure(topic, cause))),
      ),
  };
  return { transport, log: log as ReadonlyArray<LogEntry> };
}
