/** The sample positions as the server sends them, with decimals and dates as strings. */
import { Context } from "effect";
import { type DateFormatting, Dates } from "./contract.ts";

export type PositionJson = Record<string, unknown>;

/** A date formatter that writes ISO strings. */
export const formatter: DateFormatting = {
  formatDateTime: (_read, value) => value.toISOString(),
};

/** The decode context: the formatter as the `Dates` service. */
export const context = Context.make(Dates, formatter);

export const positionJson = (overrides: PositionJson = {}): PositionJson => ({
  id: "position-42",
  account: "account-7",
  isShort: false,
  collateralTicker: "USDT",
  baseTicker: "BTC",
  quoteTicker: "USDT",
  collateral: "100.25",
  size: "0.0016",
  entryPrice: "62000",
  leverage: 2,
  status: "open",
  openedAt: "2026-08-25T08:01:00.000Z",
  nextFundingAt: "2026-08-26T08:01:00.000Z",
  nextFundingFee: "0.1",
  ...overrides,
});

/** The server's estimate: a stale profit, and the funding accrued so far. */
export const liveEstimate = { profit: "999", accruedFunding: "0.25" };

export const livePositionJson = (overrides: PositionJson = {}): PositionJson =>
  positionJson({
    collateral: "120",
    size: "2",
    entryPrice: "100",
    openFee: "0.25",
    closeFee: "0.25",
    nextFundingFee: "0.25",
    estimate: liveEstimate,
    ...overrides,
  });
