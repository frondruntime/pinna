/**
 * The one surface every scenario and every conformance case is written
 * against. Each library implements it once, in `libraries/`, so a scenario
 * reads the same for every library and each pays the same wrapper calls.
 *
 * Plain code: the workers bundle this file for Node and Hermes, so it
 * imports nothing from `effect`.
 *
 * Code reads only inside `computed`, a `watch` select, `update`, or
 * `untracked`, and writes only inside `update`, because Pinna throws
 * anywhere else. A `watch` effect gets the selected value and does not read.
 */

/** Writable state. */
export interface Source<Value> {
  readonly get: () => Value;
  readonly set: (value: Value) => void;
}

/** A value derived from what `compute` reads. */
export interface Derived<Value> {
  readonly get: () => Value;
}

/** What a scenario needs of a library. */
export interface Adapter {
  readonly box: <Value>(initial: Value) => Source<Value>;
  readonly computed: <Value>(compute: () => Value) => Derived<Value>;
  /**
   * Keeps `select` observed and runs `effect` whenever `select`'s result
   * changes by `Object.is`, not on the first run. Returns the function that
   * stops watching. `effect` is required, so every library runs the same
   * reaction: a bare effect for some and a compare-and-call for others is
   * not the same work.
   */
  readonly watch: <Value>(select: () => Value, effect: (value: Value) => void) => () => void;
  /** The write scope. Nested calls join the outermost one. */
  readonly update: (write: () => void) => void;
}

/** What a conformance case needs beyond a scenario. */
export interface CheckedAdapter extends Adapter {
  readonly untracked: <Value>(read: () => Value) => Value;
  /**
   * Runs `start` when `observable` gains its first observer, and the cleanup
   * it returns when the last one leaves. Absent where the library has no such
   * hook.
   */
  readonly onObserved?: (
    observable: Source<unknown> | Derived<unknown>,
    start: () => () => void,
  ) => () => void;
}

export type LibraryName = "pinna" | "alien-signals" | "mobx" | "legend";

export interface Library<Made extends Adapter = Adapter> {
  readonly name: LibraryName;
  /** The npm package whose version the results record. */
  readonly package: string;
  /**
   * A new instance. A worker makes one per cell and builds every sample's
   * graph in it; a conformance case gets one of its own.
   */
  readonly make: () => Made;
}
