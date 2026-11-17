import {
  box,
  type Computed,
  computed,
  computedFunction,
  Model,
  type Realm,
  untracked,
  update,
} from "@frondruntime/pinna";
import { decode, fromStream, RealmService } from "@frondruntime/pinna-effect";
import { Effect, Schema, Stream } from "effect";
import type { Transport } from "../transport.ts";
import type { Account } from "./account.ts";
import type { Desk } from "./desk.ts";
import {
  checkOrder,
  compareDecimal,
  type Diagnostic,
  decimalSum,
  MessageError,
  OrderBook,
  OrderMessage,
  OrderWire,
  object,
  requireSchema,
  terminal,
  WorkingOrder,
} from "./order-data.ts";
import { OrderTicket } from "./ticket.ts";
import type { TradeBook } from "./trades.ts";
import { PositiveDecimal, Trade } from "./wire.ts";

const Answer = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(false), reason: Schema.String }),
  Schema.Struct({ ok: Schema.Literal(true), message: Schema.Unknown }),
]);
interface PendingAmendment {
  readonly before: typeof OrderWire.Type;
}
export class Orders extends Model {
  readonly book = OrderBook.make({ realm: this.realm, orders: [], acknowledgments: [] });
  readonly $orders = this.book.$orders;
  readonly $ticket = box<OrderTicket | null>(this.realm, null);
  readonly $notice = box<string | null>(this.realm, null);
  readonly $rejections = box<{ readonly count: number; readonly latest: Diagnostic | null }>(
    this.realm,
    { count: 0, latest: null },
  );
  readonly $loaded = box(this.realm, false);
  private readonly $pending = box<ReadonlyMap<string, PendingAmendment>>(this.realm, new Map());
  readonly $isPending = computedFunction(this.realm, (read, id: string) =>
    read(this.$pending).has(id),
  );
  readonly $keys = computed(this.realm, (read) => {
    read(this.$feed);
    return read(this.$orders.keys);
  });
  constructor(
    realm: Realm,
    private readonly transport: Transport,
    readonly trades: TradeBook,
    private readonly $feed: Computed<number>,
    readonly today: () => string,
    readonly run: (program: Effect.Effect<void>) => unknown,
    readonly account: Account,
  ) {
    super(realm);
  }
  private sequence = 0;
  open(tile: Desk, order?: WorkingOrder) {
    if (order && untracked(this.realm, (read) => terminal(read(order.$value).status))) return null;
    const ticket = new OrderTicket(this.realm, this, tile, order);
    update(this.realm, (_read, write) => {
      write(this.$ticket, ticket);
      write(this.$notice, null);
    });
    return ticket;
  }
  close() {
    update(this.realm, (_read, write) => write(this.$ticket, null));
  }
  reject(error: unknown) {
    const latest =
      error instanceof MessageError
        ? { path: error.path, reason: error.reason }
        : { path: "$", reason: String(error) };
    update(this.realm, (read, write) =>
      write(this.$rejections, { count: read(this.$rejections).count + 1, latest }),
    );
  }
  snapshot(value: unknown) {
    try {
      if (!Array.isArray(value)) throw new MessageError("orders", "expected an array");
      const checked = value.map((row, index) => checkOrder(row, `orders[${index}]`));
      if (new Set(checked.map((row) => row.id)).size !== checked.length)
        throw new MessageError("orders", "duplicate order identifier");
      const fresh = checked.map((row) => decode(this.realm, WorkingOrder)(row));
      update(this.realm, (read, write) => {
        // A topic may already have advanced the held revision while the snapshot was in flight.
        for (const row of fresh) {
          const held = read.row(this.$orders, row.id);
          if (!held || read(row.$value).revision > read(held.$value).revision)
            write.upsert(this.$orders, row, { at: "end" });
        }
        write(this.$loaded, true);
      });
    } catch (error) {
      this.reject(error);
    }
  }
  accept(value: unknown): boolean {
    try {
      const envelope = object(value);
      requireSchema(OrderMessage.fields.kind, envelope.kind, "kind", "unknown message kind");
      const checkedOrder = checkOrder(envelope.order);
      if (envelope.fill !== null) {
        const fill = object(envelope.fill);
        requireSchema(PositiveDecimal, fill.notional, "fill.notional", "invalid fill notional");
      }
      requireSchema(Schema.NullOr(Trade), envelope.fill, "fill", "invalid fill trade");
      const message = requireSchema(OrderMessage, value, "$", "invalid order message");
      const fresh = decode(this.realm, WorkingOrder)(checkedOrder);
      update(this.realm, (read, write) => {
        const held = read.row(this.$orders, fresh.id);
        const pending = read(this.$pending).get(fresh.id);
        const previous = pending?.before.value ?? (held ? read(held.$value) : undefined);
        const next = read(fresh.$value);
        if (!previous && message.kind !== "accepted")
          throw new MessageError("order.id", "unknown order");
        if (previous && next.revision <= previous.revision) {
          if (
            next.revision === previous.revision &&
            Schema.toEquivalence(OrderWire)({ id: fresh.id, value: previous }, checkedOrder) &&
            message.fill === null
          )
            return;
          throw new MessageError("order.value.revision", "stale or repeated revision");
        }
        if (previous && terminal(previous.status))
          throw new MessageError("order.value.status", "order is already terminal");
        if (
          previous &&
          (next.symbol !== previous.symbol ||
            next.side !== previous.side ||
            next.timeInForce !== previous.timeInForce ||
            next.expiry !== previous.expiry ||
            next.note !== previous.note)
        )
          throw new MessageError("order.value", "immutable order fields changed");
        if (previous && message.kind === "accepted")
          throw new MessageError("order.id", "order already exists");
        if (message.kind === "partial" || message.kind === "filled") {
          const fill = message.fill;
          if (!previous || !fill) throw new MessageError("fill", "missing fill");
          if (
            fill.symbol !== next.symbol ||
            fill.direction !== next.side ||
            fill.status !== "done" ||
            fill.desk !== "local" ||
            read.row(this.trades.$trades, fill.id)
          )
            throw new MessageError("fill", "mismatched or repeated fill");
          if (compareDecimal(decimalSum(previous.filled, fill.notional), previous.notional) > 0)
            throw new MessageError("fill.notional", "fill exceeds remaining amount");
          if (
            (next.side === "buy" && compareDecimal(fill.rate, next.limitPrice) > 0) ||
            (next.side === "sell" && compareDecimal(fill.rate, next.limitPrice) < 0)
          )
            throw new MessageError("fill.rate", "fill violates limit price");
          if (compareDecimal(decimalSum(previous.filled, fill.notional), next.filled) !== 0)
            throw new MessageError("order.value.filled", "filled amount does not match fill");
          if (
            next.status !== message.kind ||
            next.notional !== previous.notional ||
            next.limitPrice !== previous.limitPrice
          )
            throw new MessageError("order.value", "inconsistent fill transition");
        } else {
          if (message.fill !== null) throw new MessageError("fill", "unexpected fill");
          if (previous && next.filled !== previous.filled)
            throw new MessageError("order.value.filled", "amount changed without a fill");
          if (
            message.kind === "accepted" &&
            (next.status !== "working" || compareDecimal(next.filled, "0") !== 0)
          )
            throw new MessageError("order.value.status", "invalid acceptance");
          if (
            (message.kind === "cancelled" || message.kind === "expired") &&
            next.status !== message.kind
          )
            throw new MessageError("order.value.status", "status does not match message");
          if (
            previous &&
            message.kind !== "amended" &&
            (next.notional !== previous.notional || next.limitPrice !== previous.limitPrice)
          )
            throw new MessageError("order.value", "terms changed without amendment");
          if (
            message.kind === "amended" &&
            next.status !== (compareDecimal(next.filled, "0") === 0 ? "working" : "partial")
          )
            throw new MessageError("order.value.status", "invalid amendment status");
        }
        const ticket = read(this.$ticket);
        if (ticket?.order?.id === fresh.id) {
          if (terminal(next.status)) {
            write(this.$ticket, null);
            write(this.$notice, `Edit closed: order ${next.status}.`);
          } else ticket.receive(next);
        }
        // CollectionField merges the BoxField into the held model, preserving row identity.
        write.upsert(this.$orders, fresh, { at: "end" });
        if (message.kind === "accepted" || message.kind === "amended")
          write.upsert(this.book.$acknowledgments, checkedOrder);
        if (message.fill) write.upsert(this.trades.$trades, message.fill);
        if (pending) {
          const map = new Map(read(this.$pending));
          map.set(fresh.id, { ...pending, before: checkedOrder });
          write(this.$pending, map);
        }
      });
      return true;
    } catch (error) {
      this.reject(error);
      return false;
    }
  }
  submit(ticket: OrderTicket, confirmed = false) {
    const orders = this;
    return Effect.gen(function* () {
      const input = untracked(orders.realm, (read) => ({
        allowed: read(ticket.$canSend),
        confirm: read(ticket.$needsConfirmation),
        value: read(ticket.$value),
      }));
      if (!input.allowed) return;
      if (input.value.timeInForce === "date" && input.value.expiry <= orders.today()) {
        update(orders.realm, (_read, write) =>
          write(ticket.$localReason, "Choose a date after today."),
        );
        return;
      }
      if (input.confirm && !confirmed) {
        update(orders.realm, (_read, write) => write(ticket.$confirmation, true));
        return;
      }
      const id = ticket.order?.id ?? `limit-local-${++orders.sequence}`;
      const heldOrder = ticket.order;
      const before = heldOrder
        ? untracked(orders.realm, (read) => read(heldOrder.$value))
        : undefined;
      update(orders.realm, (read, write) => {
        write(ticket.$pending, true);
        write(ticket.$confirmation, false);
        write(ticket.$localReason, null);
        write(ticket.$exchangeReason, null);
        if (ticket.order && before) {
          write(ticket.order.$value, {
            ...before,
            notional: input.value.notional,
            limitPrice: input.value.limitPrice,
          });
          const map = new Map(read(orders.$pending));
          map.set(id, {
            before: { id, value: before },
          });
          write(orders.$pending, map);
        }
      });
      let accepted = false;
      yield* orders.transport
        .request(
          ticket.order ? "/orders/amend" : "/orders/place",
          JSON.stringify({ id, ...input.value, ...(before ? { revision: before.revision } : {}) }),
        )
        .pipe(
          Effect.flatMap((raw) =>
            Schema.decodeUnknownEffect(Schema.fromJsonString(Answer))(raw).pipe(
              Effect.tapError((error) => Effect.sync(() => orders.reject(error))),
            ),
          ),
          Effect.flatMap((answer) =>
            Effect.try({
              try: () => {
                if (!answer.ok) return answer;
                checkOrder(object(answer.message).order, "message.order");
                return {
                  ok: true as const,
                  message: requireSchema(
                    OrderMessage,
                    answer.message,
                    "message",
                    "invalid acknowledgment",
                  ),
                };
              },
              catch: (error) => {
                orders.reject(error);
                return error;
              },
            }),
          ),
          Effect.tap((answer) =>
            Effect.sync(() => {
              if (!answer.ok)
                update(orders.realm, (_read, write) =>
                  write(ticket.$exchangeReason, answer.reason),
                );
              else if (
                answer.message.order.id !== id ||
                answer.message.kind !== (ticket.order ? "amended" : "accepted") ||
                answer.message.fill !== null ||
                answer.message.order.value.symbol !== input.value.symbol ||
                answer.message.order.value.side !== input.value.side ||
                answer.message.order.value.notional !== input.value.notional ||
                answer.message.order.value.timeInForce !== input.value.timeInForce ||
                answer.message.order.value.expiry !== input.value.expiry ||
                answer.message.order.value.note !== input.value.note ||
                (!ticket.order && answer.message.order.value.limitPrice !== input.value.limitPrice)
              ) {
                orders.reject(new MessageError("order.id", "mismatched response"));
                update(orders.realm, (_read, write) =>
                  write(ticket.$localReason, "Mismatched exchange response."),
                );
              } else {
                // A matching topic acknowledgment may have arrived first.
                const acknowledgment = untracked(orders.realm, (read) =>
                  read.row(orders.book.$acknowledgments, id),
                );
                const same =
                  acknowledgment &&
                  Schema.toEquivalence(OrderWire)(acknowledgment, answer.message.order);
                accepted = !!same || orders.accept(answer.message);
                if (!accepted)
                  update(orders.realm, (_read, write) =>
                    write(ticket.$localReason, "Invalid exchange response."),
                  );
              }
            }),
          ),
          Effect.catch((error) =>
            Effect.sync(() =>
              update(orders.realm, (_read, write) => write(ticket.$localReason, String(error))),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() =>
              update(orders.realm, (read, write) => {
                const pending = read(orders.$pending).get(id);
                if (pending) {
                  const held = read.row(orders.$orders, id);
                  if (!accepted && held) {
                    const current = read(held.$value);
                    // Preserve fills and later authoritative changes while undoing optimistic terms.
                    write(held.$value, {
                      ...current,
                      notional: pending.before.value.notional,
                      limitPrice: pending.before.value.limitPrice,
                    });
                  }
                  const map = new Map(read(orders.$pending));
                  map.delete(id);
                  write(orders.$pending, map);
                }
                write(ticket.$pending, false);
                if (accepted && read(orders.$ticket) === ticket) {
                  write(orders.$ticket, null);
                  write(orders.$notice, "Order accepted.");
                }
              }),
            ),
          ),
        );
    });
  }
}
export const makeOrders = (
  transport: Transport,
  trades: TradeBook,
  today: () => string,
  run: (program: Effect.Effect<void>) => unknown,
  account: Account,
) =>
  Effect.gen(function* () {
    const realm = yield* RealmService;
    const $feed: Computed<number> = yield* fromStream(
      Stream.callback<number>(() =>
        Effect.gen(function* () {
          yield* transport.subscribe("orders").pipe(
            Stream.runForEach((raw) =>
              Effect.sync(() => {
                try {
                  orders.accept(JSON.parse(raw));
                } catch (error) {
                  orders.reject(error);
                }
              }),
            ),
            Effect.catch((error) => Effect.sync(() => orders.reject(error))),
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* transport.request("/orders", "").pipe(
            Effect.tap((raw) =>
              Effect.sync(() => {
                try {
                  orders.snapshot(JSON.parse(raw));
                } catch (error) {
                  orders.reject(error);
                }
              }),
            ),
            Effect.catch((error) => Effect.sync(() => orders.reject(error))),
          );
        }),
      ),
      0,
      { name: "Orders.feed" },
    );
    const orders = new Orders(realm, transport, trades, $feed, today, run, account);
    yield* transport.request("/settings", "").pipe(
      Effect.tap((raw) =>
        Effect.sync(() => {
          try {
            orders.account.load(JSON.parse(raw));
          } catch {
            orders.account.load(null);
          }
        }),
      ),
      Effect.catch(() => Effect.sync(() => orders.account.load(null))),
    );
    return orders;
  });
