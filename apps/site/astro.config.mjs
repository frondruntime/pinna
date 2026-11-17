import { rehypeHeadingIds, unified } from "@astrojs/markdown-remark";
import sitemap from "@astrojs/sitemap";
import { defineConfig, fontProviders } from "astro/config";
import { pinnaCodeTheme } from "./src/lib/pinnaCodeTheme.ts";
import { rehypeDocsChrome } from "./src/plugins/rehypeDocsChrome.ts";
import { remarkCallouts } from "./src/plugins/remarkCallouts.ts";
import { remarkDocsLinks } from "./src/plugins/remarkDocsLinks.ts";
import { remarkExampleLabels } from "./src/plugins/remarkExampleLabels.ts";
import { remarkMermaid } from "./src/plugins/remarkMermaid.ts";
import { remarkPageHead } from "./src/plugins/remarkPageHead.ts";

export default defineConfig({
  site: "https://pinna.frondruntime.dev",
  trailingSlash: "never",
  integrations: [sitemap()],
  // Downloaded at build time and served from the site's own origin.
  fonts: [
    {
      provider: fontProviders.google(),
      name: "IBM Plex Mono",
      cssVariable: "--font-plex-mono",
      weights: [400, 600, 700],
      styles: ["normal"],
      subsets: ["latin"],
      // While the font loads, the system's sans-like monospace, about as wide as Plex Mono. Astro's
      // optimized fallback measures against Courier New, whose slab serifs flash on every load.
      fallbacks: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      optimizedFallbacks: false,
    },
  ],
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
    // The corpus is authored to read correctly on GitHub and in a clone. These
    // five turn that source into the site: the page head out of the body,
    // repo-relative links into URLs, fence meta into labelled examples, mermaid
    // fences into SVG, and GitHub alert syntax into callouts.
    processor: unified({
      remarkPlugins: [
        remarkPageHead,
        remarkDocsLinks,
        remarkExampleLabels,
        remarkMermaid,
        remarkCallouts,
      ],
      // Heading ids first: rehypeDocsChrome links each heading to its id.
      rehypePlugins: [rehypeHeadingIds, rehypeDocsChrome],
    }),
    // Same theme landing uses via shiki's codeToHtml — keeps fenced
    // code in docs visually identical to hand-rendered blocks on /.
    shikiConfig: {
      theme: pinnaCodeTheme,
    },
  },
});
