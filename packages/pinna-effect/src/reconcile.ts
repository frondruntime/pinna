/**
 * `reconcileSchema`: pinna's `reconcile`, with `equals` worked out from the
 * schema when it is left out. `reconcile` stays pinna's own and takes
 * `equals`.
 */
import { type ReconcileOptions, reconcile } from "@frondruntime/pinna";
import type { ObservableRealm } from "@frondruntime/pinna/internal";
import { Equal, Schema } from "effect";
import { planMerge, realmOfMergeable, writeIn } from "./merge.ts";
import { equalsOf } from "./schema.ts";

/**
 * A `SchemaModel` or `Schema.Class` instance compares with its class's
 * schema: plain fields by value, boxes and the realm by identity, or the
 * class's own `[Equal.symbol]`. Anything else compares with Effect's
 * structural equality.
 */
const sameValue = (previous: unknown, next: unknown): boolean => {
  if (previous === next) {
    return true;
  }
  if (typeof previous === "object" && previous !== null) {
    const type: unknown = previous.constructor;
    if (Schema.isSchema(type) && typeof type === "function" && next instanceof type) {
      return equalsOf(type as Schema.Top)(previous, next);
    }
  }
  return Equal.equals(previous, next);
};

/**
 * `next` in its own order, with the previous instance wherever an item's key
 * and value are unchanged. Returns `previous` itself when nothing changed.
 * Throws when `next` repeats a key, before it writes anything.
 *
 * A `SchemaModel` instance whose plain fields are unchanged is kept, and
 * each of its boxes takes the value of the new instance's box: in the open
 * update, or in one of its own when none is open. A call that writes nothing
 * opens no update.
 *
 * `equals` replaces the schema's comparison, and the merge, for items with
 * the same key that are not the same instance.
 */
export const reconcileSchema = <Item, Key>(
  previous: ReadonlyArray<Item>,
  next: ReadonlyArray<Item>,
  options: {
    readonly keyOf: ReconcileOptions<Item, Key>["keyOf"];
    readonly equals?: ReconcileOptions<Item, Key>["equals"];
  },
): ReadonlyArray<Item> => {
  if (options.equals !== undefined) {
    return reconcile(previous, next, { keyOf: options.keyOf, equals: options.equals });
  }
  // The writes wait until `reconcile` returns, so a repeated key throws before any.
  let pending: Map<ObservableRealm, Array<() => void>> | undefined;
  const result = reconcile(previous, next, {
    keyOf: options.keyOf,
    equals: (held, fresh) => {
      const realm = realmOfMergeable(held);
      // A held model reads and writes where its realm writes now: a stage recipe, or the realm.
      const place = realm?.place();
      const writes = place === undefined ? false : planMerge(held, fresh, place.read, place.write);
      if (writes === false) {
        // A model that cannot merge requires replacement, even if its own Equal agrees.
        return realmOfMergeable(held) === undefined && sameValue(held, fresh);
      }
      if (writes !== undefined) {
        pending ??= new Map();
        const list = pending.get(realm as ObservableRealm);
        if (list === undefined) {
          pending.set(realm as ObservableRealm, [writes]);
        } else {
          list.push(writes);
        }
      }
      return true;
    },
  });
  if (pending !== undefined) {
    for (const [realm, writes] of pending) {
      writeIn(realm, () => {
        for (const write of writes) {
          write();
        }
      });
    }
  }
  return result;
};
