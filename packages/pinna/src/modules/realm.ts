/**
 * `Realm`: a realm's module, `Realm.make(options)` and the functions that
 * take a realm first. The module and its type share the name
 * (ruling 62 of `docs/api.md`, rule 1).
 */
import {
  autorun,
  createRealm,
  disposeRealm,
  isTracking,
  onUpdate,
  type realmBrand,
  realmStatus,
  untracked,
  update,
  watch,
} from "../realm.ts";

/**
 * A reactive realm and everything made from it. Make one per host with
 * `Realm.make()` and hand it to whatever builds state.
 */
export interface Realm extends Disposable {
  /** Only `Realm.make` makes a realm; the realm functions take it. */
  readonly [realmBrand]: true;
}

export interface RealmModule {
  /** Makes a realm; `{ name }` names it in errors, `{ onError }` takes errors with no caller. */
  readonly make: typeof createRealm;
  /** Runs `recipe` with the realm's `read` and `write`, landing its writes whole or not at all; `{ name }` labels its record. */
  readonly update: typeof update;
  /** Hands `listener` one record per landed update: each box, row, key order, and atom it changed, before and after. */
  readonly onUpdate: typeof onUpdate;
  /** Reads without tracking, from an event handler or a test. */
  readonly untracked: typeof untracked;
  /** Runs `effect` after each change to what `select` reads. */
  readonly watch: typeof watch;
  /** Runs `body` now and again after each change to what it read. */
  readonly autorun: typeof autorun;
  /** Whether reads in the realm are tracked here. */
  readonly isTracking: typeof isTracking;
  /** Ends the realm: its hooks, autoruns, listeners, and stages. */
  readonly dispose: typeof disposeRealm;
  /** `"open"` or `"disposed"`. */
  readonly status: typeof realmStatus;
}

export const Realm: RealmModule = {
  make: createRealm,
  update,
  onUpdate,
  untracked,
  watch,
  autorun,
  isTracking,
  dispose: disposeRealm,
  status: realmStatus,
};
