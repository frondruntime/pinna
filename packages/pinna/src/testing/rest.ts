/**
 * What a realm leaves open when a test breaks Pinna's own bookkeeping. Pinna's
 * tests assert it between steps; `testRealm` checks it when disposed.
 */

import {
  placeConditions,
  placeDisposed,
  placeKind,
  placeKindOf,
  placeKindShift,
  placeListening,
} from "@frondruntime/pinna-core";
import type { Realm } from "../box.ts";
import type { ObservableRealm } from "../realm.ts";

/**
 * Each part of `realm` that is still open: an update, an untracked read or a
 * peek, an undo entry, a journal slot still holding a value, an entry of the
 * completion list, an autorun's body, or a graph run, walk, or settle.
 * Empty when the realm is at rest, as it is whenever no Pinna call is in
 * progress.
 */
/** A listener's place at rest, without its conditions. */
const listeningWord = placeKind.listening << placeKindShift;

export const openParts = (realm: Realm): ReadonlyArray<string> => {
  const state = realm as ObservableRealm;
  const core = state.core;
  const open: Array<string> = [];
  if (state.updateDepth !== 0) open.push(`update depth ${state.updateDepth}`);
  // A place other than the realm's base, but for a `Realm.onUpdate` listener's,
  // which runs at rest: what an update, an untracked read, a peek, a
  // derivation, or a tracked run leaves set.
  const kind = placeKindOf(core.place);
  if (
    (core.place & ~(placeDisposed | placeListening)) !== listeningWord &&
    (core.place & ~placeDisposed) !== 0
  ) {
    open.push(`a place: ${kind}, conditions ${core.place & placeConditions}`);
  }
  if (state.scope !== 0) open.push(`update scope ${state.scope}`);
  if (state.journal.length !== 0) open.push(`${state.journal.length} undo entries`);
  const slots = state.journal.slots;
  let heldSlots = 0;
  for (let index = state.journal.length; index < slots.length; index++) {
    if (slots[index] !== undefined) heldSlots++;
  }
  if (heldSlots !== 0) open.push(`${heldSlots} journal slots past its end`);
  if (state.completions.length !== 0) {
    open.push(`${state.completions.length} completion entries`);
  }
  if (state.stack?.window === true) open.push("a visible stage's window");
  if (core.active !== undefined) open.push("a running computed value or watch");
  if (core.depth !== 0) open.push(`graph depth ${core.depth}`);
  if (core.walkDepth !== 0) open.push(`walk depth ${core.walkDepth}`);
  if (core.dueHead !== undefined) open.push("a scheduled watch");
  if (core.hooksDue.length !== 0) open.push(`${core.hooksDue.length} due hooks`);
  return open;
};
