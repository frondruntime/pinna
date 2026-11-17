import {
  box,
  collection,
  computed,
  computedFunction,
  Model,
  type Read,
  untracked,
  update,
  watch,
} from "@frondruntime/pinna";
import { decode, schemaBox } from "@frondruntime/pinna-effect";
import { Schema } from "effect";
import type { Workspace } from "./desk.ts";
import {
  checkWorkspace,
  type DroppedPart,
  LayoutData,
  readLayoutText,
  readSavedDesk,
  type WorkspaceData,
  type WorkspaceStore,
} from "./workspace-data.ts";

export const workspacesEqual = (left: WorkspaceData, right: WorkspaceData) =>
  left.positionsShown === right.positionsShown &&
  left.blotter.sort.column === right.blotter.sort.column &&
  left.blotter.sort.direction === right.blotter.sort.direction &&
  left.blotter.filter === right.blotter.filter &&
  left.blotter.scrollTop === right.blotter.scrollTop &&
  left.tiles.length === right.tiles.length &&
  left.tiles.every(
    (tile, index) =>
      tile.symbol === right.tiles[index]?.symbol && tile.notional === right.tiles[index]?.notional,
  );

export class Layouts extends Model implements Disposable {
  readonly $layouts = collection(this.realm, { keyOf: (layout: LayoutData) => layout.id });
  readonly $activeId = schemaBox(this.realm, Schema.NullOr(Schema.String), null);
  readonly $dropped = box<readonly DroppedPart[]>(this.realm, []);
  readonly $storageError = box<string | null>(this.realm, null);
  readonly $preview = box<{
    readonly workspace: WorkspaceData;
    readonly dropped: readonly DroppedPart[];
  } | null>(this.realm, null);
  readonly $snapshot = computed(this.realm, (read) => this.snapshot(read), {
    equals: workspacesEqual,
    name: "Layouts.snapshot",
  });
  readonly $modified = computed(
    this.realm,
    (read) => {
      const id = read(this.$activeId);
      const active = id === null ? undefined : read.row(this.$layouts, id);
      return active !== undefined && !workspacesEqual(active.workspace, read(this.$snapshot));
    },
    { name: "Layouts.modified" },
  );
  readonly $status = computedFunction(this.realm, (read, id: string) =>
    read(this.$activeId) === id ? (read(this.$modified) ? "modified" : "active") : "inactive",
  );
  private readonly $serialized = computed(this.realm, (read) =>
    JSON.stringify({
      version: 2,
      workspace: read(this.$snapshot),
      layouts: read(this.$layouts.rows),
      activeLayoutId: read(this.$activeId),
    }),
  );
  private readonly stopSaving: () => void;
  private queued = false;
  private disposed = false;
  private lastSaved = "";

  constructor(
    readonly workspace: Workspace,
    private readonly store?: WorkspaceStore,
  ) {
    super(workspace.realm);
    // Finish recovery and the entire apply before attaching any persistence observer.
    let stored: string | null = null;
    try {
      stored = store?.load() ?? null;
    } catch (error) {
      this.storageError(error);
    }
    const checked = readSavedDesk(stored, this.symbols);
    update(this.realm, (_read, write) => {
      this.apply(checked.data.workspace);
      write.replaceAll(
        this.$layouts,
        checked.data.layouts.map((layout) => decode(this.realm, LayoutData)(layout)),
      );
      write(this.$activeId, checked.data.activeLayoutId);
      write(this.$dropped, checked.dropped);
    });
    this.lastSaved = untracked(this.realm, (read) => read(this.$serialized));
    this.stopSaving = store
      ? watch(
          this.realm,
          (read) => read(this.$serialized),
          () => {
            if (this.queued) return;
            this.queued = true;
            queueMicrotask(() => {
              if (!this.disposed) this.flush();
            });
          },
        )
      : () => {};
  }
  private get symbols() {
    return this.workspace.tiles.map((tile) => tile.pair.symbol);
  }
  private snapshot(read: Read): WorkspaceData {
    const workspace = this.workspace;
    return {
      tiles: read(workspace.$openSymbols).map((symbol) => ({
        symbol,
        notional: read(workspace.tile(symbol).$notional),
      })),
      positionsShown: read(workspace.$panelShown),
      blotter: {
        sort: read(workspace.trades.$sort),
        filter: read(workspace.trades.$filter),
        scrollTop: read(workspace.trades.$scrollTop),
      },
    };
  }
  /** The caller has checked the entire snapshot. Existing tile objects always stay held. */
  private apply(next: WorkspaceData) {
    const workspace = this.workspace;
    update(this.realm, (read, write) => {
      const previous = read(workspace.$openSymbols);
      const symbols = next.tiles.map((tile) => tile.symbol);
      for (const tile of next.tiles) workspace.tile(tile.symbol).setNotional(tile.notional);
      if (
        previous.length !== symbols.length ||
        previous.some((symbol, index) => symbol !== symbols[index])
      )
        write(workspace.$openSymbols, symbols);
      workspace.showPositions(next.positionsShown);
      const sort = read(workspace.trades.$sort);
      if (
        sort.column !== next.blotter.sort.column ||
        sort.direction !== next.blotter.sort.direction
      )
        workspace.trades.setSort(next.blotter.sort);
      if (read(workspace.trades.$filter) !== next.blotter.filter)
        workspace.trades.setFilter(next.blotter.filter);
      workspace.trades.setScrollTop(next.blotter.scrollTop);
      // Use the ordinary close path; its watcher cancels work after this update succeeds.
      for (const symbol of previous) if (!symbols.includes(symbol)) workspace.closeTile(symbol);
    });
  }
  save(name: string): string {
    let identifier = "";
    update(this.realm, (read, write) => {
      const trimmed = this.uniqueName(name, read);
      let sequence = 1;
      while (read.row(this.$layouts, `layout-${sequence}`)) sequence++;
      identifier = `layout-${sequence}`;
      const checked = checkWorkspace(read(this.$snapshot), this.symbols);
      const layout = decode(
        this.realm,
        LayoutData,
      )({ id: identifier, name: trimmed, workspace: checked.workspace });
      write.upsert(this.$layouts, layout, { at: "end" });
      write(this.$activeId, identifier);
      write(this.$dropped, checked.dropped);
    });
    return identifier;
  }
  private uniqueName(name: string, read: Read, except?: string) {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Enter a layout name.");
    if (read(this.$layouts.rows).some((layout) => layout.id !== except && layout.name === trimmed))
      throw new Error("A layout with that name already exists.");
    return trimmed;
  }
  switchTo(id: string) {
    update(this.realm, (read, write) => {
      const layout = read.row(this.$layouts, id);
      if (!layout) throw new Error("Layout no longer exists.");
      this.apply(layout.workspace);
      write(this.$activeId, id);
    });
  }
  rename(id: string, name: string) {
    update(this.realm, (read, write) => {
      const layout = read.row(this.$layouts, id);
      if (!layout) throw new Error("Layout no longer exists.");
      const trimmed = this.uniqueName(name, read, id);
      if (layout.name !== trimmed)
        write.upsert(this.$layouts, decode(this.realm, LayoutData)({ ...layout, name: trimmed }));
    });
  }
  delete(id: string) {
    update(this.realm, (read, write) => {
      write.remove(this.$layouts, id);
      if (read(this.$activeId) === id) write(this.$activeId, null);
    });
  }
  copy(id: string) {
    return untracked(this.realm, (read) => {
      const layout = read.row(this.$layouts, id);
      if (!layout) throw new Error("Layout no longer exists.");
      return JSON.stringify({ version: 2, workspace: layout.workspace }, null, 2);
    });
  }
  preview(text: string) {
    const checked = readLayoutText(text, this.symbols);
    update(this.realm, (_read, write) => write(this.$preview, checked));
  }
  confirmPreview() {
    update(this.realm, (read, write) => {
      const preview = read(this.$preview);
      if (!preview) return;
      this.apply(preview.workspace);
      write(this.$activeId, null);
      write(this.$dropped, preview.dropped);
      write(this.$preview, null);
    });
  }
  cancelPreview() {
    update(this.realm, (_read, write) => write(this.$preview, null));
  }
  private storageError(error: unknown) {
    update(this.realm, (_read, write) =>
      write(this.$storageError, `Workspace storage failed: ${String(error)}`),
    );
  }
  flush() {
    if (!this.queued) return;
    this.queued = false;
    const text = untracked(this.realm, (read) => read(this.$serialized));
    if (text === this.lastSaved) return;
    try {
      this.store?.save(text);
      this.lastSaved = text;
      update(this.realm, (_read, write) => write(this.$storageError, null));
    } catch (error) {
      this.storageError(error);
    }
  }
  [Symbol.dispose]() {
    this.stopSaving();
    this.flush();
    this.disposed = true;
  }
}
