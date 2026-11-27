import type { SiteIdentity } from "@frondruntime/site-kit/types";

export const siteName = "Pinna";
export const siteUrl = "https://pinna.frondruntime.dev";
export const siteDescription =
  "Pinna — reactive state that’s hard to get wrong. Synchronous state for domain models, built so the usual state bugs cannot happen and the rest fail where you, or your agent, can see them.";
export const projectRepositoryUrl = "https://github.com/frondruntime/pinna";

/** What every page's head says about the site (`BaseLayout` in `@frondruntime/site-kit`). */
export const site: SiteIdentity = {
  name: siteName,
  url: siteUrl,
  description: siteDescription,
  ogImageAlt: "Pinna — reactive state that’s hard to get wrong",
  repositoryUrl: projectRepositoryUrl,
  licenseUrl: "https://opensource.org/licenses/MIT",
  author: {
    name: "Roman Dubinin",
    url: "https://romanonthego.dev",
    id: "https://romanonthego.dev/#person",
    twitterHandle: "@romanonthego",
    sameAs: [
      "https://github.com/romanonthego",
      "https://x.com/romanonthego",
      "https://www.linkedin.com/in/romanonthego/",
    ],
  },
  // The publisher both Pinna's and Frond's sites name. The `@id` and its facts match Frond's site,
  // so the two graphs describe one organization.
  organization: {
    id: "https://frondruntime.dev/#organization",
    name: "Frond",
    url: "https://frondruntime.dev",
    profile: "https://github.com/frondruntime",
  },
};

/** What `/llms.txt`, `/llms-full.txt`, and each page's Markdown copy say about the site. */
export const llmsIntro =
  "Pinna is observable state for TypeScript and React, with Effect Schema or without it. Each link points to the Markdown source of a documentation page; the HTML page is at the same URL without `.md` (without `/index.md` for a section page).";
export const llmsFullIntro =
  "This file is generated mechanically from the Markdown source for the Pinna documentation.";
