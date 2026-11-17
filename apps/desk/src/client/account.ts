import { box, computed, Model, type Realm, untracked, update } from "@frondruntime/pinna";
import { BoxField, decode, reconcileSchema, SchemaModel } from "@frondruntime/pinna-effect";
import { Effect, Schema } from "effect";
import type { Transport } from "../transport.ts";
import { FormField } from "./form-field.ts";
import { Amount, type Diagnostic, object } from "./order-data.ts";
import { symbols } from "./wire.ts";

export const DisplayName = Schema.String.check(
  Schema.makeFilter((value) => value === value.trim() && value.length >= 1 && value.length <= 40),
);
export const DefaultNotionals = Schema.Struct({
  EURUSD: Amount,
  GBPUSD: Amount,
  USDJPY: Amount,
  AUDUSD: Amount,
  EURGBP: Amount,
});
export class AccountSettings extends SchemaModel<AccountSettings>("Desk.AccountSettings")({
  $displayName: BoxField(DisplayName),
  $defaultNotionals: BoxField(DefaultNotionals),
  $confirmationThreshold: BoxField(Amount),
}) {}
export const defaultSettings = {
  displayName: "Trader",
  defaultNotionals: {
    EURUSD: "100000",
    GBPUSD: "100000",
    USDJPY: "100000",
    AUDUSD: "100000",
    EURGBP: "100000",
  },
  confirmationThreshold: "1000000",
};
export const FieldErrors = Schema.Record(Schema.String, Schema.String);
export const SettingsAnswer = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(false), errors: FieldErrors }),
  Schema.Struct({ ok: Schema.Literal(true), settings: Schema.Unknown }),
]);
export class Account extends Model {
  readonly settings = decode(this.realm, AccountSettings)(defaultSettings);
  readonly $dropped = box<readonly Diagnostic[]>(this.realm, []);
  readonly $form = box<AccountForm | null>(this.realm, null);
  load(value: unknown) {
    const raw = object(value);
    const dropped: Diagnostic[] = [];
    const keep = <S extends Schema.Top>(
      schema: S,
      value: unknown,
      fallback: S["Type"],
      path: string,
    ): S["Type"] => {
      if (Schema.is(schema)(value)) return value;
      dropped.push({
        path,
        reason:
          path === "displayName"
            ? "expected 1 to 40 trimmed characters; using default"
            : "expected a positive decimal with at most 2 places; using default",
      });
      return fallback;
    };
    const defaultNotionals = { ...defaultSettings.defaultNotionals };
    const received = object(raw.defaultNotionals);
    for (const symbol of symbols)
      defaultNotionals[symbol] = keep(
        Amount,
        received[symbol],
        defaultNotionals[symbol],
        `defaultNotionals.${symbol}`,
      );
    const fresh = decode(
      this.realm,
      AccountSettings,
    )({
      displayName: keep(DisplayName, raw.displayName, defaultSettings.displayName, "displayName"),
      defaultNotionals,
      confirmationThreshold: keep(
        Amount,
        raw.confirmationThreshold,
        defaultSettings.confirmationThreshold,
        "confirmationThreshold",
      ),
    });
    update(this.realm, (_read, write) => {
      reconcileSchema([this.settings], [fresh], { keyOf: () => "account" });
      write(this.$dropped, dropped);
    });
  }
  open() {
    const form = new AccountForm(this.realm, this, this.transport);
    update(this.realm, (_read, write) => write(this.$form, form));
    return form;
  }
  close() {
    update(this.realm, (_read, write) => write(this.$form, null));
  }
  constructor(
    realm: Realm,
    private readonly transport: Transport,
  ) {
    super(realm);
  }
}
export class AccountForm extends Model {
  readonly displayName;
  readonly defaultNotionals;
  readonly confirmationThreshold;
  readonly $pending = box(this.realm, false);
  readonly $message = box<string | null>(this.realm, null);
  readonly $valid = computed(this.realm, (read) =>
    this.fields().every(([, field]) => read(field.$error) === null),
  );
  constructor(
    realm: Realm,
    readonly account: Account,
    private readonly transport: Transport,
  ) {
    super(realm);
    const value = Schema.encodeSync(AccountSettings)(account.settings);
    this.displayName = new FormField(
      realm,
      DisplayName,
      value.displayName,
      "Use 1 to 40 characters after trimming.",
      (text) => text.trim(),
    );
    this.defaultNotionals = Object.fromEntries(
      symbols.map((symbol) => [
        symbol,
        new FormField(
          realm,
          Amount,
          value.defaultNotionals[symbol],
          "Use a positive decimal with at most 2 places.",
        ),
      ]),
    ) as Record<(typeof symbols)[number], FormField<typeof Amount>>;
    this.confirmationThreshold = new FormField(
      realm,
      Amount,
      value.confirmationThreshold,
      "Use a positive decimal with at most 2 places.",
    );
  }
  fields() {
    return [
      ["displayName", this.displayName],
      ...symbols.map(
        (symbol) => [`defaultNotionals.${symbol}`, this.defaultNotionals[symbol]] as const,
      ),
      ["confirmationThreshold", this.confirmationThreshold],
    ] as const;
  }
  save() {
    const form = this;
    return Effect.gen(function* () {
      if (!untracked(form.realm, (read) => read(form.$valid) && !read(form.$pending))) return;
      // Encode a schema model: runtime fields and realm never enter the request.
      const candidate = untracked(form.realm, (read) =>
        AccountSettings.make({
          realm: form.realm,
          displayName: read(form.displayName.$accepted),
          defaultNotionals: DefaultNotionals.make(
            Object.fromEntries(
              symbols.map((symbol) => [symbol, read(form.defaultNotionals[symbol].$accepted)]),
            ) as typeof DefaultNotionals.Type,
          ),
          confirmationThreshold: read(form.confirmationThreshold.$accepted),
        }),
      );
      const body = JSON.stringify(Schema.encodeSync(AccountSettings)(candidate));
      update(form.realm, (_read, write) => {
        write(form.$pending, true);
        write(form.$message, null);
      });
      yield* form.transport.request("/settings/save", body).pipe(
        Effect.flatMap((raw) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(SettingsAnswer))(raw),
        ),
        Effect.flatMap((answer) =>
          Effect.try({
            try: () => {
              if (!answer.ok) {
                for (const [path, field] of form.fields())
                  field.serverError(answer.errors[path] ?? null);
                return;
              }
              // A save is strict; partial recovery is only the startup policy.
              const fresh = decode(form.realm, AccountSettings)(answer.settings);
              update(form.realm, (_read, write) => {
                reconcileSchema([form.account.settings], [fresh], { keyOf: () => "account" });
                write(form.$message, "Settings saved.");
              });
            },
            catch: String,
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() =>
            update(form.realm, (_read, write) => write(form.$message, String(error))),
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => update(form.realm, (_read, write) => write(form.$pending, false))),
        ),
      );
    });
  }
}
