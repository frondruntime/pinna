import type { LogEntry } from "../src/transport.ts";

// Independent wire fold: no client schemas, state, arithmetic, or Pinna imports.
interface Value {
  symbol: string;
  side: string;
  notional: string;
  limitPrice: string;
  timeInForce: string;
  expiry: string;
  note: string;
  filled: string;
  status: string;
  revision: number;
}
interface Row {
  id: string;
  value: Value;
}
export interface OrderSnapshot {
  orders: readonly Row[];
  fills: number;
  cents: bigint;
}
export interface Rejected {
  prefix: number;
  path: string;
  reason: string;
}
const record = (
  input: unknown,
): Record<string, unknown> & Partial<Record<"value" | "path" | "reason", unknown>> =>
  typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
const positive = (input: unknown, places: number) =>
  typeof input === "string" &&
  new RegExp(`^\\d+(?:\\.\\d{1,${places}})?$`).test(input) &&
  /[1-9]/.test(input);
const units = (input: string) => {
  const [whole = "0", fractional = ""] = input.split(".");
  return BigInt(whole + fractional.padEnd(2, "0"));
};
const stringify = (value: OrderSnapshot) =>
  JSON.stringify(value, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
export function orderOracle(log: readonly LogEntry[]) {
  const rows = new Map<string, Row>();
  const fills: string[] = [];
  let cents = 0n;
  const states: { prefix: number; value: OrderSnapshot; fingerprint: string }[] = [];
  const rejected: Rejected[] = [];
  const capture = (prefix: number) => {
    const value = { orders: [...rows.values()], fills: fills.length, cents };
    states.push({ prefix, value, fingerprint: stringify(value) });
  };
  capture(0);
  const fail = (path: string, reason: string): never => {
    throw { path, reason };
  };
  for (let index = 0; index < log.length; index++) {
    const entry = log[index];
    if (!entry) continue;
    if (entry.kind === "response" && entry.address === "/orders") {
      const incoming = JSON.parse(entry.raw) as Row[];
      for (const row of incoming) rows.set(row.id, row);
      capture(index + 1);
      continue;
    }
    if (entry.kind !== "order") continue;
    try {
      const message = JSON.parse(entry.raw) as {
        kind: string;
        order: Row;
        fill: null | { id: string; notional: string; direction: string; symbol: string };
      };
      if (
        !["accepted", "amended", "partial", "filled", "cancelled", "expired"].includes(message.kind)
      )
        fail("kind", "unknown message kind");
      const row = record(message.order);
      const data = record(row.value);
      const checks: Record<string, (input: unknown) => boolean> = {
        symbol: (input) =>
          ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "EURGBP"].includes(String(input)),
        side: (input) => input === "buy" || input === "sell",
        notional: (input) => positive(input, 2),
        limitPrice: (input) => positive(input, 5),
        timeInForce: (input) => ["day", "date", "immediate"].includes(String(input)),
        expiry: (input) => typeof input === "string",
        note: (input) => typeof input === "string" && input.length <= 200,
        filled: (input) => typeof input === "string" && /^\d+(?:\.\d{1,2})?$/.test(input),
        status: (input) =>
          ["working", "partial", "filled", "cancelled", "expired"].includes(String(input)),
        revision: (input) => Number.isSafeInteger(input) && Number(input) >= 0,
      };
      for (const [key, check] of Object.entries(checks))
        if (!check(data[key])) fail(`order.value.${key}`, `invalid ${key}`);
      const next = message.order.value;
      const previous = rows.get(message.order.id)?.value;
      if (!positive(next.limitPrice, next.symbol === "USDJPY" ? 3 : 5))
        fail("order.value.limitPrice", "price exceeds pair precision");
      if (units(next.filled) > units(next.notional))
        fail("order.value.filled", "fill exceeds notional");
      if (
        (next.status === "working" && units(next.filled) !== 0n) ||
        (next.status === "partial" &&
          (units(next.filled) === 0n || units(next.filled) >= units(next.notional))) ||
        (next.status === "filled" && units(next.filled) !== units(next.notional))
      )
        fail("order.value", "inconsistent status, amount, or expiry");
      if (!previous && message.kind !== "accepted") fail("order.id", "unknown order");
      if (previous && next.revision <= previous.revision)
        fail("order.value.revision", "stale or repeated revision");
      if (previous && ["filled", "cancelled", "expired"].includes(previous.status))
        fail("order.value.status", "order is already terminal");
      if (message.fill && previous) {
        if (units(previous.filled) + units(message.fill.notional) > units(previous.notional))
          fail("fill.notional", "fill exceeds remaining amount");
        if (units(previous.filled) + units(message.fill.notional) !== units(next.filled))
          fail("order.value.filled", "filled amount does not match fill");
      }
      rows.set(message.order.id, message.order);
      if (message.fill) {
        fills.push(message.fill.id);
        cents += units(message.fill.notional) * (message.fill.direction === "buy" ? 1n : -1n);
      }
      capture(index + 1);
    } catch (error) {
      const diagnostic = record(error);
      rejected.push({
        prefix: index + 1,
        path: String(diagnostic.path),
        reason: String(diagnostic.reason),
      });
    }
  }
  return { states, rejected, fills, fingerprint: stringify };
}
