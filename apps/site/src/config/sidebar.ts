/**
 * The sidebar is authored by hand in `nav.json`, in reading order.
 * `scripts/sync-docs.ts` fails the build when an entry names no page.
 *
 * This module is a loader plus the three helpers `DocsLayout.astro` consumes.
 */

import navData from "./nav.json";

export type SidebarItem = {
  readonly label: string;
  readonly slug: string;
};

export type SidebarGroup = {
  readonly label: string;
  readonly items: ReadonlyArray<SidebarItem>;
};

export const sidebar: ReadonlyArray<SidebarGroup> = navData.groups;

export function flatSidebarItems(): ReadonlyArray<SidebarItem> {
  return sidebar.flatMap((g) => g.items);
}

export function docsPath(slug: string): string {
  return `/docs/${slug}`;
}

export function getPagination(slug: string): {
  prev: SidebarItem | null;
  next: SidebarItem | null;
} {
  const items = flatSidebarItems();
  const idx = items.findIndex((item) => item.slug === slug);
  return {
    prev: idx > 0 ? (items[idx - 1] ?? null) : null,
    next: idx < items.length - 1 ? (items[idx + 1] ?? null) : null,
  };
}
