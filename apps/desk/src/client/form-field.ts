import { box, computed, Model, type Realm, update } from "@frondruntime/pinna";
import { schemaBox } from "@frondruntime/pinna-effect";
import { Schema } from "effect";

/** Text is lossless; only a successful field check advances accepted state. */
export class FormField<S extends Schema.Schema<string>> extends Model {
  readonly $text;
  readonly $accepted;
  readonly $serverError = schemaBox(this.realm, Schema.NullOr(Schema.String), null);
  readonly $error = computed(
    this.realm,
    (read) => this.error(read(this.$text)) ?? read(this.$serverError),
  );
  constructor(
    realm: Realm,
    readonly schema: S,
    initial: S["Type"],
    readonly message: string,
    readonly normalize: (text: string) => string = (text) => text,
  ) {
    super(realm);
    this.$text = box(realm, initial as string);
    this.$accepted = schemaBox(realm, schema, initial);
  }
  error(text: string): string | null {
    return Schema.is(this.schema)(this.normalize(text)) ? null : this.message;
  }
  set(text: string) {
    update(this.realm, (_read, write) => {
      write(this.$text, text);
      write(this.$serverError, null);
      const value = this.normalize(text);
      if (Schema.is(this.schema)(value)) write(this.$accepted, value);
    });
  }
  serverError(message: string | null) {
    update(this.realm, (_read, write) => write(this.$serverError, message));
  }
}
export type TextField = Pick<FormField<Schema.Schema<string>>, "$text" | "$error" | "set">;
