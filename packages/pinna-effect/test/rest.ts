import { expect } from "bun:test";
import type { Realm } from "@frondruntime/pinna";
import { openParts } from "@frondruntime/pinna/internal";

/** Asserts no update, untracked read, undo entry, autorun body, or graph run is left open in `realm`. */
export const expectRealmAtRest = (realm: Realm): void => {
  expect(openParts(realm)).toEqual([]);
};
