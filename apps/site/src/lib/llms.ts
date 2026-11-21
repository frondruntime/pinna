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

export function textResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

// The dev server sends this type; a static build drops it, and the host types the file by its
// extension (`vercel.json` names text/markdown for `.md`).
export function markdownResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}

/**
 * Where a docs page's Markdown copy is served, mirroring `docs/public`: `effect/boxes.md` at
 * `/docs/effect/boxes.md`, and the section page `start/index.md` at `/docs/start/index.md`, as the
 * llms.txt proposal names a copy of a URL without a file name. The corpus links its pages as
 * relative `.md` paths, so every link in a copy resolves as written.
 */
export function markdownPath(slug: string): string {
  return rawDocs[`../content/docs/${slug}/index.md`] === undefined
    ? `/docs/${slug}.md`
    : `/docs/${slug}/index.md`;
}

/** A page's Markdown copy: its title and description, then its source body. */
export async function renderMarkdownPages(): Promise<
  ReadonlyArray<{ readonly path: string; readonly body: string }>
> {
  const docs = await getOrderedDocs();
  return docs.map((doc) => ({
    path: markdownPath(doc.slug),
    body: `${[`# ${doc.title}`, "", doc.description ? `> ${doc.description}` : "", "", doc.body]
      .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
      .join("\n")
      .trim()}\n`,
  }));
}

export async function renderLlmsIndex(): Promise<string> {
  const docs = await getOrderedDocs();
  const bySlug = new Map(docs.map((doc) => [doc.slug, doc]));
  const lines: string[] = [
    `# ${siteName}`,
    "",
    `> ${siteDescription}`,
    "",
    "Pinna is observable state for TypeScript and React, with Effect Schema or without it. Each link points to the Markdown source of a documentation page; the HTML page is at the same URL without `.md` (without `/index.md` for a section page).",
  ];

  for (const group of sidebar) {
    const groupDocs = group.items.flatMap((item) => bySlug.get(item.slug) ?? []);
    if (groupDocs.length === 0) continue;
    lines.push("", `## ${group.label}`, "");
    for (const doc of groupDocs) {
      lines.push(`- [${doc.title}](${siteUrl}${markdownPath(doc.slug)}): ${doc.description}`);
    }
  }

  lines.push(
    "",
    "## Optional",
    "",
    `- [Full documentation](${siteUrl}/llms-full.txt): Every page above, concatenated into one file.`,
  );

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
