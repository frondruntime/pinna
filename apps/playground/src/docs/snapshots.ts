// The site's docs print the regions of this file (docs/public/state/snapshots.md),
// so `bun run typecheck` compiles what the page shows.
import { Box, Collection, Computed, Realm, type Snapshot, Stage } from "@frondruntime/pinna";

// #region shape
interface Tab {
  readonly id: string;
  readonly title: string;
}

const realm = Realm.make();
const $theme = Box.make<"light" | "dark">(realm, "light");
const $sidebarOpen = Box.make(realm, true);
// Shown on screen, never saved: it is not in the shape.
const $hovered = Box.make<string | undefined>(realm, undefined);
const tabs = Collection.make(realm, { keyOf: (tab: Tab) => tab.id });

// The keys are the snapshot's keys: renaming a box leaves saved data as it was.
const workspace = { theme: $theme, sidebar: { open: $sidebarOpen }, tabs };
// #endregion

// #region snapshot
const saved: Snapshot<typeof workspace> = Realm.untracked(realm, (read) =>
  read.snapshot(workspace),
);
// { theme: "light", sidebar: { open: true }, tabs: [] }
// #endregion

// #region restore
const restore = (data: Snapshot<typeof workspace>): void => {
  Realm.update(realm, (_read, write) => {
    // Every box and row lands, or none: a throw puts the restore back.
    write.restore(workspace, data);
  });
};
// #endregion

// #region live
// Recomputes on any write under the shape, and on none outside it.
const $text = Computed.make(realm, (read) => JSON.stringify(read.snapshot(workspace)));
// #endregion

// #region preview
const preview = (stage: Stage): Snapshot<typeof workspace> =>
  Stage.read(stage, (read) => read.snapshot(workspace));

// #endregion

export { $hovered, $text, preview, restore, saved };
