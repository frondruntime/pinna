import {
  computed as alienComputed,
  effect as alienEffect,
  signal as alienSignal,
  endBatch,
  setActiveSub,
  startBatch,
} from "alien-signals";
import type { CheckedAdapter, Derived, Library, Source } from "../adapter.ts";

/** Sets no active subscriber while `run` runs, then restores it. */
const alienUntracked = <Value>(run: () => Value): Value => {
  const previous = setActiveSub(undefined);
  try {
    return run();
  } finally {
    setActiveSub(previous);
  }
};

export const alien: Library<CheckedAdapter> = {
  name: "alien-signals",
  package: "alien-signals",
  make: () => ({
    box: <Value>(initial: Value): Source<Value> => {
      const signal = alienSignal(initial);
      return { get: () => signal(), set: (value) => signal(value) };
    },
    // `compute` goes to alien-signals as its getter, with no wrapper
    // closure: it ignores the previous value the getter receives.
    computed: <Value>(compute: () => Value): Derived<Value> => {
      const value = alienComputed(compute);
      return { get: () => value() };
    },
    // alien-signals has no reaction: an effect runs at once. The first run
    // only records the value, and later runs call `effect` untracked when the
    // value changed, as Pinna's `watch` and MobX's `reaction` do. The active
    // subscriber is cleared and restored inline, so a notification makes no
    // closure.
    watch: <Value>(select: () => Value, effect: (value: Value) => void) => {
      let started = false;
      let previous: Value | undefined;
      return alienEffect(() => {
        const value = select();
        if (!started) {
          started = true;
          previous = value;
          return;
        }
        if (!Object.is(value, previous)) {
          previous = value;
          const outer = setActiveSub(undefined);
          try {
            effect(value);
          } finally {
            setActiveSub(outer);
          }
        }
      });
    },
    update: (write) => {
      startBatch();
      try {
        write();
      } finally {
        endBatch();
      }
    },
    untracked: alienUntracked,
  }),
};
