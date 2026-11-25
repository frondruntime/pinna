import { expect, test } from "bun:test";
import { type Box, Collection, type Read, Realm } from "@frondruntime/pinna";
import { held, record, testRealm } from "@frondruntime/pinna/testing";
import { Model, RealmService, Source } from "@frondruntime/pinna-effect";
import { Effect, Fiber, Queue, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AccountSettings, defaultSettings } from "../src/client/account.ts";
import { AccountPanel } from "../src/client/account-panel.tsx";
import { makeDesk } from "../src/client/desk.ts";
import type { OrderValue, WorkingOrder } from "../src/client/order-data.ts";
import { OrdersPanel, TicketForm } from "../src/client/orders-panel.tsx";
import { SpotTile } from "../src/client/spot-tile.tsx";
import { WorkspaceView } from "../src/client/workspace.tsx";
import { makeExchange } from "../src/exchange/index.ts";
import { inMemoryTransport } from "../src/transport.ts";
import { listedPairs } from "./feed.ts";
import { orderOracle } from "./order-oracle.ts";

const value = (changes: Partial<OrderValue> = {}): OrderValue => ({
  symbol: "EURUSD",
  side: "buy",
  notional: "100.00",
  limitPrice: "1.08000",
  timeInForce: "day",
  expiry: "",
  note: "",
  filled: "0.00",
  status: "working",
  revision: 0,
  ...changes,
});
const order = (id = "limit-local-1", changes: Partial<OrderValue> = {}) => ({
  id,
  value: value(changes),
});
const quote = (bid = "1.08000", ask = "1.08010") => ({
  symbol: "EURUSD",
  bid,
  ask,
  time: new Date(0).toISOString(),
});
const fill = (id: string, notional = "10.00") => ({
  id,
  symbol: "EURUSD",
  direction: "buy",
  notional,
  rate: "1.08000",
  status: "done",
  desk: "local",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
});
function fixture(snapshot: readonly unknown[] = [], settings: unknown = defaultSettings) {
  const listeners = new Map<string, (raw: string) => void>();
  let answer: (path: string, body: string) => Effect.Effect<string> = () =>
    Effect.succeed(JSON.stringify({ ok: false, reason: "Risk limit refused" }));
  const memory = inMemoryTransport({
    request: (path, body) =>
      path === "/pairs"
        ? Effect.succeed(JSON.stringify(listedPairs))
        : path === "/settings"
          ? Effect.succeed(JSON.stringify(settings))
          : path === "/trades"
            ? Effect.succeed("[]")
            : path === "/orders"
              ? Effect.succeed(JSON.stringify(snapshot))
              : answer(path, body),
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
    answer: (next: typeof answer) => {
      answer = next;
    },
    send: (topic: string, data: unknown) => {
      const listener = listeners.get(topic);
      if (!listener) throw new Error(`missing topic ${topic}`);
      listener(JSON.stringify(data));
    },
    sendRaw: (topic: string, raw: string) => {
      listeners.get(topic)?.(raw);
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
function duringAct<Value>(recipe: () => Value): Value {
  const result: Value[] = [];
  act(() => {
    result.push(recipe());
  });
  return result[0] as Value;
}

test("every ticket field keeps invalid text, reports its error, and rejects invalid accepted writes", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const memory = fixture();
    const workspace = yield* makeDesk(memory.transport);
    const ticket = workspace.orders.open(workspace.tile("EURUSD"));
    if (!ticket) throw new Error("missing ticket");
    using view = mount(<TicketForm ticket={ticket} />);
    yield* actEffect(TestClock.adjust(0));
    const cases = [
      {
        field: ticket.side,
        bad: ["hold", "", "BUY"],
        label: "Side",
        message: "Choose buy or sell.",
      },
      {
        field: ticket.notional,
        bad: ["", "0", "-1", ".5", "1.", "1e3", "1.001", "NaN", " 1"],
        label: "Order notional",
        message: "Use a positive decimal with at most 2 places.",
      },
      {
        field: ticket.limitPrice,
        bad: ["", "0", "-1", "1.000001", "1e2", "Infinity"],
        label: "Limit price",
        message: "Use a positive decimal with at most 5 places.",
      },
      {
        field: ticket.timeInForce,
        bad: ["forever", "", "DAY"],
        label: "Time in force",
        message: "Choose day, date, or immediate.",
      },
      {
        field: ticket.expiry,
        bad: ["", "1970-01-01", "1969-12-31", "tomorrow", "2026-02-30", "2026-13-01"],
        label: "Good till date",
        message: "Choose a date after today.",
      },
      {
        field: ticket.note,
        bad: ["x".repeat(201)],
        label: "Note",
        message: "Use at most 200 characters.",
      },
    ];
    for (const entry of cases) {
      const initial = Realm.untracked(realm, (read) => read(entry.field.$accepted));
      using receipts = record(realm, (read) => read(entry.field.$accepted));
      for (const bad of entry.bad) {
        act(() => entry.field.set(bad));
        expect(Realm.untracked(realm, (read) => read(entry.field.$text))).toBe(bad);
        expect(Realm.untracked(realm, (read) => read(entry.field.$accepted))).toBe(initial);
        expect(Realm.untracked(realm, (read) => read(entry.field.$error))).toBe(entry.message);
        const control = view.container.querySelector(`[aria-label="${entry.label}"]`);
        expect(control?.getAttribute("aria-invalid")).toBe("true");
        expect(control?.parentElement?.textContent).toContain(entry.message);
        expect(() =>
          Realm.update(realm, (_read, write) => write(entry.field.$accepted as Box<string>, bad)),
        ).toThrow("the box rejects this value");
        expect(Realm.untracked(realm, (read) => read(entry.field.$accepted))).toBe(initial);
      }
      expect(receipts.values).toEqual([]);
      act(() => entry.field.set(initial));
    }
    const yen = workspace.orders.open(workspace.tile("USDJPY"));
    if (!yen) throw new Error("missing yen ticket");
    yen.limitPrice.set("152.1234");
    expect(Realm.untracked(realm, (read) => read(yen.limitPrice.$error))).toBe(
      "Use a positive decimal with at most 3 places.",
    );
    expect(() =>
      Realm.update(realm, (_read, write) => write(yen.limitPrice.$accepted, "152.1234")),
    ).toThrow("the box rejects this value");
    yen.limitPrice.set("152.123");
    expect(Realm.untracked(realm, (read) => read(yen.limitPrice.$accepted))).toBe("152.123");
    act(() => ticket.notional.set("99999999999999999999999.99"));
    expect(Realm.untracked(realm, (read) => read(ticket.notional.$accepted))).toBe(
      "99999999999999999999999.99",
    );
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("live rules change without field renders, share demand, and release the last price topic", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const memory = fixture();
    const workspace = yield* makeDesk(memory.transport);
    const tile = workspace.tile("EURUSD");
    const ticket = workspace.orders.open(tile);
    if (!ticket) throw new Error("missing ticket");
    let rules = 0;
    const fields = new Map<string, number>();
    const before = memory.log.length;
    {
      using view = mount(
        <TicketForm
          ticket={ticket}
          onFieldRender={(label) => fields.set(label, (fields.get(label) ?? 0) + 1)}
          onRuleRender={() => {
            rules++;
          }}
        />,
      );
      yield* actEffect(TestClock.adjust(0));
      expect(
        memory.log
          .slice(before)
          .filter((entry) => entry.kind === "subscribe")
          .map((entry) => entry.address),
      ).toEqual(["prices/EURUSD"]);
      expect(view.container.textContent).toContain("No live price");
      expect(Realm.untracked(realm, (read) => read(ticket.$canSend))).toBe(false);
      const fieldCounts = [...fields];
      yield* actEffect(
        Effect.sync(() => memory.send("prices/EURUSD", quote())).pipe(
          Effect.andThen(TestClock.adjust(0)),
        ),
      );
      expect(Realm.untracked(realm, (read) => read(ticket.$canSend))).toBe(true);
      act(() => ticket.limitPrice.set("1.08020"));
      expect(view.container.textContent).toContain("fills at once");
      const editedCounts = [...fields];
      const prior = rules;
      yield* actEffect(
        Effect.sync(() => memory.send("prices/EURUSD", quote("1.08100", "1.08110"))).pipe(
          Effect.andThen(TestClock.adjust(0)),
        ),
      );
      expect(view.container.textContent).not.toContain("fills at once");
      expect([...fields]).toEqual(editedCounts);
      expect(rules).toBe(prior + 1);
      yield* actEffect(
        Effect.sync(() => memory.send("prices/EURUSD", quote("2.00000", "2.00010"))).pipe(
          Effect.andThen(TestClock.adjust(0)),
        ),
      );
      expect(view.container.textContent).toContain("within 10 percent");
      expect(Realm.untracked(realm, (read) => read(ticket.$canSend))).toBe(false);
      expect([...fields]).toEqual(editedCounts);
      act(() => {
        ticket.side.set("sell");
        ticket.limitPrice.set("2.00000");
      });
      yield* actEffect(
        Effect.sync(() => memory.send("prices/EURUSD", quote("2.00001", "2.00011"))).pipe(
          Effect.andThen(TestClock.adjust(0)),
        ),
      );
      expect(Realm.untracked(realm, (read) => read(ticket.$rules).fillsAtOnce)).toBe(true);
      expect(fieldCounts).toHaveLength(6);
    }
    yield* TestClock.adjust(0);
    expect(
      memory.log.filter(
        (entry) => entry.kind === "unsubscribe" && entry.address === "prices/EURUSD",
      ),
    ).toHaveLength(1);
    expect(Realm.untracked(realm, (read) => read(tile.$prices).current)).toBeNull();
    expect(Realm.untracked(realm, (read) => read(ticket.$canSend))).toBe(false);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("send confirmation, pending acceptance and exchange rejection keep the exact ticket", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const memory = fixture();
    memory.answer(() =>
      Effect.sleep(100).pipe(
        Effect.as(JSON.stringify({ ok: false, reason: "Insufficient margin" })),
      ),
    );
    const workspace = yield* makeDesk(memory.transport);
    const tile = workspace.tile("EURUSD");
    yield* Source.observeScoped(tile.$prices);
    yield* TestClock.adjust(0);
    memory.send("prices/EURUSD", quote());
    yield* TestClock.adjust(0);
    const ticket = workspace.orders.open(tile);
    if (!ticket) throw new Error("missing ticket");
    ticket.notional.set("1000001.25");
    ticket.note.set("  keep these spaces  ");
    yield* workspace.orders.submit(ticket);
    expect(Realm.untracked(realm, (read) => read(ticket.$confirmation))).toBe(true);
    expect(memory.log.filter((entry) => entry.address === "/orders/place")).toHaveLength(0);
    yield* workspace.orders
      .submit(ticket, true)
      .pipe(Effect.forkScoped({ startImmediately: true }));
    expect(Realm.untracked(realm, (read) => read(ticket.$pending))).toBe(true);
    yield* TestClock.adjust(100);
    expect(Realm.untracked(realm, (read) => read(ticket.$pending))).toBe(false);
    expect(Realm.untracked(realm, (read) => read(ticket.$reason))).toBe("Insufficient margin");
    expect(Realm.untracked(realm, (read) => read(workspace.orders.$ticket))).toBe(ticket);
    expect(Realm.untracked(realm, (read) => read(ticket.note.$text))).toBe("  keep these spaces  ");
    const sent = memory.log.find(
      (entry) => entry.address === "/orders/place" && entry.kind === "request",
    );
    expect(JSON.parse(sent?.raw ?? "{}")).toEqual({
      id: "limit-local-1",
      symbol: "EURUSD",
      side: "buy",
      notional: "1000001.25",
      limitPrice: "1.08000",
      timeInForce: "day",
      expiry: "",
      note: "  keep these spaces  ",
    });
    memory.answer((_path, body) =>
      Effect.succeed(
        JSON.stringify({
          ok: true,
          message: {
            kind: "accepted",
            order: {
              id: JSON.parse(body).id,
              value: {
                ...value(),
                ...JSON.parse(body),
                id: undefined,
                notional: "1000001.25",
                note: "  keep these spaces  ",
              },
            },
            fill: null,
          },
        }),
      ),
    );
    yield* workspace.orders.submit(ticket, true);
    expect(Realm.untracked(realm, (read) => read(workspace.orders.$ticket))).toBeNull();
    expect(Realm.untracked(realm, (read) => read(workspace.orders.$orders.keys))).toEqual([
      "limit-local-2",
    ]);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("amend edits survive unrelated messages, expose conflicts, retain model identity, and close at terminal status", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const memory = fixture([order()]);
    const workspace = yield* makeDesk(memory.transport);
    const orders = workspace.orders;
    yield* Source.observeScoped(orders.$keys);
    yield* TestClock.adjust(0);
    const heldOrder = Realm.untracked(realm, (read) => read.row(orders.$orders, "limit-local-1"));
    if (!heldOrder) throw new Error("missing order");
    const ticket = orders.open(workspace.tile("EURUSD"), heldOrder);
    if (!ticket) throw new Error("missing ticket");
    ticket.limitPrice.set("1.08005");
    ticket.notional.set("150.00");
    expect(
      orders.accept({
        kind: "partial",
        order: order(undefined, { filled: "10.00", status: "partial", revision: 1 }),
        fill: fill("fill-1"),
      }),
    ).toBe(true);
    expect(Realm.untracked(realm, (read) => read(ticket.notional.$text))).toBe("150.00");
    expect(Realm.untracked(realm, (read) => read(ticket.limitPrice.$text))).toBe("1.08005");
    expect(Realm.untracked(realm, (read) => read(ticket.$conflicts))).toEqual({});
    expect(
      orders.accept({
        kind: "amended",
        order: order(undefined, {
          filled: "10.00",
          status: "partial",
          revision: 2,
          limitPrice: "1.08010",
        }),
        fill: null,
      }),
    ).toBe(true);
    expect(Realm.untracked(realm, (read) => read(ticket.$conflicts))).toEqual({
      limitPrice: "1.08010",
    });
    expect(Realm.untracked(realm, (read) => read(ticket.$canSend))).toBe(false);
    ticket.choose("limitPrice", "mine");
    expect(Realm.untracked(realm, (read) => read(ticket.limitPrice.$text))).toBe("1.08005");
    expect(
      orders.accept({
        kind: "amended",
        order: order(undefined, {
          filled: "10.00",
          status: "partial",
          revision: 3,
          limitPrice: "1.08020",
        }),
        fill: null,
      }),
    ).toBe(true);
    ticket.choose("limitPrice", "exchange");
    expect(Realm.untracked(realm, (read) => read(ticket.limitPrice.$text))).toBe("1.08020");
    expect(Realm.untracked(realm, (read) => read.row(orders.$orders, heldOrder.id))).toBe(
      heldOrder,
    );
    expect(
      orders.accept({
        kind: "filled",
        order: order(undefined, {
          filled: "100.00",
          status: "filled",
          revision: 4,
          limitPrice: "1.08020",
        }),
        fill: fill("fill-2", "90.00"),
      }),
    ).toBe(true);
    expect(Realm.untracked(realm, (read) => read(orders.$ticket))).toBeNull();
    expect(Realm.untracked(realm, (read) => read(orders.$notice))).toBe(
      "Edit closed: order filled.",
    );
    expect(Realm.untracked(realm, (read) => read(workspace.trades.$heldCount))).toBe(2);
    expect(
      Realm.untracked(
        realm,
        (read) => read(workspace.trades.positions.ledger("EURUSD").$aggregate).net.numerator,
      ),
    ).toBe(100n);
    for (const status of ["cancelled", "expired"] as const) {
      const id = `terminal-${status}`;
      expect(orders.accept({ kind: "accepted", order: order(id), fill: null })).toBe(true);
      const row = Realm.untracked(realm, (read) => read.row(orders.$orders, id));
      if (!row) throw new Error("missing row");
      orders.open(workspace.tile("EURUSD"), row);
      expect(
        orders.accept({ kind: status, order: order(id, { status, revision: 1 }), fill: null }),
      ).toBe(true);
      expect(Realm.untracked(realm, (read) => read(orders.$notice))).toBe(
        `Edit closed: order ${status}.`,
      );
    }
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("a refused optimistic amendment rolls back all changed values in one receipt", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const memory = fixture([order()]);
    memory.answer(() =>
      Effect.sleep(100).pipe(
        Effect.as(JSON.stringify({ ok: false, reason: "Risk refused amendment" })),
      ),
    );
    const workspace = yield* makeDesk(memory.transport);
    const orders = workspace.orders;
    const tile = workspace.tile("EURUSD");
    yield* Source.observeScoped(orders.$keys);
    yield* Source.observeScoped(tile.$prices);
    yield* TestClock.adjust(0);
    memory.send("prices/EURUSD", quote());
    yield* TestClock.adjust(0);
    const row = Realm.untracked(realm, (read) => read.row(orders.$orders, "limit-local-1"));
    if (!row) throw new Error("missing row");
    const ticket = orders.open(tile, row);
    if (!ticket) throw new Error("missing ticket");
    ticket.notional.set("200.00");
    ticket.limitPrice.set("1.08005");
    using receipts = record(realm, (read) => ({
      ...read(row.$value),
      pending: read(ticket.$pending),
    }));
    const observed: unknown[] = [];
    const snapshot = (read: Read) => ({
      notional: read(row.$value).notional,
      limitPrice: read(row.$value).limitPrice,
      pending: read(ticket.$pending),
    });
    using _notional = held(
      Realm.watch(
        realm,
        (read) => read(row.$value).notional,
        () => {
          observed.push(Realm.untracked(realm, snapshot));
        },
      ),
    );
    using _price = held(
      Realm.watch(
        realm,
        (read) => read(row.$value).limitPrice,
        () => {
          observed.push(Realm.untracked(realm, snapshot));
        },
      ),
    );
    yield* orders.submit(ticket).pipe(Effect.forkScoped({ startImmediately: true }));
    expect(receipts.values).toHaveLength(1);
    expect(receipts.values[0]).toEqual({
      ...value({ notional: "200.00", limitPrice: "1.08005" }),
      pending: true,
    });
    yield* TestClock.adjust(100);
    expect(receipts.values).toHaveLength(2);
    expect(receipts.values[1]).toEqual({ ...value(), pending: false });
    expect(observed).toEqual([
      { notional: "200.00", limitPrice: "1.08005", pending: true },
      { notional: "200.00", limitPrice: "1.08005", pending: true },
      { notional: "100.00", limitPrice: "1.08000", pending: false },
      { notional: "100.00", limitPrice: "1.08000", pending: false },
    ]);
    expect(Realm.untracked(realm, (read) => read(orders.$ticket))).toBe(ticket);
    expect(Realm.untracked(realm, (read) => read(ticket.$reason))).toBe("Risk refused amendment");
    expect(Realm.untracked(realm, (read) => read(ticket.notional.$text))).toBe("200.00");
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("an amendment interrupted right after its guess shows leaves no stage open", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const memory = fixture([order()]);
    memory.answer(() =>
      Effect.sleep(100).pipe(Effect.as(JSON.stringify({ ok: false, reason: "never read" }))),
    );
    const workspace = yield* makeDesk(memory.transport);
    const orders = workspace.orders;
    const tile = workspace.tile("EURUSD");
    yield* Source.observeScoped(orders.$keys);
    yield* Source.observeScoped(tile.$prices);
    yield* TestClock.adjust(0);
    memory.send("prices/EURUSD", quote());
    yield* TestClock.adjust(0);
    const row = Realm.untracked(realm, (read) => read.row(orders.$orders, "limit-local-1"));
    if (!row) throw new Error("missing row");
    const ticket = orders.open(tile, row);
    if (!ticket) throw new Error("missing ticket");
    ticket.notional.set("200.00");
    let fiber: Fiber.Fiber<void> | undefined;
    // The update that shows the guess interrupts the submit, so the
    // interruption lands at the first step after the guess is made.
    using _interrupt = held(
      Realm.watch(
        realm,
        (read) => read(ticket.$pending),
        (pending) => {
          if (pending) fiber?.interruptUnsafe();
        },
      ),
    );
    fiber = yield* orders.submit(ticket).pipe(Effect.forkScoped);
    yield* Fiber.await(fiber);
    expect(Realm.untracked(realm, (read) => read(row.$value).notional)).toBe("100.00");
    expect(Realm.untracked(realm, (read) => read(ticket.$pending))).toBe(false);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
  // A stage neither applied nor dropped makes the test realm refuse.
  expect(() => realm[Symbol.dispose]()).not.toThrow();
});

test("seeded malformed messages mixed with thousands of good messages preserve every receipt's log prefix", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const exchange = yield* makeExchange({
      seed: 31041,
      initialWorkingOrders: 5,
      malformedOrderProbability: 0.16,
      historyTradeCount: 0,
      otherDeskTradeProbability: 0,
      intervalMilliseconds: 10,
      rejectionProbability: 0,
    });
    const memory = inMemoryTransport(exchange);
    const workspace = yield* makeDesk(memory.transport);
    const orders = workspace.orders;
    const snapshot = (read: Read) => ({
      orders: read(orders.$keys).map((id) => {
        const row = read.row(orders.$orders, id);
        if (!row) throw new Error("missing row");
        return { id, value: read(row.$value) };
      }),
      fills: read(workspace.trades.$heldCount),
      cents: workspace.trades.positions.ledgers.reduce((sum, ledger) => {
        const net = read(ledger.$aggregate).net;
        return sum + (net.numerator * 100n) / net.denominator;
      }, 0n),
    });
    const receipts: { prefix: number; value: ReturnType<typeof snapshot>; channel: string }[] = [];
    const diagnostics: {
      prefix: number;
      value: ReturnType<typeof snapshot>;
      count: number;
      latest: { readonly path: string; readonly reason: string } | null;
    }[] = [];
    using _diagnostics = held(
      Realm.watch(
        realm,
        (read) => read(orders.$rejections),
        (value) => {
          diagnostics.push({
            prefix: memory.log.length,
            value: Realm.untracked(realm, snapshot),
            ...value,
          });
        },
      ),
    );
    using _all = held(
      Realm.watch(realm, snapshot, (value) => {
        receipts.push({ prefix: memory.log.length, value, channel: "all" });
      }),
    );
    using _trades = held(
      Realm.watch(
        realm,
        (read) => read(workspace.trades.$heldCount),
        () => {
          receipts.push({
            prefix: memory.log.length,
            value: Realm.untracked(realm, snapshot),
            channel: "fills",
          });
        },
      ),
    );
    yield* TestClock.adjust(0);
    const identities = Realm.untracked(realm, (read) => read(orders.$orders.rows));
    for (let tick = 0; tick < 1500; tick++) yield* TestClock.adjust(10);
    const oracle = orderOracle(memory.log);
    expect(diagnostics).toHaveLength(oracle.rejected.length);
    for (const [index, expected] of oracle.rejected.entries()) {
      const actual = diagnostics[index];
      if (!actual) throw new Error("missing diagnostic");
      expect(actual.count).toBe(index + 1);
      expect(actual.latest).toEqual({ path: expected.path, reason: expected.reason });
      expect(actual.prefix).toBeGreaterThanOrEqual(expected.prefix);
      const prior = oracle.states.findLast((state) => state.prefix <= expected.prefix);
      if (!prior) throw new Error("missing prior prefix");
      expect(prior.value).toEqual(actual.value);
    }
    expect(oracle.states.length).toBeGreaterThan(2000);
    expect(oracle.rejected.length).toBeGreaterThan(500);
    expect(new Set(oracle.rejected.map((error) => error.path))).toEqual(
      new Set([
        "order.value.note",
        "order.value.notional",
        "order.value.status",
        "order.id",
        "fill.notional",
      ]),
    );
    const actual = Realm.untracked(realm, (read) => read(orders.$rejections));
    expect(actual.count).toBe(oracle.rejected.length);
    const last = oracle.rejected.at(-1);
    if (!last) throw new Error("missing rejection");
    expect(actual.latest).toEqual({ path: last.path, reason: last.reason });
    // Each receipt is a whole accepted prefix, including trades and position deltas.
    const accepted = new Map<string, number>();
    for (const state of oracle.states)
      if (!accepted.has(state.fingerprint)) accepted.set(state.fingerprint, state.prefix);
    for (const receipt of receipts) {
      const prefix = accepted.get(oracle.fingerprint(receipt.value));
      expect(prefix).toBeDefined();
      expect(prefix ?? Infinity).toBeLessThanOrEqual(receipt.prefix);
    }
    expect(new Set(receipts.map((receipt) => receipt.channel))).toEqual(new Set(["all", "fills"]));
    expect(receipts.length).toBeGreaterThan(2000);
    const final = oracle.states.at(-1);
    if (!final) throw new Error("missing oracle");
    expect(final.value).toEqual(Realm.untracked(realm, snapshot));
    expect(
      Realm.untracked(realm, (read) =>
        read(workspace.trades.$trades.rows)
          .map((trade) => trade.id)
          .reverse(),
      ),
    ).toEqual(oracle.fills);
    expect(
      Realm.untracked(realm, (read) => read(orders.$orders.rows)).every(
        (row, index) => row === identities[index],
      ),
    ).toBe(true);
    // Compare every diagnostic at its own prefix, not merely the final counter.
    const rejectionReceipts: unknown[] = [];
    using _rejected = held(
      Realm.watch(
        realm,
        (read) => read(orders.$rejections),
        (value) => {
          rejectionReceipts.push(value);
        },
      ),
    );
    const before = Realm.untracked(realm, snapshot);
    for (const raw of ["not JSON", JSON.stringify({ kind: "bogus" })]) {
      orders.accept(raw === "not JSON" ? raw : JSON.parse(raw));
      expect(Realm.untracked(realm, snapshot)).toEqual(before);
    }
    expect(rejectionReceipts).toHaveLength(2);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
}, 30000);

test("bad messages are atomic, identify the precise path, and do not poison the next good update", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const memory = fixture([order("first"), order("second")]);
    const workspace = yield* makeDesk(memory.transport);
    const orders = workspace.orders;
    yield* Source.observeScoped(orders.$keys);
    yield* TestClock.adjust(0);
    const row = Realm.untracked(realm, (read) => read.row(orders.$orders, "first"));
    if (!row) throw new Error("missing row");
    using receipts = record(realm, (read) => read(row.$value));
    const second = Realm.untracked(realm, (read) => read.row(orders.$orders, "second"));
    if (!second) throw new Error("missing neighbor");
    const neighbor = Realm.untracked(realm, (read) => read(second.$value));
    const malformed = [
      {
        message: {
          kind: "amended",
          order: { id: "first", value: { ...value({ revision: 1 }), note: undefined } },
          fill: null,
        },
        path: "order.value.note",
        reason: "invalid note",
      },
      ...["-1", "abc", 123].map((notional) => ({
        message: {
          kind: "amended",
          order: { id: "first", value: { ...value({ revision: 1 }), notional } },
          fill: null,
        },
        path: "order.value.notional",
        reason: "invalid notional",
      })),
      {
        message: {
          kind: "amended",
          order: order("first", { status: "bogus" as never, revision: 1 }),
          fill: null,
        },
        path: "order.value.status",
        reason: "invalid status",
      },
      {
        message: { kind: "amended", order: order("unknown", { revision: 1 }), fill: null },
        path: "order.id",
        reason: "unknown order",
      },
      {
        message: {
          kind: "partial",
          order: order("first", { filled: "10.00", status: "partial", revision: 1 }),
          fill: fill("too-large", "101.00"),
        },
        path: "fill.notional",
        reason: "fill exceeds remaining amount",
      },
    ];
    for (const [index, item] of malformed.entries()) {
      expect(orders.accept(item.message)).toBe(false);
      expect(Realm.untracked(realm, (read) => read(orders.$rejections))).toEqual({
        count: index + 1,
        latest: { path: item.path, reason: item.reason },
      });
      expect(Realm.untracked(realm, (read) => read(row.$value))).toEqual(value());
      expect(Realm.untracked(realm, (read) => read(second.$value))).toBe(neighbor);
      expect(Realm.untracked(realm, (read) => read(workspace.trades.$heldCount))).toBe(0);
    }
    expect(receipts.values).toHaveLength(0);
    expect(
      orders.accept({
        kind: "amended",
        order: order("first", { revision: 1, limitPrice: "1.08005" }),
        fill: null,
      }),
    ).toBe(true);
    expect(receipts.values).toHaveLength(1);
    expect(() =>
      Realm.update(realm, (_read, write) => write(row.$value, { ...value(), notional: "-1" })),
    ).toThrow("the box rejects this value");
    expect(() =>
      Realm.update(realm, (_read, write) => write.upsert(orders.$orders, {} as WorkingOrder)),
    ).toThrow();
    const badFill = { ...fill("bad"), notional: "-1" };
    expect(() =>
      Realm.update(realm, (_read, write) =>
        write.upsert(workspace.trades.$trades, badFill as never),
      ),
    ).toThrow();
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("settings recover valid neighbors, refuse unchecked writes, preserve save errors and encode only wire fields", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const memory = fixture([], {
      displayName: "Alice",
      defaultNotionals: {
        EURUSD: "123.45",
        GBPUSD: "-1",
        USDJPY: "500",
        AUDUSD: "1e5",
        EURGBP: "0",
      },
      confirmationThreshold: "200.00",
      realm: "wire intrusion",
      added: "drop me",
    });
    const workspace = yield* makeDesk(memory.transport);
    const account = workspace.orders.account;
    expect(Schema.encodeSync(AccountSettings)(account.settings)).toEqual({
      displayName: "Alice",
      defaultNotionals: {
        EURUSD: "123.45",
        GBPUSD: "100000",
        USDJPY: "500",
        AUDUSD: "100000",
        EURGBP: "100000",
      },
      confirmationThreshold: "200.00",
    });
    expect(Realm.untracked(realm, (read) => read(account.$dropped))).toEqual(
      ["GBPUSD", "AUDUSD", "EURGBP"].map((symbol) => ({
        path: `defaultNotionals.${symbol}`,
        reason: "expected a positive decimal with at most 2 places; using default",
      })),
    );
    const settings = account.settings;
    for (const bad of ["", " ", "a".repeat(41), " Alice "])
      expect(() =>
        Realm.update(realm, (_read, write) => write(settings.$displayName, bad)),
      ).toThrow("the box rejects this value");
    expect(() =>
      Realm.update(realm, (_read, write) => write(settings.$confirmationThreshold, "0")),
    ).toThrow();
    expect(() =>
      Realm.update(realm, (read, write) =>
        write(settings.$defaultNotionals, { ...read(settings.$defaultNotionals), EURUSD: "-1" }),
      ),
    ).toThrow();
    const ticket = workspace.orders.open(workspace.tile("EURUSD"));
    if (!ticket) throw new Error("missing ticket");
    expect(Realm.untracked(realm, (read) => read(ticket.notional.$text))).toBe("123.45");
    const form = account.open();
    using view = mount(<AccountPanel orders={workspace.orders} />);
    act(() => {
      form.displayName.set("  Bob  ");
      form.defaultNotionals.EURUSD.set("321.99");
    });
    for (const field of [form.confirmationThreshold, ...Object.values(form.defaultNotionals)]) {
      const before = Realm.untracked(realm, (read) => read(field.$accepted));
      act(() => field.set("1.001"));
      expect(Realm.untracked(realm, (read) => read(field.$error))).toContain("positive decimal");
      expect(Realm.untracked(realm, (read) => read(field.$accepted))).toBe(before);
      act(() => field.set(before));
    }
    act(() => form.displayName.set(" "));
    expect(Realm.untracked(realm, (read) => read(form.displayName.$accepted))).toBe("Bob");
    act(() => form.displayName.set("  Bob  "));
    memory.answer(() =>
      Effect.succeed(
        JSON.stringify({
          ok: false,
          errors: {
            displayName: "Name already used",
            "defaultNotionals.EURUSD": "Per-pair risk cap",
          },
        }),
      ),
    );
    yield* actEffect(form.save());
    expect(view.container.textContent).toContain("Name already used");
    expect(view.container.textContent).toContain("Per-pair risk cap");
    expect(Realm.untracked(realm, (read) => read(form.displayName.$text))).toBe("  Bob  ");
    expect(Schema.encodeSync(AccountSettings)(settings).displayName).toBe("Alice");
    const sent = memory.log.find(
      (entry) => entry.address === "/settings/save" && entry.kind === "request",
    );
    expect(JSON.parse(sent?.raw ?? "{}")).toEqual({
      displayName: "Bob",
      defaultNotionals: {
        EURUSD: "321.99",
        GBPUSD: "100000",
        USDJPY: "500",
        AUDUSD: "100000",
        EURGBP: "100000",
      },
      confirmationThreshold: "200.00",
    });
    act(() => {
      form.displayName.set("  Bob  ");
      form.defaultNotionals.EURUSD.set("321.99");
    });
    memory.answer((_path, body) =>
      Effect.succeed(
        JSON.stringify({
          ok: true,
          settings: {
            ...JSON.parse(body),
            displayName: "Bob on exchange",
            confirmationThreshold: "500.00",
            extra: "server-only",
          },
        }),
      ),
    );
    yield* actEffect(form.save());
    expect(account.settings).toBe(settings);
    expect(Schema.encodeSync(AccountSettings)(settings).displayName).toBe("Bob on exchange");
    expect(Schema.encodeSync(AccountSettings)(settings).confirmationThreshold).toBe("500.00");
    expect(Object.keys(Schema.encodeSync(AccountSettings)(settings))).toEqual([
      "displayName",
      "defaultNotionals",
      "confirmationThreshold",
    ]);
    expect(Realm.untracked(realm, (read) => read(form.$message))).toBe("Settings saved.");
    expect(() =>
      Model.decode(realm, AccountSettings)({ ...defaultSettings, realm: "forbidden" }),
    ).toThrow("the realm is never on the wire");
    act(() =>
      account.load({
        displayName: " ",
        defaultNotionals: { ...defaultSettings.defaultNotionals, EURUSD: "5.50" },
        confirmationThreshold: "-1",
      }),
    );
    expect(Schema.encodeSync(AccountSettings)(settings)).toEqual({
      ...defaultSettings,
      defaultNotionals: { ...defaultSettings.defaultNotionals, EURUSD: "5.50" },
    });
    expect(
      Realm.untracked(realm, (read) => read(account.$dropped).map((item) => item.path)),
    ).toEqual(["displayName", "confirmationThreshold"]);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("the real exchange accepts, rounds amendments in place, fills into positions, cancels IOC and expires dates", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const exchange = yield* makeExchange({
      seed: 92,
      historyTradeCount: 0,
      intervalMilliseconds: 10,
      rejectionProbability: 0,
      otherDeskTradeProbability: 0,
      executionLatencyMilliseconds: [25, 25],
      malformedOrderProbability: 0,
    });
    const memory = inMemoryTransport(exchange);
    const workspace = yield* makeDesk(memory.transport);
    const orders = workspace.orders;
    const tile = workspace.tile("EURUSD");
    yield* Source.observeScoped(tile.$prices);
    using view = mount(<OrdersPanel workspace={workspace} />);
    yield* actEffect(TestClock.adjust(10));
    let ticket = duringAct(() => orders.open(tile));
    if (!ticket) throw new Error("missing ticket");
    act(() => {
      ticket?.notional.set("0.02");
      ticket?.limitPrice.set("1.08100");
    });
    yield* actEffect(
      orders.submit(ticket).pipe(Effect.forkScoped({ startImmediately: true }), Effect.asVoid),
    );
    yield* actEffect(TestClock.adjust(25));
    expect(Realm.untracked(realm, (read) => read(orders.$ticket))).toBeNull();
    yield* actEffect(TestClock.adjust(30));
    const first = Realm.untracked(realm, (read) => read.row(orders.$orders, "limit-local-1"));
    if (!first) throw new Error("missing filled order");
    expect(Realm.untracked(realm, (read) => read(first.$value).status)).toBe("filled");
    expect(view.container.textContent).toContain("filled");
    expect(Realm.untracked(realm, (read) => read(workspace.trades.$heldCount))).toBe(2);
    expect(
      Realm.untracked(
        realm,
        (read) => read(workspace.trades.positions.ledger("EURUSD").$aggregate).net,
      ),
    ).toEqual({ numerator: 1n, denominator: 50n });
    ticket = duringAct(() => orders.open(tile));
    if (!ticket) throw new Error("missing second ticket");
    act(() => {
      ticket?.notional.set("100.00");
      ticket?.limitPrice.set("1.07000");
    });
    yield* actEffect(
      orders.submit(ticket).pipe(Effect.forkScoped({ startImmediately: true }), Effect.asVoid),
    );
    yield* actEffect(TestClock.adjust(25));
    const second = Realm.untracked(realm, (read) => read.row(orders.$orders, "limit-local-2"));
    if (!second) throw new Error("missing working order");
    const amendment = duringAct(() => orders.open(tile, second));
    if (!amendment) throw new Error("missing amendment");
    act(() => {
      amendment.notional.set("200.00");
      amendment.limitPrice.set("1.07006");
    });
    yield* actEffect(
      orders.submit(amendment).pipe(Effect.forkScoped({ startImmediately: true }), Effect.asVoid),
    );
    yield* actEffect(TestClock.adjust(25));
    expect(Realm.untracked(realm, (read) => read(second.$value).notional)).toBe("200.00");
    expect(Realm.untracked(realm, (read) => read(second.$value).limitPrice)).toBe("1.0701");
    expect(Realm.untracked(realm, (read) => read.row(orders.$orders, second.id))).toBe(second);
    const immediate = duringAct(() => orders.open(tile));
    if (!immediate) throw new Error("missing IOC");
    act(() => {
      immediate.notional.set("100.00");
      immediate.limitPrice.set("1.08100");
      immediate.timeInForce.set("immediate");
    });
    yield* actEffect(
      orders.submit(immediate).pipe(Effect.forkScoped({ startImmediately: true }), Effect.asVoid),
    );
    yield* actEffect(TestClock.adjust(25));
    const third = Realm.untracked(realm, (read) => read.row(orders.$orders, "limit-local-3"));
    if (!third) throw new Error("missing IOC order");
    expect(Realm.untracked(realm, (read) => read(third.$value).status)).toBe("cancelled");
    expect(Realm.untracked(realm, (read) => read(orders.$ticket))).toBeNull();
    expect(Realm.untracked(realm, (read) => read(orders.$rejections).count)).toBe(0);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("day and good-till-date orders expire on the UTC calendar boundary", async () => {
  await Effect.gen(function* () {
    const exchange = yield* makeExchange({
      seed: 2,
      historyTradeCount: 0,
      intervalMilliseconds: 86400000,
      initialWorkingOrders: 1,
      malformedOrderProbability: 0,
      otherDeskTradeProbability: 0,
      rejectionProbability: 0,
      executionLatencyMilliseconds: [0, 0],
    });
    const memory = inMemoryTransport(exchange);
    const messages: { kind: string; order: { id: string } }[] = [];
    yield* memory.transport.subscribe("orders").pipe(
      Stream.runForEach((raw) =>
        Effect.sync(() => {
          messages.push(JSON.parse(raw));
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    const request = {
      id: "limit-local-1",
      symbol: "EURUSD",
      side: "buy",
      notional: "100.00",
      limitPrice: "1.07000",
      timeInForce: "date",
      expiry: "1970-01-02",
      note: "",
    };
    const response = JSON.parse(
      yield* memory.transport.request("/orders/place", JSON.stringify(request)),
    );
    expect(response.ok).toBe(true);
    yield* TestClock.adjust(86400000);
    expect(
      messages.filter((message) => message.kind === "expired").map((message) => message.order.id),
    ).toEqual(["limit-exchange-1", "limit-local-1"]);
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise);
});

test("a failing fill subscriber rolls back order, trades, indexes and positions; fractional fills stay exact", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const memory = fixture([order()]);
    const workspace = yield* makeDesk(memory.transport);
    const orders = workspace.orders;
    yield* Source.observeScoped(orders.$keys);
    yield* TestClock.adjust(0);
    const row = Realm.untracked(realm, (read) => read.row(orders.$orders, "limit-local-1"));
    if (!row) throw new Error("missing row");
    const snapshot = (read: Read) => ({
      order: read(row.$value),
      trades: read(workspace.trades.$trades.rows),
      count: read(workspace.trades.$heldCount),
      net: read(workspace.trades.positions.ledger("EURUSD").$aggregate).net,
    });
    using receipts = record(realm, snapshot);
    const message = {
      kind: "partial",
      order: order(undefined, { filled: "0.001", status: "partial", revision: 1 }),
      fill: fill("fractional", "0.001"),
    };
    const initial = Realm.untracked(realm, snapshot);
    {
      using _stop = held(
        Collection.onRowChange(workspace.trades.$trades, ({ after }) => {
          if (after?.id === "fractional") throw new Error("refused fill listener");
        }),
      );
      expect(orders.accept(message)).toBe(false);
      expect(Realm.untracked(realm, snapshot)).toEqual(initial);
      expect(receipts.values).toEqual([]);
    }
    expect(orders.accept(message)).toBe(true);
    expect(receipts.values).toHaveLength(1);
    expect(
      Realm.untracked(
        realm,
        (read) => read(workspace.trades.positions.ledger("EURUSD").$aggregate).net,
      ),
    ).toEqual({ numerator: 1n, denominator: 1000n });
    expect(Realm.untracked(realm, (read) => read(row.$value).filled)).toBe("0.001");
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("malformed amendment acknowledgments roll back and report the missing field", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const memory = fixture([order()]);
    memory.answer(() =>
      Effect.succeed(
        JSON.stringify({
          ok: true,
          message: {
            kind: "amended",
            order: {
              id: "limit-local-1",
              value: { ...value({ revision: 1 }), notional: undefined },
            },
            fill: null,
          },
        }),
      ),
    );
    const workspace = yield* makeDesk(memory.transport);
    const orders = workspace.orders;
    const tile = workspace.tile("EURUSD");
    yield* Source.observeScoped(orders.$keys);
    yield* Source.observeScoped(tile.$prices);
    yield* TestClock.adjust(0);
    memory.send("prices/EURUSD", quote());
    yield* TestClock.adjust(0);
    const row = Realm.untracked(realm, (read) => read.row(orders.$orders, "limit-local-1"));
    if (!row) throw new Error("missing row");
    const ticket = orders.open(tile, row);
    if (!ticket) throw new Error("missing edit");
    ticket.notional.set("200");
    ticket.limitPrice.set("1.08001");
    yield* orders.submit(ticket);
    expect(Realm.untracked(realm, (read) => read(row.$value))).toEqual(value());
    expect(Realm.untracked(realm, (read) => read(orders.$rejections))).toEqual({
      count: 1,
      latest: { path: "message.order.value.notional", reason: "invalid notional" },
    });
    expect(Realm.untracked(realm, (read) => read(orders.$ticket))).toBe(ticket);
    expect(Realm.untracked(realm, (read) => read(ticket.notional.$text))).toBe("200");
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("fills during a refused pending amendment survive its rollback", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const memory = fixture([order()]);
    memory.answer(() =>
      Effect.sleep(100).pipe(Effect.as(JSON.stringify({ ok: false, reason: "Risk cap" }))),
    );
    const workspace = yield* makeDesk(memory.transport);
    const orders = workspace.orders;
    const tile = workspace.tile("EURUSD");
    yield* Source.observeScoped(orders.$keys);
    yield* Source.observeScoped(tile.$prices);
    yield* TestClock.adjust(0);
    memory.send("prices/EURUSD", quote());
    yield* TestClock.adjust(0);
    const row = Realm.untracked(realm, (read) => read.row(orders.$orders, "limit-local-1"));
    if (!row) throw new Error("missing row");
    const ticket = orders.open(tile, row);
    if (!ticket) throw new Error("missing edit");
    ticket.notional.set("200.00");
    ticket.limitPrice.set("1.08005");
    yield* orders.submit(ticket).pipe(Effect.forkScoped({ startImmediately: true }));
    expect(
      orders.accept({
        kind: "partial",
        order: order(undefined, { filled: "10.00", status: "partial", revision: 1 }),
        fill: fill("concurrent"),
      }),
    ).toBe(true);
    yield* TestClock.adjust(100);
    expect(Realm.untracked(realm, (read) => read(row.$value))).toEqual(
      value({ filled: "10.00", status: "partial", revision: 1 }),
    );
    expect(Realm.untracked(realm, (read) => read(ticket.notional.$text))).toBe("200.00");
    expect(Realm.untracked(realm, (read) => read(workspace.trades.$heldCount))).toBe(1);
    expect(
      Realm.untracked(
        realm,
        (read) => read(workspace.trades.positions.ledger("EURUSD").$aggregate).net.numerator,
      ),
    ).toBe(10n);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("the account threshold also gates market orders, and confirmation uses the current quote", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const memory = fixture([], { ...defaultSettings, confirmationThreshold: "10.00" });
    memory.answer((_path, body) =>
      Effect.succeed(
        JSON.stringify({
          ...JSON.parse(body),
          status: "done",
          desk: "local",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        }),
      ),
    );
    const workspace = yield* makeDesk(memory.transport);
    const tile = workspace.tile("EURUSD");
    using view = mount(<SpotTile desk={tile} />);
    yield* actEffect(TestClock.adjust(0));
    yield* actEffect(
      Effect.sync(() => memory.send("prices/EURUSD", quote())).pipe(
        Effect.andThen(TestClock.adjust(0)),
      ),
    );
    const buy = view.container.querySelector<HTMLButtonElement>(".execution-buttons button");
    if (!buy) throw new Error("missing buy");
    act(() => buy.click());
    expect(memory.log.filter((entry) => entry.address === "/execute")).toHaveLength(0);
    expect(view.container.textContent).toContain("Confirm this market buy");
    yield* actEffect(
      Effect.sync(() => memory.send("prices/EURUSD", quote("1.08100", "1.08110"))).pipe(
        Effect.andThen(TestClock.adjust(0)),
      ),
    );
    const confirm = [...view.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Confirm market order",
    );
    if (!confirm) throw new Error("missing confirm");
    act(() => confirm.click());
    yield* actEffect(TestClock.adjust(0));
    const request = memory.log.find(
      (entry) => entry.address === "/execute" && entry.kind === "request",
    );
    expect(JSON.parse(request?.raw ?? "{}").rate).toBe("1.08110");
    expect(Realm.untracked(realm, (read) => read(tile.$confirmation))).toBeNull();
    expect(Realm.untracked(realm, (read) => read(workspace.trades.$heldCount))).toBe(1);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("every open tile opens its own ticket and a high amendment requires confirmation", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const memory = fixture([order()], { ...defaultSettings, confirmationThreshold: "100.00" });
    const workspace = yield* makeDesk(memory.transport);
    using view = mount(
      <>
        <WorkspaceView workspace={workspace} />
        <OrdersPanel workspace={workspace} />
      </>,
    );
    yield* actEffect(TestClock.adjust(0));
    const tiles = [...view.container.querySelectorAll<HTMLElement>(".spot-tile")];
    expect(tiles).toHaveLength(5);
    for (const [index, tile] of tiles.entries()) {
      const button = [...tile.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Limit order",
      );
      if (!button) throw new Error("missing ticket action");
      act(() => button.click());
      expect(view.container.querySelector('[aria-label="Order ticket"]')?.textContent).toContain(
        listedPairs[index]?.symbol ?? "missing symbol",
      );
    }
    yield* actEffect(
      Effect.sync(() => memory.send("prices/EURUSD", quote())).pipe(
        Effect.andThen(TestClock.adjust(0)),
      ),
    );
    const row = Realm.untracked(realm, (read) =>
      read.row(workspace.orders.$orders, "limit-local-1"),
    );
    if (!row) throw new Error("missing order");
    const ticket = duringAct(() => workspace.orders.open(workspace.tile("EURUSD"), row));
    if (!ticket) throw new Error("missing edit");
    act(() => ticket.notional.set("200.00"));
    yield* actEffect(workspace.orders.submit(ticket));
    expect(Realm.untracked(realm, (read) => read(ticket.$confirmation))).toBe(true);
    expect(Realm.untracked(realm, (read) => read(row.$value).notional)).toBe("100.00");
    expect(memory.log.filter((entry) => entry.address === "/orders/amend")).toHaveLength(0);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("UI command fibers belong to the application scope and cannot write after it closes", async () => {
  using realm = testRealm();
  await Effect.gen(function* () {
    const memory = fixture();
    memory.answer(() =>
      Effect.sleep(1000).pipe(Effect.as(JSON.stringify({ ok: false, reason: "late refusal" }))),
    );
    const ticket = yield* Effect.gen(function* () {
      const workspace = yield* makeDesk(memory.transport);
      const tile = workspace.tile("EURUSD");
      yield* Source.observeScoped(tile.$prices);
      yield* TestClock.adjust(0);
      memory.send("prices/EURUSD", quote());
      yield* TestClock.adjust(0);
      const ticket = workspace.orders.open(tile);
      if (!ticket) throw new Error("missing ticket");
      workspace.orders.run(workspace.orders.submit(ticket));
      yield* TestClock.adjust(0);
      expect(Realm.untracked(realm, (read) => read(ticket.$pending))).toBe(true);
      return ticket;
    }).pipe(Effect.scoped);
    using receipts = record(realm, (read) => ({
      pending: read(ticket.$pending),
      reason: read(ticket.$reason),
    }));
    const length = memory.log.length;
    expect(Realm.untracked(realm, (read) => read(ticket.$pending))).toBe(false);
    yield* TestClock.adjust(2000);
    expect(receipts.values).toEqual([]);
    expect(memory.log).toHaveLength(length);
    expect(Realm.untracked(realm, (read) => read(ticket.$reason))).toBeNull();
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});
