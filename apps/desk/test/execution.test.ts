import { expect, test } from "bun:test";
import { Realm } from "@frondruntime/pinna";
import { testRealm } from "@frondruntime/pinna/testing";
import { RealmService, Source } from "@frondruntime/pinna-effect";
import { Clock, Effect, Exit, Fiber, type Scope } from "effect";
import { TestClock } from "effect/testing";
import { type Desk, makeDesk } from "../src/client/desk.ts";
import type { ExecutionState } from "../src/client/wire.ts";
import { type ExchangeOptions, makeExchange } from "../src/exchange/index.ts";
import { inMemoryTransport } from "../src/transport.ts";
import { foldLog } from "./oracle.ts";

const executionState = (desk: Desk) => Realm.untracked(desk.realm, (read) => read(desk.$execution));
const trades = (desk: Desk) =>
  Realm.untracked(desk.realm, (read) => read(desk.trades.$trades.rows));

async function scenario(
  options: Partial<ExchangeOptions>,
  check: (
    desk: Desk,
    memory: ReturnType<typeof inMemoryTransport>,
  ) => Effect.Effect<void, unknown, Scope.Scope>,
) {
  using realm = testRealm();
  return await Effect.gen(function* () {
    const exchange = yield* makeExchange({
      historyTradeCount: 0,
      seed: 39,
      intervalMilliseconds: 10,
      otherDeskTradeProbability: 0,
      executionLatencyMilliseconds: [100, 100],
      rejectionProbability: 0,
      longDelayProbability: 0,
      ...options,
    });
    const memory = inMemoryTransport(exchange);
    const desk = (yield* makeDesk(memory.transport)).tile("EURUSD");
    yield* Source.observeScoped(desk.$display);
    yield* Source.observeScoped(desk.trades.$keys);
    yield* TestClock.adjust(10);
    yield* check(desk, memory);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
}

test("fill replaces the immediate pending row and returns to idle three seconds later", () =>
  scenario({}, (desk, memory) =>
    Effect.gen(function* () {
      desk.setNotional("250000.125");
      yield* desk.execute("buy").pipe(Effect.forkScoped);
      yield* TestClock.adjust(0);
      expect(executionState(desk)).toBe("pending");
      expect(trades(desk)).toHaveLength(1);
      expect(trades(desk)[0]?.status).toBe("pending");
      expect(Realm.untracked(desk.realm, (read) => read(desk.$canExecute))).toBe(false);
      expect(
        JSON.parse(memory.log.find((entry) => entry.address === "/execute")?.raw ?? "{}").notional,
      ).toBe("250000.125");
      yield* desk.execute("sell"); // pending guards duplicate requests
      expect(
        memory.log.filter((entry) => entry.kind === "request" && entry.address === "/execute"),
      ).toHaveLength(1);
      yield* TestClock.adjust(100);
      expect(executionState(desk)).toBe("done");
      expect(trades(desk)).toHaveLength(1);
      expect(trades(desk)[0]?.status).toBe("done");
      yield* TestClock.adjust(2999);
      expect(executionState(desk)).toBe("done");
      yield* TestClock.adjust(1);
      expect(executionState(desk)).toBe("idle");
    }),
  ));

test("rejection withdraws the optimistic row including its topic echo", () =>
  scenario({ rejectionProbability: 1 }, (desk, memory) =>
    Effect.gen(function* () {
      yield* desk.execute("sell").pipe(Effect.forkScoped);
      yield* TestClock.adjust(100);
      expect(executionState(desk)).toBe("rejected");
      expect(trades(desk)).toEqual([]);
      expect(JSON.parse(yield* memory.transport.request("/trades", ""))[0].status).toBe("rejected");
      expect(
        memory.log
          .filter((entry) => entry.kind === "trade")
          .map((entry) => JSON.parse(entry.raw).status),
      ).toEqual(["pending", "rejected"]);
      yield* TestClock.adjust(3000);
      expect(executionState(desk)).toBe("idle");
    }),
  ));

test("timeout withdraws the row at exactly two seconds and resets after three more", () =>
  scenario({ longDelayProbability: 1, longDelayMilliseconds: 10000 }, (desk, memory) =>
    Effect.gen(function* () {
      yield* desk.execute("buy").pipe(Effect.forkScoped);
      yield* TestClock.adjust(1999);
      expect(executionState(desk)).toBe("pending");
      yield* TestClock.adjust(1);
      expect(executionState(desk)).toBe("timed out");
      expect(trades(desk)).toEqual([]);
      expect(
        memory.log.some((entry) => entry.address === "/execute" && entry.kind === "response"),
      ).toBe(false);
      yield* TestClock.adjust(2999);
      expect(executionState(desk)).toBe("timed out");
      yield* TestClock.adjust(1);
      expect(executionState(desk)).toBe("idle");
    }),
  ));

test("a late fill appears exactly once through the topic after timeout", () =>
  scenario({ longDelayProbability: 1, longDelayMilliseconds: 4000 }, (desk, memory) =>
    Effect.gen(function* () {
      yield* desk.execute("buy").pipe(Effect.forkScoped);
      yield* TestClock.adjust(2000);
      expect(trades(desk)).toEqual([]);
      yield* TestClock.adjust(2000);
      expect(executionState(desk)).toBe("timed out");
      expect(trades(desk)).toHaveLength(1);
      expect(trades(desk)[0]?.status).toBe("done");
      expect(
        memory.log.filter((entry) => entry.address === "/execute" && entry.kind === "response"),
      ).toHaveLength(0);
      yield* TestClock.adjust(1000);
      expect(executionState(desk)).toBe("idle");
      expect(trades(desk)).toHaveLength(1);
    }),
  ));

test("the workflow accepts only positive decimal notionals without rendering React", () =>
  scenario({}, (desk, memory) =>
    Effect.gen(function* () {
      for (const notional of [
        "",
        "0",
        "0.000",
        "-1",
        "1e6",
        "Infinity",
        "NaN",
        " 1",
        "1.",
        ".5",
        "one",
      ]) {
        desk.setNotional(notional);
        expect(Realm.untracked(desk.realm, (read) => read(desk.$canExecute))).toBe(false);
        yield* desk.execute("buy");
      }
      expect(memory.log.some((entry) => entry.address === "/execute")).toBe(false);
      desk.setNotional("0000.000000000000000000000001");
      yield* desk.execute("sell").pipe(Effect.forkScoped);
      yield* TestClock.adjust(100);
      expect(trades(desk)[0]?.notional).toBe("0000.000000000000000000000001");
    }),
  ));

test("an invalid execution state throws at the write and rolls back", () =>
  scenario({}, (desk) =>
    Effect.sync(() => {
      expect(() =>
        Realm.update(desk.realm, (_read, write) =>
          write(desk.$execution, "filled" as ExecutionState),
        ),
      ).toThrow("the box rejects this value");
      expect(executionState(desk)).toBe("idle");
    }),
  ));

test("interrupting headless request work stops it and withdraws pending state", () =>
  scenario({}, (desk) =>
    Effect.gen(function* () {
      const request = yield* desk.execute("buy").pipe(Effect.forkScoped);
      yield* TestClock.adjust(0);
      yield* Fiber.interrupt(request);
      expect(Exit.isFailure(yield* Fiber.await(request))).toBe(true);
      expect(executionState(desk)).toBe("idle");
      expect(trades(desk)).toEqual([]);
    }),
  ));

test("1,000 seeded ticks with other desks and random executions match the complete log fold", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const exchange = yield* makeExchange({
      historyTradeCount: 0,
      seed: 94821,
      intervalMilliseconds: 20,
      otherDeskTradeProbability: 0.12,
      executionLatencyMilliseconds: [30, 120],
      rejectionProbability: 0.3,
      longDelayProbability: 0.25,
      longDelayMilliseconds: 2600,
    });
    const memory = inMemoryTransport(exchange);
    const desk = (yield* makeDesk(memory.transport)).tile("EURUSD");
    yield* Source.observeScoped(desk.$display);
    yield* Source.observeScoped(desk.trades.$keys);
    let randomState = 87321;
    const random = () => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return randomState / 4294967296;
    };
    const outcomes = new Set<string>();
    const compare = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const expected = foldLog(memory.log, now);
      const actual = Realm.untracked(realm, (read) => ({
        pair: desk.pair,
        prices: read(desk.$prices),
        trades: read(desk.trades.$keys).map((key) => {
          const trade = read.row(desk.trades.$trades, key);
          if (trade === undefined) throw new Error(`missing held trade ${key}`);
          return trade;
        }),
        execution: read(desk.$execution),
      }));
      outcomes.add(actual.execution);
      expect(expected).toEqual(actual);
    });
    yield* TestClock.adjust(0);
    yield* compare;
    for (let tick = 0; tick < 1000; tick++) {
      yield* TestClock.adjust(20);
      yield* compare;
      if (random() < 0.045 && Realm.untracked(realm, (read) => read(desk.$canExecute))) {
        desk.setNotional(`${1000 + Math.floor(random() * 100000)}.25`);
        yield* desk.execute(random() < 0.5 ? "buy" : "sell").pipe(Effect.forkScoped);
        yield* TestClock.adjust(0);
        yield* compare;
      }
    }
    expect(outcomes).toEqual(new Set(["idle", "pending", "done", "rejected", "timed out"]));
    expect(
      memory.log.filter((entry) => entry.kind === "request" && entry.address === "/execute").length,
    ).toBeGreaterThan(10);
    expect(trades(desk).some((trade) => trade.desk !== "local")).toBe(true);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
}, 20000);
