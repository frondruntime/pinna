/**
 * The sample position against the rates. The rates live in a box and the
 * position in another; a computed value of the two is the live projection.
 */
import { describe, expect, test } from "bun:test";
import { BigDecimal, Context, Schema } from "effect";
import {
  computed,
  createRealm,
  decode,
  type Read,
  type Realm,
  schemaBox,
  untracked,
  update,
  watch,
} from "../../src/index.ts";
import { Dates, Position, Rates } from "./contract.ts";
import {
  context,
  formatter,
  liveEstimate,
  livePositionJson,
  type PositionJson,
  positionJson,
} from "./fixture.ts";

const text = (value: BigDecimal.BigDecimal | undefined): string | undefined =>
  value === undefined ? undefined : BigDecimal.format(value);

const decodePosition = (realm: Realm, json: PositionJson): Position =>
  decode(realm, Position, context)(json);

/** Watches `select`, keeping every value it settles on, the first included. */
const follow = <Value>(realm: Realm, select: (read: Read) => Value) => {
  const values: Array<Value> = [untracked(realm, select)];
  const stop = watch(realm, select, (value) => {
    values.push(value);
  });
  return { values, last: () => values.at(-1), stop };
};

/** A position and the rates in boxes, and its projection as text. */
const setup = (json: PositionJson, rates: Rates) => {
  const realm = createRealm();
  const $position = schemaBox(realm, Position, decodePosition(realm, json));
  const $rates = schemaBox(realm, Rates, rates);
  const $projection = computed(realm, (read) => read($position).calculate(read($rates)));
  const snapshot = (next: PositionJson) => {
    update(realm, (_read, write) => {
      write($position, decodePosition(realm, next));
    });
  };
  const setRates = (next: Rates) => {
    update(realm, (_read, write) => {
      write($rates, next);
    });
  };
  return { realm, $position, $projection, snapshot, setRates };
};

describe("Position", () => {
  test("decodes monetary, temporal, nested, and product-state fields", () => {
    const realm = createRealm();
    const position = decodePosition(
      realm,
      positionJson({
        status: "open",
        estimate: { profit: "10.5", accruedFunding: "0.25" },
        chart: [{ at: "2026-08-25T10:00:00.000Z", price: "61000" }],
        closedAt: null,
      }),
    );

    expect(position).toBeInstanceOf(Position);
    expect(BigDecimal.isBigDecimal(position.collateral)).toBe(true);
    expect(text(position.collateral)).toBe("100.25");
    expect(position.openedAt).toEqual(new Date("2026-08-25T08:01:00.000Z"));
    expect(position.closedAt).toBeNull();
    expect(text(position.estimate?.profit)).toBe("10.5");
    expect(text(position.chart?.[0]?.price)).toBe("61000");
    expect(position.chart?.[0]?.at).toEqual(new Date("2026-08-25T10:00:00.000Z"));
    expect(position.isOpen).toBe(true);
    expect(untracked(realm, (read) => position.openedAtFormatted(read))).toBe(
      "2026-08-25T08:01:00.000Z",
    );
    expect(untracked(realm, (read) => position.closedAtFormatted(read))).toBeUndefined();
  });

  test("the date formatter comes from the caller's context, not the wire", () => {
    const realm = createRealm();
    const position = decodePosition(realm, positionJson());
    expect(position.dates).toBe(formatter);
    const encoded = Schema.encodeSync(Position)(position);
    expect(Object.keys(encoded)).not.toContain("dates");
    // @ts-expect-error Position needs the Dates service.
    expect(() => decode(realm, Position)(positionJson())).toThrow();
  });

  test("the context is the caller's runtime instance, and its reactive state reaches the formatted dates", () => {
    const realm = createRealm();
    // An application's date service: an instance built elsewhere, whose
    // output follows a locale that changes at runtime.
    // The formatter reads its locale with the caller's read, so the watch
    // below tracks it.
    class LocaleFormatter {
      readonly $locale = schemaBox(realm, Schema.String, "en");
      readonly formatDateTime = (read: Read, value: Date): string =>
        `${read(this.$locale)} ${value.toISOString()}`;
    }
    const localeFormatter = new LocaleFormatter();
    const position = decode(realm, Position, Context.make(Dates, localeFormatter))(positionJson());

    expect(position.dates).toBe(localeFormatter);
    const formatted = follow(realm, (read) => position.openedAtFormatted(read));
    update(realm, (_read, write) => {
      write(localeFormatter.$locale, "de");
    });
    expect(formatted.values).toEqual([
      "en 2026-08-25T08:01:00.000Z",
      "de 2026-08-25T08:01:00.000Z",
    ]);
    formatted.stop();
  });

  test("a snapshot replaces the position in its box", () => {
    const { realm, $position, snapshot } = setup(positionJson(), {});
    const watched = follow(realm, (read) => read($position).isOpen);

    snapshot(
      positionJson({
        collateral: "333.75",
        status: "closed",
        closedAt: "2026-08-25T12:00:00.000Z",
      }),
    );

    const position = untracked(realm, (read) => read($position));
    expect(text(position.collateral)).toBe("333.75");
    expect(position.status).toBe("closed");
    expect(position.closedAt).toEqual(new Date("2026-08-25T12:00:00.000Z"));
    expect(untracked(realm, (read) => position.closedAtFormatted(read))).toBe(
      "2026-08-25T12:00:00.000Z",
    );
    expect(watched.values).toEqual([true, false]);
    watched.stop();
  });

  test.each([
    { isShort: false, initial: "5.25", next: "-10.75" },
    { isShort: true, initial: "-8.75", next: "7.25" },
  ])("recalculates the profit (short: $isShort) from the closing bid or ask without a position event", (scenario) => {
    const { realm, $projection, snapshot, setRates } = setup(
      livePositionJson({ isShort: scenario.isShort }),
      { BTC: { USDT: { price: 100, bid: 103, ask: 104 } } },
    );
    const pnl = follow(realm, (read) => text(read($projection)?.profit));

    expect(pnl.last()).toBe(scenario.initial);
    setRates({ BTC: { USDT: { price: 100, bid: 95, ask: 96 } } });
    expect(pnl.last()).toBe(scenario.next);
    // The server's stale estimate must not replace the live projection.
    snapshot(livePositionJson({ isShort: scenario.isShort }));
    expect(pnl.last()).toBe(scenario.next);
    pnl.stop();
  });

  test("follows collateral conversion, fees, and the payout, then keeps the settlement", () => {
    const json = livePositionJson({
      collateralTicker: "ETH",
      collateral: "20",
      openFee: "1",
      closeFee: "0.5",
      estimate: { ...liveEstimate, accruedFunding: "5" },
    });
    const { realm, $projection, snapshot, setRates } = setup(json, {
      BTC: { USDT: { price: 110, bid: 110, ask: 111 } },
      ETH: { USDT: { price: 10, bid: 10, ask: 10 } },
    });
    const projection = follow(realm, (read) => {
      const value = read($projection);
      return [text(value?.profit), text(value?.payout)];
    });

    // 20 USDT of profit is 2 ETH, less 6.5 ETH of fees.
    expect(projection.last()).toEqual(["-4.5", "15.5"]);
    setRates({
      BTC: { USDT: { price: 110, bid: 110, ask: 111 } },
      ETH: { USDT: { price: 20, bid: 20, ask: 20 } },
    });
    expect(projection.last()).toEqual(["-5.5", "14.5"]);
    snapshot({ ...json, estimate: { ...liveEstimate, accruedFunding: "15" } });
    expect(projection.last()).toEqual(["-15.5", "4.5"]);
    snapshot({
      ...json,
      status: "closed",
      settlement: { profit: "-3", percent: "-15", payout: "17" },
    });
    expect(projection.last()).toEqual(["-3", "17"]);
    setRates({
      BTC: { USDT: { price: 110, bid: 200, ask: 111 } },
      ETH: { USDT: { price: 5, bid: 5, ask: 5 } },
    });
    expect(projection.last()).toEqual(["-3", "17"]);
    projection.stop();
  });

  test("deducts the accrued funding once and never the next period's in advance", () => {
    const json = livePositionJson({
      collateral: "100.074",
      openFee: "4.953663",
      closeFee: "6.154551",
      nextFundingFee: "0.116753",
      estimate: { ...liveEstimate, accruedFunding: "0" },
    });
    const { realm, $projection, snapshot } = setup(json, {
      BTC: { USDT: { price: 100, bid: 100, ask: 100 } },
    });
    const observed = follow(realm, (read) => {
      const value = read($projection);
      return [text(value?.profit), text(value?.payout)];
    });

    // Flat market: only the open and close fees come off.
    expect(observed.last()).toEqual(["-11.108214", "88.965786"]);
    snapshot({ ...json, nextFundingFee: "0.5" });
    expect(observed.last()).toEqual(["-11.108214", "88.965786"]);
    snapshot({ ...json, estimate: { ...liveEstimate, accruedFunding: "1" } });
    expect(observed.last()).toEqual(["-12.108214", "87.965786"]);
    observed.stop();
  });

  test("keeps a missing estimate and missing or zero market rates unavailable", () => {
    const realm = createRealm();
    const rates = { BTC: { USDT: { price: 100, bid: 100, ask: 100 } } };
    expect(decodePosition(realm, positionJson()).calculate(rates)).toBeUndefined();
    const position = decodePosition(realm, livePositionJson());
    expect(position.calculate({})).toBeUndefined();
    expect(position.calculate({ BTC: { USDT: { ...rates.BTC.USDT, bid: 0 } } })).toBeUndefined();
    expect(
      decodePosition(realm, livePositionJson({ collateralTicker: "ETH" })).calculate(rates),
    ).toBeUndefined();
  });
});
