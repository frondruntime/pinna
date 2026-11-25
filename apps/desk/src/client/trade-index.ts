import type { Trade } from "./wire.ts";

export const columns = ["time", "pair", "direction", "notional", "rate", "status", "desk"] as const;
export type Column = (typeof columns)[number];
export interface Sort {
  readonly column: Column;
  readonly direction: "ascending" | "descending";
}
export const rowHeight = 36;
export const windowMargin = 3;

export function shownColumns(trade: Trade): readonly string[] {
  return [
    trade.createdAt.slice(11, 23),
    trade.symbol,
    trade.direction,
    trade.notional,
    trade.rate,
    trade.status,
    trade.desk,
  ];
}

export const matches = (trade: Trade, filter: string) =>
  shownColumns(trade).some((value) => value.toLowerCase().includes(filter.toLowerCase()));

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** Positive decimal strings, including values too precise for Number. */
export function compareDecimal(left: string, right: string): number {
  const [leftWhole = "0", leftFraction = ""] = left.split(".");
  const [rightWhole = "0", rightFraction = ""] = right.split(".");
  const wholeLeft = leftWhole.replace(/^0+/, "") || "0";
  const wholeRight = rightWhole.replace(/^0+/, "") || "0";
  const width = Math.max(leftFraction.length, rightFraction.length);
  return (
    wholeLeft.length - wholeRight.length ||
    compareText(wholeLeft, wholeRight) ||
    compareText(leftFraction.padEnd(width, "0"), rightFraction.padEnd(width, "0"))
  );
}

export function addDecimal(left: string, right: string): string {
  const width = Math.max(left.split(".")[1]?.length ?? 0, right.split(".")[1]?.length ?? 0);
  const integer = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(`${whole}${fraction.padEnd(width, "0")}`);
  };
  const result = (integer(left) + integer(right)).toString().padStart(width + 1, "0");
  return width === 0 ? result : `${result.slice(0, -width)}.${result.slice(-width)}`;
}

export function compareTrades(sort: Sort) {
  return (left: Trade, right: Trade) => {
    const field = (trade: Trade) =>
      sort.column === "time"
        ? trade.createdAt
        : sort.column === "pair"
          ? trade.symbol
          : trade[sort.column];
    const primary =
      sort.column === "notional" || sort.column === "rate"
        ? compareDecimal(field(left), field(right))
        : compareText(field(left), field(right));
    // Equal columns always fall back to newest, then descending ID, independent of sort direction.
    return (
      primary * (sort.direction === "ascending" ? 1 : -1) ||
      compareText(right.createdAt, left.createdAt) ||
      compareText(right.id, left.id)
    );
  };
}
