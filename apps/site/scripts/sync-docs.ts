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
 * which `bun run typecheck` compiles; `scripts/regions.ts` expands each
 * `<!-- region file#name -->` marker into that region, so the site and
 * `llms-full.txt` print code that compiles. A marker that names no region
 * fails the sync.
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inlineRegions, RegionError } from "./regions";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const contentTarget = join(appRoot, "src/content/docs");
const navPath = join(appRoot, "src/config/nav.json");
const docsDir = resolve(appRoot, "../../docs/public");

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

let regions = 0;

function inlinePage(page: string): { readonly text: string; readonly count: number } {
  try {
    return inlineRegions(page, readFileSync(page, "utf8"));
  } catch (error) {
    if (error instanceof RegionError) fail(error.message);
    throw error;
  }
}

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

    const inlined = inlinePage(src);
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
