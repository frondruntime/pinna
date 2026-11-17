import { BoxField, CollectionField, SchemaModel } from "@frondruntime/pinna-effect";
import { Schema } from "effect";
import { decimal, subtract } from "./decimal.ts";

export { addDecimal as decimalSum } from "./trade-index.ts";

import { PairSymbol, Trade } from "./wire.ts";

export const positiveDecimal = (places: number) =>
  Schema.String.check(
    Schema.isPattern(new RegExp(`^\\d+(?:\\.\\d{1,${places}})?$`)),
    Schema.makeFilter((value) => /[1-9]/.test(value)),
  );
export const Amount = positiveDecimal(2);
export const Side = Schema.Literals(["buy", "sell"]);
export const TimeInForce = Schema.Literals(["day", "date", "immediate"]);
export const Note = Schema.String.check(Schema.makeFilter((value) => value.length <= 200));
export const DateText = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
  ),
);
export const futureDate = (today: () => string) =>
  Schema.String.check(Schema.makeFilter((value) => Schema.is(DateText)(value) && value > today()));
export const compareDecimal = (left: string, right: string) => {
  const difference = subtract(decimal(left), decimal(right)).numerator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
};
export const Status = Schema.Literals(["working", "partial", "filled", "cancelled", "expired"]);
export type Status = typeof Status.Type;
export const terminal = (status: Status) => ["filled", "cancelled", "expired"].includes(status);
export const OrderValue = Schema.Struct({
  symbol: PairSymbol,
  side: Side,
  notional: Amount,
  limitPrice: positiveDecimal(5),
  timeInForce: TimeInForce,
  expiry: Schema.String,
  note: Note,
  filled: Schema.String.check(Schema.isPattern(/^\d+(?:\.\d+)?$/)),
  status: Status,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).check(
  Schema.makeFilter(
    (value) =>
      Schema.is(positiveDecimal(value.symbol === "USDJPY" ? 3 : 5))(value.limitPrice) &&
      (value.timeInForce === "date" ? Schema.is(DateText)(value.expiry) : value.expiry === "") &&
      compareDecimal(value.filled, value.notional) <= 0 &&
      (value.status === "working"
        ? compareDecimal(value.filled, "0") === 0
        : value.status === "partial"
          ? compareDecimal(value.filled, "0") > 0 &&
            compareDecimal(value.filled, value.notional) < 0
          : value.status === "filled"
            ? compareDecimal(value.filled, value.notional) === 0
            : true),
  ),
);
export type OrderValue = typeof OrderValue.Type;
export const Identifier = Schema.String.check(Schema.isPattern(/^\S+$/));
export class WorkingOrder extends SchemaModel<WorkingOrder>("Desk.WorkingOrder")({
  id: Identifier,
  $value: BoxField(OrderValue),
}) {}
export const OrderWire = Schema.Struct({ id: Identifier, value: OrderValue });
export class OrderBook extends SchemaModel<OrderBook>("Desk.OrderBook")({
  $orders: CollectionField(WorkingOrder, { keyOf: (order) => order.id }),
  $acknowledgments: CollectionField(OrderWire, { keyOf: (order) => order.id }),
}) {}
export const OrderMessage = Schema.Struct({
  kind: Schema.Literals(["accepted", "amended", "partial", "filled", "cancelled", "expired"]),
  order: OrderWire,
  fill: Schema.NullOr(Trade),
});
export type OrderMessage = typeof OrderMessage.Type;
export interface Diagnostic {
  readonly path: string;
  readonly reason: string;
}
export class MessageError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path}: ${reason}`);
  }
}
type ObjectKeys =
  | "id"
  | "value"
  | "symbol"
  | "filled"
  | "notional"
  | "limitPrice"
  | "kind"
  | "order"
  | "fill"
  | "displayName"
  | "defaultNotionals"
  | "confirmationThreshold";
export function object(
  value: unknown,
): Record<string, unknown> & Partial<Record<ObjectKeys, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function requireSchema<S extends Schema.Top>(
  schema: S,
  value: unknown,
  path: string,
  reason: string,
): S["Type"] {
  if (!Schema.is(schema)(value)) throw new MessageError(path, reason);
  return value;
}
/** Give failures a stable field path before constructing the observable model. */
export function checkOrder(value: unknown, path = "order") {
  const row = object(value);
  requireSchema(Identifier, row.id, `${path}.id`, "expected an order identifier");
  const data = object(row.value);
  for (const [key, schema] of Object.entries(OrderValue.fields)) {
    requireSchema(schema, data[key], `${path}.value.${key}`, `invalid ${key}`);
  }
  if (Schema.is(OrderWire)(value)) return value;
  if (!Schema.is(positiveDecimal(data.symbol === "USDJPY" ? 3 : 5))(data.limitPrice))
    throw new MessageError(`${path}.value.limitPrice`, "price exceeds pair precision");
  if (
    typeof data.filled === "string" &&
    typeof data.notional === "string" &&
    compareDecimal(data.filled, data.notional) > 0
  )
    throw new MessageError(`${path}.value.filled`, "fill exceeds notional");
  throw new MessageError(`${path}.value`, "inconsistent status, amount, or expiry");
}
