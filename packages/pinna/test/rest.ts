import { expect } from "bun:test";
import type { Realm } from "../src/index.ts";
import { openParts } from "../src/internal/index.ts";

/** Asserts no update, untracked read, undo entry, autorun body, or graph run is left open in `realm`. */
export const expectRealmAtRest = (realm: Realm): void => {
  expect(openParts(realm)).toEqual([]);
};
