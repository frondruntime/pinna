/** `Box`: a box's module. `Box.make(realm, initial, options)` makes one. */
import { box, type writesAs } from "../box.ts";
import type { Computed } from "./computed.ts";

/**
 * Observable state. Read it with `read` in a place; write it with `write`
 * inside `Realm.update`. A box reads as a computed value does, so whatever takes a
 * `Computed` takes a box.
 */
export interface Box<Value> extends Computed<Value> {
  readonly [writesAs]: (value: Value) => void;
}

export interface BoxModule {
  /** Makes a box in `realm` holding `initial`; it checks nothing. */
  readonly make: typeof box;
}

export const Box: BoxModule = { make: box };
