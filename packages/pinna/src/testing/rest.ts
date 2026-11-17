/**
 * What a realm leaves open when a test breaks Pinna's own bookkeeping. Pinna's
 * tests assert it between steps; `testRealm` checks it when disposed.
 */
import type { ObservableRealm, Realm } from "../observable.ts";

/**
 * Each part of `realm` that is still open: an update, an untracked read or a
 * peek, an undo entry, an autorun's body, or a graph run, walk, or settle.
 * Empty when the realm is at rest, as it is whenever no Pinna call is in
 * progress.
 */
export const openParts = (realm: Realm): ReadonlyArray<string> => {
  const state = realm as ObservableRealm;
  const core = state.core;
  const open: Array<string> = [];
  if (state.updateDepth !== 0) open.push(`update depth ${state.updateDepth}`);
  if (state.openDepth !== 0) open.push(`untracked depth ${state.openDepth}`);
  if (state.scope !== 0) open.push(`update scope ${state.scope}`);
  if (state.journalLength !== 0) open.push(`${state.journalLength} undo entries`);
  if (state.autorunRun !== undefined) open.push("an autorun's body");
  if (core.active !== undefined) open.push("a running computed value or watch");
  if (core.deriving !== undefined) open.push("a deriving computed value");
  if (core.depth !== 0) open.push(`graph depth ${core.depth}`);
  if (core.walkDepth !== 0) open.push(`walk depth ${core.walkDepth}`);
  if (core.dueHead !== undefined) open.push("a scheduled watch");
  if (core.hooksDue.length !== 0) open.push(`${core.hooksDue.length} due hooks`);
  return open;
};
