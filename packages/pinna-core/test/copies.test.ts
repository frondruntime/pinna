/**
 * The copies `graph.ts` keeps on purpose. Hermes inlines only a function with
 * one caller, so a few hot functions are written out where they are called
 * (`docs/performance.md`). Each copy sits in a named region:
 *
 *   // region <name> (<from>=<to>, ...)
 *   ...
 *   // endregion <name>
 *
 * Every region of one name must hold the same code once comments and
 * whitespace are dropped and each `<from>` identifier is renamed to `<to>`.
 * A line after `// region-differs: <reason>` is left out of the comparison,
 * for a copy that differs on purpose. "Change all copies together" is this
 * test, not a comment.
 */
import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("../src/graph.ts", import.meta.url)).text();

interface Region {
  readonly name: string;
  readonly line: number;
  readonly code: string;
}

const opening = /^\s*\/\/ region ([a-z-]+)(?: \(([^)]*)\))?\s*$/;
const closing = /^\s*\/\/ endregion ([a-z-]+)\s*$/;
const differs = /^\s*\/\/ region-differs: .+$/;

/** The code of a region, compared: renamed, without comments or whitespace. */
const normalize = (
  lines: ReadonlyArray<string>,
  renames: ReadonlyArray<[string, string]>,
): string => {
  const kept: Array<string> = [];
  let skipNext = false;
  for (const line of lines) {
    if (differs.test(line)) {
      skipNext = true;
      continue;
    }
    if (skipNext) {
      skipNext = false;
      continue;
    }
    kept.push(line.replace(/\/\/.*$/, ""));
  }
  let code = kept.join("\n");
  for (const [from, to] of renames) {
    code = code.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  }
  return code.replace(/\s+/g, "");
};

const parse = (text: string): Array<Region> => {
  const regions: Array<Region> = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const open = opening.exec(lines[index] as string);
    if (open === null) {
      continue;
    }
    const name = open[1] as string;
    const renames = (open[2] ?? "")
      .split(",")
      .map((pair) => pair.trim())
      .filter((pair) => pair !== "")
      .map((pair) => pair.split("=") as [string, string]);
    const body: Array<string> = [];
    let end = index + 1;
    for (; end < lines.length; end++) {
      const close = closing.exec(lines[end] as string);
      if (close !== null) {
        if (close[1] !== name) {
          throw new Error(`graph.ts:${end + 1}: endregion ${close[1]} closes region ${name}`);
        }
        break;
      }
      if (opening.test(lines[end] as string)) {
        throw new Error(`graph.ts:${end + 1}: a region inside region ${name}`);
      }
      body.push(lines[end] as string);
    }
    if (end === lines.length) {
      throw new Error(`graph.ts:${index + 1}: region ${name} is never closed`);
    }
    regions.push({ name, line: index + 1, code: normalize(body, renames) });
    index = end;
  }
  return regions;
};

describe("the copies in graph.ts", () => {
  const regions = parse(source);
  const byName = Map.groupBy(regions, (region) => region.name);

  test("each region has a copy, and the expected regions exist", () => {
    expect([...byName.keys()].sort()).toEqual([
      "append",
      "check-observing",
      "detach",
      "finish-run-clean",
      "queue-due",
      "record-read",
    ]);
    for (const [name, copies] of byName) {
      expect({ name, copies: copies.length >= 2 }).toEqual({ name, copies: true });
    }
  });

  for (const [name, copies] of byName) {
    test(`every copy of ${name} holds the same code`, () => {
      const first = copies[0] as Region;
      for (const copy of copies.slice(1)) {
        expect({ line: copy.line, code: copy.code }).toEqual({ line: copy.line, code: first.code });
      }
    });
  }

  test("a copy that differs fails", () => {
    const planted = source.replace("tail.nextObserver = edge;", "tail.nextObserver = undefined;");
    const regions = parse(planted).filter((region) => region.name === "append");
    expect(regions.map((region) => region.code === (regions[0] as Region).code)).toContain(false);
  });
});
