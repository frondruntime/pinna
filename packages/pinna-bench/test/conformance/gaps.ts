import type { LibraryName } from "../../src/adapter.ts";

/**
 * The cases each library is known to miss, by case name, with the reason.
 * A listed case runs as `test.failing`, so a gap that closes fails the
 * suite until it is removed here.
 */
export const gaps: Readonly<Partial<Record<LibraryName, Readonly<Record<string, string>>>>> = {
  pinna: {},
  "alien-signals": {
    "a derived value that threw still tracks what it read before throwing":
      "a derived value that throws keeps no dependencies, so the write that would fix it does not recompute it",
    "an observed hook starts with the first observer and cleans up after the last":
      "alien-signals has no observed hook",
  },
  mobx: {},
};
