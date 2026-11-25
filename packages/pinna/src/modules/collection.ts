/** `Collection`: a keyed collection's module. `Collection.make(realm, { keyOf })` makes one. */
import { collection, onRowChange } from "../collection.ts";
import { reconcile } from "../reconcile.ts";
import type { Computed } from "./computed.ts";

/**
 * Rows by key, in order: a cell for each key a reader reads, and one for the order. A write to
 * one key reruns only what read that key; adding, removing, or moving a key
 * reruns only what read `keys`. Written inside `Realm.update`, like a box, through
 * `write.upsert`, `write.remove`, and `write.replaceAll`; a `Model.collectionField`
 * field checks each row against its schema and is a plain array on the wire,
 * and `Collection.make` rejects `undefined` rows and checks nothing else.
 */
export interface Collection<Key, Value> {
  /**
   * The row under `key`, or `undefined`. Tracks that key alone, so a key that
   * is missing now reruns its reader when it is added. While the key is
   * present, it returns the same computed value; while it is missing, only
   * while something observes it. One taken while the key was missing keeps
   * working once it is added, though `row` then returns another.
   */
  row(key: Key): Computed<Value | undefined>;
  /** The keys in order. Changes only when a key is added, removed, or moved. */
  readonly keys: Computed<ReadonlyArray<Key>>;
  /**
   * Every row in key order. Its reader reruns when any row or the order
   * changes, so a list that renders one row per key reads `keys` and `row`.
   */
  readonly rows: Computed<ReadonlyArray<Value>>;
}

export interface CollectionModule {
  /** Makes a collection in `realm` that keys its rows with `keyOf`. */
  readonly make: typeof collection;
  /** Calls `listener` with each row a write adds, replaces, or removes. */
  readonly onRowChange: typeof onRowChange;
  /** Keeps each previous item whose key and value are unchanged in `next`, for a refetch. */
  readonly reconcile: typeof reconcile;
}

export const Collection: CollectionModule = { make: collection, onRowChange, reconcile };
