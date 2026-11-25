import { describe, expect, test } from "bun:test";
import * as Pinna from "../src/index.ts";
import * as Testing from "../src/testing/index.ts";

/**
 * The exact public surface of `@frondruntime/pinna` and its `testing` entry:
 * each top-level name, and each member of each module. A name added or
 * removed fails here first, so a change to the surface is a decision, not a
 * side effect.
 */

/** Each export's sorted members if it is a plain module object, or its type. */
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
  test("@frondruntime/pinna exports these modules and errors, and nothing else", () => {
    expect(surface(Pinna)).toEqual({
      Atom: ["make"],
      Box: ["make"],
      Collection: ["make", "onRowChange", "reconcile"],
      Computed: ["fn", "fromPromise", "make"],
      Model: ["Class"],
      PinnaError: "function",
      PinnaUsageError: "function",
      Realm: [
        "autorun",
        "dispose",
        "isTracking",
        "make",
        "onUpdate",
        "status",
        "untracked",
        "update",
        "watch",
      ],
      Source: ["inspect", "observe", "onObserved", "peek"],
      Stage: ["apply", "drop", "inspect", "make", "read", "realmRead", "status", "update"],
      StageClosedError: "function",
      StageConflictError: "function",
      ValueRejectedError: "function",
      View: ["dispose", "grouped", "ordered", "status", "totals"],
      isPinnaError: "function",
    });
  });

  test("@frondruntime/pinna/testing exports these helpers, and nothing else", () => {
    expect(surface(Testing)).toEqual({
      held: "function",
      record: "function",
      retainedKeys: "function",
      testRealm: "function",
    });
  });
});
