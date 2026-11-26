import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

/**
 * The contract bucket: every test outside a `test/internal` folder reads
 * Pinna through its public entries (`src/index.ts`, `src/testing/index.ts`,
 * or the published package names), so a rewrite of the internals cannot
 * break it by renaming them. Tests of the internals live in `test/internal`
 * and in `packages/pinna-core/test`, and change with the code they test.
 *
 * One bridge is allowed: each package's `test/rest.ts` imports `openParts`,
 * the at-rest check `testRealm` itself runs on dispose, so a test can assert
 * it between steps.
 */

const packages = new URL("../../", import.meta.url).pathname;
const contractPackages = ["pinna", "pinna-effect", "pinna-react"] as const;

/** The bridges: a file and the one internal name it may import. */
const bridges: ReadonlyMap<string, string> = new Map([
  ["pinna/test/rest.ts", "openParts"],
  ["pinna-effect/test/rest.ts", "openParts"],
]);

/**
 * A static import or re-export (its bindings never hold a semicolon or a
 * quote, so a match never runs past its own statement), a dynamic import,
 * or a side-effect import.
 */
const importPattern =
  /(?:import|export)\s+(?:type\s+)?([^;"'`]*?)\s+from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

const specifierOf = (match: RegExpMatchArray): string => match[2] ?? match[3] ?? match[4] ?? "";

/** Whether `specifier`, imported by the file at `path`, reaches an internal. */
const isInternal = (specifier: string, path: string): boolean => {
  if (/(?:^|\/)internal(?:\/|\.ts$|$)/.test(specifier)) return true;
  if (specifier.includes("pinna-core")) return true;
  if (!specifier.startsWith(".")) return false;
  const resolved = new URL(specifier, `file://${path}`).pathname;
  const inSource = resolved.match(/\/packages\/[^/]+\/src\/(.*)$/);
  return inSource !== null && inSource[1] !== "index.ts" && inSource[1] !== "testing/index.ts";
};

/** Each import of an internal in the contract tests, as `file: specifier`. */
const offenders = async (): Promise<ReadonlyArray<string>> => {
  const found: Array<string> = [];
  for (const name of contractPackages) {
    for await (const relative of new Glob("test/**/*.{ts,tsx}").scan(packages + name)) {
      if (relative.startsWith("test/internal/")) continue;
      const file = `${name}/${relative}`;
      // This file names internal imports as data, to test the check itself.
      if (file === "pinna/test/contract.test.ts") continue;
      const path = packages + file;
      const text = await Bun.file(path).text();
      for (const match of text.matchAll(importPattern)) {
        const specifier = specifierOf(match);
        if (!isInternal(specifier, path)) continue;
        const bridge = bridges.get(file);
        const names = (match[1] ?? "").replace(/[{}\s]/g, "").split(",");
        if (bridge !== undefined && names.every((imported) => imported === bridge)) continue;
        found.push(`${file}: ${specifier}`);
      }
    }
  }
  return found.sort();
};

describe("the contract bucket", () => {
  test("no contract test imports an internal, but the at-rest bridge", async () => {
    expect(await offenders()).toEqual([]);
  });

  test("the check tells an internal import from a public one", () => {
    const at = `${packages}pinna/test/example.test.ts`;
    expect(isInternal("../src/index.ts", at)).toBe(false);
    expect(isInternal("../src/testing/index.ts", at)).toBe(false);
    expect(isInternal("@frondruntime/pinna", at)).toBe(false);
    expect(isInternal("@frondruntime/pinna/testing", at)).toBe(false);
    expect(isInternal("./kept.ts", at)).toBe(false);
    expect(isInternal("../src/internal/index.ts", at)).toBe(true);
    expect(isInternal("../src/observable.ts", at)).toBe(true);
    expect(isInternal("../src/testing/rest.ts", at)).toBe(true);
    expect(isInternal("@frondruntime/pinna/internal", at)).toBe(true);
    expect(isInternal("@frondruntime/pinna-core", at)).toBe(true);
    expect(isInternal("../../pinna-effect/src/schema.ts", at)).toBe(true);
  });

  test("the pattern sees named, type, re-exported, dynamic, and side-effect imports, one statement at a time", () => {
    const text = [
      'import { a } from "../src/observable.ts";',
      'import type { B } from "../src/internal/index.ts";',
      'export { c } from "@frondruntime/pinna-core";',
      'const d = await import("../src/stage.ts");',
      'import "../src/internal/side-effect.ts";',
      'export const e = () => import("../src/collection.ts");',
      'import { f } from "../src/index.ts";',
    ].join("\n");
    const specifiers = [...text.matchAll(importPattern)].map(specifierOf);
    expect(specifiers).toEqual([
      "../src/observable.ts",
      "../src/internal/index.ts",
      "@frondruntime/pinna-core",
      "../src/stage.ts",
      "../src/internal/side-effect.ts",
      "../src/collection.ts",
      "../src/index.ts",
    ]);
  });
});
