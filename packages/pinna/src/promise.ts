/**
 * `Computed.fromPromise`: a read-only value fed by a promise while something
 * observes it, the plain form of pinna-effect's `Program.fromStream`
 * (`docs/api.md`, ruling 65).
 */

import { atom, computed, type ValueOptions } from "./box.ts";
import type { Computed } from "./modules/computed.ts";
import type { Realm } from "./modules/realm.ts";
import { type ObservableRealm, onObserved, update } from "./realm.ts";

/**
 * A read-only value: while observed, what the promise `load` returned
 * resolved to in this observation, or `initial` before it resolves; while
 * unobserved, `initial`. `load` runs when the first observer arrives, from
 * the start each time, with a signal that aborts when the last observer
 * leaves, which also resets the value to `initial` synchronously.
 * `Realm.dispose` ends it the same way. The resolved value is written in an
 * update of its own; a result or a rejection that arrives after the
 * observation ended is dropped, so it never writes a disposed realm. A
 * rejection, or a throw from `load`, goes to the realm's `onError` as it
 * is, and the value keeps what it held. `options.equals` compares the
 * resolved value with the value held, so an equal one notifies nobody;
 * `options.name` names the value for `Source.inspect`.
 */
export const fromPromise = <Value>(
  realm: Realm,
  load: (signal: AbortSignal) => PromiseLike<Value>,
  initial: Value,
  options?: ValueOptions<Value>,
): Computed<Value> => {
  const owner = realm as ObservableRealm;
  owner.assertOpen("Computed.fromPromise");
  // Lifecycle state cannot belong to an update's rollback journal: ending the
  // observation inside an update that throws must not restore a stale value.
  // An atom tracks the closure, and its invalidation survives rollback too.
  const $changed = atom(realm);
  let latest = initial;
  const equals = options?.equals ?? Object.is;
  const name = options?.name;
  const $value = computed<Value>(
    realm,
    (read) => {
      read($changed);
      return latest;
    },
    name === undefined ? undefined : { name },
  );
  onObserved($value, () => {
    const controller = new AbortController();
    let active = true;
    const settled = (value: Value): void => {
      if (!active) {
        return;
      }
      try {
        // `equals` is the caller's code: it may end the observation, so the
        // run is asked again before it writes.
        if (!Object.is(latest, value) && !equals(latest, value) && active) {
          update(realm, (_read, write) => {
            latest = value;
            write.changed($changed);
          });
        }
      } catch (error) {
        owner.core.reportAside(error);
      }
    };
    const failed = (reason: unknown): void => {
      if (active) {
        owner.core.reportAside(reason);
      }
    };
    try {
      Promise.resolve(load(controller.signal)).then(settled, failed);
    } catch (error) {
      failed(error);
    }
    return () => {
      active = false;
      controller.abort();
      // The reset bypasses equality: it restores `initial` itself.
      if (!Object.is(latest, initial)) {
        update(realm, (_read, write) => {
          latest = initial;
          write.changed($changed);
        });
      }
    };
  });
  return $value;
};
