import { cpus, platform, release } from "node:os";
import { untracked } from "@frondruntime/pinna";
import { testRealm } from "@frondruntime/pinna/testing";
import { changes, observeScoped, RealmService } from "@frondruntime/pinna-effect";
import { Effect, Fiber, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makeDesk } from "../src/client/desk.ts";
import { rowHeight, type Sort } from "../src/client/trade-index.ts";
import { makeExchange } from "../src/exchange/index.ts";
import { inMemoryTransport } from "../src/transport.ts";

const percentile = (samples: number[], fraction: number) => {
  const sorted = [...samples].sort((left, right) => left - right);
  return (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0).toFixed(
    3,
  );
};
const report = (label: string, samples: number[]) =>
  console.log(
    `${label}: median ${percentile(samples, 0.5)} ms; p95 ${percentile(samples, 0.95)} ms (${samples.length} samples)`,
  );

async function measure(historyTradeCount: number) {
  using realm = testRealm();
  await Effect.gen(function* () {
    const exchange = yield* makeExchange({
      seed: 1729,
      historyTradeCount,
      otherDeskTradesPerSecond: 0,
    });
    const senders = new Map<string, (raw: string) => void>();
    const send = (topic: string, raw: string) => {
      const deliver = senders.get(topic);
      if (!deliver) throw new Error(`topic is not subscribed: ${topic}`);
      deliver(raw);
    };
    // Use the real snapshot and the production opaque transport. Inject serialized topic
    // messages so each sample measures exactly one arrival, with the market clock frozen.
    const memory = inMemoryTransport({
      request: exchange.request,
      subscribe: (topic) =>
        Stream.callback<string>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              senders.set(topic, (raw) => {
                Queue.offerUnsafe(queue, raw);
              });
            }),
            () => Effect.sync(() => senders.delete(topic)),
          ),
        ),
    });
    const workspace = yield* makeDesk(memory.transport);
    const desk = workspace.tile("EURUSD");
    const book = desk.trades;
    const loadedAt = performance.now();
    yield* observeScoped(book.$window);
    yield* observeScoped(book.$matchingCount);
    yield* observeScoped(book.$heldCount);
    yield* observeScoped(book.$selectionSummary);
    yield* observeScoped(workspace.$view);
    yield* changes(book.$loaded).pipe(Stream.filter(Boolean), Stream.take(1), Stream.runDrain);
    const loadMilliseconds = performance.now() - loadedAt;
    yield* TestClock.adjust(0);
    for (const [symbol, bid, ask] of [
      ["EURUSD", "1.08000", "1.08010"],
      ["GBPUSD", "1.27000", "1.27010"],
      ["USDJPY", "152.000", "152.010"],
      ["AUDUSD", "0.66000", "0.66010"],
      ["EURGBP", "0.85000", "0.85010"],
    ] as const)
      send(
        `prices/${symbol}`,
        JSON.stringify({ symbol, bid, ask, time: new Date(0).toISOString() }),
      );
    yield* TestClock.adjust(0);
    const settle = () =>
      untracked(realm, (read) => ({
        window: read(book.$window),
        matching: read(book.$matchingCount),
        held: read(book.$heldCount),
        summary: read(book.$selectionSummary),
        positions: read(workspace.$view),
      }));
    settle();
    console.log(`\n${historyTradeCount.toLocaleString("en-US")} history trades`);
    console.log(`Snapshot load: ${loadMilliseconds.toFixed(3)} ms`);
    const insertSamples: number[] = [];
    const updateSamples: number[] = [];
    // Warm the same production path before collecting distributions.
    for (let index = 0; index < 270; index++) {
      const time = new Date(index + 1).toISOString();
      const pending = {
        id: `measurement-${index}`,
        symbol: "EURUSD",
        direction: "buy",
        notional: "123456.789",
        rate: "1.08010",
        desk: "desk-2",
        status: "pending",
        createdAt: time,
        updatedAt: time,
      };
      for (const status of ["pending", "done"]) {
        const raw = JSON.stringify({
          ...pending,
          status,
          updatedAt: new Date(index + (status === "done" ? 1001 : 1)).toISOString(),
        });
        const settled = yield* changes(book.$trades.row(pending.id)).pipe(
          Stream.filter((trade) => trade?.status === status),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped({ startImmediately: true }),
        );
        const started = performance.now();
        send("trades", raw);
        yield* Fiber.join(settled);
        settle();
        const elapsed = performance.now() - started;
        if (index >= 20) (status === "pending" ? insertSamples : updateSamples).push(elapsed);
      }
    }
    report("Incoming new trade", insertSamples);
    report("Incoming held-trade update", updateSamples);
    report("One done trade through positions and blotter until settled", updateSamples);
    const tickSamples: number[] = [];
    for (let index = 0; index < 270; index++) {
      // GBP/USD affects its own row and EUR/GBP conversion, plus the total.
      const tile = workspace.tile("GBPUSD");
      const time = new Date(index + 1).toISOString();
      const settled = yield* changes(tile.$prices).pipe(
        Stream.filter((state) => state.current?.time === time),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped({ startImmediately: true }),
      );
      const raw = JSON.stringify({
        symbol: "GBPUSD",
        bid: (1.27 + index / 100000).toFixed(5),
        ask: (1.2701 + index / 100000).toFixed(5),
        time,
      });
      const started = performance.now();
      send("prices/GBPUSD", raw);
      yield* Fiber.join(settled);
      settle();
      if (index >= 20) tickSamples.push(performance.now() - started);
    }
    report("One GBP/USD tick through positions until settled", tickSamples);
    const sortSamples: number[] = [];
    const sorts: Sort[] = [
      { column: "notional", direction: "ascending" },
      { column: "notional", direction: "descending" },
      { column: "status", direction: "ascending" },
      { column: "time", direction: "descending" },
    ];
    for (const sort of sorts) {
      const started = performance.now();
      book.setSort(sort);
      settle();
      sortSamples.push(performance.now() - started);
    }
    report("Change sort", sortSamples);
    const filterSamples: number[] = [];
    for (const filter of ["d", "de", "des", "desk", "desk-", "desk-2"]) {
      const started = performance.now();
      book.setFilter(filter);
      settle();
      const elapsed = performance.now() - started;
      filterSamples.push(elapsed);
      console.log(`Filter ${JSON.stringify(filter)}: ${elapsed.toFixed(3)} ms`);
    }
    report("Filter keystroke", filterSamples);
    book.setFilter("");
    book.setScrollTop(Math.floor(historyTradeCount / 2) * rowHeight);
    const scrollSamples: number[] = [];
    for (let step = 0; step < 250; step++) {
      const started = performance.now();
      book.setScrollTop((Math.floor(historyTradeCount / 2) + step + 1) * rowHeight);
      settle();
      scrollSamples.push(performance.now() - started);
    }
    report("Scroll one row", scrollSamples);
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
}

console.log(
  `Machine: ${cpus()[0]?.model ?? "unknown CPU"}; ${process.arch}; ${platform()} ${release()}`,
);
console.log(`Runtime: Bun ${Bun.version}; JavaScriptCore; concurrent JIT disabled`);
console.log(
  "Headless, observed view; times include synchronous state settlement and topic delivery; no rendering.",
);
for (const count of [10000, 100000]) await measure(count);
