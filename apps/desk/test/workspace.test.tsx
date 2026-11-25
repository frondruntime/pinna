import { expect, test } from "bun:test";
import { type Read, Realm } from "@frondruntime/pinna";
import { held, record, testRealm } from "@frondruntime/pinna/testing";
import { RealmService } from "@frondruntime/pinna-effect";
import { Effect, Exit, Schema } from "effect";
import { TestClock } from "effect/testing";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { makeDesk } from "../src/client/desk.ts";
import { LayoutList, LayoutsPanel } from "../src/client/layouts-panel.tsx";
import { type PairSymbol, symbols } from "../src/client/wire.ts";
import { WorkspaceView } from "../src/client/workspace.tsx";
import {
  browserWorkspaceStore,
  defaultWorkspace,
  LayoutData,
  readSavedDesk,
  type SavedDesk,
  WorkspaceData,
  type WorkspaceStore,
} from "../src/client/workspace-data.ts";
import { makeExchange } from "../src/exchange/index.ts";
import { inMemoryTransport } from "../src/transport.ts";
import { feed, wireTrade } from "./feed.ts";

class MemoryStore implements WorkspaceStore {
  readonly saves: string[] = [];
  loads = 0;
  constructor(public value: string | null = null) {}
  load() {
    this.loads++;
    return this.value;
  }
  save(text: string) {
    this.saves.push(text);
    this.value = text;
  }
}
const saved = (workspace: WorkspaceData): SavedDesk => ({
  version: 2,
  workspace,
  layouts: [],
  activeLayoutId: null,
});
const settleStorage = () => Effect.promise(() => Promise.resolve());
const quote = { symbol: "EURUSD", bid: "1.08000", ask: "1.08010", time: new Date(0).toISOString() };
function mount(element: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    [Symbol.dispose]() {
      act(() => root.unmount());
      container.remove();
    },
  };
}
const actEffect = <Value, Error, Requirements>(effect: Effect.Effect<Value, Error, Requirements>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Requirements>();
    yield* Effect.promise(() =>
      act(async () => {
        await Effect.runPromiseWith(context)(effect);
      }),
    );
  });

test("corrupted saves start with defaults and report the root JSON failure", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const store = new MemoryStore("{not JSON");
    const workspace = yield* makeDesk(feed([], true).transport, store);
    expect(Realm.untracked(realm, (read) => read(workspace.layouts.$snapshot))).toEqual(
      defaultWorkspace(symbols),
    );
    expect(Realm.untracked(realm, (read) => read(workspace.layouts.$dropped))).toEqual([
      { path: "$", reason: "invalid JSON; used default workspace" },
    ]);
    yield* settleStorage();
    expect(store.saves).toEqual([]);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("version 1 migrates slash pair names in order, with defaults and precise dropped rows", async () => {
  for (const legacy of [
    ["GBP/USD", "EUR/USD", "NZD/USD", "GBP/USD"],
    { version: 1, openTiles: ["GBP/USD", "EUR/USD", "NZD/USD", "GBP/USD"] },
  ]) {
    using realm = testRealm();
    await Effect.gen(function* () {
      const store = new MemoryStore(JSON.stringify(legacy));
      const workspace = yield* makeDesk(feed([], true).transport, store);
      expect(Realm.untracked(realm, (read) => read(workspace.layouts.$snapshot))).toEqual({
        ...defaultWorkspace(symbols),
        tiles: [
          { symbol: "GBPUSD", notional: "1000000" },
          { symbol: "EURUSD", notional: "1000000" },
        ],
      });
      const prefix = Array.isArray(legacy) ? "$" : "$.openTiles";
      expect(Realm.untracked(realm, (read) => read(workspace.layouts.$dropped))).toEqual([
        { path: `${prefix}[2]`, reason: "pair is not listed; dropped tile" },
        { path: `${prefix}[3]`, reason: "duplicate pair; dropped tile" },
      ]);
      yield* settleStorage();
      expect(store.saves).toEqual([]);
    }).pipe(
      Effect.provideService(RealmService, realm),
      Effect.scoped,
      Effect.provide(TestClock.layer()),
      Effect.runPromise,
    );
  }
});

test("untrusted workspace and layout rows retain every valid neighbor and report paths and reasons", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const valid = { ...defaultWorkspace(symbols), positionsShown: false };
    const input = {
      ...saved(valid),
      workspace: {
        ...valid,
        tiles: [
          { symbol: "GBPUSD", notional: "2.50" },
          { symbol: "NZDUSD", notional: "5" },
          { symbol: "EURUSD", notional: "-1" },
          { symbol: "GBPUSD", notional: "8" },
        ],
        blotter: {
          sort: { column: "unknown", direction: "ascending" },
          filter: "local",
          scrollTop: 720,
        },
      },
      layouts: [
        { id: "first", name: "Morning", workspace: valid },
        {
          id: "second",
          name: "Evening",
          workspace: {
            ...valid,
            positionsShown: "no",
            blotter: { sort: { column: "rate", direction: "wrong" }, filter: 5, scrollTop: -1 },
          },
        },
        { id: "third", name: " Morning ", workspace: valid },
        { id: "first", name: "Duplicate identifier", workspace: valid },
        null,
      ],
      activeLayoutId: "missing",
    };
    // AUD/USD is a known schema symbol, but is no longer listed by this transport.
    input.workspace.tiles.push({ symbol: "AUDUSD", notional: "1" });
    const memory = feed([], true);
    const transport = {
      ...memory.transport,
      request: (path: string, body: string) =>
        path === "/pairs"
          ? Effect.succeed(
              JSON.stringify([
                { symbol: "EURUSD", baseCurrency: "EUR", termsCurrency: "USD", pricePrecision: 5 },
                { symbol: "GBPUSD", baseCurrency: "GBP", termsCurrency: "USD", pricePrecision: 5 },
              ]),
            )
          : memory.transport.request(path, body),
    };
    const workspace = yield* makeDesk(transport, new MemoryStore(JSON.stringify(input)));
    const recovered = Realm.untracked(realm, (read) => read(workspace.layouts.$snapshot));
    expect(recovered).toEqual({
      tiles: [
        { symbol: "GBPUSD", notional: "2.50" },
        { symbol: "EURUSD", notional: "1000000" },
      ],
      positionsShown: false,
      blotter: {
        sort: { column: "time", direction: "ascending" },
        filter: "local",
        scrollTop: 720,
      },
    });
    const dropped = Realm.untracked(realm, (read) => read(workspace.layouts.$dropped));
    expect(dropped).toEqual([
      { path: "$.workspace.tiles[1].symbol", reason: "pair is not listed; dropped tile" },
      {
        path: "$.workspace.tiles[2].notional",
        reason: "expected a positive decimal string; used default notional",
      },
      { path: "$.workspace.tiles[3].symbol", reason: "duplicate pair; dropped tile" },
      { path: "$.workspace.tiles[4].symbol", reason: "pair is not listed; dropped tile" },
      {
        path: "$.workspace.blotter.sort.column",
        reason: "unknown sort column; used default column",
      },
      ...[0, 1].flatMap((index) =>
        ["USDJPY", "AUDUSD", "EURGBP"].map((_, offset) => ({
          path: `$.layouts[${index}].workspace.tiles[${offset + 2}].symbol`,
          reason: "pair is not listed; dropped tile",
        })),
      ),
      {
        path: "$.layouts[1].workspace.positionsShown",
        reason: "expected a boolean; used default visibility",
      },
      {
        path: "$.layouts[1].workspace.blotter.sort.direction",
        reason: "unknown sort direction; used default direction",
      },
      { path: "$.layouts[1].workspace.blotter.filter", reason: "expected text; used empty filter" },
      {
        path: "$.layouts[1].workspace.blotter.scrollTop",
        reason: "expected a finite nonnegative number; used zero",
      },
      { path: "$.layouts[2].name", reason: "empty or duplicate name; dropped layout" },
      { path: "$.layouts[3].id", reason: "invalid or duplicate identifier; dropped layout" },
      { path: "$.layouts[4]", reason: "expected an object; dropped layout" },
      { path: "$.activeLayoutId", reason: "layout does not exist; cleared active layout" },
    ]);
    expect(Schema.is(WorkspaceData)(recovered)).toBe(true);
    const layouts = Realm.untracked(realm, (read) => read(workspace.layouts.$layouts.rows));
    expect(layouts.map((layout) => layout.name)).toEqual(["Morning", "Evening"]);
    expect(layouts.every(Schema.is(LayoutData))).toBe(true);
    expect(layouts[1]?.workspace.blotter).toEqual({
      sort: { column: "rate", direction: "descending" },
      filter: "",
      scrollTop: 0,
    });
    expect(Realm.untracked(realm, (read) => read(workspace.layouts.$activeId))).toBeNull();
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("restore finishes before watching, one interaction saves once, rollback and market state save nothing", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const initial = {
      ...defaultWorkspace(symbols),
      tiles: [{ symbol: "EURUSD" as const, notional: "25" }],
      positionsShown: false,
      blotter: {
        sort: { column: "notional" as const, direction: "ascending" as const },
        filter: "",
        scrollTop: 360,
      },
    };
    const store = new MemoryStore(
      JSON.stringify({
        ...saved(initial),
        layouts: [{ id: "held", name: "Held", workspace: initial }],
        activeLayoutId: "held",
      }),
    );
    const memory = feed([], true);
    const workspace = yield* makeDesk(memory.transport, store);
    expect(store.loads).toBe(1);
    expect(Realm.untracked(realm, (read) => read(workspace.layouts.$snapshot))).toEqual(initial);
    yield* settleStorage();
    expect(store.saves).toEqual([]);
    workspace.tile("EURUSD").setNotional("30");
    workspace.tile("EURUSD").setNotional("35");
    workspace.showPositions(true);
    workspace.trades.setFilter("another");
    workspace.trades.setScrollTop(720);
    expect(store.saves).toEqual([]);
    yield* settleStorage();
    expect(store.saves).toHaveLength(1);
    const persisted = JSON.parse(store.saves[0] ?? "null");
    expect(persisted.workspace).toEqual(
      Realm.untracked(realm, (read) => read(workspace.layouts.$snapshot)),
    );
    expect(persisted.layouts).toEqual([{ id: "held", name: "Held", workspace: initial }]);
    expect(persisted.activeLayoutId).toBe("held");
    expect(Object.keys(persisted.workspace)).toEqual(["tiles", "positionsShown", "blotter"]);
    expect(() =>
      Realm.update(realm, () => {
        workspace.tile("EURUSD").setNotional("40");
        workspace.closeTile("EURUSD");
        throw new Error("refused workspace");
      }),
    ).toThrow("refused workspace");
    yield* settleStorage();
    expect(store.saves).toHaveLength(1);
    using _live = held(
      Realm.watch(
        realm,
        (read) => read(workspace.$view),
        () => {},
      ),
    );
    yield* TestClock.adjust(0);
    memory.send("prices/EURUSD", quote);
    yield* TestClock.adjust(0);
    yield* workspace.trades.accept(wireTrade("unpersisted"));
    workspace.trades.select("unpersisted");
    workspace.trades.setViewportHeight(72);
    yield* settleStorage();
    expect(store.saves).toHaveLength(1);
    const restored = yield* makeDesk(feed([], true).transport, new MemoryStore(store.value));
    expect(Realm.untracked(realm, (read) => read(restored.layouts.$snapshot))).toEqual(
      persisted.workspace,
    );
    expect(Realm.untracked(realm, (read) => read(restored.trades.$selection))).toEqual([]);
    expect(
      Realm.untracked(realm, (read) => read(restored.tile("EURUSD").$prices).current),
    ).toBeNull();
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("named layouts save, switch, rename and delete with unique names and persisted active and modified state", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const store = new MemoryStore();
    const workspace = yield* makeDesk(feed([], true).transport, store);
    const layouts = workspace.layouts;
    const morning = layouts.save(" Morning ");
    expect(() => layouts.save("Morning")).toThrow("already exists");
    expect(() => layouts.save("  ")).toThrow("Enter a layout name");
    workspace.closeTile("GBPUSD");
    workspace.tile("EURUSD").setNotional("12");
    expect(Realm.untracked(realm, (read) => read(layouts.$modified))).toBe(true);
    const evening = layouts.save("Evening");
    expect(Realm.untracked(realm, (read) => read(layouts.$modified))).toBe(false);
    layouts.switchTo(morning);
    expect(Realm.untracked(realm, (read) => read(layouts.$snapshot))).toEqual(
      defaultWorkspace(symbols),
    );
    layouts.rename(morning, "London");
    expect(() => layouts.rename(morning, "Evening")).toThrow("already exists");
    expect(
      Realm.untracked(realm, (read) => read(layouts.$layouts.rows).map((layout) => layout.name)),
    ).toEqual(["London", "Evening"]);
    layouts.delete(evening);
    expect(Realm.untracked(realm, (read) => read(layouts.$activeId))).toBe(morning);
    workspace.tile("EURUSD").setNotional("50");
    yield* settleStorage();
    expect(store.saves).toHaveLength(1);
    const restored = yield* makeDesk(feed([], true).transport, new MemoryStore(store.value));
    expect(Realm.untracked(realm, (read) => read(restored.layouts.$activeId))).toBe(morning);
    expect(Realm.untracked(realm, (read) => read(restored.layouts.$modified))).toBe(true);
    restored.layouts.delete(morning);
    expect(Realm.untracked(realm, (read) => read(restored.layouts.$activeId))).toBeNull();
    expect(Realm.untracked(realm, (read) => read(restored.layouts.$layouts.keys))).toEqual([]);
    expect(Realm.untracked(realm, (read) => read(restored.tile("EURUSD").$notional))).toBe("50");
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("switches preserve shared quotes and subscriptions and every synchronous receipt is old or new", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const memory = feed([], true);
    const workspace = yield* makeDesk(memory.transport, new MemoryStore());
    const layouts = workspace.layouts;
    workspace.showPositions(false);
    workspace.closeTile("USDJPY");
    workspace.closeTile("AUDUSD");
    workspace.closeTile("EURGBP");
    const first = layouts.save("First");
    workspace.closeTile("GBPUSD");
    workspace.openTile("AUDUSD");
    workspace.tile("EURUSD").setNotional("123.45");
    workspace.trades.setSort({ column: "rate", direction: "ascending" });
    workspace.trades.setFilter("local");
    workspace.trades.setScrollTop(720);
    const second = layouts.save("Second");
    layouts.switchTo(first);
    const select = (read: Read) => ({
      workspace: read(layouts.$snapshot),
      active: read(layouts.$activeId),
      view: read(workspace.$view),
    });
    using states = record(realm, select);
    yield* TestClock.adjust(0);
    memory.send("prices/EURUSD", quote);
    memory.send("prices/GBPUSD", { ...quote, symbol: "GBPUSD", bid: "1.27000", ask: "1.27010" });
    yield* TestClock.adjust(0);
    const old = Realm.untracked(realm, select);
    const shared = workspace.tile("EURUSD");
    const price = Realm.untracked(realm, (read) => read(shared.$prices));
    const receipts: ReturnType<typeof select>[] = [];
    const capture = (): undefined => {
      receipts.push(Realm.untracked(realm, select));
    };
    const stops = [
      Realm.watch(realm, (read) => read(workspace.$openSymbols), capture),
      Realm.watch(realm, (read) => read(shared.$notional), capture),
      Realm.watch(realm, (read) => read(workspace.trades.$sort), capture),
      Realm.watch(realm, (read) => read(workspace.trades.$filter), capture),
      Realm.watch(realm, (read) => read(workspace.trades.$scrollTop), capture),
      Realm.watch(realm, (read) => read(layouts.$activeId), capture),
      Realm.watch(realm, (read) => read(workspace.$view), capture),
    ];
    using _receipts = held(() => {
      for (const stop of stops) stop();
    });
    const countBefore = states.values.length;
    const logBefore = memory.log.length;
    layouts.switchTo(second);
    const next = Realm.untracked(realm, select);
    expect(receipts.length).toBeGreaterThanOrEqual(6);
    expect(states.values.slice(countBefore)).toEqual([next]);
    for (const receipt of receipts) expect([old, next]).toContainEqual(receipt);
    expect(workspace.tile("EURUSD")).toBe(shared);
    expect(Realm.untracked(realm, (read) => read(shared.$prices))).toBe(price);
    yield* TestClock.adjust(0);
    const traffic = memory.log
      .slice(logBefore)
      .filter((entry) => entry.kind === "subscribe" || entry.kind === "unsubscribe")
      .map((entry) => `${entry.kind}:${entry.address}`);
    expect(traffic.sort()).toEqual(["subscribe:prices/AUDUSD", "unsubscribe:prices/GBPUSD"]);
    const count = states.values.length;
    layouts.switchTo(second);
    yield* TestClock.adjust(0);
    expect(states.values).toHaveLength(count);
    expect(
      Realm.untracked(realm, (read) => read(workspace.tile("GBPUSD").$prices).current),
    ).toBeNull();
    layouts.switchTo(first);
    yield* TestClock.adjust(0);
    expect(Realm.untracked(realm, (read) => read(shared.$prices))).toBe(price);
    expect(
      Realm.untracked(realm, (read) => read(workspace.tile("GBPUSD").$prices).current),
    ).toBeNull();
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("a layout closing an execution in flight withdraws it and prevents late client writes", async () => {
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
    const workspace = yield* makeDesk({
      ...memory.transport,
      request: (path, body) =>
        memory.transport.request(path, body).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (path === "/execute" && Exit.isFailure(exit)) interrupted = true;
            }),
          ),
        ),
    });
    workspace.showPositions(false);
    workspace.closeTile("EURUSD");
    const closed = workspace.layouts.save("Closed");
    workspace.openTile("EURUSD");
    using view = mount(<WorkspaceView workspace={workspace} />);
    yield* actEffect(TestClock.adjust(10));
    const tile = workspace.tile("EURUSD");
    act(() =>
      tile.startExecution("buy", Realm.untracked(realm, (read) => read(tile.$display)).ask),
    );
    expect(Realm.untracked(realm, (read) => read(tile.$execution))).toBe("pending");
    using executions = record(realm, (read) => read(tile.$execution));
    using trades = record(realm, (read) => read(workspace.trades.$trades.rows));
    expect(() =>
      Realm.update(realm, () => {
        workspace.layouts.switchTo(closed);
        throw new Error("refused layout");
      }),
    ).toThrow("refused layout");
    expect(Realm.untracked(realm, (read) => read(tile.$execution))).toBe("pending");
    expect(Realm.untracked(realm, (read) => read(workspace.trades.$trades.rows))).toHaveLength(1);
    expect(Realm.untracked(realm, (read) => read(workspace.$openSymbols))).toContain("EURUSD");
    expect(interrupted).toBe(false);
    expect(executions.values).toEqual([]);
    expect(trades.values).toEqual([]);
    act(() => workspace.layouts.switchTo(closed));
    expect(Realm.untracked(realm, (read) => read(tile.$execution))).toBe("idle");
    expect(Realm.untracked(realm, (read) => read(workspace.trades.$trades.rows))).toEqual([]);
    yield* actEffect(TestClock.adjust(0));
    expect(interrupted).toBe(true);
    expect(
      memory.log.filter(
        (entry) => entry.kind === "unsubscribe" && entry.address === "prices/EURUSD",
      ),
    ).toHaveLength(1);
    const executionCount = executions.values.length;
    const tradeCount = trades.values.length;
    yield* actEffect(TestClock.adjust(8000));
    expect(executions.values).toHaveLength(executionCount);
    expect(trades.values).toHaveLength(tradeCount);
    expect(view.container.querySelector('[aria-label="EUR/USD spot"]')).toBeNull();
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("switch and typing render exactly changed tiles and marks, with zero layouts list or row renders", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const memory = feed([], true);
    const workspace = yield* makeDesk(memory.transport, new MemoryStore());
    workspace.showPositions(false);
    const first = workspace.layouts.save("First");
    workspace.closeTile("GBPUSD");
    workspace.tile("EURUSD").setNotional("25");
    const second = workspace.layouts.save("Second");
    workspace.layouts.switchTo(first);
    const tileRenders: PairSymbol[] = [];
    const rowRenders: string[] = [];
    const statusRenders: string[] = [];
    let listRenders = 0;
    using view = mount(
      <>
        <WorkspaceView workspace={workspace} onTileRender={(symbol) => tileRenders.push(symbol)} />
        <LayoutList
          layouts={workspace.layouts}
          onRender={() => listRenders++}
          onRowRender={(id) => rowRenders.push(id)}
          onStatusRender={(id) => statusRenders.push(id)}
        />
      </>,
    );
    yield* actEffect(TestClock.adjust(0));
    memory.send("prices/EURUSD", quote);
    yield* actEffect(TestClock.adjust(0));
    tileRenders.length = 0;
    rowRenders.length = 0;
    statusRenders.length = 0;
    listRenders = 0;
    act(() => workspace.layouts.switchTo(second));
    yield* actEffect(TestClock.adjust(0));
    expect(tileRenders).toEqual(["EURUSD"]);
    expect(rowRenders).toEqual([]);
    expect(listRenders).toBe(0);
    expect(statusRenders.sort()).toEqual([first, second].sort());
    tileRenders.length = 0;
    statusRenders.length = 0;
    const input = view.container.querySelector<HTMLInputElement>(
      '[aria-label="EUR/USD spot"] input',
    );
    if (!input) throw new Error("missing notional");
    act(() => {
      input.value = "26";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(tileRenders).toEqual(["EURUSD"]);
    expect(statusRenders).toEqual([second]);
    expect(rowRenders).toEqual([]);
    expect(listRenders).toBe(0);
    expect(view.container.querySelector(`[data-layout-status="${second}"]`)?.textContent).toContain(
      "Modified",
    );
    act(() => workspace.tile("EURUSD").setNotional("27"));
    expect(statusRenders).toEqual([second]); // The already-modified label did not change.
    act(() => workspace.tile("EURUSD").setNotional("25"));
    expect(statusRenders).toEqual([second, second]);
    expect(view.container.querySelector(`[data-layout-status="${second}"]`)?.textContent).toBe(
      " Active",
    );
    expect(
      memory.log.filter(
        (entry) => entry.address === "prices/EURUSD" && entry.kind === "unsubscribe",
      ),
    ).toEqual([]);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("invalid pasted text previews paths before confirmation; cancel is inert and confirm applies once", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const store = new MemoryStore();
    const workspace = yield* makeDesk(feed([], true).transport, store);
    const id = workspace.layouts.save("Original");
    yield* settleStorage();
    const original = Realm.untracked(realm, (read) => read(workspace.layouts.$snapshot));
    const text = JSON.stringify({
      version: 2,
      workspace: {
        ...defaultWorkspace(symbols),
        tiles: [
          { symbol: "GBPUSD", notional: "-5" },
          { symbol: "UNKNOWN", notional: "1" },
          { symbol: "EURUSD", notional: "10" },
        ],
        positionsShown: false,
        blotter: {
          sort: { column: "unknown", direction: "ascending" },
          filter: "local",
          scrollTop: 500,
        },
      },
    });
    using view = mount(<LayoutsPanel layouts={workspace.layouts} />);
    act(() => workspace.layouts.preview(text));
    expect(Realm.untracked(realm, (read) => read(workspace.layouts.$snapshot))).toEqual(original);
    expect(Realm.untracked(realm, (read) => read(workspace.layouts.$activeId))).toBe(id);
    const preview = Realm.untracked(realm, (read) => read(workspace.layouts.$preview));
    if (!preview) throw new Error("missing preview");
    expect(preview?.dropped.map((part) => part.path)).toEqual([
      "$.workspace.tiles[0].notional",
      "$.workspace.tiles[1].symbol",
      "$.workspace.blotter.sort.column",
    ]);
    const panel = view.container.querySelector('[aria-label="Layout preview"]');
    expect(panel?.textContent).toContain("$.workspace.tiles[0].notional");
    expect(panel?.textContent).toContain("positive decimal");
    const cancel = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel",
    );
    if (!cancel) throw new Error("missing Cancel");
    act(() => cancel.click());
    yield* settleStorage();
    expect(store.saves).toHaveLength(1);
    expect(Realm.untracked(realm, (read) => read(workspace.layouts.$snapshot))).toEqual(original);
    expect(Realm.untracked(realm, (read) => read(workspace.layouts.$preview))).toBeNull();
    act(() => workspace.layouts.preview(text));
    const confirm = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Confirm layout",
    );
    if (!confirm) throw new Error("missing Confirm");
    using receipts = record(realm, (read) => read(workspace.layouts.$snapshot));
    act(() => confirm.click());
    expect(Realm.untracked(realm, (read) => read(workspace.layouts.$snapshot))).toEqual(
      preview.workspace,
    );
    expect(receipts.values).toHaveLength(1);
    expect(Realm.untracked(realm, (read) => read(workspace.layouts.$activeId))).toBeNull();
    expect(Realm.untracked(realm, (read) => read(workspace.layouts.$dropped))).toEqual(
      preview.dropped,
    );
    yield* settleStorage();
    expect(store.saves).toHaveLength(2);
    const exported = workspace.layouts.copy(id);
    act(() => workspace.layouts.preview(exported));
    expect(Realm.untracked(realm, (read) => read(workspace.layouts.$preview)?.workspace)).toEqual(
      original,
    );
    expect(Realm.untracked(realm, (read) => read(workspace.layouts.$preview)?.dropped)).toEqual([]);
    act(() => workspace.layouts.cancelPreview());
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("storage failures are visible and disposal flushes a pending interaction exactly once", async () => {
  using realm = testRealm();
  let writes = 0;
  await Effect.gen(function* () {
    const workspace = yield* makeDesk(feed().transport, {
      load: () => {
        throw new Error("storage denied");
      },
      save: () => {
        writes++;
        throw new Error("quota exceeded");
      },
    });
    expect(Realm.untracked(realm, (read) => read(workspace.layouts.$storageError))).toContain(
      "storage denied",
    );
    workspace.tile("EURUSD").setNotional("20");
    workspace.layouts.flush();
    expect(writes).toBe(1);
    expect(Realm.untracked(realm, (read) => read(workspace.layouts.$storageError))).toContain(
      "quota exceeded",
    );
    workspace.tile("EURUSD").setNotional("30");
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
  await Promise.resolve();
  expect(writes).toBe(2);
});

test("the browser adapter uses the same small storage contract", () => {
  const values = new Map<string, string>();
  const store = browserWorkspaceStore({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  });
  expect(store.load()).toBeNull();
  store.save("layout text");
  expect(store.load()).toBe("layout text");
  expect([...values]).toEqual([["pinna.desk.workspace", "layout text"]]);
});

test("structural corruption defaults each invalid field without discarding adjacent values", () => {
  const valid = defaultWorkspace(symbols);
  for (const value of [null, true, 42, "wrong", [], {}]) {
    const checked = readSavedDesk(
      JSON.stringify({
        ...saved(valid),
        workspace: {
          tiles: value,
          positionsShown: false,
          blotter: { sort: value, filter: "kept", scrollTop: 72 },
        },
        layouts: [null, { id: "kept", name: "Kept", workspace: value }],
        extra: "unknown",
      }),
      symbols,
    );
    expect(Schema.is(WorkspaceData)(checked.data.workspace)).toBe(true);
    expect(checked.data.workspace.positionsShown).toBe(false);
    expect(checked.data.workspace.blotter.filter).toBe("kept");
    expect(checked.data.workspace.blotter.scrollTop).toBe(72);
    expect(checked.data.layouts).toHaveLength(1);
    expect(checked.data.layouts.every(Schema.is(LayoutData))).toBe(true);
    expect(checked.dropped).toContainEqual({ path: "$.extra", reason: "unknown field; ignored" });
    expect(checked.dropped).toContainEqual({
      path: "$.layouts[0]",
      reason: "expected an object; dropped layout",
    });
  }
  const empty = readSavedDesk(JSON.stringify(saved({ ...valid, tiles: [] })), symbols);
  expect(empty.data.workspace.tiles).toEqual([]);
  expect(empty.dropped).toEqual([]);
});

test("the layouts UI saves, renames, copies text and deletes a layout", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const workspace = yield* makeDesk(feed().transport, new MemoryStore());
    using view = mount(<LayoutsPanel layouts={workspace.layouts} />);
    const saveForm = view.container.querySelector("form");
    const name = saveForm?.querySelector("input");
    if (!saveForm || !name) throw new Error("missing Save form");
    act(() => {
      name.value = "Morning";
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => saveForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    const keys = Realm.untracked(realm, (read) => read(workspace.layouts.$layouts.keys));
    expect(keys).toHaveLength(1);
    const row = view.container.querySelector("[data-layout]");
    const renameForm = row?.querySelector("form");
    const rename = renameForm?.querySelector("input");
    if (!rename || !renameForm) throw new Error("missing Rename form");
    rename.value = "London";
    act(() => renameForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(Realm.untracked(realm, (read) => read(workspace.layouts.$layouts.rows)[0]?.name)).toBe(
      "London",
    );
    const copy = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Copy London",
    );
    if (!copy) throw new Error("missing Copy");
    act(() => copy.click());
    const exported = view.container.querySelector<HTMLTextAreaElement>("textarea[readonly]")?.value;
    expect(JSON.parse(exported ?? "null")).toEqual({
      version: 2,
      workspace: defaultWorkspace(["EURUSD"]),
    });
    const remove = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Delete London",
    );
    if (!remove) throw new Error("missing Delete");
    act(() => remove.click());
    expect(view.container.querySelector("[data-layout]")).toBeNull();
    expect(Realm.untracked(realm, (read) => read(workspace.layouts.$activeId))).toBeNull();
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});
