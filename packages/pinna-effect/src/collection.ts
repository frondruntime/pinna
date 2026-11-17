import type { Collection, CollectionOptions, Realm } from "@frondruntime/pinna";
import { KeyedCollection, type ObservableRealm } from "@frondruntime/pinna/internal";
import type { Schema } from "effect";
import { planMerge } from "./merge.ts";
import { checkOf, equalsOf } from "./schema.ts";

/**
 * An empty keyed collection of values `schema` accepts: the collection a
 * `CollectionField` holds, without a model around it. A row the schema
 * rejects throws from the write and rolls its update back. A row written
 * under a held key compares with the schema's equivalence unless
 * `options.equals` says otherwise, and a `SchemaModel` row is merged into the
 * one held, as `CollectionField` merges it.
 */
export const schemaCollection = <S extends Schema.Top, Key>(
  realm: Realm,
  schema: S,
  options: CollectionOptions<Key, S["Type"]>,
): Collection<Key, S["Type"]> =>
  new KeyedCollection<Key, S["Type"]>(
    realm as ObservableRealm,
    checkOf(schema),
    options.equals ?? equalsOf<S["Type"]>(schema),
    options.keyOf,
    [],
    planMerge,
  );
