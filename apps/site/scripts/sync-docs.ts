/**
 * Copies the public documentation corpus from `docs/public/` in this repository into
 * `src/content/docs/`, where Astro's content collection can see it, expanding every
 * `<!-- region file#name -->` marker into that region of a sample under
 * `apps/playground/src/docs/`, which `bun run typecheck` compiles. `syncDocs` in
 * `@frondruntime/site-kit/sync` does the copy and its checks: a marker that names no region, a
 * sidebar entry with no page, or an empty corpus fails the sync.
 *
 * `docs/public/` is the only writer. Nothing here edits docs; a page that is wrong is wrong there.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SyncError, syncDocs } from "@frondruntime/site-kit/sync";
import { regionsDir } from "./regions";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = resolve(appRoot, "../../docs/public");

console.log(`[sync-docs] source: ${docsDir}`);
try {
  const { pages, regions } = syncDocs({
    corpus: docsDir,
    content: join(appRoot, "src/content/docs"),
    nav: join(appRoot, "src/config/nav.json"),
    samples: regionsDir,
  });
  console.log(
    `[sync-docs] copied ${pages} pages into src/content/docs, inlining ${regions} regions`,
  );
} catch (error) {
  if (!(error instanceof SyncError)) throw error;
  console.error(`[sync-docs] ${error.message}`);
  process.exit(1);
}
