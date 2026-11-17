/**
 * Rewrites the corpus's relative markdown links into site URLs.
 *
 * Pages link each other as `[models](../models/classes.md)` so they resolve
 * on GitHub, in an editor, and for an agent reading a clone. This plugin is the
 * one place an absolute `/docs/...` URL is allowed to come into existence.
 *
 * Links also reach *out* of `docs/public/` — into the package READMEs, source
 * files, and the rest of `docs/`. Those have no page to point at, so they
 * become GitHub blob URLs. Both cases are resolved against the repository
 * layout rather than the local filesystem, because the synced tree only
 * contains the pages.
 */

import type { Link, Root } from "mdast";
import { visit } from "unist-util-visit";
import type { VFile } from "vfile";

const REPO_BLOB = "https://github.com/frondruntime/pinna/blob/main";

/** Recovers `react/hooks` from the absolute path Astro hands the plugin. */
function slugFromFile(file: VFile): string | null {
  const path = file.path?.replace(/\\/g, "/");
  const match = path?.match(/\/src\/content\/docs\/(.+)\.mdx?$/);
  return match?.[1] ?? null;
}

/** Applies `..` and `.` segments without touching the filesystem. */
function normalize(segments: ReadonlyArray<string>): ReadonlyArray<string> {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out;
}

export function remarkDocsLinks() {
  return (tree: Root, file: VFile): void => {
    const slug = slugFromFile(file);
    if (slug === null) return;

    // Where this page sits in the repository, e.g. ["docs", "public", "react"].
    const pageDir = ["docs", "public", ...slug.split("/").slice(0, -1)];

    visit(tree, "link", (node: Link) => {
      const url = node.url;

      if (url.startsWith("/docs/")) {
        throw new Error(
          `${slug}.md links "${url}" absolutely. Docs pages link each other as ` +
            `relative .md paths so they resolve outside the site; the rewrite to ` +
            `/docs/... happens here and nowhere else.`,
        );
      }

      // Leave external links, mail, and pure anchors alone.
      if (/^[a-z]+:/i.test(url) || url.startsWith("#") || url.startsWith("/")) return;

      const [target, hash] = url.split("#");
      const resolved = normalize([...pageDir, ...(target ?? "").split("/")]);
      const path = resolved.join("/");
      const fragment = hash === undefined ? "" : `#${hash}`;

      if (path.startsWith("docs/public/") && path.endsWith(".md")) {
        // The glob loader gives `<section>/index.md` the id `<section>`.
        const slug = path.slice("docs/public/".length, -".md".length).replace(/\/index$/, "");
        node.url = `/docs/${slug}${fragment}`;
        return;
      }

      // Anything outside docs/ is repo content the site does not render.
      node.url = `${REPO_BLOB}/${path}${fragment}`;
    });
  };
}
