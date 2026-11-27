import { unified } from "@astrojs/markdown-remark";
import sitemap from "@astrojs/sitemap";
import { codeTheme } from "@frondruntime/site-kit/code-theme";
import { plexMono } from "@frondruntime/site-kit/fonts";
import { docsRehypePlugins, docsRemarkPlugins } from "@frondruntime/site-kit/plugins";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://pinna.frondruntime.dev",
  trailingSlash: "never",
  integrations: [sitemap()],
  // Downloaded at build time and served from the site's own origin.
  fonts: [plexMono],
  // Pinna's packages from their source, so the site needs no build of them. A
  // list here replaces Vite's own, so each repeats Vite's defaults after `source`.
  vite: {
    resolve: { conditions: ["source", "module", "browser", "development|production"] },
    ssr: {
      resolve: {
        conditions: ["source", "module", "node", "development|production"],
        externalConditions: ["source", "node"],
      },
    },
  },
  prefetch: {
    prefetchAll: true,
    defaultStrategy: "hover",
  },
  markdown: {
    // The corpus is authored to read correctly on GitHub and in a clone; the shared plugins turn
    // that source into the site (`@frondruntime/site-kit/plugins`).
    processor: unified({
      remarkPlugins: docsRemarkPlugins({
        corpusPath: "docs/public",
        repositoryBlob: "https://github.com/frondruntime/pinna/blob/main",
      }),
      rehypePlugins: docsRehypePlugins,
    }),
    // Same theme landing uses via shiki's codeToHtml — keeps fenced
    // code in docs visually identical to hand-rendered blocks on /.
    shikiConfig: {
      theme: codeTheme,
    },
  },
});
