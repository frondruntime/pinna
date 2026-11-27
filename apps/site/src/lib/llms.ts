/**
 * Pinna's agent files, rendered by `@frondruntime/site-kit/llms` from the docs collection: the
 * routes `llms.txt`, `llms-full.txt`, and `docs/[...path].md` call these.
 */

import { getCollection } from "astro:content";
import * as llms from "@frondruntime/site-kit/llms";
import { sidebar } from "../config/sidebar";
import { llmsFullIntro, llmsIntro, siteDescription, siteName, siteUrl } from "./siteMetadata";

export { markdownResponse, textResponse } from "@frondruntime/site-kit/llms";

const site: llms.LlmsSite = {
  name: siteName,
  url: siteUrl,
  description: siteDescription,
  intro: llmsIntro,
  fullIntro: llmsFullIntro,
  sidebar,
};

export const renderMarkdownPages = async () =>
  llms.renderMarkdownPages(site, await getCollection("docs"));

export const renderLlmsIndex = async () => llms.renderLlmsIndex(site, await getCollection("docs"));

export const renderLlmsFull = async () => llms.renderLlmsFull(site, await getCollection("docs"));
