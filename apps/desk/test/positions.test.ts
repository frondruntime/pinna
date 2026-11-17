import { expect, test } from "bun:test";
import { type Read, untracked, watch } from "@frondruntime/pinna";
import { testRealm } from "@frondruntime/pinna/testing";
import { changes, observeScoped, RealmService } from "@frondruntime/pinna-effect";
import { Effect, Stream } from "effect";
import { TestClock } from "effect/testing";
import { decimal, format, rounded } from "../src/client/decimal.ts";
import { makeDesk } from "../src/client/desk.ts";
import { type PairSymbol, symbols } from "../src/client/wire.ts";
import { makeExchange } from "../src/exchange/index.ts";
import { inMemoryTransport } from "../src/transport.ts";
import { feed, wireTrade } from "./feed.ts";
import { foldPositions, PositionOracle } from "./oracle.ts";

test("10,000 trades, concurrent tiles, workspace changes, and every subscriber receipt match a log prefix", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const exchange = yield* makeExchange({
      seed: 923,
      historyTradeCount: 10000,
      intervalMilliseconds: 20,
      otherDeskTradesPerSecond: 120,
      executionLatencyMilliseconds: [30, 60],
      longDelayProbability: 0,
      rejectionProbability: 0.2,
    });
    const memory = inMemoryTransport(exchange);
    const workspace = yield* makeDesk(memory.transport);
    const channels: { name: string; select: (read: Read) => unknown }[] = [
      { name: "view", select: (read) => read(workspace.$view) },
      {
        name: "total",
        select: (read) => (read(workspace.$panelShown) ? read(workspace.positions.$total) : null),
      },
      ...symbols.flatMap((symbol) => [
        {
          name: `price/${symbol}`,
          select: (read: Read) =>
            read(workspace.$openSymbols).includes(symbol)
              ? read(workspace.tile(symbol).$prices).current
              : null,
        },
        {
          name: `position/${symbol}`,
          select: (read: Read) =>
            read(workspace.$panelShown) && read(workspace.positions.$symbols).includes(symbol)
              ? read(workspace.positions.row(symbol).$value)
              : null,
        },
      ]),
    ];
    const receipts: {
      prefix: number;
      channel: string;
      value: unknown;
      open: readonly PairSymbol[];
      shown: boolean;
    }[] = [];
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        channels.map((channel) =>
          watch(realm, channel.select, (value) => {
            receipts.push({
              prefix: memory.log.length,
              channel: channel.name,
              value,
              ...untracked(realm, (read) => ({
                open: read(workspace.$openSymbols),
                shown: read(workspace.$panelShown),
              })),
            });
          }),
        ),
      ),
      (stops) =>
        Effect.sync(() => {
          for (const stop of stops) stop();
        }),
    );
    yield* observeScoped(workspace.trades.$window);
    yield* changes(workspace.trades.$loaded).pipe(
      Stream.filter(Boolean),
      Stream.take(1),
      Stream.runDrain,
    );
    yield* TestClock.adjust(0);
    let state = 27891;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const compare = () => {
      const expected = foldPositions(
        memory.log,
        untracked(realm, (read) => ({
          open: read(workspace.$openSymbols),
          shown: read(workspace.$panelShown),
        })),
      );
      const completeBook: unknown = untracked(realm, (read) => ({
        positions: read(workspace.positions.$symbols).map((symbol) =>
          read(workspace.positions.row(symbol).$value),
        ),
        total: read(workspace.positions.$total),
        prices: Object.fromEntries(
          workspace.tiles.map((tile) => [tile.pair.symbol, read(tile.$prices).current]),
        ),
      }));
      expect(completeBook).toEqual(expected);
      const actual: unknown = untracked(realm, (read) => read(workspace.$view));
      expect(actual).toEqual({
        tiles: untracked(realm, (read) => read(workspace.$openSymbols)).map((symbol) => ({
          symbol,
          price: expected.prices[symbol],
        })),
        positions: untracked(realm, (read) => read(workspace.$panelShown))
          ? expected.positions
          : [],
        total: untracked(realm, (read) => read(workspace.$panelShown)) ? expected.total : null,
      });
    };
    compare();
    for (let step = 0; step < 30; step++) {
      yield* TestClock.adjust(20 + Math.floor(random() * 3) * 20);
      compare();
      const symbol = symbols[Math.floor(random() * symbols.length)] ?? "EURUSD";
      if (step % 5 === 0) {
        for (const tile of workspace.tiles.slice(0, 3)) {
          tile.setNotional(`${1000 + step}.125`);
          yield* tile.execute(random() < 0.5 ? "buy" : "sell").pipe(Effect.forkScoped);
        }
      } else if (step % 5 === 1) workspace.closeTile(symbol);
      else if (step % 5 === 2) workspace.showPositions(false);
      else if (step % 5 === 3) workspace.openTile(symbol);
      else workspace.showPositions(true);
      yield* TestClock.adjust(0);
      compare();
    }
    const oracle = new PositionOracle();
    let previousObservation = "";
    let expected = foldPositions([]);
    for (const receipt of receipts) {
      const observation = `${receipt.prefix}/${receipt.open.join(",")}/${receipt.shown}`;
      if (observation !== previousObservation) {
        expected = oracle.advance(memory.log.slice(0, receipt.prefix), receipt);
        previousObservation = observation;
      }
      const view = {
        tiles: receipt.open.map((symbol) => ({ symbol, price: expected.prices[symbol] })),
        positions: receipt.shown ? expected.positions : [],
        total: receipt.shown ? expected.total : null,
      };
      const value =
        receipt.channel === "view"
          ? view
          : receipt.channel === "total"
            ? view.total
            : receipt.channel.startsWith("price/")
              ? (view.tiles.find((tile) => tile.symbol === receipt.channel.slice(6))?.price ?? null)
              : (view.positions.find((position) => position.symbol === receipt.channel.slice(9)) ??
                null);
      expect(receipt.value).toEqual(value);
    }
    expect(receipts.length).toBeGreaterThan(500);
    expect(new Set(receipts.map((receipt) => receipt.channel)).size).toBe(12);
    const executions = memory.log
      .filter((entry) => entry.kind === "request" && entry.address === "/execute")
      .map((entry) => JSON.parse(entry.raw));
    expect(new Set(executions.map((request) => request.symbol)).size).toBe(3);
    expect(new Set(executions.map((request) => request.id)).size).toBe(executions.length);
    const oracleTrades = JSON.parse(
      memory.log.find((entry) => entry.address === "/trades" && entry.kind === "response")?.raw ??
        "[]",
    );
    expect(new Set(oracleTrades.map((trade: { symbol: string }) => trade.symbol)).size).toBe(5);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("price topics follow tiles, positions, conversion dependencies, and the last observer", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const memory = feed(
      [{ ...wireTrade("cross"), symbol: "EURGBP", rate: "0.85000", status: "done" }],
      true,
    );
    const workspace = yield* makeDesk(memory.transport);
    yield* observeScoped(workspace.$view);
    yield* TestClock.adjust(0);
    const active = () => {
      const topics = new Set<string>();
      for (const entry of memory.log) {
        if (entry.kind === "subscribe" && entry.address.startsWith("prices/"))
          topics.add(entry.address);
        if (entry.kind === "unsubscribe") topics.delete(entry.address);
      }
      return [...topics].sort();
    };
    expect(active()).toEqual(symbols.map((symbol) => `prices/${symbol}`).sort());
    for (const symbol of symbols) workspace.closeTile(symbol);
    yield* TestClock.adjust(0);
    expect(active()).toEqual(["prices/EURGBP", "prices/GBPUSD"]);
    memory.send("prices/EURGBP", {
      symbol: "EURGBP",
      bid: "0.85000",
      ask: "0.85010",
      time: new Date(1).toISOString(),
    });
    yield* TestClock.adjust(0);
    expect(untracked(realm, (read) => read(workspace.positions.$total))).toEqual({
      cents: 0n,
      complete: false,
    });
    workspace.showPositions(false);
    yield* TestClock.adjust(0);
    expect(active()).toEqual([]);
    workspace.openTile("GBPUSD");
    yield* TestClock.adjust(0);
    expect(active()).toEqual(["prices/GBPUSD"]);
    expect(untracked(realm, (read) => read(workspace.tile("GBPUSD").$prices)).current).toBeNull();
    memory.send("prices/GBPUSD", {
      symbol: "GBPUSD",
      bid: "1.27000",
      ask: "1.27010",
      time: new Date(2).toISOString(),
    });
    yield* TestClock.adjust(0);
    workspace.showPositions(true);
    yield* TestClock.adjust(0);
    expect(active()).toEqual(["prices/EURGBP", "prices/GBPUSD"]);
    expect(
      untracked(realm, (read) => read(workspace.positions.row("EURGBP").$value))?.mark,
    ).toBeNull();
    expect(untracked(realm, (read) => read(workspace.positions.$total)).complete).toBe(false);
    memory.send("prices/EURGBP", {
      symbol: "EURGBP",
      bid: "0.85010",
      ask: "0.85020",
      time: new Date(3).toISOString(),
    });
    yield* TestClock.adjust(0);
    expect(untracked(realm, (read) => read(workspace.positions.$total)).complete).toBe(true);
    workspace.closeTile("GBPUSD");
    yield* TestClock.adjust(0);
    expect(active()).toEqual(["prices/EURGBP", "prices/GBPUSD"]);
    memory.send("trades", {
      ...wireTrade("cross"),
      symbol: "EURGBP",
      rate: "0.85000",
      status: "rejected",
      updatedAt: new Date(3).toISOString(),
    });
    yield* TestClock.adjust(0);
    expect(active()).toEqual([]);
    // Reopening starts exactly one new topic and waits for its next tick.
    workspace.openTile("USDJPY");
    yield* TestClock.adjust(0);
    memory.send("prices/USDJPY", {
      symbol: "USDJPY",
      bid: "152.000",
      ask: "152.010",
      time: new Date(4).toISOString(),
    });
    yield* TestClock.adjust(0);
    expect(untracked(realm, (read) => read(workspace.tile("USDJPY").$prices)).current?.bid).toBe(
      "152.000",
    );
    workspace.closeTile("USDJPY");
    yield* TestClock.adjust(0);
    expect(active()).toEqual([]);
    for (const symbol of symbols) {
      const entries = memory.log.filter((entry) => entry.address === `prices/${symbol}`);
      expect(entries.filter((entry) => entry.kind === "subscribe").length).toBe(
        entries.filter((entry) => entry.kind === "unsubscribe").length,
      );
    }
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("all five pairs execute independently and terminal corrections replace their contributions", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const exchange = yield* makeExchange({
      seed: 177,
      historyTradeCount: 0,
      intervalMilliseconds: 10,
      otherDeskTradesPerSecond: 0,
      executionLatencyMilliseconds: [50, 50],
      rejectionProbability: 0,
      longDelayProbability: 0,
    });
    const memory = inMemoryTransport(exchange);
    const workspace = yield* makeDesk(memory.transport);
    yield* observeScoped(workspace.$view);
    yield* TestClock.adjust(20);
    const first = workspace.tile("EURUSD");
    first.setNotional("1.000000000000000000001");
    yield* first.execute("buy").pipe(Effect.forkScoped);
    yield* TestClock.adjust(0);
    expect(untracked(realm, (read) => read(first.$execution))).toBe("pending");
    for (const tile of workspace.tiles.slice(1)) {
      expect(untracked(realm, (read) => read(tile.$canExecute))).toBe(true);
      expect(untracked(realm, (read) => read(tile.$notional))).toBe("1000000");
      yield* tile.execute("sell").pipe(Effect.forkScoped);
    }
    yield* TestClock.adjust(50);
    expect(
      untracked(realm, (read) => workspace.tiles.map((tile) => read(tile.$execution))),
    ).toEqual(["done", "done", "done", "done", "done"]);
    expect(untracked(realm, (read) => read(workspace.$view).positions) as unknown).toEqual(
      foldPositions(memory.log).positions,
    );
    const original = untracked(realm, (read) => read.row(workspace.trades.$trades, "local-1"));
    if (!original) throw new Error("missing first execution");
    // Direct accepted corrections exercise symbol, side, notional, and rate in one atomic edit.
    yield* workspace.trades.accept({
      ...original,
      symbol: "EURGBP",
      direction: "sell",
      notional: "2.000000000000000000003",
      rate: "0.85000",
      updatedAt: new Date(100).toISOString(),
    });
    expect(untracked(realm, (read) => read(workspace.positions.row("EURUSD").$value))).toBeNull();
    expect(untracked(realm, (read) => read(workspace.positions.$symbols))).toEqual([
      "GBPUSD",
      "USDJPY",
      "AUDUSD",
      "EURGBP",
    ]);
    workspace.trades.withdraw("local-1");
    expect(untracked(realm, (read) => read(workspace.positions.row("EURGBP").$value))?.net).toEqual(
      decimal("-1000000"),
    );
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("exact decimals, signed half-even cents, flat average, and terminal revisions", async () => {
  for (const [value, cents] of [
    ["0.005", 0n],
    ["0.015", 2n],
    ["-0.005", 0n],
    ["-0.015", -2n],
    ["12345678901234567890.125", 1234567890123456789012n],
  ] as const)
    expect(rounded(decimal(value), 2)).toBe(cents);
  expect(format(decimal("-0.015"), 2)).toBe("-0.02");
  using realm = testRealm();
  await Effect.gen(function* () {
    const memory = feed([], true);
    const workspace = yield* makeDesk(memory.transport);
    yield* observeScoped(workspace.$view);
    yield* TestClock.adjust(0);
    for (const [symbol, bid, ask] of [
      ["EURUSD", "1.00000", "1.00000"],
      ["GBPUSD", "1.00000", "1.00000"],
      ["USDJPY", "3.000", "3.000"],
      ["EURGBP", "1.00000", "1.00000"],
    ] as const)
      memory.send(`prices/${symbol}`, { symbol, bid, ask, time: new Date(0).toISOString() });
    yield* TestClock.adjust(0);
    for (const [id, symbol, notional, rate] of [
      ["first", "EURUSD", "1", "0.99500"],
      ["second", "GBPUSD", "1", "0.99500"],
      ["yen", "USDJPY", "1", "2.955"],
      ["cross", "EURGBP", "1", "0.98500"],
    ] as const)
      memory.send("trades", { ...wireTrade(id), symbol, notional, rate, status: "done" });
    yield* TestClock.adjust(0);
    // .005 -> .00 twice, .045 / 3 -> .02, .015 * 1 -> .02; sum rounded rows = .04.
    expect(untracked(realm, (read) => read(workspace.positions.$total))).toEqual({
      cents: 4n,
      complete: true,
    });
    expect(
      untracked(realm, (read) =>
        read(workspace.positions.$symbols).map((symbol) =>
          read(workspace.positions.row(symbol).$value),
        ),
      ) as unknown,
    ).toEqual(foldPositions(memory.log).positions);
    memory.send("trades", {
      ...wireTrade("opposite"),
      notional: "1",
      rate: "1.00500",
      direction: "sell",
      status: "done",
    });
    yield* TestClock.adjust(0);
    const row = workspace.positions.row("EURUSD");
    expect(untracked(realm, (read) => read(row.$value))?.average).toBeNull();
    expect(format(untracked(realm, (read) => read(row.$value))?.profitLoss ?? null, 3)).toBe(
      "0.010",
    );
    memory.send("trades", {
      ...wireTrade("first"),
      notional: "1",
      rate: "0.99500",
      status: "rejected",
      updatedAt: new Date(1).toISOString(),
    });
    yield* TestClock.adjust(0);
    expect(format(untracked(realm, (read) => read(row.$value))?.net ?? null, 0)).toBe("-1");
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});
