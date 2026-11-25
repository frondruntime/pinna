/**
 * Merging a refetched `Model.Schema` instance into the one held under its
 * key: the held instance stays, and each of its boxes takes the refetched
 * value. `Model.collectionField` and `Collection.reconcile` merge; a `Box.schema` and a
 * caller's `equals` do not.
 */
import type { Read, Write } from "@frondruntime/pinna";
import { type ObservableRealm, writeNow } from "@frondruntime/pinna/internal";

/** The writes a merge makes, or none when every box already holds its refetched value. */
export type MergeWrites = (() => void) | undefined;

/** The method a `Model.Schema` instance plans a merge with; see `planMerge`. */
export const mergeKey: unique symbol = Symbol("pinna/merge");

interface Mergeable {
  readonly realm: ObservableRealm;
  readonly [mergeKey]: (fresh: unknown, read: Read, write: Write) => MergeWrites | false;
}

const isMergeable = (value: unknown): value is Mergeable =>
  typeof value === "object" && value !== null && mergeKey in value;

/**
 * `false` when `fresh` replaces `held`: `held` is no `Model.Schema` instance,
 * `fresh` is another class's or another realm's, or their plain fields
 * differ (or the class's own `[Equal.symbol]` says they differ). Otherwise
 * `held` stays, and the answer is the writes that bring its boxes to
 * `fresh`'s values. Planning writes nothing, so a refetch whose boxes all
 * hold their values needs no open update. It reads both instances through
 * `read`, and the writes go through `write`: an update's, or a stage
 * recipe's, so a refetch through a stage merges into the stage.
 */
export const planMerge = (
  held: unknown,
  fresh: unknown,
  read: Read,
  write: Write,
): MergeWrites | false => (isMergeable(held) ? held[mergeKey](fresh, read, write) : false);

/**
 * Runs `write` where `realm` writes now: in a running stage recipe, whose
 * session puts it back on a throw; in the open update; or in one of its own.
 */
export const writeIn = (realm: ObservableRealm, write: () => void): void => {
  writeNow(realm, write);
};

/** The realm of a `Model.Schema` instance, for `Collection.reconcile`'s writes. */
export const realmOfMergeable = (held: unknown): ObservableRealm | undefined =>
  isMergeable(held) ? held.realm : undefined;
