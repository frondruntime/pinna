/** `Computed`: a computed value's module. `Computed.make(realm, compute, options)` makes one. */
import { computed, computedFunction, type readsAs } from "../box.ts";
import { fromPromise } from "../promise.ts";

/**
 * An observable value derived from other observables. Cached; recomputes when
 * they change. Read it with `read` in a place.
 */
export interface Computed<Value> {
  readonly [readsAs]: () => Value;
}

export interface ComputedModule {
  /** Makes a computed value in `realm`. */
  readonly make: typeof computed;
  /**
   * A computed value per argument tuple, as MobX's `computedFn`: arguments
   * compare by identity, and a tuple's value is dropped when its last
   * observer leaves. `fn` stands for the reserved word `function`.
   */
  readonly fn: typeof computedFunction;
  /**
   * A read-only value fed by the promise `load` returns while something
   * observes it: `initial` until it resolves, and again once nothing
   * observes it. The signal `load` takes aborts when the last observer leaves.
   */
  readonly fromPromise: typeof fromPromise;
}

export const Computed: ComputedModule = { make: computed, fn: computedFunction, fromPromise };
