import { describe, expect, test } from "bun:test";
import * as React from "../src/index.ts";

/** The exact public surface of `@frondruntime/pinna-react`. */
describe("exports", () => {
  test("@frondruntime/pinna-react exports these hooks and the provider, and nothing else", () => {
    expect(Object.keys(React).sort()).toEqual([
      "RealmProvider",
      "useRealm",
      "useSelect",
      "useValue",
      "useValues",
    ]);
  });
});
