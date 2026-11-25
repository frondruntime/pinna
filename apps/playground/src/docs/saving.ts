// The site's docs print the regions of this file (docs/public/guides/saving.md), so
// `bun run typecheck` compiles what the pages show.
import { Box, Computed, Model, Realm } from "@frondruntime/pinna";

// #region storage
interface SettingsStorage {
  readonly load: () => string | undefined;
  // Throws when the storage refuses the write, as a full localStorage does.
  readonly save: (text: string) => void;
}

const browserStorage: SettingsStorage = {
  load: () => localStorage.getItem("workspace") ?? undefined,
  save: (text) => localStorage.setItem("workspace", text),
};
// #endregion

// #region model
type Theme = "light" | "dark";

class Workspace extends Model.Class implements Disposable {
  readonly $theme = Box.make<Theme>(this.realm, "light");
  readonly $sidebarOpen = Box.make(this.realm, true);
  // Shown, never saved: a restart begins with nothing hovered.
  readonly $hovered = Box.make<string | undefined>(this.realm, undefined);
  readonly $storageError = Box.make<string | undefined>(this.realm, undefined);

  // The text to save, and nothing else: it never reads $hovered, so a write
  // to $hovered leaves it, and the watch below, untouched.
  private readonly $saved = Computed.make(this.realm, (read) =>
    JSON.stringify({ theme: read(this.$theme), sidebarOpen: read(this.$sidebarOpen) }),
  );

  private readonly storage: SettingsStorage;
  private readonly stopSaving: () => void;
  private queued = false;
  private lastSaved: string;

  constructor(realm: Realm, storage: SettingsStorage) {
    super(realm);
    this.storage = storage;
    // Restored before the watch starts, so restoring saves nothing back.
    this.restore();
    this.lastSaved = Realm.untracked(realm, (read) => read(this.$saved));
    this.stopSaving = Realm.watch(
      realm,
      (read) => read(this.$saved),
      () => {
        this.queue();
      },
    );
  }

  private restore() {
    const text = this.storage.load();
    if (text === undefined) return;
    let saved: { readonly theme?: unknown; readonly sidebarOpen?: unknown } | null;
    try {
      saved = JSON.parse(text);
    } catch {
      return; // a damaged save starts from the defaults
    }
    // Each field is taken only when it is valid, so one bad field keeps the rest.
    Realm.update(this.realm, (_read, write) => {
      if (saved?.theme === "light" || saved?.theme === "dark") write(this.$theme, saved.theme);
      if (typeof saved?.sidebarOpen === "boolean") write(this.$sidebarOpen, saved.sidebarOpen);
    });
  }

  // A burst of updates in one task queues one save, which reads the end state.
  private queue() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => this.flush());
  }

  flush() {
    if (!this.queued) return;
    this.queued = false;
    const text = Realm.untracked(this.realm, (read) => read(this.$saved));
    if (text === this.lastSaved) return; // the burst ended where it began
    try {
      this.storage.save(text);
      this.lastSaved = text;
      Realm.update(this.realm, (_read, write) => write(this.$storageError, undefined));
    } catch (error) {
      // Kept as state for the screen to show; the next change tries again.
      const message = error instanceof Error ? error.message : String(error);
      Realm.update(this.realm, (_read, write) => write(this.$storageError, message));
    }
  }

  [Symbol.dispose]() {
    this.stopSaving();
    this.flush(); // a save still queued is written now, not lost
  }
}
// #endregion

// #region start
const realm = Realm.make();
const workspace = new Workspace(realm, browserStorage);

// #endregion

export { type SettingsStorage, Workspace, workspace };
