/**
 * pinna's `Collection` module, with `Collection.schema`, and a `Collection.reconcile`
 * whose `equals` defaults to the schema's.
 */
import {
  Collection as PlainCollection,
  type CollectionModule as PlainCollectionModule,
} from "@frondruntime/pinna";
import { schemaCollection } from "../collection.ts";
import { reconcileSchema } from "../reconcile.ts";

/** A keyed collection: rows by key, one cell per key. */
export type Collection<Key, Value> = PlainCollection<Key, Value>;

export interface CollectionModule extends Omit<PlainCollectionModule, "reconcile"> {
  /** Makes a collection whose rows `schema` checks. */
  readonly schema: typeof schemaCollection;
  /** pinna's `Collection.reconcile`, its `equals` optional: a row that knows its schema compares by it. */
  readonly reconcile: typeof reconcileSchema;
}

export const Collection: CollectionModule = {
  ...PlainCollection,
  schema: schemaCollection,
  reconcile: reconcileSchema,
};
