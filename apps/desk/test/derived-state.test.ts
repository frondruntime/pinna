import { expect, test } from "bun:test";
import { Collection, Computed, type Read, Realm } from "@frondruntime/pinna";
import { held, record, testRealm } from "@frondruntime/pinna/testing";
import { Effect } from "effect";
import { decimal } from "../src/client/decimal.ts";
import { TradeBook } from "../src/client/trades.ts";
import { decodeTrade } from "../src/client/wire.ts";
import { wireTrade } from "./feed.ts";

test("collection writes alone keep sorted and filtered trades, counts, selection, and positions in step", async () => {
  using realm = testRealm();
  using book = new TradeBook(
    realm,
    Computed.make(realm, () => 0),
  );
  book.setSort({ column: "notional", direction: "ascending" });
  book.setFilter("done");
  const first = await Effect.runPromise(
    decodeTrade({ ...wireTrade("first"), status: "done", notional: "2", rate: "1.00000" }),
  );
  const second = await Effect.runPromise(
    decodeTrade({ ...wireTrade("second"), status: "done", notional: "3", rate: "2.00000" }),
  );
  const pending = await Effect.runPromise(decodeTrade({ ...wireTrade("pending"), notional: "1" }));
  const corrected = await Effect.runPromise(
    decodeTrade({ ...first, symbol: "GBPUSD", direction: "sell", notional: "4", rate: "1.50000" }),
  );
  const select = (read: Read) => ({
    rows: read(book.$trades.rows),
    keys: read(book.$keys),
    window: read(book.$window).ids,
    held: read(book.$heldCount),
    matching: read(book.$matchingCount),
    selected: read(book.$selection),
    positions: read(book.$positionSymbols),
    euro: read(book.positions.ledger("EURUSD").$aggregate),
    pound: read(book.positions.ledger("GBPUSD").$aggregate),
  });
  using receipts = record(realm, select);
  Realm.update(realm, (_read, write) => write.replaceAll(book.$trades, [first, second, pending]));
  expect(receipts.values).toHaveLength(1);
  expect(receipts.values[0]).toEqual({
    rows: [first, second, pending],
    keys: ["first", "second"],
    window: ["first", "second"],
    held: 3,
    matching: 2,
    selected: [],
    positions: ["EURUSD"],
    euro: { count: 2, net: decimal("5"), cost: decimal("8") },
    pound: { count: 0, net: decimal("0"), cost: decimal("0") },
  });
  book.setSelection(["first", "second"]);
  const beforeCorrection = receipts.values.length;
  Realm.update(realm, (_read, write) => {
    write.upsert(book.$trades, corrected);
    write.remove(book.$trades, "second");
  });
  expect(receipts.values).toHaveLength(beforeCorrection + 1);
  expect(receipts.values.at(-1)).toEqual({
    rows: [corrected, pending],
    keys: ["first"],
    window: ["first"],
    held: 2,
    matching: 1,
    selected: ["first"],
    positions: ["GBPUSD"],
    euro: { count: 0, net: decimal("0"), cost: decimal("0") },
    pound: { count: 1, net: decimal("-4"), cost: decimal("-6") },
  });
  const beforeEqual = receipts.values.length;
  Realm.update(realm, (_read, write) => {
    write.upsert(book.$trades, { ...corrected });
    write.remove(book.$trades, "absent");
    write.replaceAll(book.$trades, [{ ...corrected }, { ...pending }]);
  });
  expect(receipts.values).toHaveLength(beforeEqual);
  Realm.update(realm, (_read, write) => write.replaceAll(book.$trades, [second]));
  expect(receipts.values).toHaveLength(beforeEqual + 1);
  expect(Realm.untracked(realm, select)).toEqual({
    rows: [second],
    keys: ["second"],
    window: ["second"],
    held: 1,
    matching: 1,
    selected: [],
    positions: ["EURUSD"],
    euro: { count: 1, net: decimal("3"), cost: decimal("6") },
    pound: { count: 0, net: decimal("0"), cost: decimal("0") },
  });
  book.setFilter("");
  Realm.update(realm, (_read, write) => write.upsert(book.$trades, pending));
  expect(Realm.untracked(realm, (read) => read(book.$keys))).toEqual(["pending", "second"]);
  Realm.update(realm, (_read, write) => write.replaceAll(book.$trades, []));
  expect(
    Realm.untracked(realm, (read) => [read(book.$heldCount), read(book.$matchingCount)]),
  ).toEqual([0, 0]);
  expect(Realm.untracked(realm, (read) => read(book.$positionSymbols))).toEqual([]);
});

test("failed collection writes roll back the rows and every derived structure, including caught listener failures", async () => {
  using realm = testRealm();
  using book = new TradeBook(
    realm,
    Computed.make(realm, () => 0),
  );
  const first = await Effect.runPromise(decodeTrade({ ...wireTrade("first"), status: "done" }));
  const refused = await Effect.runPromise(
    decodeTrade({ ...wireTrade("refused"), symbol: "GBPUSD", status: "done" }),
  );
  const select = (read: Read) => ({
    rows: read(book.$trades.rows),
    keys: read(book.$keys),
    window: read(book.$window),
    held: read(book.$heldCount),
    matching: read(book.$matchingCount),
    selection: read(book.$selection),
    positions: book.positions.ledgers.map((ledger) => read(ledger.$aggregate)),
  });
  Realm.update(realm, (_read, write) => write.upsert(book.$trades, first));
  book.setSelection([first.id]);
  book.setFilter("done");
  const before = Realm.untracked(realm, select);
  using receipts = record(realm, select);
  expect(() =>
    Realm.update(realm, (_read, write) => {
      write.remove(book.$trades, first.id);
      write.upsert(book.$trades, refused);
      throw new Error("failed trade batch");
    }),
  ).toThrow("failed trade batch");
  expect(Realm.untracked(realm, select)).toEqual(before);
  expect(receipts.values).toEqual([]);
  using _listener = held(
    Collection.onRowChange(book.$trades, ({ before, after }) => {
      if (after?.id === refused.id || (before?.id === first.id && after === undefined))
        throw new Error("refused trade write");
    }),
  );
  // The rejecting listener runs after both application listeners have written.
  Realm.update(realm, (_read, write) => {
    expect(() => write.upsert(book.$trades, refused)).toThrow("refused trade write");
    expect(() => write.remove(book.$trades, first.id)).toThrow("refused trade write");
    expect(() => write.replaceAll(book.$trades, [refused])).toThrow("refused trade write");
  });
  expect(Realm.untracked(realm, select)).toEqual(before);
  expect(receipts.values).toEqual([]);
});
