/**
 * Helpers for tests of code built on Pinna, for any test runner. `record`
 * keeps each value a select changes to; `held` lets `using` run a stop
 * function; `testRealm` makes a realm that, when disposed, throws if a
 * watch, an autorun, an `observe`, an `onRowChange` listener, or a stage is
 * still running; `retainedKeys` names the keys a collection still keeps something
 * for. None imports a test runner: a failure is a thrown `Error`.
 */
import type { Graph } from "@frondruntime/pinna-core";
import { KeyedCollection } from "../collection.ts";
import {
  type Collection,
  createRealm,
  type ObservableRealm,
  type Options,
  type Read,
  type Realm,
  type RealmOptions,
  watch,
} from "../observable.ts";
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
 * thrown here, as `watch` throws it.
 */
export const record = <Value>(
  realm: Realm,
  select: (read: Read) => Value,
  options?: Options<Value>,
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
 * Holds a stop function, or an `observe` release, for `using`, which runs it
 * when the scope ends, also when an assertion throws:
 * `using _ = held(autorun(realm, ...))`. The stop functions of `watch` and
 * `autorun` are plain functions, because a dispose property on each costs
 * every application's watches.
 */
export const held = (stop: () => void): Disposable => withDispose({}, stop);

/**
 * Makes a realm whose dispose throws when the test left a watch, an autorun,
 * an `observe`, an `onRowChange` listener, or an Effect program's watch
 * running, or a stage neither applied nor dropped, naming each by its label
 * (a watch's `name`, or `watch`, `autorun`, `onRowChange`, or `stage`), and
 * stops each first, dropping a stage, so nothing runs on into the next test. A React component's subscription is
 * not counted. Dispose also throws when the realm is not at rest, which only
 * a fault in Pinna leaves it.
 */
export const testRealm = (options?: RealmOptions): Realm & Disposable => {
  const realm = createRealm(options);
  const core: Graph = (realm as ObservableRealm).core;
  const running = new Set<{ readonly label: string; readonly stop: () => void }>();
  const watchInCore = core.watch.bind(core);
  const count = (label: string, stop: () => void): (() => void) => {
    const entry = {
      label,
      stop: () => {
        stop();
        running.delete(entry);
      },
    };
    running.add(entry);
    return entry.stop;
  };
  // The test realm's own graph counts its watches; every other graph keeps
  // the class's `watch`, so the count costs an application nothing.
  core.watch = ((select, effect, watchOptions) => {
    const stop = watchInCore(select, effect, watchOptions);
    // Autorun registers its complete stop function, which also runs cleanup.
    // A watch named "autorun" still has an effect and is counted here.
    return effect === undefined && watchOptions?.label === "autorun"
      ? stop
      : count(watchOptions?.label ?? "watch", stop);
  }) as Graph["watch"];
  (realm as ObservableRealm).running = count;
  return withDispose(realm, () => {
    const problems = [...running].map((entry) => `${entry.label} still running`);
    // Stopped here, so a failed test leaves nothing running for the next one.
    for (const entry of running) {
      try {
        entry.stop();
      } catch {
        // Reported below as still running.
      }
    }
    problems.push(...openParts(realm));
    if (problems.length > 0) {
      throw new Error(`The test realm is not at rest: ${problems.join("; ")}.`);
    }
  });
};

/**
 * The keys `collection` keeps something for: a row, or the box and computed
 * value a reader made for a key. Every one is a present key unless Pinna
 * leaks, so a test that removes rows checks that this set equals the keys
 * it expects to remain. A copy, taken when called. Throws for a value that
 * is not a collection Pinna made.
 */
export const retainedKeys = <Key, Value>(collection: Collection<Key, Value>): ReadonlySet<Key> => {
  if (!(collection instanceof KeyedCollection)) {
    throw new Error("pinna: retainedKeys takes a collection Pinna made");
  }
  return (collection as KeyedCollection<Key, Value>).retainedKeys();
};
