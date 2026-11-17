/**
 * Copies the public documentation corpus from `docs/public/` in this
 * repository into `src/content/docs/`, where Astro's content collection can
 * see it.
 *
 * Why a copy rather than a pointer: `src/lib/llms.ts` reads page bodies through
 * `import.meta.glob("../content/docs/**")`, which Vite resolves at *compile*
 * time from the literal. Repointing the collection's `base` would fix the
 * rendered pages and silently leave `llms-full.txt` empty. And a symlink is
 * worse than either — Astro's glob loader computes `posixRelative(base, changed)`
 * against chokidar's real path, so HMR stops firing with no error at all.
 *
 * `docs/public/` is the only writer. Nothing here edits docs; a page that is
 * wrong is wrong there.
 *
 * Every code example is a region of a sample under `apps/playground/src/docs/`,
 * which `bun run typecheck` compiles. A page names one on a line of its own:
 *
 *     <!-- region start.tsx#node -->
 *
 * and the copy carries that region in a fenced block in its place, so the
 * site and `llms-full.txt` print code that compiles. The region is the lines
 * between `// #region node` and the next `// #endregion`, dedented, without
 * `@ts-expect-error` lines, under the imports of its file it uses (`src/lib/sampleImports.ts`,
 * AGENTS.md rule 9). An unknown file or region, or a marker that does
 * not parse, fails the sync.
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
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withImports } from "../src/lib/sampleImports";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const contentTarget = join(appRoot, "src/content/docs");
const navPath = join(appRoot, "src/config/nav.json");
const docsDir = resolve(appRoot, "../../docs/public");
const regionsDir = resolve(appRoot, "../playground/src/docs");

const markerStart = "<!-- region";
const marker = /^<!-- region ([\w./-]+)#([\w-]+) -->$/;
const fenceLanguages: Readonly<Record<string, string>> = { ".ts": "ts", ".tsx": "tsx" };

/**
 * A page is exactly `docs/public/<section>/<name>.md`. Top-level files such as
 * `README.md` are folder meta, not pages, so only section directories are
 * copied.
 */
function isSectionDir(name: string): boolean {
  return !name.startsWith("_") && !name.startsWith(".");
}

function isSectionDirEntry(parent: string): (name: string) => boolean {
  return (name) => isSectionDir(name) && statSync(join(parent, name)).isDirectory();
}

function log(message: string): void {
  console.log(`[sync-docs] ${message}`);
}

function fail(message: string): never {
  console.error(`[sync-docs] ${message}`);
  process.exit(1);
}

const sources = new Map<string, string>();

function sourceOf(page: string, file: string): string {
  const path = resolve(regionsDir, file);
  if (relative(regionsDir, path).startsWith("..")) {
    fail(`${page}: region file ${file} is outside ${regionsDir}`);
  }
  const cached = sources.get(path);
  if (cached !== undefined) return cached;
  if (!existsSync(path)) {
    fail(`${page}: region file ${file} does not exist in ${regionsDir}`);
  }
  const source = readFileSync(path, "utf8");
  sources.set(path, source);
  return source;
}

/** The lines of `// #region <name>` in `file`, dedented, as a fenced block. */
function region(page: string, file: string, name: string): string {
  const language = fenceLanguages[extname(file)];
  if (language === undefined) {
    fail(`${page}: region file ${file} is not a .ts or .tsx sample`);
  }
  const lines = sourceOf(page, file).split("\n");
  const opens = lines.flatMap((line, index) =>
    line.trim() === `// #region ${name}` ? [index] : [],
  );
  const start = opens[0];
  if (start === undefined) {
    fail(`${page}: ${file} has no region "${name}"`);
  }
  if (opens.length > 1) {
    fail(`${page}: ${file} declares region "${name}" ${opens.length} times`);
  }
  const end = lines.findIndex((line, index) => index > start && line.trim() === "// #endregion");
  if (end === -1) {
    fail(`${page}: region "${name}" in ${file} has no // #endregion`);
  }
  const body = lines.slice(start + 1, end).filter((line) => !line.includes("@ts-expect-error"));
  if (body.some((line) => line.trim().startsWith("// #region"))) {
    fail(`${page}: region "${name}" in ${file} contains another region`);
  }
  const filled = body.filter((line) => line.trim() !== "");
  if (filled.length === 0) {
    fail(`${page}: region "${name}" in ${file} is empty`);
  }
  // A region inside a declaration prints from its own indentation, not the file's.
  const indent = Math.min(...filled.map((line) => line.search(/\S/)));
  const code = withImports(
    sourceOf(page, file),
    body
      .map((line) => line.slice(indent))
      .join("\n")
      .trim(),
  );
  return `\`\`\`${language}\n${code}\n\`\`\``;
}

/** `text` with each region marker replaced by its region, and how many it replaced. */
function inlineRegions(
  page: string,
  text: string,
): { readonly text: string; readonly count: number } {
  let count = 0;
  const lines = text.split("\n").map((line) => {
    if (!line.trim().startsWith(markerStart)) return line;
    const match = marker.exec(line.trim());
    if (match === null) {
      fail(
        `${page}: malformed region marker "${line.trim()}"; write <!-- region <file>#<name> -->`,
      );
    }
    count += 1;
    return region(page, match[1] ?? "", match[2] ?? "");
  });
  return { text: lines.join("\n"), count };
}

let regions = 0;

function copyTree(from: string, to: string): number {
  mkdirSync(to, { recursive: true });
  let pages = 0;

  for (const name of readdirSync(from)) {
    if (name.startsWith(".")) continue;
    const src = join(from, name);
    const dest = join(to, name);

    if (statSync(src).isDirectory()) {
      pages += copyTree(src, dest);
      continue;
    }
    if (!name.endsWith(".md") && !name.endsWith(".mdx")) continue;

    const inlined = inlineRegions(src, readFileSync(src, "utf8"));
    writeFileSync(dest, inlined.text);
    regions += inlined.count;
    pages += 1;
  }

  return pages;
}

function navSlugs(navPath: string): ReadonlyArray<string> {
  const nav = JSON.parse(readFileSync(navPath, "utf8")) as {
    groups: ReadonlyArray<{ items: ReadonlyArray<{ slug: string }> }>;
  };
  return nav.groups.flatMap((group) => group.items.map((item) => item.slug));
}

function main(): void {
  if (!existsSync(docsDir)) {
    fail(`${docsDir} is missing — the corpus has no source.`);
  }
  log(`source: ${docsDir}`);

  rmSync(contentTarget, { recursive: true, force: true });
  mkdirSync(contentTarget, { recursive: true });

  let pages = 0;
  for (const name of readdirSync(docsDir).filter(isSectionDirEntry(docsDir))) {
    pages += copyTree(join(docsDir, name), join(contentTarget, name));
  }

  // A sync that copies nothing is the failure mode worth spending a guard on:
  // every downstream step succeeds and the deploy is a green, empty site.
  if (pages === 0) {
    fail(`copied 0 pages from ${docsDir}. Refusing to build an empty site.`);
  }

  // Every sidebar entry must have landed. Deliberately one-directional: the
  // sidebar lists only the pages the site shows, so a copied page absent from
  // it is not an error. Here we only prove the sidebar has no dead links.
  // A slug names `<slug>.md` or, for a section index, `<slug>/index.md`.
  const missing = navSlugs(navPath).filter(
    (slug) =>
      !existsSync(join(contentTarget, `${slug}.md`)) &&
      !existsSync(join(contentTarget, slug, "index.md")),
  );
  if (missing.length > 0) {
    fail(`nav.json lists ${missing.length} slug(s) with no page: ${missing.join(", ")}`);
  }

  log(`copied ${pages} pages into src/content/docs, inlining ${regions} regions`);
}

main();
