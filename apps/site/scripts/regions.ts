/**
 * Pinna's samples folder, and `inlineRegions` from `@frondruntime/site-kit/regions` bound to it.
 * `scripts/sync-docs.ts` expands every page the site copies, and `scripts/skills/build.ts` at the
 * repository root every page a skill carries, so both print the code `bun run typecheck` compiles.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inlineRegions as inlineRegionsIn } from "@frondruntime/site-kit/regions";

export { RegionError } from "@frondruntime/site-kit/regions";

export const regionsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../playground/src/docs",
);

/** `text` with each region marker replaced by its region from Pinna's samples. */
export const inlineRegions = (page: string, text: string) =>
  inlineRegionsIn(page, text, regionsDir);
