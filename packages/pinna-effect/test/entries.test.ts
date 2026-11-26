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

  test("a star import reads modules and errors at the top level, and no flat builder", () => {
    const extra = Object.keys(Schema)
      .filter((name) => !(name in Bare))
      .sort();
    expect(extra).toEqual(["DecodeError", "Program", "RealmService"]);
    expect("Pinna" in Schema).toBe(false);
    expect("Pinna" in Bare).toBe(false);
  });

  test("every name pinna exports is pinna's own value here, but the modules this package extends", () => {
    const differing = Object.keys(Bare)
      .filter(
        (name) =>
          (Bare as Record<string, unknown>)[name] !== (Schema as Record<string, unknown>)[name],
      )
      .sort();
    expect(differing).toEqual(["Box", "Collection", "Model", "Realm", "Source", "Stage", "View"]);
  });

  test("an extended module keeps every member of pinna's, the same function, but reconcile", () => {
    const pairs = {
      Box: [Bare.Box, Schema.Box],
      Collection: [Bare.Collection, Schema.Collection],
      Model: [Bare.Model, Schema.Model],
      Realm: [Bare.Realm, Schema.Realm],
      Source: [Bare.Source, Schema.Source],
      Stage: [Bare.Stage, Schema.Stage],
      View: [Bare.View, Schema.View],
    } as const;
    for (const [name, [bare, schema]] of Object.entries(pairs)) {
      const plain = bare as unknown as Record<string, unknown>;
      const extended = schema as unknown as Record<string, unknown>;
      const changed = Object.keys(plain).filter((member) => plain[member] !== extended[member]);
      expect({ name, changed }).toEqual({
        name,
        changed: name === "Collection" ? ["reconcile"] : [],
      });
    }
  });
});
