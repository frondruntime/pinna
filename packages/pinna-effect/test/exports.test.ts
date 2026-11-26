import { describe, expect, test } from "bun:test";
import * as Schema from "../src/index.ts";

/**
 * The exact public surface of `@frondruntime/pinna-effect`: each top-level
 * name, and each member of each module. `entries.test.ts` checks how it
 * relates to pinna's; this checks the list itself.
 */

const surface = (entry: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.keys(entry)
      .sort()
      .map((name) => {
        const value = entry[name];
        const isModule =
          typeof value === "object" &&
          value !== null &&
          Object.getPrototypeOf(value) === Object.prototype;
        return [name, isModule ? Object.keys(value).sort() : typeof value];
      }),
  );

describe("exports", () => {
  test("@frondruntime/pinna-effect exports these modules and errors, and nothing else", () => {
    expect(surface(Schema)).toEqual({
      Atom: ["make"],
      Box: ["make", "schema"],
      Collection: ["make", "onRowChange", "reconcile", "schema"],
      Computed: ["fn", "fromPromise", "make"],
      DecodeError: "function",
      Model: ["Class", "Schema", "boxField", "collectionField", "context", "decode", "restore"],
      PinnaError: "function",
      PinnaUsageError: "function",
      Program: ["changes", "fromEffect", "fromStream", "updates", "watchScoped", "whileObserved"],
      Realm: [
        "autorun",
        "dispose",
        "isTracking",
        "make",
        "onUpdate",
        "scoped",
        "status",
        "untracked",
        "update",
        "watch",
      ],
      RealmService: "function",
      Source: ["inspect", "observe", "observeScoped", "onObserved", "peek"],
      Stage: [
        "apply",
        "drop",
        "inspect",
        "make",
        "read",
        "realmRead",
        "scoped",
        "status",
        "update",
      ],
      StageClosedError: "function",
      StageConflictError: "function",
      ValueRejectedError: "function",
      View: [
        "dispose",
        "grouped",
        "groupedScoped",
        "ordered",
        "orderedScoped",
        "status",
        "totals",
        "totalsScoped",
      ],
      isPinnaError: "function",
    });
  });
});
