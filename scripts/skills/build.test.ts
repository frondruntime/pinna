import { describe, expect, test } from "bun:test";
import { buildSkills, differences } from "./build.ts";
import { skills } from "./manifest.ts";
import { loadNames, unresolved } from "./names.ts";

// The TypeScript program behind the name check takes a few seconds.
const slow = 60_000;

describe("skills/", () => {
  test(
    "is what scripts/skills/build.ts writes",
    () => {
      // `buildSkills` throws on an unresolved name, a hub block or a docs section in no
      // skill, a broken link, and a size over budget; the message names each.
      const files = buildSkills();
      expect(differences(files)).toEqual([]);
    },
    slow,
  );

  test(
    "the name check fails on a name no package exports",
    () => {
      const names = loadNames();
      expect(
        unresolved(names, "probe", "`Box.make` `read.row` `useValue` `pinna/realm-disposed`"),
      ).toEqual([]);
      expect(unresolved(names, "probe", "`Box.observe`")).toEqual([
        "probe: Box.observe is no member of Box",
      ]);
      expect(unresolved(names, "probe", "`read.keys`")).toEqual([
        "probe: read.keys is no property of Read",
      ]);
      expect(unresolved(names, "probe", "`useStore`")).toEqual([
        "probe: useStore is no hook of pinna-react or React",
      ]);
      expect(unresolved(names, "probe", "`pinna/no-such-code`")).toEqual([
        "probe: pinna/no-such-code is no PinnaUsageCode",
      ]);
      expect(unresolved(names, "probe", "see @frondruntime/pinna-form")).toEqual([
        "probe: names an unpublished package",
      ]);
    },
    slow,
  );
});

describe("the trigger prompts", () => {
  const known = new Set(skills.map((skill) => skill.name));
  const loadsOf = new Map<string, string>();
  for (const skill of skills)
    for (const prompt of skill.prompts.loads) loadsOf.set(prompt, skill.name);

  for (const skill of skills) {
    test(`${skill.name} has five of each kind, each one consistent`, () => {
      expect(skill.prompts.loads.length).toBeGreaterThanOrEqual(5);
      expect(skill.prompts.skips.length).toBeGreaterThanOrEqual(5);
      for (const { prompt, expected } of skill.prompts.skips) {
        expect(expected === "none" || known.has(expected)).toBe(true);
        expect(expected).not.toBe(skill.name);
        // A prompt that loads one skill is expected there by every skill that skips it.
        const loads = loadsOf.get(prompt);
        if (loads !== undefined) expect(expected).toBe(loads);
      }
    });
  }

  test("no prompt loads two skills", () => {
    const all = skills.flatMap((skill) => skill.prompts.loads);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("skills.sh.json", () => {
  test("groups every skill once and names no other", async () => {
    const config = (await Bun.file(new URL("../../skills.sh.json", import.meta.url)).json()) as {
      readonly groupings: ReadonlyArray<{
        readonly title: string;
        readonly skills: ReadonlyArray<string>;
      }>;
    };
    const grouped = config.groupings.flatMap((group) => group.skills);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual(skills.map((skill) => skill.name).sort());
    for (const group of config.groupings) expect(group.title.length).toBeGreaterThan(0);
  });
});
