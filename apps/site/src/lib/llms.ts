import { type CollectionEntry, getCollection } from "astro:content";
import { docsPath, flatSidebarItems, sidebar } from "../config/sidebar";
import { siteDescription, siteName, siteUrl } from "./siteMetadata";

// Compile-time glob: Vite resolves this literal statically, which is the reason
// `sync-docs.ts` physically copies the corpus here rather than pointing the
// content collection somewhere else.
const rawDocs = import.meta.glob<string>("../content/docs/**/*.md", {
  eager: true,
  import: "default",
  query: "?raw",
});

type DocEntry = CollectionEntry<"docs">;

type LlmsDoc = {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly url: string;
  readonly body: string;
};

const contentType = "text/plain; charset=utf-8";

export function textResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
    },
  });
}

export async function renderLlmsIndex(): Promise<string> {
  const docs = await getOrderedDocs();
  const bySlug = new Map(docs.map((doc) => [doc.slug, doc]));
  const lines: string[] = [
    `# ${siteName}`,
    "",
    `> ${siteDescription}`,
    "",
    "Pinna is observable state for TypeScript and React, with Effect Schema or without it. These links point to the canonical documentation pages.",
    "",
    "## Full context",
    "",
    `- [Full documentation](${siteUrl}/llms-full.txt): Complete Markdown documentation concatenated into one plain-text file.`,
    "",
    "## Documentation",
  ];

  for (const group of sidebar) {
    const groupDocs = group.items.flatMap((item) => bySlug.get(item.slug) ?? []);
    if (groupDocs.length === 0) continue;
    lines.push("", `### ${group.label}`);
    for (const doc of groupDocs) {
      lines.push(`- [${doc.title}](${doc.url}): ${doc.description}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export async function renderLlmsFull(): Promise<string> {
  const docs = await getOrderedDocs();
  const pages = docs.map((doc) =>
    [
      `# ${doc.title}`,
      "",
      `URL: ${doc.url}`,
      doc.description ? `Description: ${doc.description}` : "",
      "",
      doc.body,
    ]
      .filter(Boolean)
      .join("\n")
      .trim(),
  );

  return `${[
    `# ${siteName} Documentation`,
    "",
    `> ${siteDescription}`,
    "",
    "This file is generated mechanically from the Markdown source for the Pinna documentation.",
    "",
    ...pages.flatMap((page) => ["---", "", page, ""]),
  ]
    .join("\n")
    .trimEnd()}\n`;
}

async function getOrderedDocs(): Promise<ReadonlyArray<LlmsDoc>> {
  const entries = (await getCollection("docs")).filter((entry) => entry.data.draft !== true);
  const entriesBySlug = new Map(entries.map((entry) => [entry.id, entry]));
  const sidebarSlugs = flatSidebarItems().map((item) => item.slug);
  const sidebarSlugSet = new Set(sidebarSlugs);
  const orderedEntries = [
    ...sidebarSlugs.map((slug) => entriesBySlug.get(slug)).filter(isEntry),
    ...entries
      .filter((entry) => !sidebarSlugSet.has(entry.id))
      .sort((a, b) => a.id.localeCompare(b.id)),
  ];

  return orderedEntries.map((entry) => ({
    slug: entry.id,
    title: entry.data.title,
    description: entry.data.description ?? "",
    url: `${siteUrl}${docsPath(entry.id)}`,
    body: getSourceBody(entry.id),
  }));
}

function getSourceBody(slug: string): string {
  // The glob loader gives `<section>/index.md` the id `<section>`.
  const raw = rawDocs[`../content/docs/${slug}.md`] ?? rawDocs[`../content/docs/${slug}/index.md`];
  if (raw === undefined) {
    // The collection knows about this page, so a miss here means the raw glob
    // and the collection disagree — a silently truncated llms-full.txt is the
    // one failure nobody notices, so it is fatal instead.
    throw new Error(`llms: no raw source for "${slug}". Did sync-docs run?`);
  }
  return stripFrontmatter(raw).trim();
}

function stripFrontmatter(source: string): string {
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function isEntry(entry: DocEntry | undefined): entry is DocEntry {
  return Boolean(entry);
}
