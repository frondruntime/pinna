import { useValue, useValues } from "@frondruntime/pinna-react";
import { memo, useId } from "react";
import type { Workspace } from "./desk.ts";
import type { TextField } from "./form-field.ts";
import type { WorkingOrder } from "./order-data.ts";
import type { Orders } from "./orders.ts";
import type { OrderTicket } from "./ticket.ts";

export const Field = memo(function Field({
  field,
  label,
  choices,
  disabled,
  onRender,
}: {
  readonly field: TextField;
  readonly label: string;
  readonly choices?: readonly string[];
  readonly disabled?: boolean;
  readonly onRender?: ((label: string) => void) | undefined;
}) {
  onRender?.(label);
  const identifier = useId();
  const [text, error] = useValues([field.$text, field.$error]);
  return (
    <label className="form-field" htmlFor={identifier}>
      {label}
      {choices ? (
        <select
          id={identifier}
          aria-label={label}
          aria-invalid={error !== null}
          disabled={disabled}
          value={text}
          onChange={(event) => field.set(event.currentTarget.value)}
        >
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice === "day"
                ? "Good for the day"
                : choice === "date"
                  ? "Good till a date"
                  : choice === "immediate"
                    ? "Immediate or cancel"
                    : choice}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={identifier}
          aria-label={label}
          aria-invalid={error !== null}
          disabled={disabled}
          value={text}
          onInput={(event) => field.set(event.currentTarget.value)}
        />
      )}
      {error && <span role="alert">{error}</span>}
    </label>
  );
});
export const RuleMarks = memo(function RuleMarks({
  ticket,
  onRender,
}: {
  readonly ticket: OrderTicket;
  readonly onRender?: (() => void) | undefined;
}) {
  onRender?.();
  const { reasons, fillsAtOnce } = useValue(ticket.$rules);
  return (
    <fieldset aria-label="Order rules">
      {reasons.map((reason) => (
        <p role="alert" key={reason}>
          {reason}
        </p>
      ))}
      {fillsAtOnce && <p role="status">fills at once</p>}
    </fieldset>
  );
});
const Conflicts = memo(function Conflicts({ ticket }: { readonly ticket: OrderTicket }) {
  const conflicts = useValue(ticket.$conflicts);
  const [notional, limitPrice] = useValues([ticket.notional.$text, ticket.limitPrice.$text]);
  return (
    <>
      {(["notional", "limitPrice"] as const).map((key) =>
        conflicts[key] === undefined ? null : (
          <div key={key} role="alert">
            {key}: your edit {key === "notional" ? notional : limitPrice}; exchange {conflicts[key]}
            <button type="button" onClick={() => ticket.choose(key, "mine")}>
              Keep my {key}
            </button>
            <button type="button" onClick={() => ticket.choose(key, "exchange")}>
              Use exchange {key}
            </button>
          </div>
        ),
      )}
    </>
  );
});
const Send = memo(function Send({ ticket }: { readonly ticket: OrderTicket }) {
  const [allowed, pending, reason, confirmation, threshold] = useValues([
    ticket.$canSend,
    ticket.$pending,
    ticket.$reason,
    ticket.$confirmation,
    ticket.orders.account.settings.$confirmationThreshold,
  ]);
  const send = (confirmed = false) => ticket.orders.run(ticket.orders.submit(ticket, confirmed));
  return (
    <>
      <button type="button" disabled={!allowed} onClick={() => send()}>
        {pending ? "Pending…" : ticket.order ? "Send amendment" : "Send order"}
      </button>
      {pending && <p role="status">Pending exchange acceptance</p>}
      {reason && <p role="alert">{reason}</p>}
      {confirmation && (
        <div role="alert">
          Notional exceeds {threshold}. Confirm this request.
          <button type="button" disabled={!allowed} onClick={() => send(true)}>
            Confirm send
          </button>
          <button type="button" onClick={() => ticket.orders.close()}>
            Cancel request
          </button>
        </div>
      )}
    </>
  );
});
export const TicketForm = memo(function TicketForm({
  ticket,
  onFieldRender,
  onRuleRender,
}: {
  readonly ticket: OrderTicket;
  readonly onFieldRender?: (label: string) => void;
  readonly onRuleRender?: () => void;
}) {
  return (
    <section aria-label="Order ticket" className="order-ticket">
      <header>
        <h2>
          {ticket.order ? "Amend" : "Limit order"} · {ticket.tile.pair.symbol}
        </h2>
        <button type="button" onClick={() => ticket.orders.close()}>
          Close ticket
        </button>
      </header>
      <div className="form-grid">
        <Field
          field={ticket.side}
          label="Side"
          choices={["buy", "sell"]}
          disabled={!!ticket.order}
          onRender={onFieldRender}
        />
        <Field field={ticket.notional} label="Order notional" onRender={onFieldRender} />
        <Field field={ticket.limitPrice} label="Limit price" onRender={onFieldRender} />
        <Field
          field={ticket.timeInForce}
          label="Time in force"
          choices={["day", "date", "immediate"]}
          disabled={!!ticket.order}
          onRender={onFieldRender}
        />
        <Field
          field={ticket.expiry}
          label="Good till date"
          disabled={!!ticket.order}
          onRender={onFieldRender}
        />
        <Field
          field={ticket.note}
          label="Note"
          disabled={!!ticket.order}
          onRender={onFieldRender}
        />
      </div>
      <RuleMarks ticket={ticket} onRender={onRuleRender} />
      <Conflicts ticket={ticket} />
      <Send ticket={ticket} />
    </section>
  );
});
const WorkingRow = memo(function WorkingRow({
  order,
  workspace,
}: {
  readonly order: WorkingOrder;
  readonly workspace: Workspace;
}) {
  const value = useValue(order.$value);
  const pending = useValue(workspace.orders.$isPending(order.id));
  return (
    <tr data-order-id={order.id}>
      <td>{order.id}</td>
      <td>{value.symbol}</td>
      <td>{value.side}</td>
      <td>{value.notional}</td>
      <td>{value.limitPrice}</td>
      <td>{value.filled}</td>
      <td>{pending ? "pending amendment" : value.status}</td>
      <td>
        <button
          type="button"
          disabled={pending || ["filled", "cancelled", "expired"].includes(value.status)}
          onClick={() => workspace.orders.open(workspace.tile(value.symbol), order)}
        >
          Amend
        </button>
      </td>
    </tr>
  );
});
const OrderSlot = memo(function OrderSlot({
  id,
  workspace,
}: {
  readonly id: string;
  readonly workspace: Workspace;
}) {
  const order = useValue(workspace.orders.$orders.row(id));
  return order ? <WorkingRow order={order} workspace={workspace} /> : null;
});
const TicketSlot = memo(function TicketSlot({ orders }: { readonly orders: Orders }) {
  const ticket = useValue(orders.$ticket);
  return ticket ? <TicketForm ticket={ticket} /> : null;
});
export const OrdersPanel = memo(function OrdersPanel({
  workspace,
}: {
  readonly workspace: Workspace;
}) {
  const keys = useValue(workspace.orders.$keys);
  const rejected = useValue(workspace.orders.$rejections);
  const notice = useValue(workspace.orders.$notice);
  return (
    <>
      <TicketSlot orders={workspace.orders} />
      {notice && <p role="status">{notice}</p>}
      <section aria-label="Working orders">
        <h2>Working orders</h2>
        <output aria-label="Rejected order messages">
          Rejected messages: {rejected.count}
          {rejected.latest && ` · ${rejected.latest.path}: ${rejected.latest.reason}`}
        </output>
        <div className="trade-table">
          <table>
            <thead>
              <tr>
                {["Order", "Pair", "Side", "Notional", "Limit", "Filled", "Status", "Action"].map(
                  (label) => (
                    <th key={label}>{label}</th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {keys.map((id) => (
                <OrderSlot key={id} id={id} workspace={workspace} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
});
