/**
 * Pinna, MobX, and alien-signals behind the `ReactiveFramework` interface of
 * reactive-framework-test-suite (MIT, johnsoncodehk). The package ships its
 * cases, not its adapters; the MobX adapter here follows the suite's own
 * MobX adapter, so the local MobX run is the oracle.
 *
 * The alien-signals adapter is written from the `ReactiveFramework` interface
 * and the library's own API: the package ships no adapter, and its README
 * documents only the interface. It uses `signal`, `computed`, `effect`,
 * `startBatch`/`endBatch`, and `setActiveSub`, the way
 * `packages/pinna-bench/src/libraries/alien.ts` does. alien-signals' effect
 * ignores the value its function returns, so the adapter runs a returned
 * function as the cleanup.
 */
import {
  computed as alienComputed,
  effect as alienEffect,
  signal as alienSignal,
  endBatch,
  setActiveSub,
  startBatch,
} from "alien-signals";
import {
  autorun as mobxAutorun,
  computed as mobxComputed,
  untracked as mobxUntracked,
  observable,
  runInAction,
  transaction,
} from "mobx";
import type { ReactiveFramework } from "reactive-framework-test-suite";
import {
  autorun,
  box,
  computed,
  createRealm,
  type Realm,
  untracked,
  update,
} from "../../../src/index.ts";
import { keptRead } from "../../kept.ts";

/**
 * Each case runs in a fresh realm, so one case's errors and pending watchers
 * never reach the next. An error with no caller is dropped: a case asserts on
 * what it observes, not on what was reported.
 */
const makePinna = (): ReactiveFramework => {
  let realm: Realm = createRealm({ onError: () => {} });
  let depth = 0;
  // The suite reads through `read()` with no verb in hand, so each observable
  // keeps a read of its realm (test/kept.ts says why that works).
  return {
    name: "pinna",
    signal: (initial) => {
      const $box = box(realm, initial as unknown);
      const read = keptRead(realm);
      return {
        read: () => read($box) as typeof initial,
        write: (value) =>
          update(realm, (_read, write) => {
            write($box, value);
          }),
      };
    },
    computed: (compute) => {
      const value = computed(realm, compute);
      const read = keptRead(realm);
      return { read: () => read(value) };
    },
    // A function the effect returns is the autorun's cleanup.
    effect: (effect) =>
      autorun(realm, () => {
        const cleanup = effect();
        return typeof cleanup === "function" ? cleanup : undefined;
      }),
    effectCleanup: true,
    // A case reads at its top level, where Pinna throws on a tracked read:
    // the case body is an untracked place. The suite wraps each case in
    // `run`, and a case may call `run` again inside: only the outermost one
    // starts a fresh realm, so the case's observables stay in one realm.
    run: (body) => {
      if (depth === 0) {
        realm = createRealm({ onError: () => {} });
      }
      depth++;
      try {
        untracked(realm, body);
      } finally {
        depth--;
      }
    },
    batch: (write) =>
      update(realm, () => {
        write();
      }),
    untracked: (read) => untracked(realm, read),
  };
};

const makeMobx = (): ReactiveFramework => ({
  name: "mobx",
  signal: (initial) => {
    const box = observable.box(initial);
    return {
      read: () => box.get(),
      write: (value) => runInAction(() => box.set(value)),
    };
  },
  computed: (compute) => {
    const value = mobxComputed(compute);
    return { read: () => value.get() };
  },
  effect: (effect) =>
    mobxAutorun(() => {
      effect();
    }),
  run: (body) => {
    body();
  },
  batch: (write) => transaction(write),
  untracked: (read) => mobxUntracked(read),
});

/** Sets no active subscriber while `read` runs, then restores it. */
const alienUntracked = <Value>(read: () => Value): Value => {
  const previous = setActiveSub(undefined);
  try {
    return read();
  } finally {
    setActiveSub(previous);
  }
};

const makeAlien = (): ReactiveFramework => ({
  name: "alien-signals",
  signal: (initial) => {
    const signal = alienSignal(initial);
    return { read: () => signal(), write: (value) => signal(value) };
  },
  computed: (compute) => {
    const value = alienComputed(compute);
    return { read: () => value() };
  },
  // alien-signals runs a function its effect returns before the next run and
  // on stop, outside tracking.
  effect: (effect) => alienEffect(effect),
  effectCleanup: true,
  run: (body) => {
    body();
  },
  batch: (write) => {
    startBatch();
    try {
      write();
    } finally {
      endBatch();
    }
  },
  untracked: alienUntracked,
});

export const frameworks = { pinna: makePinna, mobx: makeMobx, "alien-signals": makeAlien } as const;

export type FrameworkName = keyof typeof frameworks;
