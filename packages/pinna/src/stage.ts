/**
 * Stages: the writes of asynchronous work, landed in one update when it
 * succeeds or dropped when it fails. Until then no box changes, so nothing
 * renders a half-done result and nothing needs undoing.
 *
 * A stage is an overlay and a journal. The overlay holds a value for each box
 * the stage wrote and the rows of each collection it wrote; the journal holds
 * the recipes in the order they ran. `Stage.update` runs its recipe at once
 * against the stage's `read` and `write` to fill the overlay, and keeps the
 * recipe. A read through the stage sees its own writes everywhere: a box, a
 * collection's keys, rows, and row, and a computed value, which the stage
 * evaluates over its own values, outside the graph, and caches until the
 * stage or the realm changes.
 *
 * `Stage.apply` replays the journal into a fresh overlay over the realm's
 * values at that moment, under the same recipe guard. It then lands the
 * overlay's final values and atom marks in one `Realm.update`, nested in an update
 * already open, without calling user code in the landing recipe. A child
 * stage, opened over a stage, replays into its parent instead: a savepoint.
 * `Stage.drop` discards a stage and its open children.
 *
 * A recipe runs once when staged and once per apply through its parents to
 * the realm, so it is a function of its `read`: while it runs, the realm's
 * own `read`, `write`, `Realm.update`, a watch, and making an observable all throw.
 * The place word's recipe kind carries the check, so `Realm.update` and
 * `read` pay nothing for it.
 */
import {
  computeOf,
  nextPlace,
  PinnaError,
  PinnaUsageError,
  peekCell,
  placeDeriving,
  placeKind,
} from "@frondruntime/pinna-core";
import {
  type Atom,
  AtomCell,
  type Box,
  BoxCell,
  type Collection,
  type Computed,
  ComputedValue,
  checkName,
  describeSource,
  nameOf,
  type Realm,
} from "./box.ts";
import {
  collectionOfOrder,
  collectionReads,
  KeyedCollection,
  type StagedRows,
} from "./collection.ts";
import { type Draft, produce } from "./draft.ts";
import { deleteMember, Journal, missing, restoreEntry, type UndoTarget } from "./journal.ts";
import type { Stage } from "./modules/stage.ts";
import { OrderPatch, orderValue, type RowLayer, RowPatch, removedRow } from "./patch.ts";
import {
  assertNotInRecipe,
  assertUpdateCanRun,
  type ObservableRealm,
  otherRealmError,
  untracked,
  update,
  updateRefused,
} from "./realm.ts";
import { applyRecord, noteAtom, noteStage, type UpdateRecord } from "./record.ts";
import { type RestoreData, restoreShape } from "./snapshot.ts";
import { inWindow, Stack } from "./stack.ts";
import {
  type Read,
  type StagedPlace,
  type UpdateRecipe,
  type UpsertOptions,
  type Write,
  withSnapshot,
} from "./verbs.ts";

// Declared beside its module, where the package's entry exports it.
export type { Stage };

export declare const stageBrand: unique symbol;

/** Where a stage is in its life: open, or closed by `Stage.apply` or `Stage.drop`. */
export type StageStatus = "open" | "applied" | "dropped";

/** How `Stage.make` makes a stage. */
export interface StageOptions {
  /** A name for errors, `Stage.inspect`, and the test realm's report. */
  readonly name?: string;
  /**
   * What `Stage.apply` does when a box or collection the stage read or wrote
   * changed in the realm since: `"replay"`, the default, replays over the new
   * values, so a box written without reading is the last writer's; `"fail"`
   * throws a `StageConflictError` and lands nothing. Only a stage
   * over a realm takes it; a child stage records its reads for its root.
   */
  readonly conflicts?: "replay" | "fail";
  /**
   * `true` shows the stage's writes in the realm while it is open, over the
   * confirmed values and the visible stages opened before it: what
   * `Stage.apply` would land now. `Stage.drop` takes them back. Only a stage
   * over a realm takes it.
   */
  readonly visible?: boolean;
}

/** What `Stage.inspect` reports. */
export interface StageInspection {
  readonly name: string | undefined;
  /** The name of the realm the stage writes, from `Realm.make({ name })`. */
  readonly realm: string | undefined;
  /** The parent stage's name, `"<anonymous>"` when it has none, or `undefined` over a realm. */
  readonly parent: string | undefined;
  readonly status: StageStatus;
  readonly conflicts: "replay" | "fail";
  /** The boxes this stage wrote, by name; an unnamed box is `"<anonymous>"`. */
  readonly boxes: ReadonlyArray<string>;
  /** The collections this stage wrote, by name; an unnamed one is `"a collection"`. */
  readonly collections: ReadonlyArray<string>;
  /**
   * What this stage read or wrote from the realm and `Stage.apply` checks,
   * by name: filled only under `{ conflicts: "fail" }`, empty otherwise.
   */
  readonly read: ReadonlyArray<string>;
  /** How many recipes this stage keeps for its replay. */
  readonly recipes: number;
  /** How many child stages are open over this one. */
  readonly children: number;
  /** Whether the stage was made with `{ visible: true }`. */
  readonly visible: boolean;
  /**
   * Whether the stage's writes show in the realm now: `false` for a hidden
   * stage, a closed one, and a visible one that stopped because
   * `Stage.apply` would throw.
   */
  readonly showing: boolean;
  /** The error a stopped visible stage holds and its next call throws, else `undefined`. */
  readonly failure: unknown;
}

const describeStage = (state: StageState): string =>
  state.name === undefined ? "a stage" : `the stage "${state.name}"`;

/** Thrown by a call on a stage that `Stage.apply` or `Stage.drop` closed: a bug in the caller. */
export class StageClosedError extends PinnaError {
  readonly _tag = "StageClosedError" as const;
  /** The stage's name, when it has one. */
  readonly stage: string | undefined;
  readonly status: StageStatus;

  constructor(call: string, stage: string | undefined, status: StageStatus) {
    super(
      `pinna: ${call} runs on ${stage === undefined ? "a stage" : `the stage "${stage}"`} after it was ${status}; open a new one with Stage.make`,
    );
    this.name = "StageClosedError";
    this.stage = stage;
    this.status = status;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), stage: this.stage, status: this.status };
  }
}

/**
 * Thrown by `Stage.apply` on a stage opened with `{ conflicts: "fail" }` when
 * a box or collection it read or wrote changed in the realm since. Nothing
 * lands. A visible stage that stopped on a conflict also throws it from
 * `Stage.update` and `Stage.read`.
 */
export class StageConflictError extends PinnaError {
  readonly _tag = "StageConflictError" as const;
  /** The stage's name, when it has one. */
  readonly stage: string | undefined;
  /** The name of each box or collection that changed: `"<anonymous>"` for an unnamed box, `"a collection"` for an unnamed collection. */
  readonly changed: ReadonlyArray<string>;
  /** The boxes and collections that changed, for code that compares them. */
  readonly observables: ReadonlyArray<object>;

  constructor(
    stage: string | undefined,
    changed: ReadonlyArray<string>,
    observables: ReadonlyArray<object>,
  ) {
    super(
      `pinna: ${changed.join(", ")} changed since ${stage === undefined ? "the stage" : `the stage "${stage}"`} read ${changed.length === 1 ? "it" : "them"}; nothing lands`,
    );
    this.name = "StageConflictError";
    this.stage = stage;
    this.changed = changed;
    this.observables = observables;
  }

  /** Leaves out `observables`, which hold realms and do not serialize. */
  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), stage: this.stage, changed: this.changed };
  }
}

declare module "@frondruntime/pinna-core" {
  interface PinnaErrorByTag {
    StageClosedError: StageClosedError;
    StageConflictError: StageConflictError;
  }
}

/** How a stage's reports name a box or a collection. */
const describeRead = (observable: object, cell: ReadCell): string =>
  observable instanceof KeyedCollection
    ? ((observable as KeyedCollection<unknown, unknown>).name ?? "a collection")
    : observable instanceof ComputedValue
      ? nameOf((observable as ComputedValue<unknown>).source)
      : nameOf(cell.source);

/** What a stage records a read of: a box, or an atom, whose node's version moves on each change. */
type ReadCell = BoxCell<unknown> | AtomCell;

/** A version the stage read, and what to report when it changed. */
interface ReadVersion {
  readonly version: number;
  readonly observable: object;
}

/** The realm versions a row copy came from, and the keys the stage chain replaced. */
interface CollectionProvenance {
  readonly changes: number;
  readonly order: number;
  readonly written: Set<unknown>;
}

/** A computed result, including a thrown value, kept until the overlay or realm changes. */
interface CachedResult {
  readonly failed: boolean;
  readonly value: unknown;
}

export class StageState implements Stage {
  declare readonly [stageBrand]: true;
  readonly realm: ObservableRealm;
  readonly parent: StageState | undefined;
  /** The stage over the realm at the top of the chain. */
  readonly root: StageState;
  readonly name: string | undefined;
  readonly conflicts: "replay" | "fail";
  /** The value of each box this stage wrote, a collection's key order among them. */
  boxes = new Map<BoxCell<unknown>, unknown>();
  /**
   * The rows of each collection this stage wrote: a patch over the rows
   * beneath as they were at its first write, made without a copy.
   */
  rows = new Map<KeyedCollection<unknown, unknown>, RowPatch<unknown, unknown>>();
  /** Every patch this stage made, let go of when it closes or replays. */
  patches: Array<RowPatch<unknown, unknown>> = [];
  /** Keys written in this overlay, including removed keys: landing visits these alone. */
  rowWrites = new Map<KeyedCollection<unknown, unknown>, Set<unknown>>();
  /** A removed row no longer uses its realm cell's write-back value during replay. */
  rowRemovals = new Map<KeyedCollection<unknown, unknown>, Set<unknown>>();
  atoms = new Set<AtomCell>();
  provenance = new Map<KeyedCollection<unknown, unknown>, CollectionProvenance>();
  /** The recipes that ran without throwing, in order. */
  journal: Array<UpdateRecipe> = [];
  status: StageStatus = "open";
  readonly children = new Set<StageState>();
  /** Set from the root's count by each write to this overlay, so a cache knows its chain changed. */
  revision = 0;
  /** Computed values evaluated through this stage, valid while `cacheClock` and `cacheRevision` hold. */
  cache = new Map<ComputedValue<unknown>, CachedResult>();
  cacheClock = -1;
  cacheRevision = -1;
  readonly evaluating = new Set<ComputedValue<unknown>>();
  /** The innermost computed value running in this chain; held on the root alone. */
  computing: ComputedValue<unknown> | undefined = undefined;
  /** What this stage read from the realm, by box, when its root checks conflicts. */
  reads: Map<ReadCell, ReadVersion> | undefined;
  /** Set under `testRealm` only: tells it the stage closed. */
  release: (() => void) | undefined = undefined;
  /** Made with `{ visible: true }`: it has a place in the realm's stack. */
  visible = false;
  /** A visible stage shows its writes until it closes or stops. */
  showing = false;
  /** The error a stopped visible stage holds: `Stage.apply` would throw it. */
  failure: unknown = undefined;
  /**
   * The showing stage beneath this visible one at its last replay: its
   * reads walk that stage's overlay after its own, as a child walks its
   * parent's.
   */
  below: StageState | undefined = undefined;
  /**
   * The realm cells a visible stage's last replay read or wrote, with the
   * version each had: a change to one means the replay is out of date.
   */
  inputs: Map<ReadCell, number> | undefined = undefined;

  constructor(
    realm: ObservableRealm,
    parent: StageState | undefined,
    name: string | undefined,
    conflicts: "replay" | "fail",
    readonly replaying = false,
  ) {
    this.realm = realm;
    this.parent = parent;
    this.root = parent === undefined ? this : parent.root;
    this.name = name;
    this.conflicts = conflicts;
    this.reads = conflicts === "fail" ? new Map() : undefined;
  }
}

/**
 * The `read` and `write` handed to one recipe or read function: good while
 * it runs. Replayed recipes share `journal`, which puts back their overlay
 * writes, the last first.
 */
interface Session {
  open: boolean;
  readonly writable: boolean;
  readonly journal: Journal;
}

const keptError = (verb: string): Error =>
  new PinnaUsageError(
    "pinna/stage-handle-kept",
    `pinna: ${verb} of a stage runs after its recipe returned; read and write inside the recipe`,
  );

/** Why `Stage.read` and `Stage.realmRead` refuse a derivation: their reads are not tracked, so it would go stale. */
const assertReadCanRun = (realm: ObservableRealm, call: string): void => {
  const core = realm.core;
  // Where an update is refused, an untracked read inside a derivation included.
  if (updateRefused(realm)) {
    throw new PinnaUsageError(
      "pinna/update-in-derivation",
      (core.place & placeDeriving) !== 0
        ? `pinna: ${call} cannot run in a computed value; a stage's reads are not tracked, so read it from an event, a watch's effect, or an autorun`
        : `pinna: ${call} cannot run in a watch's select or a selector; a stage's reads are not tracked, so read it from an event, a watch's effect, or an autorun`,
    );
  }
};

/** The stage behind `stage`, open, with no stage recipe running. */
const openState = (stage: Stage, call: string): StageState => {
  const state = stage as StageState;
  assertNotInRecipe(state.realm, call);
  if (state.status !== "open") {
    throw new StageClosedError(call, state.name, state.status);
  }
  return state;
};

/** Closes the stage and its open children once, and lets go of what they held. */
/** The open stages of each realm, for a call that must not start under staged rows. */
const openStages = new WeakMap<ObservableRealm, Set<StageState>>();

/**
 * The name of an open stage of `realm` that has written `collection`, or
 * `undefined`: a row listener added now would miss those staged rows.
 */
export const stageWritingCollection = (
  realm: ObservableRealm,
  collection: KeyedCollection<unknown, unknown>,
): string | undefined => {
  for (const state of openStages.get(realm) ?? []) {
    // A visible stage replays through a new listener as it registers; its
    // hidden children do not, so they refuse as any hidden stage does.
    if (state.visible) continue;
    if (state.rows.has(collection) || state.rowWrites.has(collection)) {
      return state.name === undefined ? "a stage" : `the stage "${state.name}"`;
    }
  }
  return undefined;
};

const close = (state: StageState, status: "applied" | "dropped"): void => {
  if (state.status !== "open") {
    return;
  }
  openStages.get(state.realm)?.delete(state);
  if (state.visible) {
    (state.realm.stack as Stack | undefined)?.leave(state);
    state.showing = false;
    state.below = undefined;
    state.inputs = undefined;
  }
  for (const child of state.children) {
    close(child, "dropped");
  }
  state.status = status;
  state.boxes = new Map();
  retirePatches(state);
  state.rows = new Map();
  state.rowWrites = new Map();
  state.rowRemovals = new Map();
  state.atoms = new Set();
  state.provenance = new Map();
  state.journal = [];
  state.cache = new Map();
  state.reads = undefined;
  state.parent?.children.delete(state);
  const release = state.release;
  state.release = undefined;
  release?.();
};

/**
 * A journal step that takes a patch a recipe made back out of the stage's
 * patches and retires it: a recipe that throws keeps no row it replaced.
 * No child reads through it, since a recipe makes no child stage.
 */
const dropPatch: UndoTarget = {
  undo(a, b) {
    const patches = a as Array<RowPatch<unknown, unknown>>;
    const patch = b as RowPatch<unknown, unknown>;
    const index = patches.lastIndexOf(patch);
    if (index !== -1) patches.splice(index, 1);
    patch.retire();
  },
};

/** Lets go of every patch the stage made: each leaves the rows beneath once nothing reads through it. */
const retirePatches = (state: StageState): void => {
  for (const patch of state.patches) patch.retire();
  state.patches = [];
};

// Reading through the chain of overlays

/**
 * The version a conflict check compares: a box's node version, an atom's
 * confirmed revision, which a visible stage's mark leaves alone until the
 * stage is applied.
 */
export const readVersion = (cell: ReadCell): number =>
  cell instanceof AtomCell ? cell.revision : cell.source.version;

/** Records a read of the realm's box or atom, when the stage's root checks conflicts. */
const recordRead = (
  state: StageState,
  box: ReadCell,
  observable: object,
  version = readVersion(box),
): void => {
  const reads = state.reads;
  const held = reads?.get(box);
  if (reads === undefined) return;
  if (held === undefined) {
    reads.set(box, { version, observable });
  } else if (held.version !== version) {
    // Rollback restores earlier versions. Two observed versions cannot
    // both match at apply; NaN matches neither, and keeps the first name.
    reads.set(box, { version: Number.NaN, observable: held.observable });
  }
};

/**
 * The next overlay a read walks: the parent's, or for a visible stage the
 * showing stage beneath it.
 */
const beneath = (stage: StageState): StageState | undefined => stage.parent ?? stage.below;

/** Notes a realm cell a visible stage's run read or wrote, at its first version. */
const noteInput = (state: StageState, cell: ReadCell): void => {
  const inputs = state.inputs;
  if (inputs !== undefined && !inputs.has(cell)) {
    inputs.set(cell, cell.source.version);
  }
};

/** The stage's value of `Box.make`: its own overlay's, an ancestor's, a lower visible stage's, or the realm's. */
const boxValue = <Value>(state: StageState, box: BoxCell<Value>, record: boolean): Value => {
  const key = box as BoxCell<unknown>;
  let below = false;
  for (let stage: StageState | undefined = state; stage !== undefined; stage = beneath(stage)) {
    if (stage.boxes.has(key)) {
      if (record) {
        const collection = collectionOfOrder.get(box);
        const provenance = collection === undefined ? undefined : stage.provenance.get(collection);
        if (provenance !== undefined && collection !== undefined) {
          recordRead(state, key, collection, provenance.order);
        } else if (below) {
          // A conflict is a change to the base: the cell holds the base
          // version of a box a lower visible stage covers while a stage call runs.
          recordRead(state, key, collection ?? box);
        }
      }
      return orderValue(stage.boxes.get(key)) as Value;
    }
    if (stage.parent === undefined) below = true;
  }
  noteInput(state, key);
  if (record) {
    recordRead(state, key, collectionOfOrder.get(box) ?? box);
  }
  // `peek`: the key order's box hands its array out, and its next write copies.
  return box.peek();
};

/** The stage's rows of `Collection.make`: its own, an ancestor's, or the ones the realm holds. */
const rowsOf = <Key, Value>(
  state: StageState,
  collection: KeyedCollection<Key, Value>,
  record: boolean,
  rowKey?: Key,
  singleRow = false,
): ReadonlyMap<Key, Value> => {
  const key = collection as KeyedCollection<unknown, unknown>;
  let below = false;
  for (let stage: StageState | undefined = state; stage !== undefined; stage = beneath(stage)) {
    const rows = stage.rows.get(key);
    if (rows !== undefined) {
      const provenance = stage.provenance.get(key);
      // A row a lower visible stage wrote is not this chain's own write:
      // reading it records the base versions its copy came from.
      if (
        record &&
        provenance !== undefined &&
        (below || !(singleRow && provenance.written.has(rowKey)))
      ) {
        recordRead(
          state,
          collection.changesCell as BoxCell<unknown>,
          collection,
          provenance.changes,
        );
        recordRead(state, collection.orderCell as BoxCell<unknown>, collection, provenance.order);
      }
      if (record && below && provenance === undefined) {
        // A lower stage's `replaceAll` keeps no provenance: its rows stand
        // over the base as it is now, in the window.
        recordRead(state, collection.changesCell as BoxCell<unknown>, collection);
        recordRead(state, collection.orderCell as BoxCell<unknown>, collection);
      }
      return rows as unknown as ReadonlyMap<Key, Value>;
    }
    if (stage.parent === undefined) below = true;
  }
  noteInput(state, collection.changesCell as BoxCell<unknown>);
  noteInput(state, collection.orderCell as BoxCell<unknown>);
  if (record) {
    recordRead(state, collection.changesCell as BoxCell<unknown>, collection);
    recordRead(state, collection.orderCell as BoxCell<unknown>, collection);
  }
  return collection.heldRows();
};

/** The highest revision along the chain: a child's cache is stale when an ancestor wrote. */
const chainRevision = (state: StageState): number => {
  let highest = 0;
  for (let stage: StageState | undefined = state; stage !== undefined; stage = beneath(stage)) {
    if (stage.revision > highest) {
      highest = stage.revision;
    }
  }
  return highest;
};

/**
 * A computed value as the stage sees it. A collection's `rows` and `row` read
 * the stage's rows; any other computed value runs its own function against
 * the stage's `read`, outside the graph, so it starts no `Source.onObserved` source
 * and caches nothing in the realm. The result is cached on the stage until
 * the stage, an ancestor, or the realm changes.
 */
const evaluate = (state: StageState, read: Read, computed: ComputedValue<unknown>): unknown => {
  const tag = collectionReads.get(computed);
  if (tag !== undefined && !tag.all) {
    return rowsOf(state, tag.collection, true, tag.key, true).get(tag.key);
  }
  const clock = state.realm.core.clock;
  const revision = chainRevision(state);
  if (state.cacheClock !== clock || state.cacheRevision !== revision) {
    state.cache.clear();
    state.cacheClock = clock;
    state.cacheRevision = revision;
  }
  const cache = state.cache;
  const cached = cache.get(computed);
  if (cached !== undefined) {
    if (cached.failed) {
      throw cached.value;
    }
    return cached.value;
  }
  if (state.evaluating.has(computed)) {
    throw new PinnaUsageError(
      "pinna/cycle",
      `pinna: ${describeSource(computed.source)} is read while a stage evaluates it (cycle)`,
    );
  }
  state.evaluating.add(computed);
  const computing = state.root.computing;
  state.root.computing = computed;
  try {
    let value: unknown;
    if (tag !== undefined) {
      const rows = rowsOf(state, tag.collection, true);
      value = boxValue(state, tag.collection.orderCell, true).map((key) => rows.get(key));
    } else {
      value = (computeOf(computed.source) as (read: Read) => unknown)(read);
    }
    cache.set(computed, { failed: false, value });
    return value;
  } catch (error) {
    cache.set(computed, { failed: true, value: error });
    throw error;
  } finally {
    state.root.computing = computing;
    state.evaluating.delete(computed);
  }
};

const ownRealm = (
  state: StageState,
  verb: string,
  observable: { readonly realm?: ObservableRealm; readonly source?: unknown },
): void => {
  if (observable.realm !== state.realm) {
    throw otherRealmError(
      verb,
      observable.source as Parameters<typeof otherRealmError>[1],
      observable.realm as ObservableRealm,
      state.realm,
    );
  }
};

/** The `read` a stage hands out: its own value of everything it wrote, the realm's of the rest. */
const stageReader = (state: StageState, session: Session): Read => {
  function read<Value>(observable: Computed<Value>): Value;
  function read(atom: Atom): undefined;
  function read(observable: Computed<unknown> | Atom): unknown {
    if (!session.open) {
      throw keptError("read");
    }
    const cell = observable as unknown as { readonly realm: ObservableRealm };
    ownRealm(state, "read", cell);
    if (cell instanceof BoxCell) {
      return boxValue(state, cell, true);
    }
    if (cell instanceof AtomCell) {
      // An atom stands for state outside Pinna, and a change to it moves its
      // version, so a stage that read it conflicts as one that read a box.
      // Read beneath a computed value, the conflict names that value.
      noteInput(state, cell);
      recordRead(state, cell, state.root.computing ?? cell);
      return undefined;
    }
    return evaluate(state, reader, cell as unknown as ComputedValue<unknown>);
  }
  const row = <Key, Value>(collection: Collection<Key, Value>, key: Key): Value | undefined => {
    if (!session.open) {
      throw keptError("read.row");
    }
    ownRealm(state, "read.row", collection as unknown as { readonly realm: ObservableRealm });
    return rowsOf(state, collection as unknown as KeyedCollection<Key, Value>, true, key, true).get(
      key,
    );
  };
  const reader = withSnapshot(read, row);
  return reader;
};

// Writing to the overlay

/**
 * The last revision handed out, for every stage: a visible stage reads
 * through the overlays of the stages beneath it, so one count orders the
 * writes of every chain a cache can walk.
 */
let revisions = 0;

const changedOverlay = (state: StageState): void => {
  state.revision = ++revisions;
};

/** Puts `value` in this stage's overlay for `Box.make`, and keeps what it replaced for the undo. */
const setBox = (
  state: StageState,
  session: Session,
  box: BoxCell<unknown>,
  value: unknown,
): void => {
  const boxes = state.boxes;
  const had = boxes.has(box);
  const prior = boxes.get(box);
  session.journal.step(restoreEntry, boxes, box, had ? prior : missing);
  boxes.set(box, value);
  changedOverlay(state);
};

/** The rows a new patch of `collection` reads through: the nearest stage beneath that holds some, or the realm's. */
const layerBeneath = <Key, Value>(
  state: StageState,
  collection: KeyedCollection<Key, Value>,
): RowLayer<Key, Value> => {
  const key = collection as KeyedCollection<unknown, unknown>;
  for (let stage = beneath(state); stage !== undefined; stage = beneath(stage)) {
    const rows = stage.rows.get(key);
    if (rows !== undefined) return rows as RowPatch<Key, Value>;
  }
  return collection;
};

/** The rows of `Collection.make` this stage changes: a patch over the chain or the realm, made on its first write. */
const stagedRows = <Key, Value>(
  state: StageState,
  session: Session,
  collection: KeyedCollection<Key, Value>,
): StagedRows<Key, Value> => {
  const key = collection as KeyedCollection<unknown, unknown>;
  const orderCell = collection.orderCell as BoxCell<unknown>;
  if (state.reads !== undefined) {
    // Under `"fail"`, a write records the collection as a read of its rows does.
    rowsOf(state, collection, true);
  }
  const own = (): RowPatch<Key, Value> => {
    let rows = state.rows.get(key) as RowPatch<Key, Value> | undefined;
    if (rows === undefined) {
      rows = new RowPatch<Key, Value>(layerBeneath(state, collection));
      state.patches.push(rows as RowPatch<unknown, unknown>);
      session.journal.step(dropPatch, state.patches, rows, undefined);
      let ancestor = beneath(state);
      let below = state.parent === undefined;
      while (ancestor !== undefined && !ancestor.rows.has(key)) {
        if (ancestor.parent === undefined) below = true;
        ancestor = beneath(ancestor);
      }
      const inherited = ancestor?.provenance.get(key);
      // Rows a lower visible stage wrote are not this stage's writes: a read
      // of them records the base versions the copy came from.
      const provenance =
        ancestor === undefined
          ? {
              changes: collection.changesCell.source.version,
              order: collection.orderCell.source.version,
              written: new Set<unknown>(),
            }
          : inherited === undefined
            ? below
              ? {
                  changes: collection.changesCell.source.version,
                  order: collection.orderCell.source.version,
                  written: new Set<unknown>(),
                }
              : undefined
            : { ...inherited, written: below ? new Set<unknown>() : new Set(inherited.written) };
      if (provenance !== undefined) {
        state.provenance.set(key, provenance);
      }
      // The order is held with the rows, so the two never disagree.
      if (!state.boxes.has(orderCell)) {
        setBox(state, session, orderCell, boxValue(state, collection.orderCell, false));
      }
      state.rows.set(key, rows as RowPatch<unknown, unknown>);
      session.journal.step(restoreEntry, state.provenance, key, missing);
      session.journal.step(restoreEntry, state.rows, key, missing);
    }
    return rows;
  };
  /** The stage's order as a patch: `own` put the order in its boxes. */
  const orderPatch = (): OrderPatch<Key> => {
    const order = state.boxes.get(orderCell);
    return order instanceof OrderPatch
      ? (order as OrderPatch<Key>)
      : OrderPatch.over(order as ReadonlyArray<Key>);
  };
  const wrote = (rowKey: Key): void => {
    let keys = state.rowWrites.get(key);
    if (keys === undefined) {
      keys = new Set();
      state.rowWrites.set(key, keys);
      session.journal.step(restoreEntry, state.rowWrites, key, missing);
    }
    if (!keys.has(rowKey)) {
      const written = keys;
      written.add(rowKey);
      session.journal.step(deleteMember, written, rowKey, undefined);
    }
    const written = state.provenance.get(key)?.written;
    if (written !== undefined && !written.has(rowKey)) {
      session.journal.step(deleteMember, written, rowKey, undefined);
      written.add(rowKey);
    }
  };
  const removed = (rowKey: Key): void => {
    if (!state.replaying) return;
    let keys = state.rowRemovals.get(key);
    if (keys === undefined) {
      keys = new Set();
      state.rowRemovals.set(key, keys);
      session.journal.step(restoreEntry, state.rowRemovals, key, missing);
    }
    if (!keys.has(rowKey)) {
      const removals = keys;
      removals.add(rowKey);
      session.journal.step(deleteMember, removals, rowKey, undefined);
    }
  };
  return {
    get rows() {
      return rowsOf(state, collection, false);
    },
    get order() {
      return boxValue(state, collection.orderCell, false);
    },
    cellValue: state.replaying
      ? (rowKey, cell, value, current) =>
          checkedValue(
            cell,
            current,
            value,
            !state.rowRemovals.get(key)?.has(rowKey),
            state.rowWrites.get(key)?.has(rowKey) ?? false,
          ) as Value
      : undefined,
    setRow(rowKey, row) {
      const rows = own();
      session.journal.step(rows.target, rowKey, rows.own.has(rowKey), rows.own.get(rowKey));
      rows.set(rowKey, row);
      wrote(rowKey);
      changedOverlay(state);
    },
    deleteRow(rowKey) {
      const rows = own();
      session.journal.step(rows.target, rowKey, rows.own.has(rowKey), rows.own.get(rowKey));
      rows.set(rowKey, removedRow);
      removed(rowKey);
      wrote(rowKey);
      changedOverlay(state);
    },
    addKey(rowKey, at) {
      own();
      setBox(state, session, orderCell, orderPatch().add(rowKey, at));
    },
    removeKey(rowKey) {
      own();
      setBox(state, session, orderCell, orderPatch().remove(rowKey));
    },
    setOrder(order) {
      own();
      setBox(state, session, orderCell, order);
    },
    setAll(rows, order, written) {
      // Replaced whole: no copy of the rows held first.
      for (const rowKey of written) {
        wrote(rowKey);
        if (!rows.has(rowKey)) removed(rowKey);
      }
      const prior = state.rows.get(key);
      const provenance = state.provenance.get(key);
      session.journal.step(
        restoreEntry,
        state.provenance,
        key,
        provenance === undefined ? missing : provenance,
      );
      session.journal.step(restoreEntry, state.rows, key, prior === undefined ? missing : prior);
      // A whole replace holds every row itself: it reads through nothing.
      const whole = new RowPatch<unknown, unknown>(
        undefined,
        rows as ReadonlyMap<unknown, unknown>,
      );
      state.patches.push(whole);
      session.journal.step(dropPatch, state.patches, whole, undefined);
      state.rows.set(key, whole);
      state.provenance.delete(key);
      setBox(state, session, orderCell, order);
    },
  };
};

/** The value an overlay write keeps, checked before either equality comparison. */
const checkedValue = <Value>(
  cell: BoxCell<Value>,
  current: Value,
  value: Value,
  replaying: boolean,
  written: boolean,
): Value => {
  if (Object.is(value, current)) return current;
  cell.verify(value, current);
  if (replaying) {
    const recorded = cell.nextRecorded !== undefined;
    if (recorded || written) {
      // An enclosing write supplies the outermost update's original;
      // otherwise the first replay write would record the realm's value.
      const before = recorded ? (cell.valueBefore as Value) : peekCell(cell.source);
      // Before an overlay write, the realm's versions decide whether a
      // write-back is possible. After one, original identity means its
      // version was restored; any other overlay value has a new version.
      const changed = written
        ? !Object.is(current, before)
        : cell.versionBefore !== cell.source.version;
      if (changed && cell.source.equals(before, value)) return before;
    }
  }
  return cell.source.equals(current, value) ? current : value;
};

/** The `write` a stage hands out: boxes, collections, and atoms. */
const stageWriter = (state: StageState, session: Session, reader: Read): Write => {
  const open = (verb: string): void => {
    const computing = state.root.computing;
    if (computing !== undefined) {
      throw new PinnaUsageError(
        "pinna/write-while-computing",
        `pinna: ${computing.source.label ?? "a computed value"} cannot write while it computes`,
      );
    }
    if (!session.open) {
      throw keptError(verb);
    }
    if (!session.writable) {
      throw new PinnaUsageError(
        "pinna/stage-read-writes",
        `pinna: ${verb} runs in Stage.read, which writes nothing; write in Stage.update`,
      );
    }
  };
  const ownBox = <Value>(verb: string, box: Box<Value>): BoxCell<Value> => {
    open(verb);
    const cell = box as BoxCell<Value>;
    ownRealm(state, verb, cell);
    return cell;
  };
  const ownCollection = <Key, Value>(
    verb: string,
    collection: Collection<Key, Value>,
  ): KeyedCollection<Key, Value> => {
    open(verb);
    ownRealm(state, verb, collection as unknown as { readonly realm: ObservableRealm });
    return collection as unknown as KeyedCollection<Key, Value>;
  };
  const writeValue = <Value>(cell: BoxCell<Value>, value: Value): void => {
    // Under `"fail"`, a write records the realm's version as a read does: a
    // base write to a box the stage wrote without reading conflicts too.
    const current = boxValue(state, cell, state.reads !== undefined);
    const key = cell as BoxCell<unknown>;
    const kept = checkedValue(cell, current, value, state.replaying, state.boxes.has(key));
    if (!Object.is(kept, current)) setBox(state, session, key, kept);
  };
  const writeBox = <Value>(box: Box<Value>, value: Value): undefined => {
    writeValue(ownBox("write", box), value);
    return undefined;
  };
  const writer: Write = Object.assign(writeBox, {
    modify: <Value>(box: Box<Value>, recipe: (draft: Draft<Value>) => undefined): undefined => {
      const cell = ownBox("write.modify", box);
      // Drafted from the stage's value: a draft of the realm's would change it in place.
      writeValue(cell, produce(boxValue(state, cell, true), recipe));
      return undefined;
    },
    upsert: <Key, Value>(
      collection: Collection<Key, Value>,
      value: Value,
      options?: UpsertOptions,
    ): undefined => {
      const keyed = ownCollection("write.upsert", collection);
      undoOnThrow(state, session, () => {
        keyed.stagedUpsert(stagedRows(state, session, keyed), value, options, reader, writer);
      });
      return undefined;
    },
    remove: <Key, Value>(collection: Collection<Key, Value>, key: Key): undefined => {
      const keyed = ownCollection("write.remove", collection);
      undoOnThrow(state, session, () => {
        keyed.stagedRemove(stagedRows(state, session, keyed), key, reader, writer);
      });
      return undefined;
    },
    replaceAll: <Key, Value>(
      collection: Collection<Key, Value>,
      values: ReadonlyArray<Value>,
    ): undefined => {
      const keyed = ownCollection("write.replaceAll", collection);
      undoOnThrow(state, session, () => {
        keyed.stagedReplace(stagedRows(state, session, keyed), values, reader, writer);
      });
      return undefined;
    },
    restore: <Shape>(shape: Shape, data: RestoreData<Shape>): undefined => {
      open("write.restore");
      undoOnThrow(state, session, () => {
        restoreShape(reader, writer, shape, data);
      });
      return undefined;
    },
    replay: (record: UpdateRecord): undefined => {
      open("write.replay");
      undoOnThrow(state, session, () => {
        applyRecord(reader, writer, record, true, "write.replay");
      });
      return undefined;
    },
    revert: (record: UpdateRecord): undefined => {
      open("write.revert");
      undoOnThrow(state, session, () => {
        applyRecord(reader, writer, record, false, "write.revert");
      });
      return undefined;
    },
    // An atom holds no value; a successful replay lands its marks once.
    changed: (atom: Atom): undefined => {
      open("write.changed");
      ownRealm(state, "write.changed", atom as unknown as { readonly realm: ObservableRealm });
      const cell = atom as AtomCell;
      if (!state.atoms.has(cell)) {
        state.atoms.add(cell);
        session.journal.step(deleteMember, state.atoms, cell, undefined);
      }
      return undefined;
    },
  }) as Write;
  return writer;
};

/** Puts back the overlay writes after a savepoint, the last first. */
const undoSession = (state: StageState, session: Session, savepoint = 0): void => {
  try {
    session.journal.rollback(savepoint);
  } finally {
    changedOverlay(state);
  }
};

/** A caught failure undoes the operation and its listeners, leaving earlier writes in place. */
const undoOnThrow = <Result>(state: StageState, session: Session, run: () => Result): Result => {
  const savepoint = session.journal.length;
  try {
    return run();
  } catch (error) {
    undoSession(state, session, savepoint);
    throw error;
  }
};

/**
 * Runs `run` as a stage's place: untracked, with the realm's own `read`,
 * `write`, `Realm.update`, watches, and new observables refused, and the stage's
 * `read` and `write` where a merge looks for them.
 */
const asPlace = <Result>(state: StageState, place: StagedPlace, run: () => Result): Result => {
  const realm = state.realm;
  const core = realm.core;
  const active = core.active;
  const outerPlace = core.place;
  const stagedPlace = realm.stagedPlace;
  core.active = undefined;
  core.place = nextPlace(outerPlace, placeKind.recipe);
  realm.stagedPlace = place;
  try {
    return run();
  } finally {
    core.active = active;
    core.place = outerPlace;
    realm.stagedPlace = stagedPlace;
  }
};

/** Marks an async recipe's rejection handled: `Stage.update` has thrown for it already. */
const ignore = (): void => {};

/**
 * Runs `recipes` with one undo boundary and a session per recipe: all of
 * them, or none, with the overlay as it was. Root replay prepares its
 * landing under the same guard, with every recipe's handles closed, through
 * a read-only session of its own.
 */
export const runRecipes = (
  state: StageState,
  recipes: ReadonlyArray<UpdateRecipe>,
  prepare?: () => void,
): void => {
  const boundary: Session = { open: false, writable: false, journal: new Journal() };
  try {
    for (const recipe of recipes) {
      const session: Session = { open: true, writable: true, journal: boundary.journal };
      const read = stageReader(state, session);
      const write = stageWriter(state, session, read);
      try {
        asPlace(
          state,
          { read, write, undoOnThrow: (run) => undoOnThrow(state, session, run) },
          () => {
            const result: unknown = recipe(read, write);
            if (result !== undefined) {
              if (typeof (result as { readonly then?: unknown }).then === "function") {
                (result as PromiseLike<unknown>).then(undefined, ignore);
                throw new PinnaUsageError(
                  "pinna/async-recipe",
                  "pinna: Stage.update recipes are synchronous; await outside, then Stage.update",
                );
              }
              throw new PinnaUsageError(
                "pinna/recipe-returns-value",
                "pinna: a Stage.update recipe returns nothing",
              );
            }
          },
        );
      } finally {
        session.open = false;
      }
    }
    if (prepare !== undefined) {
      // Its own read-only session: merge planning reads through the field
      // codecs, and a recipe's handles are closed by now.
      const session: Session = { open: true, writable: false, journal: boundary.journal };
      const read = stageReader(state, session);
      try {
        asPlace(
          state,
          {
            read,
            write: stageWriter(state, session, read),
            undoOnThrow: (run) => undoOnThrow(state, session, run),
          },
          prepare,
        );
      } finally {
        session.open = false;
      }
    }
  } catch (error) {
    undoSession(state, boundary);
    throw error;
  } finally {
    boundary.journal.forget();
  }
  for (const recipe of recipes) {
    state.journal.push(recipe);
  }
};

/**
 * Prepares final values under the recipe guard, including equality with the
 * realm and an enclosing update's starting value. Landing calls no user
 * check or equality: the replay checked every value with the box's check.
 */
const prepareLanding = (state: StageState, stack?: Stack): (() => void) => {
  const boxes: Array<() => void> = [];
  const rows: Array<() => void> = [];
  const prepareBox = <Value>(box: BoxCell<Value>, value: Value): Value => {
    const current = peekCell(box.source);
    if (Object.is(current, value)) return current;
    let version: number | undefined;
    if (
      box.nextRecorded !== undefined &&
      box.versionBefore !== box.source.version &&
      box.source.equals(box.valueBefore as Value, value)
    ) {
      value = box.valueBefore as Value;
      version = box.versionBefore;
    } else if (box.source.equals(current, value)) {
      return current;
    }
    if (version === undefined && stack !== undefined) {
      const shown = stack.shownMatch(box as BoxCell<unknown>, value);
      if (shown !== undefined) {
        value = shown.value as Value;
        version = shown.version;
      }
    }
    const landing = value;
    boxes.push(() => {
      const realm = box.realm;
      if (box.nextRecorded === undefined) {
        realm.recordFirst(box as BoxCell<unknown>, current, box.source.version);
      } else {
        realm.record(box as BoxCell<unknown>, current);
      }
      // A value a visible stage shows now lands with the version readers
      // already hold, so applying the stage that shows it reruns nobody.
      box.restore(landing, version ?? realm.core.nextCellVersion());
    });
    return value;
  };
  for (const [box, value] of state.boxes) prepareBox(box, orderValue(value));
  for (const [collection, keys] of state.rowWrites) {
    rows.push(
      collection.prepareStageRows(
        state.rows.get(collection) as RowPatch<unknown, unknown>,
        keys,
        prepareBox,
      ),
    );
  }
  return () => {
    for (const land of boxes) land();
    for (const land of rows) land();
    for (const atom of state.atoms) {
      // A mark a visible stage showed reran its readers when it showed; the
      // change stream records it as landed all the same.
      if (stack?.showsAtom(atom) !== true) atom.change();
      else {
        atom.revision++;
        noteAtom(atom.realm, atom);
      }
    }
  };
};

/** The conflict `Stage.apply` would throw for a root stage under `"fail"`, or `undefined`. */
export const findConflict = (state: StageState): StageConflictError | undefined => {
  const reads = state.reads;
  if (reads === undefined) return undefined;
  const changed: Array<string> = [];
  const observables: Array<object> = [];
  for (const [box, read] of reads) {
    if (readVersion(box) !== read.version && !observables.includes(read.observable)) {
      observables.push(read.observable);
      changed.push(describeRead(read.observable, box));
    }
  }
  return changed.length > 0 ? new StageConflictError(state.name, changed, observables) : undefined;
};

/** Empties a visible stage's overlay before a replay fills it again. */
export const clearOverlay = (state: StageState): void => {
  state.boxes = new Map();
  retirePatches(state);
  state.rows = new Map();
  state.rowWrites = new Map();
  state.rowRemovals = new Map();
  state.atoms = new Set();
  state.provenance = new Map();
  state.cache = new Map();
  changedOverlay(state);
};

/**
 * The stage listeners of each realm that has one: devtools, through
 * `onStageChange`. Kept apart from the realm, so the realm, which every
 * update reads, keeps its shape; a stage call looks its realm up once.
 */
const stageListeners = new WeakMap<ObservableRealm, ReadonlyArray<() => void>>();

/**
 * Calls each stage listener of `realm`, once a stage call or a window ended:
 * a listener's error goes to `onError`, and the others still run. One map
 * lookup when nobody listens.
 */
export const noteStageChange = (realm: ObservableRealm): void => {
  const listeners = stageListeners.get(realm);
  if (listeners === undefined) return;
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      realm.core.reportAside(error);
    }
  }
};

/** The open stages of `realm`, children included, in the order they opened: for devtools. */
export const stagesOf = (realm: Realm): ReadonlyArray<Stage> => [
  ...(openStages.get(realm as ObservableRealm) ?? []),
];

/**
 * Calls `listener` after each `Stage.make`, `Stage.update`, `Stage.apply`,
 * and `Stage.drop` of `realm`, thrown or not, and after an update in which a
 * visible stage stopped showing: for devtools, which lists open stages.
 * Returns the stop, which does nothing the second time; `Realm.dispose`
 * stops it.
 */
export const onStageChange = (realm: Realm, listener: () => void): (() => void) => {
  const owner = realm as ObservableRealm;
  owner.assertOpen("a stage listener");
  const entry = (): void => listener();
  stageListeners.set(owner, [...(stageListeners.get(owner) ?? []), entry]);
  return owner.register("stage listener", () => {
    const next = (stageListeners.get(owner) ?? []).filter((kept) => kept !== entry);
    if (next.length === 0) {
      stageListeners.delete(owner);
    } else {
      stageListeners.set(owner, next);
    }
  });
};

// The calls

/**
 * A new stage, holding nothing. Over a realm, `Stage.apply` lands it in the
 * realm; over another stage, a child, `Stage.apply` replays it into that
 * stage, and dropping the parent drops it. A stage neither applied nor
 * dropped holds its overlay until it is collected; under `testRealm`, the
 * realm's dispose reports it.
 */
export const openStage = (over: Realm | Stage, options?: StageOptions): Stage => {
  checkName(options?.name);
  const visible = options?.visible;
  if (visible !== undefined && typeof visible !== "boolean") {
    throw new PinnaUsageError(
      "pinna/stage-visible-option",
      `pinna: visible is true or false, not ${String(visible)}`,
    );
  }
  const conflicts = options?.conflicts;
  if (conflicts !== undefined && conflicts !== "replay" && conflicts !== "fail") {
    throw new PinnaUsageError(
      "pinna/stage-conflicts-option",
      `pinna: conflicts is "replay" or "fail", not ${JSON.stringify(conflicts)}`,
    );
  }
  let state: StageState;
  if (over instanceof StageState) {
    const parent = openState(over, "Stage.make");
    // An older stage is still open while disposal stops newer entries.
    parent.realm.assertOpen("a stage");
    if (options?.conflicts !== undefined) {
      throw new PinnaUsageError(
        "pinna/stage-conflicts-option",
        "pinna: a child stage takes no conflicts option; its root stage checks what the child read",
      );
    }
    if (visible !== undefined) {
      throw new PinnaUsageError(
        "pinna/stage-visible-option",
        "pinna: a child stage takes no visible option; it is a savepoint that shows through its parent once applied. A second guess that must show at once is a second stage over the realm",
      );
    }
    state = new StageState(parent.realm, parent, options?.name, parent.conflicts);
    parent.children.add(state);
  } else {
    const realm = over as ObservableRealm;
    assertNotInRecipe(realm, "Stage.make");
    realm.assertOpen("a stage");
    state = new StageState(realm, undefined, options?.name, options?.conflicts ?? "replay");
    if (visible === true) {
      state.visible = true;
      state.showing = true;
      state.inputs = new Map();
      let stack = realm.stack as Stack | undefined;
      if (stack === undefined) {
        stack = new Stack(realm);
        realm.stack = stack;
      }
      stack.push(state);
    }
  }
  let open = openStages.get(state.realm);
  if (open === undefined) {
    open = new Set();
    openStages.set(state.realm, open);
  }
  open.add(state);
  // Kept so `Realm.dispose` drops it, and `testRealm` reports it left open.
  state.release = state.realm.register(
    state.name === undefined ? "stage" : `stage "${state.name}"`,
    () => close(state, "dropped"),
  );
  noteStageChange(state.realm);
  return state;
};

/**
 * Runs `recipe` at once against the stage, and keeps it for `Stage.apply`.
 * Its `read` sees the stage's own writes, and the realm's current values
 * elsewhere; its `write` writes the stage, through each box's and
 * collection's check. A recipe that throws puts back what it wrote to the
 * stage, is not kept, and its error is rethrown; one that returns a promise
 * throws at once. Throws where `Realm.update` would: in a computed value, a
 * watch's select, or a selector.
 */
export const stageUpdate = (stage: Stage, recipe: UpdateRecipe): void => {
  const state = openState(stage, "Stage.update");
  assertUpdateCanRun(state.realm, "Stage.update");
  try {
    inWindow(state.realm, () => {
      const stack = state.realm.stack as Stack | undefined;
      stack?.prepare(state);
      runRecipes(state, [recipe]);
      if (state.visible) stack?.updated(state);
    });
  } finally {
    noteStageChange(state.realm);
  }
};

/**
 * What `run` returns, reading through the stage: its own writes, and the
 * realm's current values elsewhere. Not a snapshot: what the stage did not
 * write can change between two calls. Untracked, so it throws in a computed
 * value, a watch's select, or a selector.
 */
export const stageRead = <Result>(stage: Stage, run: (read: Read) => Result): Result => {
  const state = openState(stage, "Stage.read");
  assertReadCanRun(state.realm, "Stage.read");
  return inWindow(state.realm, () => {
    (state.realm.stack as Stack | undefined)?.prepare(state);
    return readThrough(state, run);
  });
};

const readThrough = <Result>(state: StageState, run: (read: Read) => Result): Result => {
  const session: Session = { open: true, writable: false, journal: new Journal() };
  const read = stageReader(state, session);
  try {
    return asPlace(
      state,
      {
        read,
        write: stageWriter(state, session, read),
        undoOnThrow: (run) => undoOnThrow(state, session, run),
      },
      () => run(read),
    );
  } finally {
    session.open = false;
  }
};

/**
 * What `run` returns, reading the realm's values, as `Realm.untracked` does: the
 * stage is ignored, so the work compares the stage with the realm. Throws
 * where `Stage.read` does.
 */
export const realmRead = <Result>(stage: Stage, run: (read: Read) => Result): Result => {
  const state = openState(stage, "Stage.realmRead");
  const realm = state.realm;
  assertReadCanRun(realm, "Stage.realmRead");
  return inWindow(realm, () => readRealm(realm, run));
};

const readRealm = <Result>(realm: ObservableRealm, run: (read: Read) => Result): Result => {
  const session = { open: true };
  try {
    return untracked(realm, (realmReader) => {
      function read<Value>(observable: Computed<Value>): Value;
      function read(atom: Atom): undefined;
      function read(observable: Computed<unknown> | Atom): unknown {
        if (!session.open) {
          throw keptError("read");
        }
        return realmReader(observable as Computed<unknown>);
      }
      const row = <Key, Value>(collection: Collection<Key, Value>, key: Key): Value | undefined => {
        if (!session.open) {
          throw keptError("read.row");
        }
        return realmReader.row(collection, key);
      };
      return run(withSnapshot(read, row));
    });
  } finally {
    session.open = false;
  }
};

/**
 * Replays the stage's recipes in order, then closes it and lands their final values.
 *
 * Over a realm, replay runs in a fresh overlay over its current values,
 * under the stage recipe guard. One `Realm.update` lands the final values and atom
 * marks without user code in its recipe, nested in an update already open.
 * A replay throw, including a refused write, drops the stage and reaches the
 * caller without changing the realm; the caller's update keeps its own
 * writes if it catches it. With `{ conflicts: "fail" }`, the stage's recorded
 * reads are checked first; a changed box or collection drops the stage and
 * throws `StageConflictError`, landing nothing. Final values equal to the
 * realm's values change no version and notify nobody.
 *
 * Over a parent stage, the replay runs against the parent, as one
 * `Stage.update` of every recipe: a throw leaves the parent as it was. The
 * parent keeps the recipes, and what the child read, for its own apply.
 *
 * An open child, or a call where `Realm.update` is refused, throws and leaves the
 * stage open. Apply or drop the child first. After landing, watch effects
 * and autoruns report errors to `onError`; the stage stays `"applied"`.
 * An enclosing update's rollback undoes the landing and marks the stage
 * `"dropped"`; an empty journal has no landing to undo and stays `"applied"`.
 */
export const applyStage = (stage: Stage): void => {
  const state = openState(stage, "Stage.apply");
  assertUpdateCanRun(state.realm, "Stage.apply");
  if (state.children.size > 0) {
    throw new PinnaUsageError(
      "pinna/stage-child-open",
      `pinna: Stage.apply runs on ${describeStage(state)} while a child stage of it is open; apply or drop the child first`,
    );
  }
  try {
    inWindow(state.realm, () => {
      applyIn(state);
    });
  } finally {
    noteStageChange(state.realm);
  }
};

const applyIn = (state: StageState): void => {
  const journal = state.journal;
  const parent = state.parent;
  const stack = state.realm.stack as Stack | undefined;
  if (parent !== undefined) {
    const priorReads = parent.reads === undefined ? undefined : new Map(parent.reads);
    try {
      // A child of a stopped visible stage throws its root's error.
      stack?.prepare(parent);
      runRecipes(parent, journal);
    } catch (error) {
      parent.reads = priorReads;
      close(state, "dropped");
      throw error;
    }
    // Replay and the child's earlier decisions must agree on one version.
    const reads = state.reads;
    const parentReads = parent.reads;
    if (reads !== undefined && parentReads !== undefined) {
      for (const [box, read] of reads) {
        recordRead(parent, box, read.observable, read.version);
      }
    }
    if (parent.visible) stack?.updated(parent);
    close(state, "applied");
    return;
  }
  const realm = state.realm;
  if (state.visible) {
    if (!state.showing) {
      // A stopped stage throws what made it stop, and is dropped.
      const failure = state.failure;
      close(state, "dropped");
      throw failure;
    }
    // Off the stack first: the stage replays over the base alone.
    stack?.leave(state);
  }
  const conflict = findConflict(state);
  if (conflict !== undefined) {
    close(state, "dropped");
    throw conflict;
  }
  if (journal.length === 0) {
    close(state, "applied");
    return;
  }
  const replay = new StageState(realm, undefined, state.name, "replay", true);
  let land: () => void = () => undefined;
  try {
    runRecipes(replay, journal, () => {
      land = prepareLanding(replay, state.visible ? stack : undefined);
    });
  } catch (error) {
    close(replay, "dropped");
    close(state, "dropped");
    throw error;
  }
  if (state.visible) stack?.keepMarks(state);
  close(state, "applied");
  try {
    update(realm, () => {
      realm.recordUndo(() => {
        state.status = "dropped";
      });
      noteStage(realm, state.name);
      land();
    });
  } finally {
    close(replay, "applied");
  }
};

/**
 * Closes the stage, and its open children, and discards what they hold. No
 * box changes and no watcher runs. A stage already closed is left as it is,
 * so a cleanup drops whether or not the work applied.
 */
export const dropStage = (stage: Stage): void => {
  const state = stage as StageState;
  if (state.status !== "open") {
    return;
  }
  const open = openState(stage, "Stage.drop");
  try {
    if (open.visible) {
      // The stages above replay without it, in one update.
      inWindow(open.realm, () => close(open, "dropped"));
      return;
    }
    close(open, "dropped");
  } finally {
    noteStageChange(open.realm);
  }
};

/** Where the stage is in its life: `"open"`, `"applied"`, or `"dropped"`. */
export const stageStatus = (stage: Stage): StageStatus => {
  const state = stage as StageState;
  assertNotInRecipe(state.realm, "Stage.status");
  return state.status;
};

/**
 * What the stage read and `Stage.apply` checks, by name, once per box or
 * collection: a collection records two boxes, and two unnamed boxes are two
 * entries.
 */
const readNames = (state: StageState): ReadonlyArray<string> => {
  const names: Array<string> = [];
  const seen = new Set<object>();
  for (const [box, read] of state.reads ?? []) {
    if (!seen.has(read.observable)) {
      seen.add(read.observable);
      names.push(describeRead(read.observable, box));
    }
  }
  return names;
};

/** The stage's name, realm, parent, status, and what it holds now. */
export const inspectStage = (stage: Stage): StageInspection => {
  const state = stage as StageState;
  assertNotInRecipe(state.realm, "Stage.inspect");
  const orders = new Set<BoxCell<unknown>>();
  for (const collection of state.rows.keys()) {
    orders.add(collection.orderCell as BoxCell<unknown>);
  }
  const boxes: Array<string> = [];
  for (const box of state.boxes.keys()) {
    if (!orders.has(box)) {
      boxes.push(nameOf(box.source));
    }
  }
  return {
    name: state.name,
    realm: state.realm.name,
    parent: state.parent === undefined ? undefined : (state.parent.name ?? "<anonymous>"),
    status: state.status,
    conflicts: state.conflicts,
    boxes,
    collections: [...state.rows.keys()].map((collection) => collection.name ?? "a collection"),
    read: readNames(state),
    recipes: state.journal.length,
    children: state.children.size,
    visible: state.visible,
    showing: state.status === "open" && state.showing,
    failure: state.failure,
  };
};
