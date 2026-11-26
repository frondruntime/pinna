import { expect } from "bun:test";
import type { Collection, Realm, Stage } from "../src/index.ts";
import { openParts } from "../src/internal/index.ts";
import { retainedKeys } from "../src/testing/index.ts";

/** Asserts no update, untracked read, undo entry, autorun body, or graph run is left open in `realm`. */
export const expectRealmAtRest = (realm: Realm): void => {
  expect(openParts(realm)).toEqual([]);
};

/**
 * The parts of a collection `expectNothingHeld` looks at, which no public
 * call reaches: reached by a cast, not an import, so this file keeps to its
 * one internal import (`test/contract.test.ts`).
 */
interface CollectionParts<Key> {
  readonly held: ReadonlyMap<Key, unknown>;
  readonly order: {
    readonly log: ReadonlyArray<unknown>;
    readonly source: { readonly value: ReadonlyArray<Key> };
  };
}

/**
 * Asserts that `realm` holds nothing an update acquired once the outermost
 * update has ended (docs/design.md, "One owner for what an update
 * acquires"): the realm is at rest, every journal slot and the completion
 * list are empty (`openParts`), each collection's order log is empty, and
 * `retainedKeys` names no key outside the rows the collection holds and the
 * keys a reader sees now, which a visible stage may add. The shown keys are
 * taken from the order's node, as `peekCell` does, not read: a read hands the order array out,
 * so the next change would copy it and the fuzz would lose the order's
 * in-place path, where D5-1 was.
 */
export const expectNothingHeld = <Key, Value>(
  realm: Realm,
  collections: ReadonlyArray<Collection<Key, Value>>,
): void => {
  const problems = [...openParts(realm)];
  for (const collection of collections) {
    const parts = collection as unknown as CollectionParts<Key>;
    if (parts.order.log.length !== 0) {
      problems.push(`an order log of ${parts.order.log.length / 3} changes`);
    }
    const shown = new Set(parts.order.source.value);
    for (const key of retainedKeys(collection)) {
      if (!parts.held.has(key) && !shown.has(key)) problems.push(`retained key ${String(key)}`);
    }
  }
  expect(problems).toEqual([]);
};

/**
 * Runs `recipe`, a `Stage.update` on `stage`, and asserts that a throw
 * leaves the stage holding the patches it held before: a failed recipe's
 * row patch is taken back out by a journal step (D6-5). Rethrows. Counted
 * around the recipe, not per step: a visible stage's replay may make a
 * patch its first run did not (a recipe that writes a row only when it
 * reads one), so the count after a step has no bound but this.
 */
export const expectFailedRecipeKeepsNoPatch = (stage: Stage, recipe: () => void): void => {
  // A stage's `patches` (`StageState` in `src/stage.ts`), which no public call reaches.
  const state = stage as unknown as { readonly patches: ReadonlyArray<unknown> };
  const before = state.patches.length;
  try {
    recipe();
  } catch (error) {
    expect(state.patches.length).toBe(before);
    throw error;
  }
};
