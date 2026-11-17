import { useValues } from "@frondruntime/pinna-react";
import { memo } from "react";
import type { AccountForm } from "./account.ts";
import type { Orders } from "./orders.ts";
import { Field } from "./orders-panel.tsx";
import { symbols } from "./wire.ts";

const SettingsForm = memo(function SettingsForm({
  form,
  orders,
}: {
  readonly form: AccountForm;
  readonly orders: Orders;
}) {
  const [valid, pending, message] = useValues([form.$valid, form.$pending, form.$message]);
  return (
    <div className="settings-form">
      <Field field={form.displayName} label="Display name" />
      {symbols.map((symbol) => (
        <Field
          key={symbol}
          field={form.defaultNotionals[symbol]}
          label={`Default ${symbol} notional`}
        />
      ))}
      <Field field={form.confirmationThreshold} label="Confirmation threshold" />
      <button type="button" disabled={!valid || pending} onClick={() => orders.run(form.save())}>
        {pending ? "Saving…" : "Save settings"}
      </button>
      <button type="button" onClick={() => orders.account.close()}>
        Close settings
      </button>
      {message && <p role="status">{message}</p>}
    </div>
  );
});
export const AccountPanel = memo(function AccountPanel({ orders }: { readonly orders: Orders }) {
  const [name, dropped, form] = useValues([
    orders.account.settings.$displayName,
    orders.account.$dropped,
    orders.account.$form,
  ]);
  return (
    <section aria-label="Account settings">
      <h2>Account · {name}</h2>
      {dropped.length > 0 && (
        <ul aria-label="Dropped settings">
          {dropped.map((item) => (
            <li key={item.path}>
              {item.path}: {item.reason}
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={() => orders.account.open()}>
        Edit account settings
      </button>
      {form && <SettingsForm form={form} orders={orders} />}
    </section>
  );
});
