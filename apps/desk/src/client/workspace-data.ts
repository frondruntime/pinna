import { Schema } from "effect";
import { Position, SortSchema } from "./trades.ts";
import { PairSymbol, PositiveDecimal } from "./wire.ts";

export const defaultNotional = "1000000";
export const WorkspaceData = Schema.Struct({
  tiles: Schema.Array(Schema.Struct({ symbol: PairSymbol, notional: PositiveDecimal })),
  positionsShown: Schema.Boolean,
  blotter: Schema.Struct({ sort: SortSchema, filter: Schema.String, scrollTop: Position }),
});
export type WorkspaceData = typeof WorkspaceData.Type;
export const LayoutData = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^\S+$/)),
  name: Schema.String.check(Schema.makeFilter((value) => value.trim().length > 0)),
  workspace: WorkspaceData,
});
export type LayoutData = typeof LayoutData.Type;
export interface DroppedPart {
  readonly path: string;
  readonly reason: string;
}
export interface SavedDesk {
  readonly version: 2;
  readonly workspace: WorkspaceData;
  readonly layouts: readonly LayoutData[];
  readonly activeLayoutId: string | null;
}
export interface CheckedDesk {
  readonly data: SavedDesk;
  readonly dropped: readonly DroppedPart[];
}

export const defaultWorkspace = (symbols: readonly PairSymbol[]): WorkspaceData => ({
  tiles: symbols.map((symbol) => ({ symbol, notional: defaultNotional })),
  positionsShown: true,
  blotter: { sort: { column: "time", direction: "descending" }, filter: "", scrollTop: 0 },
});

/** Recovery is per field and per row. A whole-document decode would lose good neighbors. */
class Recovery {
  readonly dropped: DroppedPart[] = [];
  constructor(readonly symbols: readonly PairSymbol[]) {}
  drop(path: string, reason: string) {
    this.dropped.push({ path, reason });
  }
  field<S extends Schema.Top>(
    schema: S,
    value: unknown,
    fallback: S["Type"],
    path: string,
    reason: string,
  ): S["Type"] {
    if (Schema.is(schema)(value)) return value;
    this.drop(path, reason);
    return fallback;
  }
  object<Key extends string>(
    value: unknown,
    path: string,
    keys: readonly Key[],
    fallback = "used defaults",
  ): Partial<Record<Key, unknown>> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.drop(path, `expected an object; ${fallback}`);
      return undefined;
    }
    for (const key of Object.keys(value)) {
      if (!(keys as readonly string[]).includes(key))
        this.drop(`${path}.${key}`, "unknown field; ignored");
    }
    return value as Partial<Record<Key, unknown>>;
  }
  workspace(value: unknown, path: string): WorkspaceData {
    const defaults = defaultWorkspace(this.symbols);
    const input = this.object(value, path, ["tiles", "positionsShown", "blotter"]);
    if (!input) return defaults;
    const tiles: WorkspaceData["tiles"][number][] = [];
    if (!Array.isArray(input.tiles)) {
      this.drop(`${path}.tiles`, "expected an array; used default tiles");
      tiles.push(...defaults.tiles);
    } else {
      const seen = new Set<string>();
      input.tiles.forEach((value: unknown, index: number) => {
        const tilePath = `${path}.tiles[${index}]`;
        const tile = this.object(value, tilePath, ["symbol", "notional"], "dropped tile");
        if (!tile) return;
        if (!Schema.is(PairSymbol)(tile.symbol) || !this.symbols.includes(tile.symbol)) {
          this.drop(`${tilePath}.symbol`, "pair is not listed; dropped tile");
          return;
        }
        if (seen.has(tile.symbol)) {
          this.drop(`${tilePath}.symbol`, "duplicate pair; dropped tile");
          return;
        }
        seen.add(tile.symbol);
        tiles.push({
          symbol: tile.symbol,
          notional: this.field(
            PositiveDecimal,
            tile.notional,
            defaultNotional,
            `${tilePath}.notional`,
            "expected a positive decimal string; used default notional",
          ),
        });
      });
    }
    const blotter = this.object(input.blotter, `${path}.blotter`, ["sort", "filter", "scrollTop"]);
    const sort =
      blotter && this.object(blotter.sort, `${path}.blotter.sort`, ["column", "direction"]);
    return {
      tiles,
      positionsShown: this.field(
        Schema.Boolean,
        input.positionsShown,
        true,
        `${path}.positionsShown`,
        "expected a boolean; used default visibility",
      ),
      blotter: {
        sort: sort
          ? {
              column: this.field(
                SortSchema.fields.column,
                sort.column,
                defaults.blotter.sort.column,
                `${path}.blotter.sort.column`,
                "unknown sort column; used default column",
              ),
              direction: this.field(
                SortSchema.fields.direction,
                sort.direction,
                defaults.blotter.sort.direction,
                `${path}.blotter.sort.direction`,
                "unknown sort direction; used default direction",
              ),
            }
          : defaults.blotter.sort,
        filter: blotter
          ? this.field(
              Schema.String,
              blotter.filter,
              "",
              `${path}.blotter.filter`,
              "expected text; used empty filter",
            )
          : "",
        scrollTop: blotter
          ? this.field(
              Position,
              blotter.scrollTop,
              0,
              `${path}.blotter.scrollTop`,
              "expected a finite nonnegative number; used zero",
            )
          : 0,
      },
    };
  }
}

export function checkWorkspace(
  value: unknown,
  symbols: readonly PairSymbol[],
  path = "$.workspace",
) {
  const recovery = new Recovery(symbols);
  return { workspace: recovery.workspace(value, path), dropped: recovery.dropped };
}

export function readSavedDesk(text: string | null, symbols: readonly PairSymbol[]): CheckedDesk {
  const recovery = new Recovery(symbols);
  const data: SavedDesk = {
    version: 2,
    workspace: defaultWorkspace(symbols),
    layouts: [],
    activeLayoutId: null,
  };
  if (text === null) return { data, dropped: [] };
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return { data, dropped: [{ path: "$", reason: "invalid JSON; used default workspace" }] };
  }
  // Version 1 was only open pair names, with slashes. Accept its bare-array export too.
  if (
    Array.isArray(input) ||
    (typeof input === "object" && input !== null && "version" in input && input.version === 1)
  ) {
    const legacy = Array.isArray(input)
      ? input
      : (input as { readonly openTiles?: unknown; readonly tiles?: unknown });
    const values: unknown = Array.isArray(legacy) ? legacy : (legacy.openTiles ?? legacy.tiles);
    const path = Array.isArray(legacy)
      ? "$"
      : legacy.openTiles !== undefined
        ? "$.openTiles"
        : "$.tiles";
    if (!Array.isArray(values)) recovery.drop(path, "expected an array; used default tiles");
    else {
      const tiles: WorkspaceData["tiles"][number][] = [];
      const seen = new Set<string>();
      values.forEach((value: unknown, index: number) => {
        const symbol = typeof value === "string" ? value.replace("/", "") : value;
        if (!Schema.is(PairSymbol)(symbol) || !symbols.includes(symbol))
          recovery.drop(`${path}[${index}]`, "pair is not listed; dropped tile");
        else if (seen.has(symbol))
          recovery.drop(`${path}[${index}]`, "duplicate pair; dropped tile");
        else {
          seen.add(symbol);
          tiles.push({ symbol, notional: defaultNotional });
        }
      });
      return {
        data: { ...data, workspace: { ...data.workspace, tiles } },
        dropped: recovery.dropped,
      };
    }
    return { data, dropped: recovery.dropped };
  }
  const envelope = recovery.object(input, "$", [
    "version",
    "workspace",
    "layouts",
    "activeLayoutId",
  ]);
  if (!envelope) return { data, dropped: recovery.dropped };
  if (envelope.version !== 2)
    recovery.drop("$.version", "unsupported version; recovered recognized fields");
  const workspace = recovery.workspace(envelope.workspace, "$.workspace");
  const layouts: LayoutData[] = [];
  if (!Array.isArray(envelope.layouts))
    recovery.drop("$.layouts", "expected an array; used empty layouts");
  else
    envelope.layouts.forEach((value: unknown, index: number) => {
      const path = `$.layouts[${index}]`;
      const layout = recovery.object(value, path, ["id", "name", "workspace"], "dropped layout");
      if (!layout) return;
      if (
        !Schema.is(LayoutData.fields.id)(layout.id) ||
        layouts.some((held) => held.id === layout.id)
      ) {
        recovery.drop(`${path}.id`, "invalid or duplicate identifier; dropped layout");
        return;
      }
      if (
        typeof layout.name !== "string" ||
        !layout.name.trim() ||
        layouts.some((held) => held.name === (layout.name as string).trim())
      ) {
        recovery.drop(`${path}.name`, "empty or duplicate name; dropped layout");
        return;
      }
      layouts.push({
        id: layout.id,
        name: layout.name.trim(),
        workspace: recovery.workspace(layout.workspace, `${path}.workspace`),
      });
    });
  let activeLayoutId: string | null = null;
  if (envelope.activeLayoutId !== null) {
    if (
      typeof envelope.activeLayoutId === "string" &&
      layouts.some((layout) => layout.id === envelope.activeLayoutId)
    )
      activeLayoutId = envelope.activeLayoutId;
    else recovery.drop("$.activeLayoutId", "layout does not exist; cleared active layout");
  }
  return { data: { version: 2, workspace, layouts, activeLayoutId }, dropped: recovery.dropped };
}

export function readLayoutText(text: string, symbols: readonly PairSymbol[]) {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return {
      workspace: defaultWorkspace(symbols),
      dropped: [{ path: "$", reason: "invalid JSON; used default workspace" }],
    };
  }
  if (typeof input === "object" && input !== null && "version" in input && input.version === 2) {
    const recovery = new Recovery(symbols);
    const envelope = recovery.object(input, "$", ["version", "workspace"]);
    const workspace = recovery.workspace(envelope?.workspace, "$.workspace");
    return { workspace, dropped: recovery.dropped };
  }
  const legacy = readSavedDesk(text, symbols);
  return { workspace: legacy.data.workspace, dropped: legacy.dropped };
}

export interface WorkspaceStore {
  load(): string | null;
  save(text: string): void;
}
export const browserWorkspaceStore = (
  storage: Pick<Storage, "getItem" | "setItem">,
): WorkspaceStore => ({
  load: () => storage.getItem("pinna.desk.workspace"),
  save: (text) => storage.setItem("pinna.desk.workspace", text),
});
