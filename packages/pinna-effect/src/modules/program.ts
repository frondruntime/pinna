/**
 * `Program`: the Effect programs over streams, queues, and fibers. Apart
 * from `Realm` and `Source`, so using `Realm.make` keeps none of Effect's
 * `Stream`, `Queue`, or fiber code in a bundle: `watchScoped` on `Realm`
 * added 21,047 bytes minified to an entry that never called it (decision B2
 * of ruling 71 of `docs/api.md`).
 */
import {
  changes,
  fromEffect,
  fromStream,
  updates,
  watchScoped,
  whileObserved,
} from "../programs.ts";

export interface ProgramModule {
  /** A watch for the length of the caller's scope, its effect an Effect program. */
  readonly watchScoped: typeof watchScoped;
  /** A stream of the observable's value, then each change. */
  readonly changes: typeof changes;
  /** A stream of the realm's update records, unbounded, until the realm is disposed. */
  readonly updates: typeof updates;
  /** A read-only value that follows a stream while observed. */
  readonly fromStream: typeof fromStream;
  /** A read-only value that holds what an Effect succeeds with while observed. */
  readonly fromEffect: typeof fromEffect;
  /** Runs a program while the observable is observed. */
  readonly whileObserved: typeof whileObserved;
}

export const Program: ProgramModule = {
  watchScoped,
  changes,
  updates,
  fromStream,
  fromEffect,
  whileObserved,
};
