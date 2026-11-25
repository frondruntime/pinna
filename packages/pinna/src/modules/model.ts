/**
 * `Model`: the model's module. `Model.Class` is the base of a model that
 * checks nothing; `type Model` is its instance type. pinna-effect adds the
 * schema forms.
 */
import { Model as ModelClass } from "../box.ts";

/** A model instance: a class whose fields are boxes, computed values, and collections in one realm. */
export type Model = ModelClass;

export interface ModelModule {
  /** The base class of a model that checks nothing: `class Todo extends Model.Class`. */
  readonly Class: typeof ModelClass;
}

export const Model: ModelModule = { Class: ModelClass };
