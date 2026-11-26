/**
 * Helpers for tests of code built on Pinna, for any test runner. `record`
 * keeps each value a select changes to; `held` lets `using` run a stop
 * function; `testRealm` makes a realm that, when disposed, throws if a
 * watch, an autorun, a `Source.observe`, a `Collection.onRowChange` listener, or a stage is
 * still running; `retainedKeys` names the keys a collection still keeps something
 * for. None imports a test runner: a failure is a thrown `Error`.
 */
import { type Graph, PinnaUsageError } from "@frondruntime/pinna-core";
import type { Collection, Realm, ValueOptions } from "../box.ts";
import { KeyedCollection } from "../collection.ts";
import {
  createRealm,
  disposeRealm,
  type ObservableRealm,
  type RealmOptions,
  watch,
} from "../realm.ts";
import type { Read } from "../verbs.ts";
import { openParts } from "./rest.ts";

/** `Symbol.dispose`, or `undefined` on a runtime that has none. */
const disposeKey: typeof Symbol.dispose | undefined =
  typeof Symbol.dispose === "symbol" ? Symbol.dispose : undefined;

const withDispose = <Target extends object>(
  target: Target,
  dispose: () => void,
): Target & Disposable => {
  if (disposeKey !== undefined) {
    Object.defineProperty(target, disposeKey, { value: dispose, configurable: true });
  }
  return target as Target & Disposable;
};

/** The values a select changed to, kept until `stop` runs or `using` ends. */
export interface Recording<Value> extends Disposable {
  /**
   * Each value `select` changed to, oldest first. Its first value, which is
   * no change, is not kept, so `values.length` counts the changes.
   */
  readonly values: ReadonlyArray<Value>;
  /** Stops recording. Stopping twice does nothing. */
  readonly stop: () => void;
}

/**
 * Watches `select` in `realm` and keeps each value it changes to, compared
 * with `options.equals` or `Object.is`. An error from `select`'s first run is
 * thrown here, as `Realm.watch` throws it.
 */
export const record = <Value>(
  realm: Realm,
  select: (read: Read) => Value,
  options?: ValueOptions<Value>,
): Recording<Value> => {
  const values: Array<Value> = [];
  const stop = watch(
    realm,
    select,
    (value) => {
      values.push(value);
      return undefined;
    },
    options,
  );
  return withDispose({ values, stop }, stop);
};

/**
 * Holds a stop function, or a `Source.observe` release, for `using`, which runs it
 * when the scope ends, also when an assertion throws:
 * `using _ = held(Realm.autorun(realm, ...))`. The stop functions of `Realm.watch` and
 * `Realm.autorun` are plain functions, because a dispose property on each costs
 * every application's watches.
 */
export const held = (stop: () => void): Disposable => withDispose({}, stop);

/**
 * Makes a realm whose dispose throws when the test left a watch, an autorun,
 * a `Source.observe`, a `Collection.onRowChange` listener, or an Effect program's watch
 * running, or a stage neither applied nor dropped, naming each by its label
 * (a watch's `name`, or `Realm.watch`, `Realm.autorun`, `Collection.onRowChange`, or `stage`). It
 * disposes the realm first, with `Realm.dispose`, so nothing runs on into the
 * next test and a test that keeps using the realm throws at the use. A React
 * component's subscription is not reported. Dispose also throws when the
 * realm is not at rest, which only a fault in Pinna leaves it.
 */
export const testRealm = (options?: RealmOptions): Realm & Disposable => {
  const realm = createRealm(options);
  const owner = realm as ObservableRealm;
  const core: Graph = owner.core;
  const watches = new Set<{ readonly label: string; readonly stop: () => void }>();
  const watchInCore = core.watch.bind(core);
  // The test realm's own graph counts its watches; every other graph keeps
  // the class's `Realm.watch`, so the count costs an application nothing.
  core.watch = ((select, effect, watchOptions) => {
    const stop = watchInCore(select, effect, watchOptions);
    // An autorun is registered with the realm, with its complete stop. A
    // watch named "autorun" still has an effect and is counted here.
    if (effect === undefined && watchOptions?.label === "autorun") {
      return stop;
    }
    const entry = {
      label: watchOptions?.label ?? "watch",
      stop: () => {
        stop();
        watches.delete(entry);
      },
    };
    watches.add(entry);
    return entry.stop;
  }) as Graph["watch"];
  return withDispose(realm, () => {
    if (owner.status !== "open") {
      return;
    }
    const problems = [...owner.registered, ...watches].map(
      (entry) => `${entry.label} still running`,
    );
    const open = openParts(realm);
    if (open.length === 0) {
      disposeRealm(realm);
    } else {
      // Not at rest, so `Realm.dispose` would refuse: stop what the realm
      // registered by hand, so a failed test leaves nothing running.
      for (const entry of [...owner.registered].reverse()) {
        try {
          entry.stop();
        } catch {
          // Reported above as still running.
        }
      }
    }
    // Unlinked too, so the test's sources keep no observer.
    for (const entry of watches) {
      try {
        entry.stop();
      } catch {
        // Reported above as still running.
      }
    }
    problems.push(...open);
    if (problems.length > 0) {
      throw new PinnaUsageError(
        "pinna/test-realm-not-at-rest",
        `The test realm is not at rest: ${problems.join("; ")}.`,
      );
    }
  });
};

/**
 * The keys `Collection.make` keeps something for: a row, or the box and computed
 * value a reader made for a key. Every one is a present key unless Pinna
 * leaks, so a test that removes rows checks that this set equals the keys
 * it expects to remain. A copy, taken when called. Throws for a value that
 * is not a collection Pinna made.
 */
export const retainedKeys = <Key, Value>(collection: Collection<Key, Value>): ReadonlySet<Key> => {
  if (!(collection instanceof KeyedCollection)) {
    throw new PinnaUsageError(
      "pinna/not-made-by-pinna",
      "pinna: retainedKeys takes a collection Pinna made",
    );
  }
  return (collection as KeyedCollection<Key, Value>).retainedKeys();
};
