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

/** Persistent AVL tree: rank reads and edits copy only the search path. */
export interface TradeIndex {
  readonly trade: Trade;
  readonly left: TradeIndex | undefined;
  readonly right: TradeIndex | undefined;
  readonly height: number;
  readonly size: number;
}
export const size = (tree: TradeIndex | undefined): number => tree?.size ?? 0;
const height = (tree: TradeIndex | undefined) => tree?.height ?? 0;
const branch = (trade: Trade, left?: TradeIndex, right?: TradeIndex): TradeIndex => ({
  trade,
  left,
  right,
  height: Math.max(height(left), height(right)) + 1,
  size: size(left) + size(right) + 1,
});

function balance(trade: Trade, left?: TradeIndex, right?: TradeIndex): TradeIndex {
  if (left && height(left) > height(right) + 1) {
    if (height(left.right) > height(left.left) && left.right) {
      const middle = left.right;
      return branch(
        middle.trade,
        branch(left.trade, left.left, middle.left),
        branch(trade, middle.right, right),
      );
    }
    return branch(left.trade, left.left, branch(trade, left.right, right));
  }
  if (right && height(right) > height(left) + 1) {
    if (height(right.left) > height(right.right) && right.left) {
      const middle = right.left;
      return branch(
        middle.trade,
        branch(trade, left, middle.left),
        branch(right.trade, middle.right, right.right),
      );
    }
    return branch(right.trade, branch(trade, left, right.left), right.right);
  }
  return branch(trade, left, right);
}

export function insert(
  tree: TradeIndex | undefined,
  trade: Trade,
  compare: (left: Trade, right: Trade) => number,
): TradeIndex {
  if (!tree) return branch(trade);
  const order = compare(trade, tree.trade);
  return order === 0
    ? branch(trade, tree.left, tree.right)
    : order < 0
      ? balance(tree.trade, insert(tree.left, trade, compare), tree.right)
      : balance(tree.trade, tree.left, insert(tree.right, trade, compare));
}

export function remove(
  tree: TradeIndex | undefined,
  trade: Trade,
  compare: (left: Trade, right: Trade) => number,
): TradeIndex | undefined {
  if (!tree) return undefined;
  const order = compare(trade, tree.trade);
  if (order < 0) return balance(tree.trade, remove(tree.left, trade, compare), tree.right);
  if (order > 0) return balance(tree.trade, tree.left, remove(tree.right, trade, compare));
  if (!tree.left) return tree.right;
  if (!tree.right) return tree.left;
  let successor = tree.right;
  while (successor.left) successor = successor.left;
  return balance(successor.trade, tree.left, remove(tree.right, successor.trade, compare));
}

export function range(
  tree: TradeIndex | undefined,
  start: number,
  end: number,
  result: string[] = [],
): string[] {
  if (!tree || end <= 0 || start >= tree.size || start >= end) return result;
  const rank = size(tree.left);
  range(tree.left, start, end, result);
  if (start <= rank && rank < end) result.push(tree.trade.id);
  range(tree.right, start - rank - 1, end - rank - 1, result);
  return result;
}

export function buildIndex(trades: Trade[], compare: (left: Trade, right: Trade) => number) {
  trades.sort(compare);
  return buildOrderedIndex(trades);
}

function buildOrderedIndex(trades: readonly Trade[]) {
  const build = (start: number, end: number): TradeIndex | undefined => {
    if (start >= end) return undefined;
    const middle = Math.floor((start + end) / 2);
    return branch(trades[middle] as Trade, build(start, middle), build(middle + 1, end));
  };
  return build(0, trades.length);
}

export function indexTrades(tree: TradeIndex | undefined, filter = ""): Trade[] {
  const trades: Trade[] = [];
  const visit = (tree: TradeIndex | undefined) => {
    if (!tree) return;
    visit(tree.left);
    if (!filter || matches(tree.trade, filter)) trades.push(tree.trade);
    visit(tree.right);
  };
  visit(tree);
  return trades;
}

export const filterIndex = (tree: TradeIndex | undefined, filter: string) =>
  filter ? buildOrderedIndex(indexTrades(tree, filter)) : tree;
