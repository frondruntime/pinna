/**
 * pinna's `Model` module, with the schema forms: `Model.Schema`, its fields
 * `Model.boxField`, `Model.collectionField`, and `Model.context`,
 * `Model.decode`, and `Model.restore`.
 */
import { Model as PlainModel, type ModelModule as PlainModelModule } from "@frondruntime/pinna";
import { BoxField, CollectionField, SchemaModel } from "../class.ts";
import { FromContext } from "../context.ts";
import { decode } from "../decode.ts";
import { restore } from "../restore.ts";

/** A model instance. */
export type Model = PlainModel;

export interface ModelModule extends PlainModelModule {
  /** A model on an Effect `Schema.Class`, whose `$` fields are boxes and collections. */
  readonly Schema: typeof SchemaModel;
  /** A `Model.Schema` field that holds a box checked by `schema`. */
  readonly boxField: typeof BoxField;
  /** A `Model.Schema` field that holds a keyed collection checked by `schema`. */
  readonly collectionField: typeof CollectionField;
  /** A field that holds a service the decode's context provides. */
  readonly context: typeof FromContext;
  /** Decodes wire data into `realm`. */
  readonly decode: typeof decode;
  /** Decodes wire data into `realm` and restores it into a held instance, in place. */
  readonly restore: typeof restore;
}

export const Model: ModelModule = {
  ...PlainModel,
  Schema: SchemaModel,
  boxField: BoxField,
  collectionField: CollectionField,
  context: FromContext,
  decode,
  restore,
};
