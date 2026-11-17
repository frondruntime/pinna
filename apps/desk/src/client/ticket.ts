import { box, computed, Model, type Realm, untracked, update } from "@frondruntime/pinna";
import { schemaBox } from "@frondruntime/pinna-effect";
import { Schema } from "effect";
import { add, decimal, divide, fraction, subtract } from "./decimal.ts";
import type { Desk } from "./desk.ts";
import { FormField } from "./form-field.ts";
import {
  Amount,
  compareDecimal,
  futureDate,
  Note,
  OrderValue,
  positiveDecimal,
  Side,
  TimeInForce,
  type WorkingOrder,
} from "./order-data.ts";
import type { Orders } from "./orders.ts";

type Editable = "notional" | "limitPrice";
export class OrderTicket extends Model {
  readonly side;
  readonly notional;
  readonly limitPrice;
  readonly timeInForce;
  readonly expiry;
  readonly note;
  readonly $pending = box(this.realm, false);
  readonly $confirmation = box(this.realm, false);
  readonly $exchangeReason = schemaBox(this.realm, Schema.NullOr(Schema.String), null);
  readonly $localReason = box<string | null>(this.realm, null);
  readonly $reason = computed(
    this.realm,
    (read) => read(this.$localReason) ?? read(this.$exchangeReason),
  );
  readonly $conflicts = box<Readonly<Partial<Record<Editable, string>>>>(this.realm, {});
  private readonly $base;
  readonly $value = computed(this.realm, (read) => ({
    symbol: this.tile.pair.symbol,
    side: read(this.side.$accepted),
    notional: read(this.notional.$accepted),
    limitPrice: read(this.limitPrice.$accepted),
    timeInForce: read(this.timeInForce.$accepted),
    expiry: read(this.timeInForce.$accepted) === "date" ? read(this.expiry.$accepted) : "",
    note: read(this.note.$accepted),
  }));
  readonly $fieldValid = computed(
    this.realm,
    (read) =>
      [this.side, this.notional, this.limitPrice, this.timeInForce, this.expiry, this.note].every(
        (field) => read(field.$error) === null,
      ) &&
      (read(this.timeInForce.$accepted) !== "date" || read(this.expiry.$error) === null),
  );
  readonly $rules = computed(
    this.realm,
    (read) => {
      const value = read(this.$value);
      const price = read(this.tile.$prices);
      const reasons: string[] = [];
      let fillsAtOnce = false;
      if (price.current === null || price.error !== null)
        reasons.push("No live price for this pair; wait for a fresh quote.");
      else {
        const mid = divide(
          add(decimal(price.current.bid), decimal(price.current.ask)),
          fraction(2n),
        );
        const difference = divide(subtract(decimal(value.limitPrice), mid), mid);
        if (
          (difference.numerator < 0n ? -difference.numerator : difference.numerator) * 10n >
          difference.denominator
        )
          reasons.push("Limit price must be within 10 percent of the live mid price.");
        fillsAtOnce =
          value.side === "buy"
            ? compareDecimal(value.limitPrice, price.current.ask) > 0
            : compareDecimal(value.limitPrice, price.current.bid) < 0;
      }
      if (value.timeInForce === "date" && value.expiry <= this.orders.today())
        reasons.push("Choose a date after today.");
      const base = read(this.$base);
      if (
        base &&
        (value.side !== base.side ||
          value.timeInForce !== base.timeInForce ||
          value.expiry !== base.expiry ||
          value.note !== base.note)
      )
        reasons.push("An amendment changes only notional and limit price.");
      if (base && compareDecimal(value.notional, base.filled) <= 0)
        reasons.push("Notional must exceed the amount already filled.");
      return { reasons, fillsAtOnce };
    },
    {
      name: "Ticket.rules",
      equals: (left, right) =>
        left.fillsAtOnce === right.fillsAtOnce &&
        left.reasons.join("\n") === right.reasons.join("\n"),
    },
  );
  readonly $canSend = computed(
    this.realm,
    (read) =>
      read(this.$fieldValid) &&
      read(this.$rules).reasons.length === 0 &&
      !read(this.$pending) &&
      Object.keys(read(this.$conflicts)).length === 0,
  );
  readonly $needsConfirmation = computed(
    this.realm,
    (read) =>
      compareDecimal(
        read(this.notional.$accepted),
        read(this.orders.account.settings.$confirmationThreshold),
      ) > 0,
  );
  constructor(
    realm: Realm,
    readonly orders: Orders,
    readonly tile: Desk,
    readonly order?: WorkingOrder,
  ) {
    super(realm);
    const base = order ? untracked(realm, (read) => read(order.$value)) : null;
    this.$base = schemaBox(realm, Schema.NullOr(OrderValue), base);
    const price = untracked(realm, (read) => read(tile.$prices).current);
    this.side = new FormField(realm, Side, base?.side ?? "buy", "Choose buy or sell.");
    this.notional = new FormField(
      realm,
      Amount,
      base?.notional ??
        untracked(
          realm,
          (read) => read(orders.account.settings.$defaultNotionals)[tile.pair.symbol],
        ),
      "Use a positive decimal with at most 2 places.",
    );
    this.limitPrice = new FormField(
      realm,
      positiveDecimal(tile.pair.pricePrecision),
      base?.limitPrice ?? price?.bid ?? "1",
      `Use a positive decimal with at most ${tile.pair.pricePrecision} places.`,
    );
    this.timeInForce = new FormField(
      realm,
      TimeInForce,
      base?.timeInForce ?? "day",
      "Choose day, date, or immediate.",
    );
    const tomorrow = new Date(Date.parse(`${orders.today()}T00:00:00Z`) + 86400000)
      .toISOString()
      .slice(0, 10);
    this.expiry = new FormField(
      realm,
      futureDate(orders.today),
      base?.expiry || tomorrow,
      "Choose a date after today.",
    );
    this.note = new FormField(realm, Note, base?.note ?? "", "Use at most 200 characters.");
  }
  receive(next: OrderValue) {
    update(this.realm, (read, write) => {
      const base = read(this.$base);
      const conflicts = { ...read(this.$conflicts) };
      if (base)
        for (const key of ["notional", "limitPrice"] as const) {
          if (next[key] === base[key]) continue;
          const typed = read(this[key].$text);
          if (typed === base[key] || typed === next[key]) {
            this[key].set(next[key]);
            delete conflicts[key];
          } else conflicts[key] = next[key];
        }
      write(this.$conflicts, conflicts);
      write(this.$base, next);
    });
  }
  choose(field: Editable, choice: "mine" | "exchange") {
    update(this.realm, (read, write) => {
      const conflicts = { ...read(this.$conflicts) };
      if (choice === "exchange" && conflicts[field] !== undefined)
        this[field].set(conflicts[field]);
      delete conflicts[field];
      write(this.$conflicts, conflicts);
    });
  }
}
