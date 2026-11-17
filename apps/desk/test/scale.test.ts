import { expect, test } from "bun:test";
import { type Box, untracked } from "@frondruntime/pinna";
import { testRealm } from "@frondruntime/pinna/testing";
import { changes, observeScoped, RealmService } from "@frondruntime/pinna-effect";
import { Clock, Effect, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makeDesk } from "../src/client/desk.ts";
import { columns, rowHeight, type Sort, type TradeIndex } from "../src/client/trade-index.ts";
import type { TradeBook } from "../src/client/trades.ts";
import { makeExchange } from "../src/exchange/index.ts";
import { inMemoryTransport } from "../src/transport.ts";
import { feed, wireTrade } from "./feed.ts";
import { foldBlotter, foldLog, type OracleView } from "./oracle.ts";

const snapshot = (book: TradeBook) =>
  untracked(book.realm, (read) => ({
    heldCount: read(book.$heldCount),
    matchingCount: read(book.$matchingCount),
    window: read(book.$window),
    selectionSummary: read(book.$selectionSummary),
  }));

const randomGenerator = (seed: number) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};

test("10,000 history trades and 300 trades/second match the independent fold after every seeded step", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const exchange = yield* makeExchange({
      seed: 1729,
      historyTradeCount: 10000,
      intervalMilliseconds: 20,
      otherDeskTradesPerSecond: 300,
      executionLatencyMilliseconds: [30, 150],
      rejectionProbability: 0.3,
      longDelayProbability: 0,
    });
    const memory = inMemoryTransport(exchange);
    const desk = (yield* makeDesk(memory.transport)).tile("EURUSD");
    const book = desk.trades;
    yield* observeScoped(book.$window);
    yield* changes(book.$loaded).pipe(Stream.filter(Boolean), Stream.take(1), Stream.runDrain);
    expect(snapshot(book).heldCount).toBe(10000);
    const random = randomGenerator(81723);
    let view: OracleView = {
      sort: { column: "time", direction: "descending" },
      filter: "",
      scrollTop: 0,
      viewportHeight: 360,
      selection: [],
    };
    const compare = Effect.gen(function* () {
      const expected = foldBlotter(memory.log, view, yield* Clock.currentTimeMillis);
      expect(snapshot(book)).toEqual(expected);
    });
    yield* compare;
    const filters = ["", "d", "do", "done", "REJ", "desk-2", "1.08", "000", "eurusd", "no match"];
    const visited = new Set<string>();
    for (let step = 0; step < 40; step++) {
      yield* TestClock.adjust(20 + Math.floor(random() * 4) * 20);
      yield* compare;
      const action = step % 5;
      if (action === 0) {
        const sort: Sort = {
          column: columns[Math.floor(random() * columns.length)] ?? "time",
          direction: random() < 0.5 ? "ascending" : "descending",
        };
        visited.add(sort.column);
        book.setSort(sort);
        view = { ...view, sort };
      } else if (action === 1) {
        const filter = filters[Math.floor(random() * filters.length)] ?? "";
        book.setFilter(filter);
        view = { ...view, filter };
      } else if (action === 2) {
        const scrollTop =
          Math.floor(random() * 12000) * rowHeight + Math.floor(random() * rowHeight);
        book.setScrollTop(scrollTop);
        view = { ...view, scrollTop };
      } else if (action === 3) {
        const viewportHeight = [0, 1, 72, 180, 360, 721][Math.floor(random() * 6)] ?? 360;
        book.setViewportHeight(viewportHeight);
        view = { ...view, viewportHeight };
      } else {
        const ids = foldLog(memory.log).trades.map((trade) => trade.id);
        const selection = Array.from(
          { length: 3 },
          () => ids[Math.floor(random() * ids.length)] ?? "missing",
        );
        book.setSelection(selection);
        view = { ...view, selection: [...new Set(selection)] };
      }
      yield* compare;
    }
    expect(visited.size).toBeGreaterThanOrEqual(4);
    expect(snapshot(book).heldCount).toBeGreaterThan(10500);
    const history = foldLog(memory.log).trades.filter((trade) => Date.parse(trade.createdAt) < 0);
    expect(new Set(history.map((trade) => trade.status))).toEqual(
      new Set(["pending", "done", "rejected"]),
    );
    expect(new Set(history.map((trade) => trade.desk)).size).toBe(4);
    expect(Math.min(...history.map((trade) => Date.parse(trade.createdAt)))).toBeLessThan(
      -3 * 3600000,
    );
    const updates = memory.log
      .filter((entry) => entry.kind === "trade")
      .map((entry) => JSON.parse(entry.raw));
    const firstId = updates[0]?.id;
    expect(updates.filter((trade) => trade.id === firstId).length).toBe(3);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
}, 10000);

test("every column has a total order; decimals retain precision, and selection survives views and withdrawal", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const memory = feed([
      { ...wireTrade("small", 1), notional: "2", rate: "2.00000" },
      { ...wireTrade("large", 2), notional: "10", rate: "10.00000", direction: "sell" },
      { ...wireTrade("precise", 3), notional: "2.000000000000000000001", rate: "2.00001" },
      { ...wireTrade("tie-a", 4), notional: "02.0", rate: "2.00000" },
      { ...wireTrade("tie-z", 4), notional: "2.00", rate: "2.00000" },
    ]);
    const desk = (yield* makeDesk(memory.transport)).tile("EURUSD");
    const book = desk.trades;
    yield* observeScoped(book.$window);
    yield* TestClock.adjust(0);
    for (const column of columns)
      for (const direction of ["ascending", "descending"] as const) {
        const sort = { column, direction };
        book.setSort(sort);
        expect(snapshot(book)).toEqual(
          foldBlotter(memory.log, {
            sort,
            filter: "",
            scrollTop: 0,
            viewportHeight: 360,
            selection: [],
          }),
        );
      }
    book.setSort({ column: "notional", direction: "ascending" });
    expect(untracked(realm, (read) => read(book.$keys))).toEqual([
      "tie-z",
      "tie-a",
      "small",
      "precise",
      "large",
    ]);
    book.select("small");
    book.select("large", true);
    book.select("precise", true);
    book.select("precise", true);
    book.setSort({ column: "desk", direction: "ascending" });
    book.setFilter("no match");
    expect(snapshot(book).selectionSummary).toEqual({ count: 2, buy: "2", sell: "10" });
    expect(untracked(realm, (read) => read(book.$selection))).toEqual(["small", "large"]);
    book.withdraw("small");
    expect(snapshot(book).selectionSummary).toEqual({ count: 1, buy: "0", sell: "10" });
    book.select("large");
    book.select("missing");
    book.setSelection(["large", "large", "missing"]);
    expect(untracked(realm, (read) => read(book.$selection))).toEqual(["large"]);
    expect(() => book.setScrollTop(-1)).toThrow("the box rejects this value");
    expect(() => book.setViewportHeight(Number.NaN)).toThrow("the box rejects this value");
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

/** Audit retained key tables directly, rather than equating a bounded row count with no leaks. */
function assertBookRetention(book: TradeBook) {
  untracked(book.realm, (read) => {
    const rows = read(book.$trades.rows);
    const held = new Map(rows.map((trade) => [trade.id, trade]));
    expect(read(book.$heldCount)).toBe(held.size);
    expect(read(book.$selection).every((id) => held.has(id))).toBe(true);
    for (const property of ["held", "cells", "rowsByKey"]) {
      const table = Reflect.get(book.$trades, property) as Map<string, unknown>;
      expect([...table.keys()].every((id) => held.has(id))).toBe(true);
      expect(table.size).toBeLessThanOrEqual(held.size);
    }
    for (const value of Object.values(book)) {
      if (value instanceof Map || value instanceof Set)
        expect([...value.keys()].every((id) => held.has(id))).toBe(true);
    }
    const auditTree = (tree: TradeIndex | undefined): number => {
      if (!tree) return 0;
      expect(held.get(tree.trade.id)).toBe(tree.trade);
      return 1 + auditTree(tree.left) + auditTree(tree.right);
    };
    for (const property of ["$index", "$order"])
      expect(auditTree(read(Reflect.get(book, property) as Box<TradeIndex | undefined>))).toBe(
        held.size,
      );
  });
}

test("long seeded execution run retains no withdrawn IDs or per-trade tables beyond held trades", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const exchange = yield* makeExchange({
      seed: 23213,
      historyTradeCount: 0,
      intervalMilliseconds: 1000,
      otherDeskTradeProbability: 0,
      rejectionProbability: 0.5,
      longDelayProbability: 0.35,
      longDelayMilliseconds: 2600,
      executionLatencyMilliseconds: [10, 20],
    });
    const memory = inMemoryTransport(exchange);
    const desk = (yield* makeDesk(memory.transport)).tile("EURUSD");
    yield* observeScoped(desk.$display);
    yield* observeScoped(desk.trades.$window);
    yield* TestClock.adjust(1000);
    const outcomes = new Set<string>();
    for (let execution = 0; execution < 100; execution++) {
      yield* desk.execute(execution % 2 === 0 ? "buy" : "sell").pipe(Effect.forkScoped);
      yield* TestClock.adjust(0);
      const pending = untracked(realm, (read) =>
        read(desk.trades.$keys).find(
          (id) => read.row(desk.trades.$trades, id)?.status === "pending",
        ),
      );
      if (pending) desk.trades.select(pending);
      yield* TestClock.adjust(2000);
      outcomes.add(untracked(realm, (read) => read(desk.$execution)));
      assertBookRetention(desk.trades);
      yield* TestClock.adjust(3100);
      assertBookRetention(desk.trades);
      // Force all held rows to leave: collection cells and index entries must leave too.
      for (const id of untracked(realm, (read) => read(desk.trades.$keys)))
        desk.trades.withdraw(id);
      assertBookRetention(desk.trades);
    }
    expect(outcomes).toEqual(new Set(["done", "rejected", "timed out"]));
    expect(snapshot(desk.trades).heldCount).toBe(0);
    // A stale snapshot and topic echo cannot resurrect a withdrawn local pending order.
    yield* desk.trades.accept({ ...wireTrade("local-1"), desk: "local" });
    yield* desk.trades.acceptSnapshot([{ ...wireTrade("local-1"), desk: "local" }]);
    expect(snapshot(desk.trades).heldCount).toBe(0);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("the default exchange snapshot has 1,000 seeded trades; 100,000 loads through the same client path", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const defaults = yield* makeExchange({ seed: 1 });
    expect(JSON.parse(yield* defaults.request("/trades", ""))).toHaveLength(1000);
    const exchange = yield* makeExchange({ seed: 1, historyTradeCount: 100000 });
    const desk = (yield* makeDesk(inMemoryTransport(exchange).transport)).tile("EURUSD");
    yield* observeScoped(desk.trades.$window);
    yield* changes(desk.trades.$loaded).pipe(
      Stream.filter(Boolean),
      Stream.take(1),
      Stream.runDrain,
    );
    expect(snapshot(desk.trades).heldCount).toBe(100000);
    expect(snapshot(desk.trades).window.ids).toHaveLength(13);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});
