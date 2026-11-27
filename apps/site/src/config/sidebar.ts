/**
 * The sidebar is authored by hand in `nav.json`, in reading order. `scripts/sync-docs.ts` fails the
 * build when an entry names no page.
 */

import type { SidebarGroup } from "@frondruntime/site-kit/types";
import navData from "./nav.json";

export { docsPath } from "@frondruntime/site-kit/sidebar";

export const sidebar: ReadonlyArray<SidebarGroup> = navData.groups;
