/**
 * The prose half of the API rename: inline code in Markdown and in
 * TypeScript comments, which `rename-api.ts` cannot reach through symbols.
 *
 *   bun scripts/codemod/rename-prose.ts           rewrites the files
 *   bun scripts/codemod/rename-prose.ts --check   writes nothing; exits 1 when
 *                                                 a run would change a file
 *
 * Inside a code span (`…`), a flat name from `names.ts` written as code
 * becomes its module member: the whole span (`box` becomes `Box.make`), a
 * call (`box(realm, 0)` becomes `Box.make(realm, 0)`), or a type with
 * arguments (`Options<Value>`). An article before it follows the new first
 * letter. A renamed module (`names.ts`, kind `"module"`) is renamed as the
 * whole span or before a member (`Programs.changes`). A span may run over
 * lines of a paragraph or a comment. A name
 * among words stays: `the box rejects this value` is a message,
 * `{ update, notify }` another library's options, `realm.update`,
 * `$box`, and `collection.row` are not the export. `Model` stays: in prose
 * it names the instance type, which keeps its name.
 *
 * What is left, and reported where it names a flat export:
 * - A line that names another library (MobX, alien-signals, Legend State,
 *   ...), where `computed` or `autorun` can be that library's; in a table
 *   whose header names one, that column alone.
 * - A fence not marked `ts` or `tsx`; a TypeScript fence is `rename-api.ts`'s.
 * - An error's message or code (`pinna: …`, `pinna/…`): the messages are
 *   renamed by hand, with the code that throws them.
 * - `packages/pinna-core`, whose graph has its own `watch` and `reconcile`,
 *   and `packages/pinna-bench`, which measures other libraries beside Pinna.
 * - The records of past decisions (`docs/api-redesign.md`, the research
 *   notes, a changelog), which keep the names they were written with.
 * In an `.astro` page's frontmatter, the site's copy lives in strings, so a
 * string's code spans are renamed as a comment's are, and a string that is
 * a flat name alone (a list of names) becomes its module member; a module's
 * name alone stays, as it is also a word of the copy ("Programs").
 *
 * - Markdown between `<!-- rename-prose: off -->` and
 *   `<!-- rename-prose: on -->`: a ruling that names the flat names on
 *   purpose, as ruling 62 in `docs/api.md` does.
 *
 * A second run changes nothing: a replacement starts with a module name,
 * which no flat name is.
 */

import { resolve } from "node:path";
import ts from "typescript";
import { renames } from "./names.ts";

const root = resolve(import.meta.dir, "../..");
const check = process.argv.includes("--check");

const historical = new Set([
  "docs/api-redesign.md",
  "docs/feature-gaps.md",
  "docs/reaction-schedulers.md",
  "docs/realm-dispose.md",
]);
const skippedDirectories = ["scripts/codemod/", "packages/pinna-core/", "packages/pinna-bench/"];

/** Each flat name and what it becomes; `Model` stays, as the instance type's name. */
const replacements = new Map<string, string>();
/** Each renamed module, which a member access (`Programs.changes`) also names. */
const modules = new Map<string, string>();
for (const rename of renames) {
  if (rename.kind === "module") {
    modules.set(rename.from, rename.to);
    replacements.set(rename.from, rename.to);
    replacements.set(`${rename.from}Module`, `${rename.to}Module`);
  } else if (rename.kind === "type") {
    replacements.set(rename.from, rename.to);
  } else if (rename.from !== rename.module) {
    replacements.set(rename.from, `${rename.module}.${rename.member}`);
  }
}
const names = [...replacements.keys()].sort((left, right) => right.length - left.length);
const foreign =
  /\b(?:MobX|mobx|alien|Legend|legend-state|Jotai|jotai|Recoil|Preact|preact|SolidJS|Solid's|Zustand|Valtio|Vue|Svelte|Redux)\b/;

/**
 * A flat name written as code in a span: the whole span (`box`), a call
 * (`box(realm, 0)`), or a type with arguments (`Options<Value>`). A name
 * among words (`the box rejects this value`, `{ update, notify }`) is prose,
 * a message, or another library's, and stays.
 */
const codeName = new RegExp(
  `(?<![\\w$./-])(${names.join("|")})(?=\\(|<|$)|(?<![\\w$./-])(${[...modules.keys()].join("|")})(?=\\.)`,
  "g",
);

/** A code span; one may run over lines inside a paragraph or a comment. */
const spans = /`[^`]+`/g;

/** An error's message or code keeps its text: it is what the code throws, renamed by hand. */
const isError = (span: string): boolean => /^`pinna(?:-effect)?[:/]/.test(span);

const renameSpan = (span: string): string =>
  isError(span)
    ? span
    : `\`${span.slice(1, -1).replace(codeName, (name: string) => replacements.get(name) ?? name)}\``;

/**
 * Rewrites the spans of a paragraph or a comment, and the article before
 * each. A span on a line that names another library is left and reported.
 */
const rewrite = (text: string, firstLine: number, path: string, report: Array<string>): string => {
  const lines = text.split("\n");
  const lineAt = (offset: number): number => text.slice(0, offset).split("\n").length - 1;
  const renamed = text.replace(spans, (span: string, offset: number) => {
    const next = renameSpan(span);
    if (next === span) {
      return span;
    }
    const touched = lines.slice(lineAt(offset), lineAt(offset + span.length) + 1);
    if (touched.some((line) => foreign.test(line))) {
      report.push(`${path}:${firstLine + lineAt(offset) + 1}: names another library`);
      return span;
    }
    return next;
  });
  return renamed
    .replace(
      /\b([Aa])n(\s+`(?:Box|Collection|Computed|Model|Program|Realm|Source|Stage)\.)/g,
      "$1$2",
    )
    .replace(/\b([Aa])(\s+`Atom\.)/g, "$1n$2");
};

const markdown = (text: string, path: string, report: Array<string>): string => {
  const lines = text.split("\n");
  const output: Array<string> = [];
  let fence: string | undefined;
  /** The columns of the open table whose header names another library. */
  let foreignColumns: ReadonlySet<number> | undefined;
  let paragraph: Array<string> = [];
  let paragraphStart = 0;
  /** Inside an off region: the lines stay as written. */
  let off = false;
  const flush = (): void => {
    if (paragraph.length > 0) {
      output.push(...rewrite(paragraph.join("\n"), paragraphStart, path, report).split("\n"));
      paragraph = [];
    }
  };
  lines.forEach((line, index) => {
    const marker = /^\s*<!-- rename-prose: (off|on) -->\s*$/.exec(line);
    if (marker !== null || off) {
      flush();
      if (marker !== null) {
        off = marker[1] === "off";
      }
      output.push(line);
      return;
    }
    const opened = /^\s*(```+|~~~+)(\w*)/.exec(line);
    if (opened !== null || fence !== undefined) {
      flush();
      if (opened !== null) {
        fence = fence === undefined ? (opened[2] ?? "") : undefined;
      } else if (
        !["ts", "tsx", "typescript"].includes(fence ?? "") &&
        new RegExp(codeName.source.replace("|$", "|\\b")).test(line)
      ) {
        // A TypeScript fence is `rename-api.ts`'s; another names a flat export for review.
        report.push(`${path}:${index + 1}: a fenced block names a flat export`);
      }
      output.push(line);
      return;
    }
    if (line.startsWith("|")) {
      flush();
      const cells = line.split("|");
      if (foreignColumns === undefined && /^\|\s*:?-{3}/.test(lines[index + 1] ?? "")) {
        foreignColumns = new Set(
          cells.flatMap((cell, column) => (foreign.test(cell) ? [column] : [])),
        );
        output.push(line);
        return;
      }
      const skip = foreignColumns ?? new Set<number>();
      output.push(
        cells
          .map((cell, column) => (skip.has(column) ? cell : rewrite(cell, index, path, report)))
          .join("|"),
      );
      return;
    }
    foreignColumns = undefined;
    if (line.trim() === "") {
      flush();
      output.push(line);
      return;
    }
    if (paragraph.length === 0) {
      paragraphStart = index;
    }
    paragraph.push(line);
  });
  flush();
  return output.join("\n");
};

/** Each comment of a TypeScript file, found through the parser, so a template or a regex never hides one. */
const typescript = (text: string, path: string, report: Array<string>): string => {
  const file = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    false,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found = new Map<number, number>();
  const collect = (ranges: ReadonlyArray<ts.CommentRange> | undefined): void => {
    for (const range of ranges ?? []) {
      found.set(range.pos, range.end);
    }
  };
  const visit = (node: ts.Node): void => {
    collect(ts.getLeadingCommentRanges(text, node.pos));
    collect(ts.getTrailingCommentRanges(text, node.end));
    ts.forEachChild(node, visit);
  };
  visit(file);
  collect(ts.getLeadingCommentRanges(text, file.endOfFileToken.pos));
  const comments = [...found].map(([start, end]) => ({ start, end }));
  comments.sort((left, right) => right.start - left.start);
  let result = text;
  for (const { start, end } of comments) {
    const firstLine = file.getLineAndCharacterOfPosition(start).line;
    const comment = rewrite(result.slice(start, end), firstLine, path, report);
    result = result.slice(0, start) + comment + result.slice(end);
  }
  return result;
};

/**
 * An `.astro` page: its frontmatter's comments as TypeScript's, and its
 * strings, where the site's copy lives.
 */
const astro = (text: string, path: string, report: Array<string>): string => {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (frontmatter === null) {
    return text;
  }
  const source = typescript(frontmatter[1] ?? "", path, report);
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const strings: Array<{ start: number; end: number; text: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const start = node.getStart(file) + 1;
      const end = node.getEnd() - 1;
      const inner = source.slice(start, end);
      const whole = modules.has(inner) ? undefined : replacements.get(inner);
      const firstLine = file.getLineAndCharacterOfPosition(start).line;
      const next = whole ?? rewrite(inner, firstLine + 1, path, report);
      if (next !== inner) {
        strings.push({ start, end, text: next });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  strings.sort((left, right) => right.start - left.start);
  let result = source;
  for (const { start, end, text: next } of strings) {
    result = result.slice(0, start) + next + result.slice(end);
  }
  return `---\n${result}\n---\n${text.slice(frontmatter[0].length)}`;
};

const listed = Bun.spawnSync(["git", "ls-files", "*.md", "*.ts", "*.tsx", "*.astro"], {
  cwd: root,
});
const files = new TextDecoder()
  .decode(listed.stdout)
  .split("\n")
  .filter(
    (path) =>
      path.length > 0 &&
      !historical.has(path) &&
      !skippedDirectories.some((directory) => path.startsWith(directory)) &&
      !/(^|\/)CHANGELOG\.md$/.test(path),
  );

const report: Array<string> = [];
const changed: Array<string> = [];
for (const path of files) {
  const full = resolve(root, path);
  const text = await Bun.file(full).text();
  const next = path.endsWith(".md")
    ? markdown(text, path, report)
    : path.endsWith(".astro")
      ? astro(text, path, report)
      : typescript(text, path, report);
  if (next !== text) {
    changed.push(path);
    if (!check) {
      await Bun.write(full, next);
    }
  }
}

console.log(`${changed.length} files ${check ? "would change" : "changed"}`);
for (const line of [...new Set(report)]) {
  console.log(`  review: ${line}`);
}
if (check && changed.length > 0) {
  process.exit(1);
}
