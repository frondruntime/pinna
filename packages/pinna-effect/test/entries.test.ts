import { describe, expect, test } from "bun:test";
import * as Bare from "@frondruntime/pinna";
import { Glob } from "bun";
import * as Schema from "../src/index.ts";

/**
 * The split between the two packages: `pinna` never reaches for Effect, and
 * this package hands out every value `pinna` does, so an application imports
 * from one place.
 */

describe("the entries", () => {
  test("pinna's source imports nothing from effect", async () => {
    const source = new URL("../../pinna/src/", import.meta.url).pathname;
    const offenders: Array<string> = [];
    for await (const path of new Glob("**/*.ts").scan(source)) {
      const text = await Bun.file(source + path).text();
      if (/(?:from\s+|import\s*\(\s*)["']effect(?:\/[^"']*)?["']/.test(text)) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("this package exports every value pinna exports, under the same name", () => {
    const missing = Object.keys(Bare).filter((name) => !(name in Schema));
    expect(missing).toEqual([]);
  });

  test("a star import reads every builder at the top level, with no nested namespace", () => {
    const extra = Object.keys(Schema)
      .filter((name) => !(name in Bare))
      .sort();
    expect(extra).toEqual([
      "BoxField",
      "CollectionField",
      "FromContext",
      "RealmService",
      "SchemaModel",
      "StageConflict",
      "changes",
      "decode",
      "fromStream",
      "observeScoped",
      "reconcileSchema",
      "schemaBox",
      "schemaCollection",
      "watchScoped",
      "whileObserved",
      "withStage",
    ]);
    expect("Pinna" in Schema).toBe(false);
    expect("Pinna" in Bare).toBe(false);
  });

  test("every name pinna exports is pinna's own value here: a name that checks a schema says so", () => {
    const differing = Object.keys(Bare).filter(
      (name) =>
        (Bare as Record<string, unknown>)[name] !== (Schema as Record<string, unknown>)[name],
    );
    expect(differing).toEqual([]);
  });
});
