import { expect, test } from "bun:test";
import { untracked } from "@frondruntime/pinna";
import { testRealm } from "@frondruntime/pinna/testing";
import { observeScoped, RealmService } from "@frondruntime/pinna-effect";
import { Effect, Exit, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makeDesk } from "../src/client/desk.ts";
import { decodePrice } from "../src/client/wire.ts";
import { makeExchange } from "../src/exchange/index.ts";
import { inMemoryTransport, type LogEntry } from "../src/transport.ts";
import { foldLog, oracleDisplay } from "./oracle.ts";

const intervalMilliseconds = 10;

async function runMarket(seed: number, ticks: number) {
  using realm = testRealm();
  let log: ReadonlyArray<LogEntry> = [];
  await Effect.gen(function* () {
    const exchange = yield* makeExchange({ seed, intervalMilliseconds });
    const memory = inMemoryTransport(exchange);
    log = memory.log;
    const desk = (yield* makeDesk(memory.transport)).tile("EURUSD");
    const snapshot = () => ({
      pair: desk.pair,
      prices: untracked(realm, (read) => read(desk.$prices)),
      trades: [],
      execution: untracked(realm, (read) => read(desk.$execution)),
    });
    expect(foldLog(log)).toEqual(snapshot());
    expect(exchange.subscriptionCount()).toBe(0);
    yield* observeScoped(desk.$display);
    yield* TestClock.adjust(0);
    expect(exchange.subscriptionCount()).toBe(1);
    for (let tick = 1; tick <= ticks; tick++) {
      yield* TestClock.adjust(intervalMilliseconds);
      // TestClock waits until awakened fibers suspend, including stream consumption.
      expect(log.filter((entry) => entry.kind === "price")).toHaveLength(tick);
      const expected = foldLog(log);
      expect(expected).toEqual(snapshot());
      expect(oracleDisplay(expected)).toEqual(untracked(realm, (read) => read(desk.$display)));
    }
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
  return [...log];
}

test("the same seed and simulated clock schedule produce the same complete log", async () => {
  const first = await runMarket(8271, 40);
  expect(await runMarket(8271, 40)).toEqual(first);
  expect(await runMarket(8272, 40)).not.toEqual(first);
  expect(first[0]).toEqual({
    direction: "client-to-exchange",
    kind: "request",
    address: "/pairs",
    raw: "",
    time: "1970-01-01T00:00:00.000Z",
  });
  expect(first.at(-1)?.kind).toBe("unsubscribe");
});

test("1,000 settled ticks match the independent log fold after every tick", async () => {
  expect((await runMarket(20261116, 1000)).filter((entry) => entry.kind === "price")).toHaveLength(
    1000,
  );
}, 20000);

test("two consumers receive one shared market, and releasing one leaves the other subscribed", async () => {
  await Effect.gen(function* () {
    const exchange = yield* makeExchange({ seed: 9, intervalMilliseconds });
    const memory = inMemoryTransport(exchange);
    const first: Array<string> = [];
    const second: Array<string> = [];
    const firstFiber = yield* memory.transport.subscribe("prices/EURUSD").pipe(
      Stream.runForEach((raw) =>
        Effect.sync(() => {
          first.push(raw);
        }),
      ),
      Effect.forkScoped,
    );
    yield* memory.transport.subscribe("prices/EURUSD").pipe(
      Stream.runForEach((raw) =>
        Effect.sync(() => {
          second.push(raw);
        }),
      ),
      Effect.forkScoped,
    );
    yield* TestClock.adjust(intervalMilliseconds);
    expect(exchange.subscriptionCount()).toBe(2);
    expect(first).toHaveLength(1);
    expect(first).toEqual(second);
    yield* Fiber.interrupt(firstFiber);
    yield* TestClock.adjust(intervalMilliseconds);
    expect(exchange.subscriptionCount()).toBe(1);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise);
});

test("unknown paths and topics fail as transport errors and log the failure", async () => {
  await Effect.gen(function* () {
    const exchange = yield* makeExchange({ seed: 1 });
    const memory = inMemoryTransport(exchange);
    const response = yield* memory.transport.request("/missing", "{}").pipe(Effect.exit);
    const topic = yield* memory.transport
      .subscribe("prices/UNKNOWN")
      .pipe(Stream.runDrain, Effect.exit);
    expect(Exit.isFailure(response)).toBe(true);
    expect(Exit.isFailure(topic)).toBe(true);
    expect(memory.log.filter((entry) => entry.kind === "error")).toHaveLength(2);
    expect(exchange.subscriptionCount()).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise);
});

test("the decoder rejects invalid JSON, numeric decimals, crossed prices, and invalid ISO times", async () => {
  const valid = {
    symbol: "EURUSD",
    bid: "1.08000",
    ask: "1.08010",
    time: "1970-01-01T00:00:00.000Z",
  };
  for (const raw of [
    "not JSON",
    JSON.stringify({ ...valid, bid: 1.08 }),
    JSON.stringify({ ...valid, bid: "1.08011" }),
    JSON.stringify({ ...valid, time: "yesterday" }),
  ]) {
    expect(Exit.isFailure(await Effect.runPromise(decodePrice(raw).pipe(Effect.exit)))).toBe(true);
  }
});
