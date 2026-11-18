import {
  type IComputedValue,
  type IObservableValue,
  computed as mobxComputed,
  observable as mobxObservable,
  untracked as mobxUntracked,
  onBecomeObserved,
  onBecomeUnobserved,
  reaction,
  runInAction,
} from "mobx";
import type { CheckedAdapter, Derived, Library, Source } from "../adapter.ts";

/** Each source and derived value keeps the MobX observable it reads. */
interface Kept {
  readonly observable: IObservableValue<unknown> | IComputedValue<unknown>;
}

export const mobx: Library<CheckedAdapter> = {
  name: "mobx",
  package: "mobx",
  make: () => ({
    box: <Value>(initial: Value): Source<Value> => {
      const box = mobxObservable.box(initial, { deep: false });
      const source: Source<Value> & Kept = {
        get: () => box.get(),
        set: (value) => box.set(value),
        observable: box as IObservableValue<unknown>,
      };
      return source;
    },
    computed: <Value>(compute: () => Value): Derived<Value> => {
      const value = mobxComputed(compute);
      const derived: Derived<Value> & Kept = {
        get: () => value.get(),
        observable: value as IComputedValue<unknown>,
      };
      return derived;
    },
    watch: (select, effect) => reaction(select, effect),
    update: (write) => runInAction(write),
    untracked: (read) => mobxUntracked(read),
    onObserved: (observable, start) => {
      const target = (observable as Partial<Kept>).observable;
      if (target === undefined) {
        throw new Error("pinna-bench: not an observable of this adapter");
      }
      let cleanup: (() => void) | undefined;
      const stopObserved = onBecomeObserved(target, () => {
        cleanup = start();
      });
      const stopUnobserved = onBecomeUnobserved(target, () => {
        cleanup?.();
        cleanup = undefined;
      });
      return () => {
        stopObserved();
        stopUnobserved();
      };
    },
  }),
};
