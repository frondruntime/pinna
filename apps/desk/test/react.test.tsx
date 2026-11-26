import { expect, test } from "bun:test";
import { Realm, Source } from "@frondruntime/pinna";
import { held, record, testRealm } from "@frondruntime/pinna/testing";
import { RealmService } from "@frondruntime/pinna-effect";
import { Effect, Exit, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { act, Profiler, type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Blotter } from "../src/client/blotter.tsx";
import { makeDesk } from "../src/client/desk.ts";
import { SpotTile } from "../src/client/spot-tile.tsx";
import { type PairSymbol, type Price, symbols } from "../src/client/wire.ts";
import { PositionsPanel, WorkspaceView } from "../src/client/workspace.tsx";
import { makeExchange } from "../src/exchange/index.ts";
import { inMemoryTransport } from "../src/transport.ts";
import { feed, wireTrade } from "./feed.ts";

function mount(element: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  let mounted = true;
  return {
    container,
    render(next: ReactNode) {
      act(() => root.render(next));
    },
    unmount() {
      if (!mounted) return;
      act(() => root.unmount());
      mounted = false;
      container.remove();
    },
    [Symbol.dispose]() {
      this.unmount();
    },
  };
}

/** Keep external-store updates inside act while retaining the Effect test services. */
const actEffect = <Value, Error, Requirements>(effect: Effect.Effect<Value, Error, Requirements>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Requirements>();
    yield* Effect.promise(() =>
      act(async () => {
        await Effect.runPromiseWith(context)(effect);
      }),
    );
  });

test("five-pair ticks and done trades render exactly their dependent tiles, rows, and total", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const history = symbols
      .filter((symbol) => symbol !== "AUDUSD")
      .map((symbol, index) => ({
        ...wireTrade(`held-${symbol}`, index),
        symbol,
        status: "done",
        rate: symbol === "USDJPY" ? "152.000" : symbol === "EURGBP" ? "0.85000" : "1.08000",
      }));
    const pending = { ...wireTrade("pending", 10), symbol: "EURGBP", rate: "0.85000" };
    const memory = feed([...history, pending], true);
    const workspace = yield* makeDesk(memory.transport);
    const tiles = new Map<PairSymbol, number>();
    const prices = new Map<PairSymbol, number>();
    const positions = new Map<PairSymbol, number>();
    const blotterRows = new Map<string, number>();
    let totals = 0;
    let blotters = 0;
    const countPosition = (symbol: PairSymbol) =>
      positions.set(symbol, (positions.get(symbol) ?? 0) + 1);
    const countTotal = () => {
      totals++;
    };
    const countBlotter = () => {
      blotters++;
    };
    const countBlotterRow = (id: string) => blotterRows.set(id, (blotterRows.get(id) ?? 0) + 1);
    const tileElements = workspace.tiles.map((tile) => (
      <SpotTile
        key={tile.pair.symbol}
        desk={tile}
        onRender={() => tiles.set(tile.pair.symbol, (tiles.get(tile.pair.symbol) ?? 0) + 1)}
        onPriceRender={() => prices.set(tile.pair.symbol, (prices.get(tile.pair.symbol) ?? 0) + 1)}
      />
    ));
    const panel = (
      <PositionsPanel
        positions={workspace.positions}
        onRowRender={countPosition}
        onTotalRender={countTotal}
      />
    );
    const blotter = (
      <Blotter book={workspace.trades} onRender={countBlotter} onRowRender={countBlotterRow} />
    );
    using view = mount(
      <>
        {tileElements}
        {panel}
        {blotter}
      </>,
    );
    yield* actEffect(TestClock.adjust(0));
    const clear = () => {
      tiles.clear();
      prices.clear();
      positions.clear();
      blotterRows.clear();
      totals = 0;
      blotters = 0;
    };
    const tick = (symbol: PairSymbol, bid: string, ask: string) =>
      actEffect(
        Effect.sync(() =>
          memory.send(`prices/${symbol}`, { symbol, bid, ask, time: new Date(1).toISOString() }),
        ).pipe(Effect.andThen(TestClock.adjust(0))),
      );
    const assertTick = (symbol: PairSymbol, affected: PairSymbol[]) => {
      expect([...tiles]).toEqual([[symbol, 1]]);
      expect([...prices]).toEqual([[symbol, 1]]);
      expect([...positions].sort()).toEqual(
        affected.map((symbol): [PairSymbol, number] => [symbol, 1]).sort(),
      );
      expect(totals).toBe(affected.length ? 1 : 0);
      expect(blotters).toBe(0);
      expect([...blotterRows]).toEqual([]);
    };
    clear();
    yield* tick("GBPUSD", "1.27000", "1.27010");
    assertTick("GBPUSD", ["GBPUSD", "EURGBP"]);
    clear();
    yield* tick("EURGBP", "0.85000", "0.85010");
    assertTick("EURGBP", ["EURGBP"]);
    clear();
    yield* tick("USDJPY", "152.000", "152.010");
    assertTick("USDJPY", ["USDJPY"]);
    clear();
    yield* tick("EURUSD", "1.08000", "1.08010");
    assertTick("EURUSD", ["EURUSD"]);
    clear();
    yield* tick("AUDUSD", "0.66000", "0.66010");
    assertTick("AUDUSD", []);
    clear();
    yield* actEffect(
      Effect.sync(() =>
        memory.send("trades", {
          ...pending,
          status: "done",
          updatedAt: new Date(20).toISOString(),
        }),
      ).pipe(Effect.andThen(TestClock.adjust(0))),
    );
    expect([...positions]).toEqual([["EURGBP", 1]]);
    expect(totals).toBe(1);
    expect([...blotterRows]).toEqual([["pending", 1]]);
    expect(blotters).toBe(0);
    expect([...tiles]).toEqual([]);
    expect([...prices]).toEqual([]);
    // The index and hidden-row guarantee also hold when a done trade is offscreen.
    act(() => {
      workspace.trades.setViewportHeight(0);
      workspace.trades.setScrollTop(10000);
    });
    yield* actEffect(TestClock.adjust(0));
    clear();
    yield* actEffect(
      Effect.sync(() =>
        memory.send("trades", {
          ...pending,
          status: "rejected",
          updatedAt: new Date(30).toISOString(),
        }),
      ).pipe(Effect.andThen(TestClock.adjust(0))),
    );
    expect([...positions]).toEqual([["EURGBP", 1]]);
    expect(totals).toBe(1);
    expect([...tiles]).toEqual([]);
    expect([...prices, ...blotterRows]).toEqual([]);
    expect(blotters).toBe(0);
    // Hide every price reader for AUD/USD, while keeping every other component mounted.
    view.render(
      <>
        {tileElements.filter((_, index) => index !== 3)}
        {panel}
        {blotter}
      </>,
    );
    workspace.closeTile("AUDUSD");
    yield* actEffect(TestClock.adjust(0));
    clear();
    yield* actEffect(TestClock.adjust(10));
    expect([...tiles, ...prices, ...positions, ...blotterRows]).toEqual([]);
    expect(totals).toBe(0);
    expect(blotters).toBe(0);
    expect(
      memory.log.filter(
        (entry) => entry.kind === "unsubscribe" && entry.address === "prices/AUDUSD",
      ),
    ).toHaveLength(1);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("market ticks render nothing with no position and no open tile", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const exchange = yield* makeExchange({
      seed: 9,
      historyTradeCount: 0,
      intervalMilliseconds: 10,
      otherDeskTradesPerSecond: 0,
    });
    const memory = inMemoryTransport(exchange);
    const workspace = yield* makeDesk(memory.transport);
    for (const symbol of symbols) workspace.closeTile(symbol);
    let renders = 0;
    using view = mount(
      <Profiler
        id="workspace"
        onRender={() => {
          renders++;
        }}
      >
        <WorkspaceView workspace={workspace} />
        <Blotter book={workspace.trades} />
      </Profiler>,
    );
    yield* actEffect(TestClock.adjust(0));
    const baseline = renders;
    yield* actEffect(TestClock.adjust(100));
    expect(renders).toBe(baseline);
    expect(exchange.subscriptionCount()).toBe(1); // trades only
    expect(memory.log.filter((entry) => entry.kind === "price")).toEqual([]);
    expect(view.container.querySelectorAll(".spot-tile")).toHaveLength(0);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("the price component renders exactly once per displayed change; typing renders it zero times", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    let send = (_raw: string): void => {
      throw new Error("not subscribed");
    };
    const memory = inMemoryTransport({
      request: () =>
        Effect.succeed(
          JSON.stringify([
            {
              symbol: "EURUSD",
              baseCurrency: "EUR",
              termsCurrency: "USD",
              pricePrecision: 5,
            },
          ]),
        ),
      subscribe: () =>
        Stream.callback<string>((queue) =>
          Effect.sync(() => {
            send = (raw) => {
              Queue.offerUnsafe(queue, raw);
            };
          }),
        ),
    });
    const desk = (yield* makeDesk(memory.transport)).tile("EURUSD");
    let renders = 0;
    const countRender = () => {
      renders++;
    };
    using view = mount(<SpotTile desk={desk} onPriceRender={countRender} />);
    yield* actEffect(TestClock.adjust(0));
    expect(renders).toBe(1);
    const tick = (bid: string, ask: string, milliseconds: number) =>
      actEffect(
        Effect.sync(() =>
          send(
            JSON.stringify({
              symbol: "EURUSD",
              bid,
              ask,
              time: new Date(milliseconds).toISOString(),
            }),
          ),
        ).pipe(Effect.andThen(TestClock.adjust(0))),
      );
    yield* tick("1.08000", "1.08010", 1);
    expect(renders).toBe(2);
    expect(view.container.textContent).toContain("1.0");
    yield* tick("1.08000", "1.08010", 2); // only the timestamp changes
    expect(renders).toBe(2);
    yield* tick("1.08001", "1.08011", 3);
    expect(renders).toBe(3);
    expect(view.container.querySelector('[aria-label="Price up"]')).not.toBeNull();
    yield* tick("1.08001", "1.08011", 4); // the marker changes to unchanged
    expect(renders).toBe(4);
    expect(view.container.querySelector('[aria-label="Price unchanged"]')).not.toBeNull();
    yield* tick("1.08001", "1.08011", 5);
    expect(renders).toBe(4);
    yield* tick("1.07999", "1.08009", 6);
    expect(renders).toBe(5);
    expect(view.container.querySelector('[aria-label="Price down"]')).not.toBeNull();
    const input = view.container.querySelector("input");
    if (input === null) throw new Error("missing notional input");
    for (const value of ["2", "25", "250", "2500"]) {
      act(() => {
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(input.value).toBe(value);
      expect(renders).toBe(5);
    }
    // A parent render restores the controlled value from React state, not the DOM.
    view.render(<SpotTile desk={desk} onPriceRender={countRender} />);
    expect(input.value).toBe("2500");
    expect(renders).toBe(5);
    // A subsequent price render must not discard the local input state.
    yield* tick("1.07998", "1.08008", 7);
    expect(renders).toBe(6);
    expect(input.value).toBe("2500");
    expect(
      memory.log.filter((entry) => entry.kind === "request").map((entry) => entry.address),
    ).toEqual(["/pairs", "/settings"]);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("unmounting the last tile clears its live quote; a later tile waits and remembers only movement history", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const exchange = yield* makeExchange({ seed: 21, intervalMilliseconds: 10 });
    const memory = inMemoryTransport(exchange);
    const desk = (yield* makeDesk(memory.transport)).tile("EURUSD");
    yield* TestClock.adjust(30);
    expect(exchange.subscriptionCount()).toBe(0);
    expect(memory.log.filter((entry) => entry.kind === "price")).toHaveLength(0);
    using first = mount(<SpotTile desk={desk} />);
    using second = mount(<SpotTile desk={desk} />);
    yield* actEffect(TestClock.adjust(10));
    expect(exchange.subscriptionCount()).toBe(1);
    expect(memory.log.filter((entry) => entry.kind === "price")).toHaveLength(1);
    first.unmount();
    yield* actEffect(TestClock.adjust(10));
    expect(exchange.subscriptionCount()).toBe(1);
    const retained = Realm.untracked(realm, (read) => read(desk.$prices));
    expect(retained.current).not.toBeNull();
    expect(
      second.container.querySelector<HTMLButtonElement>(".execution-buttons button")?.disabled,
    ).toBe(false);
    second.unmount();
    yield* TestClock.adjust(0);
    expect(exchange.subscriptionCount()).toBe(0);
    const messages = memory.log.length;
    yield* TestClock.adjust(10000);
    expect(memory.log).toHaveLength(messages);
    expect(Realm.untracked(realm, (read) => read(desk.$prices))).toEqual({
      current: null,
      previous: null,
      error: null,
    });
    using again = mount(
      <StrictMode>
        <SpotTile desk={desk} />
      </StrictMode>,
    );
    yield* actEffect(TestClock.adjust(0));
    expect(exchange.subscriptionCount()).toBe(1);
    expect(
      [...again.container.querySelectorAll(".quotes strong")].map((quote) => quote.textContent),
    ).toEqual(["—", "—"]);
    const buttons = [
      ...again.container.querySelectorAll<HTMLButtonElement>(".execution-buttons button"),
    ];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(Realm.untracked(realm, (read) => read(desk.$canExecute))).toBe(false);
    const requests = memory.log.filter((entry) => entry.kind === "request").length;
    act(() => {
      for (const button of buttons) button.click();
    });
    yield* desk.execute("buy");
    yield* desk.execute("sell");
    expect(memory.log.filter((entry) => entry.kind === "request")).toHaveLength(requests);
    yield* actEffect(TestClock.adjust(10));
    expect(exchange.subscriptionCount()).toBe(1);
    expect(Realm.untracked(realm, (read) => read(desk.$prices)).previous).toEqual(retained.current);
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    const current = Realm.untracked(realm, (read) => read(desk.$prices)).current;
    if (!current) throw new Error("missing fresh quote");
    expect(
      [...again.container.querySelectorAll(".quotes strong")].map((quote) => quote.textContent),
    ).toEqual([current.bid, current.ask]);
    again.unmount();
    yield* TestClock.adjust(0);
    expect(exchange.subscriptionCount()).toBe(0);
    expect(memory.log.filter((entry) => entry.kind === "subscribe")).toHaveLength(
      memory.log.filter((entry) => entry.kind === "unsubscribe").length,
    );
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("closing a priced workspace tile for ten seconds requires a fresh quote before trading", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const memory = feed();
    const workspace = yield* makeDesk(memory.transport);
    using view = mount(<WorkspaceView workspace={workspace} />);
    yield* actEffect(TestClock.adjust(0));
    const price = {
      symbol: "EURUSD",
      bid: "1.08000",
      ask: "1.08010",
      time: new Date(0).toISOString(),
    } as const;
    memory.send("prices/EURUSD", price);
    yield* actEffect(TestClock.adjust(0));
    const close = view.container.querySelector<HTMLButtonElement>('[aria-label="Close EURUSD"]');
    if (!close) throw new Error("missing Close EURUSD button");
    act(() => close.click());
    yield* actEffect(TestClock.adjust(10000));
    expect(view.container.querySelector(".spot-tile")).toBeNull();
    expect(
      memory.log.filter(
        (entry) => entry.address === "prices/EURUSD" && entry.kind === "unsubscribe",
      ),
    ).toHaveLength(1);
    const open = view.container.querySelector<HTMLButtonElement>("nav button");
    if (!open) throw new Error("missing Open EURUSD button");
    act(() => open.click());
    yield* actEffect(TestClock.adjust(0));
    expect(
      [...view.container.querySelectorAll(".quotes strong")].map((quote) => quote.textContent),
    ).toEqual(["—", "—"]);
    const buttons = [
      ...view.container.querySelectorAll<HTMLButtonElement>(".execution-buttons button"),
    ];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(
      Realm.untracked(realm, (read) => read(workspace.tile("EURUSD").$prices).current),
    ).toBeNull();
    const requests = memory.log.filter((entry) => entry.address === "/execute").length;
    act(() => {
      for (const button of buttons) button.click();
    });
    expect(memory.log.filter((entry) => entry.address === "/execute")).toHaveLength(requests);
    memory.send("prices/EURUSD", {
      ...price,
      bid: "1.08020",
      ask: "1.08030",
      time: new Date(10001).toISOString(),
    });
    yield* actEffect(TestClock.adjust(0));
    expect(
      [...view.container.querySelectorAll(".quotes strong")].map((quote) => quote.textContent),
    ).toEqual(["1.08020", "1.08030"]);
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    expect(view.container.querySelector('[aria-label="Price up"]')).not.toBeNull();
    expect(
      Realm.untracked(realm, (read) => read(workspace.tile("EURUSD").$prices).previous),
    ).toEqual(price);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("the price feed records exactly one coherent change per tick", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const memory = feed();
    const desk = (yield* makeDesk(memory.transport)).tile("EURUSD");
    using prices = record(realm, (read) => read(desk.$prices));
    yield* TestClock.adjust(0);
    expect(prices.values).toEqual([]);
    const ticks: Array<Price> = [0, 1, 2].map((milliseconds) => ({
      symbol: "EURUSD",
      bid: "1.08000",
      ask: "1.08010",
      time: new Date(milliseconds).toISOString(),
    }));
    for (const [index, current] of ticks.entries()) {
      memory.send("prices/EURUSD", current);
      yield* TestClock.adjust(0);
      expect(prices.values).toHaveLength(index + 1);
      expect(prices.values[index]).toEqual({
        current,
        previous: ticks[index - 1] ?? null,
        error: null,
      });
    }
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

for (const failure of [
  { name: "malformed", raw: '{"bid":12}', error: "SchemaError" },
  {
    name: "mismatched",
    raw: JSON.stringify({
      symbol: "GBPUSD",
      bid: "1.08000",
      ask: "1.08010",
      time: new Date(0).toISOString(),
    }),
    error: "price does not match topic",
  },
]) {
  test(`a ${failure.name} price keeps the last state and error while observed`, async () => {
    using realm = testRealm();
    await Effect.gen(function* () {
      const memory = feed();
      const desk = (yield* makeDesk(memory.transport)).tile("EURUSD");
      using prices = record(realm, (read) => read(desk.$prices));
      yield* TestClock.adjust(0);
      const current: Price = {
        symbol: "EURUSD",
        bid: "1.08000",
        ask: "1.08010",
        time: new Date(0).toISOString(),
      };
      memory.send("prices/EURUSD", current);
      yield* TestClock.adjust(0);
      memory.sendRaw("prices/EURUSD", failure.raw);
      yield* TestClock.adjust(0);
      const failed = Realm.untracked(realm, (read) => read(desk.$prices));
      expect(failed).toEqual({
        current,
        previous: null,
        error: expect.stringContaining(failure.error),
      });
      expect(memory.subscriptionCount()).toBe(0);
      expect(prices.values).toEqual([{ current, previous: null, error: null }, failed]);
      {
        using _another = held(Source.observe(desk.$display));
        yield* TestClock.adjust(10000);
        expect(Realm.untracked(realm, (read) => read(desk.$prices))).toEqual(failed);
        expect(prices.values).toHaveLength(2);
        expect(memory.log.filter((entry) => entry.kind === "subscribe")).toHaveLength(1);
      }
      prices.stop();
      expect(Realm.untracked(realm, (read) => read(desk.$prices))).toEqual({
        current: null,
        previous: null,
        error: null,
      });
      yield* TestClock.adjust(0);
      using _again = held(Source.observe(desk.$prices));
      yield* TestClock.adjust(0);
      const next = { ...current, time: new Date(10001).toISOString() };
      memory.send("prices/EURUSD", next);
      yield* TestClock.adjust(0);
      expect(Realm.untracked(realm, (read) => read(desk.$prices))).toEqual({
        current: next,
        previous: current,
        error: null,
      });
    }).pipe(
      Effect.provideService(RealmService, realm),
      Effect.scoped,
      Effect.provide(TestClock.layer()),
      Effect.runPromise,
    );
  });
}

test("the first tick after the last observer leaves keeps the earlier run's last price", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const memory = feed();
    const desk = (yield* makeDesk(memory.transport)).tile("EURUSD");
    const initial = { current: null, previous: null, error: null };
    const first: Price = {
      symbol: "EURUSD",
      bid: "1.08000",
      ask: "1.08010",
      time: new Date(0).toISOString(),
    };
    const last = { ...first, bid: "1.08020", ask: "1.08030", time: new Date(1).toISOString() };
    {
      using prices = record(realm, (read) => read(desk.$prices));
      using _another = held(Source.observe(desk.$display));
      yield* TestClock.adjust(0);
      expect(Realm.untracked(realm, (read) => read(desk.$prices))).toEqual(initial);
      memory.send("prices/EURUSD", first);
      yield* TestClock.adjust(0);
      memory.send("prices/EURUSD", last);
      yield* TestClock.adjust(0);
      prices.stop();
      yield* TestClock.adjust(0);
      expect(Realm.untracked(realm, (read) => read(desk.$prices))).toEqual({
        current: last,
        previous: first,
        error: null,
      });
      expect(memory.subscriptionCount()).toBe(1);
    }
    expect(Realm.untracked(realm, (read) => read(desk.$prices))).toEqual(initial);
    yield* TestClock.adjust(0);
    expect(memory.subscriptionCount()).toBe(0);
    using prices = record(realm, (read) => read(desk.$prices));
    yield* TestClock.adjust(0);
    expect(Realm.untracked(realm, (read) => read(desk.$prices))).toEqual(initial);
    expect(prices.values).toEqual([]);
    const next = { ...last, bid: "1.08040", ask: "1.08050", time: new Date(2).toISOString() };
    memory.send("prices/EURUSD", next);
    yield* TestClock.adjust(0);
    expect(prices.values).toEqual([{ current: next, previous: last, error: null }]);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("a malformed price is visible as an error and releases the subscription", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    let subscribed = false;
    const memory = inMemoryTransport({
      request: () =>
        Effect.succeed(
          '[{"symbol":"EURUSD","baseCurrency":"EUR","termsCurrency":"USD","pricePrecision":5}]',
        ),
      subscribe: () =>
        Stream.succeed('{"bid":12}').pipe(
          Stream.onStart(
            Effect.sync(() => {
              subscribed = true;
            }),
          ),
          Stream.ensuring(
            Effect.sync(() => {
              subscribed = false;
            }),
          ),
        ),
    });
    const desk = (yield* makeDesk(memory.transport)).tile("EURUSD");
    using _hold = held(Source.observe(desk.$display));
    yield* TestClock.adjust(0);
    expect(subscribed).toBe(false);
    expect(Realm.untracked(realm, (read) => read(desk.$display)).error).toContain("SchemaError");
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("blotter rows render exactly for their own adds and changes; trades never render the price", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const firstTrade = wireTrade("first", 1);
    const memory = feed([firstTrade]);
    const desk = (yield* makeDesk(memory.transport)).tile("EURUSD");
    const rowRenders = new Map<string, number>();
    const countRow = (id: string) => rowRenders.set(id, (rowRenders.get(id) ?? 0) + 1);
    let priceRenders = 0;
    const countPrice = () => {
      priceRenders++;
    };
    using view = mount(
      <>
        <SpotTile desk={desk} onPriceRender={countPrice} />
        <Blotter book={desk.trades} onRowRender={countRow} />
      </>,
    );
    yield* actEffect(TestClock.adjust(0));
    expect([...rowRenders]).toEqual([["first", 1]]);
    expect(priceRenders).toBe(1);
    const send = (topic: string, value: unknown) =>
      actEffect(
        Effect.sync(() => memory.send(topic, value)).pipe(Effect.andThen(TestClock.adjust(0))),
      );
    yield* send("trades", firstTrade); // snapshot/topic overlap is silent
    expect([...rowRenders]).toEqual([["first", 1]]);
    const secondTrade = wireTrade("second", 2);
    yield* send("trades", secondTrade);
    expect([...rowRenders]).toEqual([
      ["first", 1],
      ["second", 1],
    ]);
    expect(
      [...view.container.querySelectorAll("tbody tr")].map((row) =>
        row.getAttribute("data-trade-id"),
      ),
    ).toEqual(["second", "first"]);
    yield* send("trades", { ...firstTrade, status: "done", updatedAt: new Date(3).toISOString() });
    expect([...rowRenders]).toEqual([
      ["first", 2],
      ["second", 1],
    ]);
    yield* send("trades", {
      ...secondTrade,
      status: "rejected",
      updatedAt: new Date(4).toISOString(),
    });
    expect([...rowRenders]).toEqual([
      ["first", 2],
      ["second", 2],
    ]);
    expect(priceRenders).toBe(1);
    for (let tick = 0; tick < 3; tick++) {
      yield* send("prices/EURUSD", {
        symbol: "EURUSD",
        bid: `1.0800${tick}`,
        ask: `1.0801${tick}`,
        time: new Date(tick).toISOString(),
      });
      expect([...rowRenders]).toEqual([
        ["first", 2],
        ["second", 2],
      ]);
      expect(priceRenders).toBe(tick + 2);
    }
    view.unmount();
    yield* TestClock.adjust(0);
    expect(memory.subscriptionCount()).toBe(0);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("Buy and Sell use model input, disable invalid input and pending requests, and show the fill", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const exchange = yield* makeExchange({
      historyTradeCount: 0,
      seed: 18,
      intervalMilliseconds: 10,
      otherDeskTradeProbability: 0,
      rejectionProbability: 0,
      longDelayProbability: 0,
      executionLatencyMilliseconds: [100, 100],
    });
    const memory = inMemoryTransport(exchange);
    const desk = (yield* makeDesk(memory.transport)).tile("EURUSD");
    using view = mount(
      <>
        <SpotTile desk={desk} />
        <Blotter book={desk.trades} />
      </>,
    );
    yield* actEffect(TestClock.adjust(10));
    const input = view.container.querySelector("input");
    const [buy, sell] = view.container.querySelectorAll("button");
    if (!input || !buy || !sell) throw new Error("missing execution controls");
    for (const value of ["0", "-1", "invalid", "1e3", ""]) {
      act(() => {
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(buy.disabled).toBe(true);
      expect(sell.disabled).toBe(true);
    }
    act(() => {
      input.value = "2500.75";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(buy.disabled).toBe(false);
    const displayedAsk = view.container.querySelectorAll("strong")[1]?.textContent;
    act(() => buy.click());
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe("pending");
    expect(view.container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(buy.disabled).toBe(true);
    expect(sell.disabled).toBe(true);
    const request = memory.log.find(
      (entry) => entry.address === "/execute" && entry.kind === "request",
    );
    expect(JSON.parse(request?.raw ?? "{}")).toMatchObject({
      notional: "2500.75",
      direction: "buy",
      rate: displayedAsk,
    });
    yield* actEffect(TestClock.adjust(100));
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe("done");
    expect(view.container.querySelectorAll("tbody tr")).toHaveLength(1);
    yield* actEffect(TestClock.adjust(3000));
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe("idle");
    const displayedBid = view.container.querySelectorAll("strong")[0]?.textContent;
    act(() => sell.click());
    const second = memory.log.filter(
      (entry) => entry.address === "/execute" && entry.kind === "request",
    )[1];
    expect(JSON.parse(second?.raw ?? "{}")).toMatchObject({
      direction: "sell",
      rate: displayedBid,
    });
    view.unmount();
    yield* TestClock.adjust(0);
    expect(exchange.subscriptionCount()).toBe(0);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("unmount mid-request interrupts client work, closes every topic, and writes nothing later", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const exchange = yield* makeExchange({
      historyTradeCount: 0,
      seed: 18,
      intervalMilliseconds: 10,
      otherDeskTradeProbability: 0,
      rejectionProbability: 0,
      longDelayProbability: 1,
      longDelayMilliseconds: 4000,
    });
    const memory = inMemoryTransport(exchange);
    let interrupted = false;
    const desk = (yield* makeDesk({
      ...memory.transport,
      request: (path, body) =>
        memory.transport.request(path, body).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (path === "/execute" && Exit.isFailure(exit)) interrupted = true;
            }),
          ),
        ),
    })).tile("EURUSD");
    using executionValues = record(realm, (read) => read(desk.$execution));
    using tradeValues = record(realm, (read) => read(desk.trades.$trades.rows));
    using view = mount(
      <>
        <SpotTile desk={desk} />
        <Blotter book={desk.trades} />
      </>,
    );
    yield* actEffect(TestClock.adjust(10));
    expect(exchange.subscriptionCount()).toBe(2);
    const buy = view.container.querySelector("button");
    if (!buy) throw new Error("missing Buy button");
    act(() => buy.click());
    expect(Realm.untracked(realm, (read) => read(desk.$execution))).toBe("pending");
    expect(interrupted).toBe(false);
    view.unmount();
    const executionCount = executionValues.values.length;
    const tradeCount = tradeValues.values.length;
    yield* TestClock.adjust(0);
    expect(interrupted).toBe(true);
    expect(exchange.subscriptionCount()).toBe(0);
    expect(executionValues.values).toHaveLength(executionCount);
    expect(tradeValues.values).toHaveLength(tradeCount);
    const logLength = memory.log.length;
    yield* TestClock.adjust(8000);
    expect(executionValues.values).toHaveLength(executionCount);
    expect(tradeValues.values).toHaveLength(tradeCount);
    expect(memory.log).toHaveLength(logLength);
    expect(Realm.untracked(realm, (read) => read(desk.trades.$trades.rows))).toEqual([]);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("window renders only entering or changed visible rows; controls and ticks stay isolated; view state survives remount", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const history = Array.from({ length: 100 }, (_, index) => ({
      ...wireTrade(`window-${index}`, index),
      notional: String(index + 1),
    }));
    const memory = feed(history);
    const desk = (yield* makeDesk(memory.transport)).tile("EURUSD");
    const book = desk.trades;
    // Set application state without mounting or measuring layout.
    book.setViewportHeight(72);
    book.setScrollTop(360);
    const renders = new Map<string, number>();
    const count = (id: string) => renders.set(id, (renders.get(id) ?? 0) + 1);
    let priceRenders = 0;
    let blotterRenders = 0;
    const countPrice = () => {
      priceRenders++;
    };
    const countBlotter = () => {
      blotterRenders++;
    };
    const element = (
      <>
        <SpotTile desk={desk} onPriceRender={countPrice} />
        <Blotter book={book} onRowRender={count} onRender={countBlotter} />
      </>
    );
    using view = mount(element);
    yield* actEffect(TestClock.adjust(0));
    const rowIds = () =>
      [...view.container.querySelectorAll("[data-trade-id]")].map((row) =>
        row.getAttribute("data-trade-id"),
      );
    expect(rowIds()).toEqual([
      "window-92",
      "window-91",
      "window-90",
      "window-89",
      "window-88",
      "window-87",
      "window-86",
      "window-85",
    ]);
    expect([...renders.values()]).toEqual(Array(8).fill(1));
    expect(renders.has("window-0")).toBe(false);
    const priceBefore = priceRenders;
    renders.clear();
    yield* actEffect(
      book.accept({ ...history[90], status: "done", updatedAt: new Date(101).toISOString() }),
    );
    expect([...renders]).toEqual([["window-90", 1]]);
    renders.clear();
    yield* actEffect(
      book.accept({ ...history[0], status: "done", updatedAt: new Date(102).toISOString() }),
    );
    expect([...renders]).toEqual([]);
    const viewport = view.container.querySelector<HTMLDivElement>(".trade-table");
    if (!viewport) throw new Error("missing viewport");
    act(() => {
      viewport.scrollTop = 396;
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect([...renders]).toEqual([["window-84", 1]]);
    expect(rowIds()).toEqual([
      "window-91",
      "window-90",
      "window-89",
      "window-88",
      "window-87",
      "window-86",
      "window-85",
      "window-84",
    ]);
    renders.clear();
    const filter = view.container.querySelector<HTMLInputElement>('input[type="search"]');
    if (!filter) throw new Error("missing filter");
    act(() => {
      filter.value = "E";
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...renders]).toEqual([]); // All pairs match; retained rows keep their components.
    const sort = [...view.container.querySelectorAll<HTMLButtonElement>("th button")].find(
      (button) => button.textContent?.includes("Notional"),
    );
    if (!sort) throw new Error("missing Notional sort");
    act(() => sort.click());
    expect([...renders]).toEqual(
      Array.from({ length: 8 }, (_, index) => [`window-${8 + index}`, 1]),
    );
    expect(priceRenders).toBe(priceBefore);
    renders.clear();
    act(() => {
      filter.value = "9";
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...renders]).toEqual(
      [48, 49, 58, 59, 68, 69, 78, 79].map((index) => [`window-${index}`, 1]),
    );
    expect(rowIds()).toHaveLength(8);
    renders.clear();
    act(() => {
      filter.value = "E";
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...renders]).toEqual(
      Array.from({ length: 8 }, (_, index) => [`window-${8 + index}`, 1]),
    );
    expect(priceRenders).toBe(priceBefore);
    renders.clear();
    const beforeTick = blotterRenders;
    yield* actEffect(
      Effect.sync(() =>
        memory.send("prices/EURUSD", {
          symbol: "EURUSD",
          bid: "1.08000",
          ask: "1.08010",
          time: new Date(1).toISOString(),
        }),
      ).pipe(Effect.andThen(TestClock.adjust(0))),
    );
    expect([...renders]).toEqual([]);
    expect(blotterRenders).toBe(beforeTick);
    expect(priceRenders).toBe(priceBefore + 1);
    const rows = view.container.querySelectorAll<HTMLElement>("[data-trade-id]");
    const [first, second, third] = rows;
    if (!first || !second || !third) throw new Error("missing selection rows");
    act(() => first.click());
    act(() => second.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true })));
    act(() => third.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })));
    act(() => second.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true })));
    expect(Realm.untracked(realm, (read) => read(book.$selection))).toEqual([
      "window-8",
      "window-10",
    ]);
    const saved = Realm.untracked(realm, (read) => ({
      sort: read(book.$sort),
      filter: read(book.$filter),
      scrollTop: read(book.$scrollTop),
      height: read(book.$viewportHeight),
      selection: read(book.$selection),
      ids: read(book.$window).ids,
    }));
    view.unmount();
    yield* TestClock.adjust(0);
    expect(memory.subscriptionCount()).toBe(0);
    using remounted = mount(element);
    yield* actEffect(TestClock.adjust(0));
    expect(
      Realm.untracked(realm, (read) => ({
        sort: read(book.$sort),
        filter: read(book.$filter),
        scrollTop: read(book.$scrollTop),
        height: read(book.$viewportHeight),
        selection: read(book.$selection),
        ids: read(book.$window).ids,
      })),
    ).toEqual(saved);
    expect(remounted.container.querySelector<HTMLDivElement>(".trade-table")?.scrollTop).toBe(396);
    expect(remounted.container.querySelector('[aria-label="Selection summary"]')?.textContent).toBe(
      "2 selected · Buy 20 · Sell 0",
    );
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});
