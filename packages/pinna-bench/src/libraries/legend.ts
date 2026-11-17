import {
  batch as legendBatch,
  observable as legendObservable,
  observe as legendObserve,
} from "@legendapp/state";
import type { Adapter, Library } from "../adapter.ts";

/**
 * The Hermes command line has no timers; React Native has them. Legend's
 * batch arms a timer on entry and clears it on exit, a guard against a batch
 * left open. The stand-in does that bookkeeping and never fires, so a timer
 * costs a map entry here where React Native makes a native call: Legend's
 * Hermes numbers leave that call out. Installed only when Legend runs, so the
 * other libraries' processes see the host as it is.
 */
const timers = (): void => {
  if (typeof globalThis.setTimeout === "function") {
    return;
  }
  const pending = new Map<number, () => void>();
  let last = 0;
  globalThis.setTimeout = ((run: () => void) => {
    last++;
    pending.set(last, run);
    return last;
  }) as never;
  globalThis.clearTimeout = ((id: number) => {
    pending.delete(id);
  }) as never;
};

/**
 * Legend State, an observable store React Native teams pick today. It has
 * no untracked read and no observed hook, so it runs the scenarios and not
 * the conformance cases. Its `observe` runs at once and calls back tracked;
 * the adapter skips the first run and calls `effect` only on a change, as
 * Pinna's `watch` does. The scenarios' effects read nothing, so tracking
 * them costs nothing.
 */
export const legend: Library<Adapter> = {
  name: "legend",
  package: "@legendapp/state",
  make: () => {
    timers();
    return {
      // The scenarios' sources hold numbers and booleans; the cast picks
      // Legend's primitive typing over its object one.
      box: <Value>(initial: Value) => {
        const value = legendObservable<number>(initial as never);
        return { get: () => value.get() as Value, set: (next: Value) => value.set(next as never) };
      },
      computed: <Value>(compute: () => Value) => {
        const value = legendObservable(compute);
        return { get: () => value.get() as Value };
      },
      watch: <Value>(select: () => Value, effect?: (value: Value) => void) => {
        if (effect === undefined) {
          return legendObserve(() => {
            select();
          });
        }
        let started = false;
        let previous: Value | undefined;
        return legendObserve(() => {
          const value = select();
          if (!started) {
            started = true;
            previous = value;
            return;
          }
          if (!Object.is(value, previous)) {
            previous = value;
            effect(value);
          }
        });
      },
      update: (write) => legendBatch(write),
    };
  },
};
