import { expect, test } from "bun:test";
import { untracked } from "@frondruntime/pinna";
import { testRealm } from "@frondruntime/pinna/testing";
import { observeScoped, RealmService } from "@frondruntime/pinna-effect";
import { Effect, Logger } from "effect";
import { TestClock } from "effect/testing";
import { makeDesk } from "../src/client/desk.ts";
import { feed, wireTrade } from "./feed.ts";

// The snapshot envelope is deliberately not a schema of trades: bad neighbors
// are isolated and logged while valid rows keep arriving on the same topic.
test("snapshot and topic trades are checked individually; malformed trades are logged and dropped", async () => {
  using realm = testRealm();
  const warnings: Array<unknown> = [];
  const valid = wireTrade("valid");
  const invalid = [
    { ...valid, id: "" },
    { ...valid, symbol: "USDCAD" },
    { ...valid, direction: "hold" },
    { ...valid, notional: "0" },
    { ...valid, notional: "-20" },
    { ...valid, notional: 20 },
    { ...valid, rate: "0.00000" },
    { ...valid, rate: 1.08 },
    { ...valid, status: "filled" },
    { ...valid, desk: "" },
    { ...valid, createdAt: "today" },
    { ...valid, updatedAt: "1969-12-31T23:59:59.999Z" },
  ];
  await Effect.gen(function* () {
    const memory = feed([valid, ...invalid]);
    const desk = (yield* makeDesk(memory.transport)).tile("EURUSD");
    yield* observeScoped(desk.trades.$keys);
    yield* TestClock.adjust(0);
    expect([valid]).toEqual([...untracked(realm, (read) => read(desk.trades.$trades.rows))]);
    expect(warnings).toHaveLength(invalid.length);
    for (const trade of invalid) memory.send("trades", trade);
    memory.sendRaw("trades", "not JSON");
    memory.send("trades", wireTrade("after-invalid", 1));
    yield* TestClock.adjust(0);
    expect(warnings).toHaveLength(invalid.length * 2 + 1);
    expect(untracked(realm, (read) => read(desk.trades.$keys))).toEqual(["after-invalid", "valid"]);
    expect(memory.subscriptionCount()).toBe(1);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.provide(
      Logger.layer([
        Logger.make((options) => {
          warnings.push(options.message);
        }),
      ]),
    ),
    Effect.runPromise,
  );
});

test("a topic update beats an overlapping stale snapshot and duplicates keep one row", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const pending = wireTrade("overlap");
    const done = { ...pending, status: "done", updatedAt: new Date(5).toISOString() };
    const memory = feed([pending]);
    const desk = (yield* makeDesk({
      ...memory.transport,
      request: (path, body) =>
        path === "/trades"
          ? Effect.gen(function* () {
              // The subscription must already be open when the snapshot starts.
              expect(memory.subscriptionCount()).toBe(1);
              memory.send("trades", done);
              yield* Effect.sleep(10);
              return yield* memory.transport.request(path, body);
            })
          : memory.transport.request(path, body),
    })).tile("EURUSD");
    yield* observeScoped(desk.trades.$keys);
    yield* TestClock.adjust(10);
    memory.send("trades", done);
    memory.send("trades", { ...pending, updatedAt: done.updatedAt }); // equal-time pending cannot regress a terminal status
    yield* TestClock.adjust(0);
    expect([done]).toEqual([...untracked(realm, (read) => read(desk.trades.$trades.rows))]);
    expect(untracked(realm, (read) => read(desk.trades.$keys))).toEqual(["overlap"]);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("malformed and mismatched execution responses are logged and never become blotter rows", async () => {
  using realm = testRealm();
  const warnings: Array<unknown> = [];
  await Effect.gen(function* () {
    const memory = feed();
    let response: (request: Record<string, unknown>) => string = () => "not JSON";
    const desk = (yield* makeDesk({
      ...memory.transport,
      request: (path, body) =>
        path === "/execute"
          ? Effect.sync(() => response(JSON.parse(body)))
          : memory.transport.request(path, body),
    })).tile("EURUSD");
    yield* observeScoped(desk.$display);
    yield* observeScoped(desk.trades.$keys);
    yield* TestClock.adjust(0);
    memory.send("prices/EURUSD", {
      symbol: "EURUSD",
      bid: "1.08000",
      ask: "1.08010",
      time: new Date(0).toISOString(),
    });
    yield* TestClock.adjust(0);
    for (const makeResponse of [
      () => "not JSON",
      (request: Record<string, unknown>) =>
        JSON.stringify({ ...wireTrade("invalid"), ...request, desk: "local", status: "filled" }),
      (request: Record<string, unknown>) =>
        JSON.stringify({
          ...wireTrade("invalid"),
          ...request,
          desk: "local",
          status: "done",
          notional: "0",
        }),
      (request: Record<string, unknown>) =>
        JSON.stringify({
          ...wireTrade("invalid"),
          ...request,
          id: "unrelated",
          desk: "local",
          status: "done",
        }),
    ]) {
      response = makeResponse;
      yield* desk.execute("buy").pipe(Effect.forkScoped);
      yield* TestClock.adjust(0);
      expect(untracked(realm, (read) => read(desk.$execution))).toBe("rejected");
      expect(untracked(realm, (read) => read(desk.trades.$trades.rows))).toEqual([]);
      yield* TestClock.adjust(3000);
    }
    expect(warnings).toHaveLength(4);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.provide(
      Logger.layer([
        Logger.make((options) => {
          warnings.push(options.message);
        }),
      ]),
    ),
    Effect.runPromise,
  );
});

test("a newly arriving row is first even when creation timestamps tie", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const first = wireTrade("first");
    const memory = feed([first]);
    const desk = (yield* makeDesk(memory.transport)).tile("EURUSD");
    yield* observeScoped(desk.trades.$keys);
    yield* TestClock.adjust(0);
    memory.send("trades", wireTrade("second"));
    yield* TestClock.adjust(0);
    expect(untracked(realm, (read) => read(desk.trades.$keys))).toEqual(["second", "first"]);
    memory.send("trades", { ...first, status: "done" });
    yield* TestClock.adjust(0);
    expect(untracked(realm, (read) => read(desk.trades.$keys))).toEqual(["second", "first"]);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});
