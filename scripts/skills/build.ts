/**
 * Writes `skills/`, the Agent Skills for applications on Pinna, from
 * `manifest.ts`, the hub (`packages/pinna/AGENTS.md`), and `docs/public`.
 * Every file is generated: a skill's rules are the hub's text under the
 * hub's numbers, and its references are the docs pages with their samples
 * expanded, so `bun run typecheck` compiles every line of code a skill
 * prints (AGENTS.md rule 9).
 *
 *     bun scripts/skills/build.ts           writes skills/
 *     bun scripts/skills/build.ts --check   writes nothing; exits 1 on a difference
 *
 * The build fails on a slice that names no block, a hub block or a docs
 * section that no skill carries, a name that resolves in no package
 * (`names.ts`), a relative link to a page that does not exist, or a size
 * over its budget.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inlineRegions } from "../../apps/site/scripts/regions.ts";
import { type HubSlice, type Reference, type Skill, skills } from "./manifest.ts";
import { loadNames, type Names, unresolved } from "./names.ts";
import { type Block, fail, type Hub, type Page, parseHub, parsePage, pick } from "./slices.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const skillsDir = join(root, "skills");
const hubPath = "packages/pinna/AGENTS.md";
const docsDir = join(root, "docs/public");
const site = "https://pinna.frondruntime.dev/docs";

/** Most characters a description may have, and most lines a reference may have. */
export const limits = { description: 300, reference: 450, headingsOver: 100 } as const;

const generated =
  "<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->";

const closing =
  "`node_modules/@frondruntime/pinna/AGENTS.md` is the same text at the installed version and wins where it differs.";

// ---------------------------------------------------------------- the hub

/** The hub's text for one slice, and the blocks it covers. */
function hubText(
  hub: Hub,
  slice: HubSlice,
): { readonly text: string; readonly covers: ReadonlyArray<Block> } {
  if ("rule" in slice) {
    const rule = hub.rules.get(slice.rule);
    if (rule === undefined) fail(`${hubPath} has no rule ${slice.rule}`);
    const bullets = pick(`${hubPath} rule ${slice.rule}`, rule.bullets, slice);
    return {
      text: [rule.lead.text, ...bullets.map((bullet) => bullet.text)].join("\n"),
      covers: [rule.lead, ...bullets],
    };
  }
  const blocks = hub.sections.get(slice.section);
  if (blocks === undefined) fail(`${hubPath} has no section "${slice.section}"`);
  const chosen = pick(`${hubPath} "${slice.section}"`, blocks, slice);
  return {
    // Consecutive bullets stay one tight list, as the hub prints them.
    text: chosen.reduce(
      (text, block, index) =>
        `${text}${index > 0 && isBullet(block) && isBullet(chosen[index - 1] as Block) ? "\n" : "\n\n"}${block.text}`,
      `### ${slice.section}`,
    ),
    covers: chosen,
  };
}

const isBullet = (block: Block): boolean => block.text.startsWith("- ");

/**
 * Joins slices with a blank line between them. Numbered rules come before
 * the sections, so a rule never reads as part of the section above it.
 */
function rulesText(hub: Hub, slices: ReadonlyArray<HubSlice>, covered: Set<Block>): string {
  const firstSection = slices.findIndex((slice) => "section" in slice);
  if (firstSection !== -1 && slices.slice(firstSection).some((slice) => "rule" in slice)) {
    fail("a rule slice follows a section slice; list the rules first");
  }
  return slices
    .map((slice) => {
      const { text, covers } = hubText(hub, slice);
      for (const block of covers) covered.add(block);
      return text;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------- pages

const pages = new Map<string, Page>();

function pageOf(path: string): Page {
  const cached = pages.get(path);
  if (cached !== undefined) return cached;
  const file = join(docsDir, path);
  if (!existsSync(file)) fail(`docs/public/${path} does not exist`);
  const page = parsePage(`docs/public/${path}`, readFileSync(file, "utf8"));
  pages.set(path, page);
  return page;
}

function allPages(directory = docsDir): ReadonlyArray<string> {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return allPages(path);
    return directory === docsDir || !name.endsWith(".md") ? [] : [relative(docsDir, path)];
  });
}

/** The anchor a heading gets on the site: lowercase words joined by "-". */
const slug = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/ /g, "-");

/** The anchors of the `## ` to `#### ` headings in `text`, outside code fences. */
function anchorsOf(text: string): ReadonlySet<string> {
  const anchors = new Set<string>();
  let fenced = false;
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("```")) fenced = !fenced;
    if (!fenced && /^#{2,4} /.test(line)) anchors.add(slug(line.replace(/^#+ /, "")));
  }
  return anchors;
}

/** The text of the sections a reference carries. */
function carriedText(reference: Reference): string {
  const page = pageOf(reference.page);
  return page.sections
    .filter(
      (section) => reference.sections === undefined || reference.sections.includes(section.heading),
    )
    .map((section) => section.text)
    .join("\n\n");
}

/**
 * Where a link to `target` (a page under `docs/public`) and `anchor` goes:
 * the reference file of this skill that carries it, or else the page on
 * the site. An anchor no heading of the page has fails the build.
 */
function linkTarget(skill: Skill, from: string, target: string, anchor: string): string {
  if (
    anchor !== "" &&
    !anchorsOf(
      pageOf(target)
        .sections.map((s) => s.text)
        .join("\n\n"),
    ).has(anchor)
  ) {
    fail(`docs/public/${from} links to ${target}#${anchor}, a heading the page does not have`);
  }
  const local = skill.references.find(
    (reference) =>
      reference.page === target &&
      (anchor === ""
        ? reference.sections === undefined
        : anchorsOf(carriedText(reference)).has(anchor)),
  );
  const suffix = anchor === "" ? "" : `#${anchor}`;
  if (local !== undefined) return `${local.file}${suffix}`;
  if (anchor === "") return `${site}/${target}`;
  // The site serves a section's index page at the section's own path.
  return `${site}/${target.slice(0, -3).replace(/\/index$/, "")}${suffix}`;
}

/** Points every relative and in-page link at a reference file of this skill or at the site. */
function rewriteLinks(skill: Skill, page: string, text: string): string {
  return text
    .replace(/\]\((\.{1,2}\/[^)\s#]+?\.md)(?:#([\w-]+))?\)/g, (_, target: string, anchor = "") => {
      const resolved = posix.normalize(posix.join(posix.dirname(page), target));
      if (!existsSync(join(docsDir, resolved))) {
        fail(`docs/public/${page} links to ${target}, which does not exist`);
      }
      return `](${linkTarget(skill, page, resolved, anchor)})`;
    })
    .replace(
      /\]\(#([\w-]+)\)/g,
      (_, anchor: string) => `](${linkTarget(skill, page, page, anchor)})`,
    );
}

function referenceText(skill: Skill, reference: Reference): string {
  const page = pageOf(reference.page);
  const wanted = reference.sections;
  const sections =
    wanted === undefined
      ? page.sections
      : wanted.map((heading) => {
          const section = page.sections.find((candidate) => candidate.heading === heading);
          if (section === undefined)
            fail(`docs/public/${reference.page} has no section "## ${heading}"`);
          return section;
        });
  const title =
    wanted === undefined
      ? page.title
      : `${page.title}: ${wanted.filter((h) => h !== "" && h !== "See also").join(", ")}`;
  const body = sections.map((section) => section.text).join("\n\n");
  const expanded = inlineRegions(`docs/public/${reference.page}`, body).text;
  const linked = rewriteLinks(skill, reference.page, expanded);
  const source =
    wanted === undefined
      ? `From docs/public/${reference.page}.`
      : `From docs/public/${reference.page}, ${wanted.length === 1 ? "its section" : "its sections"} ${wanted.map((heading) => `"${heading || "(introduction)"}"`).join(", ")}.`;
  const lines = [`# ${title}`, "", generated, source];
  const headings = sections
    .filter((section) => section.heading !== "")
    .map((section) => section.heading);
  const draft = `${[...lines, "", linked].join("\n")}\n`;
  if (draft.split("\n").length > limits.headingsOver && headings.length > 1) {
    lines.push("", `Sections: ${headings.join(", ")}.`);
  }
  return `${[...lines, "", linked].join("\n")}\n`;
}

function whenOf(reference: Reference): string {
  if (reference.when !== undefined) return reference.when;
  if (reference.sections !== undefined)
    fail(`${reference.file}: a part of a page needs its own "when"`);
  return pageOf(reference.page).description;
}

// ---------------------------------------------------------------- a skill

function skillText(hub: Hub, skill: Skill, covered: Set<Block>): string {
  // Every skill prints the hub's first paragraph; `pinna-state` prints
  // rules 1 to 3 under its own Rules, so not twice.
  const assumes = [
    "## Every skill assumes",
    "",
    hub.intro,
    "",
    ...(skill.name === "pinna-state"
      ? []
      : [rulesText(hub, [{ rule: 1 }, { rule: 2 }, { rule: 3 }], new Set()), ""]),
  ];
  const references = [
    "## References",
    "",
    "Open a file under `references/` when its condition holds.",
    "",
    "| File | Read when |",
    "| --- | --- |",
    ...skill.references.map(
      (reference) =>
        `| [${reference.file}](references/${reference.file}) | ${whenOf(reference).replace(/\|/g, "\\|")} |`,
    ),
    "",
  ];
  const neighbors = [
    "## Another skill applies",
    "",
    ...skill.neighbors.map((neighbor) => `- \`${neighbor.skill}\`: ${neighbor.when}.`),
    "",
    closing,
  ];
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description)}`,
    "---",
    "",
    generated,
    "",
    `# ${skill.title}`,
    "",
    skill.claim,
    "",
    ...assumes,
    "## Rules",
    "",
    rulesText(hub, skill.hub, covered),
    "",
    ...references,
    ...neighbors,
    "",
  ].join("\n");
}

/** Every file of `skills/`, by its path under `skills/`. */
export function buildSkills(names: Names = loadNames()): ReadonlyMap<string, string> {
  const hub = parseHub(readFileSync(join(root, hubPath), "utf8"));
  const problems: string[] = [
    ...unresolved(names, hubPath, readFileSync(join(root, hubPath), "utf8")),
  ];
  const files = new Map<string, string>();
  const covered = new Set<Block>();
  const carried = new Map<string, string>();
  const known = new Set(skills.map((skill) => skill.name));

  for (const skill of skills) {
    if (!/^[a-z]+(?:-[a-z]+)*$/.test(skill.name))
      fail(`${skill.name}: a name is lowercase words joined by "-"`);
    if (skill.description.length > limits.description) {
      fail(
        `${skill.name}: the description has ${skill.description.length} characters, over ${limits.description}`,
      );
    }
    for (const neighbor of skill.neighbors) {
      if (!known.has(neighbor.skill)) fail(`${skill.name}: neighbor ${neighbor.skill} is no skill`);
    }
    if (!skill.neighbors.some((neighbor) => skill.description.includes(neighbor.skill))) {
      fail(`${skill.name}: the description names none of its neighbors`);
    }
    problems.push(...unresolved(names, `${skill.name} description`, skill.description, true));

    const text = skillText(hub, skill, covered);
    const body = text.split("\n").length - 4;
    if (body > skill.budget)
      fail(`${skill.name}: SKILL.md has ${body} lines of body, over its budget of ${skill.budget}`);
    problems.push(...unresolved(names, `${skill.name}/SKILL.md`, text));
    files.set(`${skill.name}/SKILL.md`, text);

    const fileNames = new Set<string>();
    for (const reference of skill.references) {
      if (fileNames.has(reference.file))
        fail(`${skill.name}: two references are named ${reference.file}`);
      fileNames.add(reference.file);
      const page = pageOf(reference.page);
      const headings = reference.sections ?? page.sections.map((section) => section.heading);
      for (const heading of headings) {
        if (heading === "See also") continue;
        const key = `${reference.page}#${heading}`;
        const owner = carried.get(key);
        if (owner !== undefined)
          fail(`docs/public/${key} is carried by ${owner} and ${skill.name}`);
        carried.set(key, skill.name);
      }
      const reference_text = referenceText(skill, reference);
      const lines = reference_text.split("\n").length;
      if (lines > limits.reference) {
        fail(
          `${skill.name}/references/${reference.file} has ${lines} lines, over ${limits.reference}`,
        );
      }
      problems.push(
        ...unresolved(names, `${skill.name}/references/${reference.file}`, reference_text),
      );
      files.set(`${skill.name}/references/${reference.file}`, reference_text);
    }
  }

  for (const rule of hub.rules.values()) {
    for (const block of [rule.lead, ...rule.bullets]) {
      if (!covered.has(block))
        problems.push(
          `${hubPath} rule ${rule.number}: "${block.flat.slice(0, 60)}" is in no skill`,
        );
    }
  }
  for (const [heading, blocks] of hub.sections) {
    if (heading === "The rules") continue;
    for (const block of blocks) {
      if (!covered.has(block))
        problems.push(`${hubPath} "${heading}": "${block.flat.slice(0, 60)}" is in no skill`);
    }
  }
  for (const path of allPages()) {
    for (const section of pageOf(path).sections) {
      if (section.heading === "See also") continue;
      if (!carried.has(`${path}#${section.heading}`)) {
        problems.push(
          `docs/public/${path} "## ${section.heading || "(before the first heading)"}" is in no skill`,
        );
      }
    }
  }
  if (problems.length > 0) fail(`the skills do not build:\n${problems.join("\n")}`);
  return files;
}

/** The paths under `skills/` that differ from `files`, are missing, or are extra. */
export function differences(files: ReadonlyMap<string, string>): ReadonlyArray<string> {
  const onDisk = existsSync(skillsDir) ? listFiles(skillsDir) : [];
  const result: string[] = [];
  for (const [path, text] of files) {
    const file = join(skillsDir, path);
    if (!existsSync(file)) result.push(`${path} is missing`);
    else if (readFileSync(file, "utf8") !== text) result.push(`${path} differs`);
  }
  for (const path of onDisk) if (!files.has(path)) result.push(`${path} is extra`);
  return result;
}

function listFiles(directory: string, base = directory): ReadonlyArray<string> {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? listFiles(path, base) : [relative(base, path)];
  });
}

function main(): void {
  const files = buildSkills();
  if (process.argv.includes("--check")) {
    const found = differences(files);
    if (found.length > 0) {
      console.error(
        `[skills] skills/ is not what the build writes; run bun run skills:\n${found.join("\n")}`,
      );
      process.exit(1);
    }
    console.log(`[skills] ${files.size} files match`);
    return;
  }
  rmSync(skillsDir, { recursive: true, force: true });
  for (const [path, text] of files) {
    mkdirSync(dirname(join(skillsDir, path)), { recursive: true });
    writeFileSync(join(skillsDir, path), text);
  }
  console.log(`[skills] wrote ${files.size} files for ${skills.length} skills`);
}

if (import.meta.main) main();
