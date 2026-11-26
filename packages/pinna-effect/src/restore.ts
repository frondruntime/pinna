/**
 * `Model.restore`: decodes wire data and restores it into a held
 * `Model.Schema` instance, the whole hydration path for a schema model.
 */
import { Realm } from "@frondruntime/pinna";
import type { ObservableRealm } from "@frondruntime/pinna/internal";
import type { Schema } from "effect";
import { type DecodeContext, decode } from "./decode.ts";

/**
 * Decodes `input` with `schema` into `realm`, then restores the decoded
 * instance into `held`, as `write.restore(held, decoded)` does: each `$` field
 * takes the decoded value in place, a collection row under a held key is
 * restored in place, and a new row is the decoded instance, so nothing is
 * decoded twice. It writes in the open update, or in an update of its own.
 * Throws `DecodeError` when `input` does not fit `schema`, and
 * `pinna/restore-plain-field` when a plain field of the decoded instance
 * differs from `held`'s. Inside a stage recipe it throws
 * `pinna/made-in-recipe`, because a decode makes boxes: decode outside, and
 * restore the decoded instance with the recipe's `write.restore`.
 */
export const restore = <S extends Schema.Top>(
  realm: Realm,
  schema: S,
  ...context: DecodeContext<S>
): ((held: S["Type"], input: unknown) => undefined) => {
  const decodeInto = decode(realm, schema, ...context);
  const owner = realm as ObservableRealm;
  return (held, input) => {
    const decoded = decodeInto(input);
    if (owner.updateDepth > 0) {
      owner.write.restore(held, decoded as never);
      return undefined;
    }
    Realm.update(realm, (_read, write) => {
      write.restore(held, decoded as never);
    });
    return undefined;
  };
};
