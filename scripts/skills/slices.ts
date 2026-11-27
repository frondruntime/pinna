/**
 * Cuts the texts a skill prints: the numbered rules and the closing sections
 * of `packages/pinna/AGENTS.md` (the hub), and the `## ` sections of a page
 * under `docs/public`. A part of a rule or a section is named by the opening
 * words of its block, which must be found exactly once, so a reworded bullet
 * fails the build instead of dropping out of a skill.
 */

/** A paragraph, a bullet with its continuation lines, a fenced block, or a table. */
export interface Block {
  /** The block's lines as the hub has them, indentation kept. */
  readonly text: string;
  /** The block's text with its bullet marker, indentation, and line breaks removed. */
  readonly flat: string;
}

/** A numbered rule: its lead (the text before its first bullet) and its bullets. */
export interface Rule {
  readonly number: number;
  readonly lead: Block;
  readonly bullets: ReadonlyArray<Block>;
}

export interface Hub {
  /** The first paragraph under the title: the packages and the import rule. */
  readonly intro: string;
  readonly rules: ReadonlyMap<number, Rule>;
  /** Each `## ` section after "The rules", by its heading. */
  readonly sections: ReadonlyMap<string, ReadonlyArray<Block>>;
}

/** A failure of a slice, a page, or a check; the message names what to fix. */
export class SkillsError extends Error {
  override readonly name = "SkillsError";
}

export function fail(message: string): never {
  throw new SkillsError(message);
}

const flatten = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim().replace(/^(?:\d+\.|-)\s+/, ""))
    .join(" ")
    .trim();

const block = (lines: ReadonlyArray<string>): Block => {
  const text = lines.join("\n").replace(/\s+$/, "");
  return { text, flat: flatten(text) };
};

/** Splits lines into blocks: blank lines, a bullet's start, a fence, or a table end one. */
function blocks(lines: ReadonlyArray<string>, bullet: RegExp): ReadonlyArray<Block> {
  const result: Block[] = [];
  let current: string[] = [];
  let fenced = false;
  const close = (): void => {
    if (current.some((line) => line.trim() !== "")) result.push(block(current));
    current = [];
  };
  for (const line of lines) {
    if (fenced) {
      current.push(line);
      if (line.trim().startsWith("```")) {
        fenced = false;
        close();
      }
      continue;
    }
    if (line.trim().startsWith("```")) {
      close();
      current.push(line);
      fenced = true;
      continue;
    }
    if (line.trim() === "") {
      close();
      continue;
    }
    const table = line.trim().startsWith("|");
    const previousTable = current.length > 0 && (current[0] ?? "").trim().startsWith("|");
    if (bullet.test(line) || table !== previousTable) close();
    current.push(line);
  }
  if (fenced) fail("a fenced block in the hub has no closing fence");
  close();
  return result;
}

const ruleStart = /^(\d+)\.\s/;
const ruleBullet = /^\s{3,4}- /;
const sectionBullet = /^- /;

export function parseHub(text: string): Hub {
  const lines = text.split("\n");
  const headings = lines.flatMap((line, index) => (line.startsWith("## ") ? [index] : []));
  const firstHeading = headings[0];
  if (firstHeading === undefined) fail("the hub has no ## section");
  const introLines = lines
    .slice(1, firstHeading)
    .join("\n")
    .trim()
    .split(/\n\s*\n/);
  const intro = introLines[0];
  if (intro === undefined || intro === "") fail("the hub has no first paragraph");

  const rules = new Map<number, Rule>();
  const sections = new Map<string, ReadonlyArray<Block>>();
  headings.forEach((start, position) => {
    const end = headings[position + 1] ?? lines.length;
    const heading = (lines[start] ?? "").slice(3).trim();
    const body = lines.slice(start + 1, end);
    if (heading !== "The rules") {
      sections.set(heading, blocks(body, sectionBullet));
      return;
    }
    const starts = body.flatMap((line, index) => (ruleStart.test(line) ? [index] : []));
    starts.forEach((ruleIndex, rulePosition) => {
      const ruleLines = body.slice(ruleIndex, starts[rulePosition + 1] ?? body.length);
      const number = Number(ruleStart.exec(ruleLines[0] ?? "")?.[1]);
      const firstBullet = ruleLines.findIndex((line) => ruleBullet.test(line));
      const leadLines = firstBullet === -1 ? ruleLines : ruleLines.slice(0, firstBullet);
      const bulletLines = firstBullet === -1 ? [] : ruleLines.slice(firstBullet);
      rules.set(number, {
        number,
        lead: block(leadLines),
        bullets: blocks(bulletLines, ruleBullet),
      });
    });
  });
  return { intro, rules, sections };
}

/**
 * The blocks `openings` name, in the hub's order. Each opening must start
 * exactly one block; with `omit`, every block but the ones named.
 */
export function pick(
  where: string,
  all: ReadonlyArray<Block>,
  options: { readonly parts?: ReadonlyArray<string>; readonly omit?: ReadonlyArray<string> },
): ReadonlyArray<Block> {
  const find = (opening: string): Block => {
    const found = all.filter((candidate) => candidate.flat.startsWith(opening));
    if (found.length !== 1) {
      fail(`${where}: "${opening}" opens ${found.length} blocks; name one block by its opening`);
    }
    return found[0] as Block;
  };
  if (options.parts !== undefined) {
    const chosen = new Set(options.parts.map(find));
    return all.filter((candidate) => chosen.has(candidate));
  }
  const omitted = new Set((options.omit ?? []).map(find));
  return all.filter((candidate) => !omitted.has(candidate));
}

/** A page of `docs/public`: its frontmatter and its `## ` sections. */
export interface Page {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  /** The text before the first `## ` heading, under the heading "". */
  readonly sections: ReadonlyArray<{ readonly heading: string; readonly text: string }>;
}

export function parsePage(path: string, text: string): Page {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (match === null) fail(`${path}: no frontmatter`);
  const field = (name: string): string => {
    const line = (match[1] ?? "").split("\n").find((entry) => entry.startsWith(`${name}:`));
    if (line === undefined) fail(`${path}: frontmatter has no ${name}`);
    return line
      .slice(name.length + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
  };
  const lines = text.slice(match[0].length).split("\n");
  const sections: { heading: string; text: string }[] = [];
  let heading = "";
  let current: string[] = [];
  let fenced = false;
  for (const line of lines) {
    if (line.trim().startsWith("```")) fenced = !fenced;
    if (!fenced && line.startsWith("## ")) {
      sections.push({ heading, text: current.join("\n").trim() });
      heading = line.slice(3).trim();
      current = [line];
      continue;
    }
    current.push(line);
  }
  sections.push({ heading, text: current.join("\n").trim() });
  return {
    path,
    title: field("title"),
    description: field("description"),
    sections: sections.filter((section) => section.text !== ""),
  };
}
