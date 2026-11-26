/**
 * Visible stages: the stack, the window, and the replay. The open visible
 * stages of a realm form a stack that shows their writes in the realm's
 * cells at rest and gives the base back for the length of every outermost
 * update (`docs/design.md`, "Stages").
 */
import { isPinnaError, nextPlace, peekCell, placeKind } from "@frondruntime/pinna-core";
import type { AtomCell, BoxCell, Realm } from "./box.ts";
import type { KeyedCollection } from "./collection.ts";
import { orderValue } from "./patch.ts";
import { type ObservableRealm, sendStackReports, update, type VisibleStack } from "./realm.ts";
import {
  clearOverlay,
  findConflict,
  noteStageChange,
  readVersion,
  runRecipes,
  type StageState,
} from "./stage.ts";

/** A covered box: its base value and version, and the value and version shown at rest. */
interface UnderBox {
  readonly baseValue: unknown;
  readonly baseVersion: number;
  readonly shownValue: unknown;
  readonly shownVersion: number;
}

/**
 * A covered key of a collection: the cell a reader made for it, if any, the
 * row it shows, and its base row. The rows held hold the shown row at rest
 * and the base row in the window.
 */
interface UnderKey {
  cell: BoxCell<unknown> | undefined;
  readonly shownPresent: boolean;
  shownValue: unknown;
  shownVersion: number;
  basePresent: boolean;
  baseRow: unknown;
}

/** A covered collection: each key the stack wrote, and the base rows as a view at rest. */
interface UnderRows {
  readonly keys: Map<unknown, UnderKey>;
  readonly base: BaseRows;
  /** The version of `changesCell` in the base when the rows were shown. */
  readonly baseChanges: number;
}

/**
 * The base rows of a covered collection at rest, without a copy: the rows
 * held, which show the stack's rows, with each key the stack wrote read from
 * its base row. A stage's patch reads through it, and the change stream
 * reads the base from it.
 */
class BaseRows implements ReadonlyMap<unknown, unknown> {
  constructor(
    private readonly collection: KeyedCollection<unknown, unknown>,
    private readonly written: ReadonlyMap<unknown, UnderKey>,
  ) {}

  /** The rows held: read each time, as a whole replace in the window puts a new map there. */
  private get held(): ReadonlyMap<unknown, unknown> {
    return this.collection.heldRows();
  }

  get(key: unknown): unknown {
    const under = this.written.get(key);
    if (under === undefined) return this.held.get(key);
    return under.basePresent ? under.baseRow : undefined;
  }

  has(key: unknown): boolean {
    const under = this.written.get(key);
    return under === undefined ? this.held.has(key) : under.basePresent;
  }

  get size(): number {
    let size = this.held.size;
    for (const under of this.written.values()) {
      if (under.basePresent !== under.shownPresent) size += under.basePresent ? 1 : -1;
    }
    return size;
  }

  *entries(): MapIterator<[unknown, unknown]> {
    const written = this.written;
    for (const entry of this.held) {
      const under = written.get(entry[0]);
      if (under === undefined) yield entry;
      else if (under.basePresent) yield [entry[0], under.baseRow];
    }
    for (const [key, under] of written) {
      if (under.basePresent && !under.shownPresent) yield [key, under.baseRow];
    }
  }

  *keys(): MapIterator<unknown> {
    for (const [key] of this.entries()) yield key;
  }

  *values(): MapIterator<unknown> {
    for (const [, row] of this.entries()) yield row;
  }

  [Symbol.iterator](): MapIterator<[unknown, unknown]> {
    return this.entries();
  }

  forEach(
    callback: (value: unknown, key: unknown, map: ReadonlyMap<unknown, unknown>) => void,
  ): void {
    for (const [key, row] of this.entries()) callback(row, key, this);
  }
}

const restoreIfMoved = (cell: BoxCell<unknown>, value: unknown, version: number): void => {
  if (!Object.is(peekCell(cell.source), value) || cell.source.version !== version) {
    cell.restore(value, version);
  }
};

/**
 * The open visible stages of a realm, bottom first, and what they cover.
 * Between updates every covered cell holds the shown value: the base with
 * each showing stage's journal replayed over it, bottom first. For the
 * length of an outermost update, the window, it holds the base value and
 * base version, so every writer reads and writes the base and a write
 * records the base as its value before. Swapping is raw (`BoxCell.restore`),
 * never a write, so no update records a shown value and the change stream
 * sees base values alone.
 */
/**
 * A box's `equals` while the stack plans what it shows, under the stage
 * guard as a replay's comparisons are: an `equals` that updates or observes
 * throws at the checks the core already makes. A throw counts as unequal,
 * and reaches `onError` once the walk is over, as a stopped stage's error
 * does (`sendStackReports`): a handler that writes or drops a stage must not
 * change the stack under the plan.
 */
const same = (
  realm: ObservableRealm,
  box: BoxCell<unknown>,
  left: unknown,
  right: unknown,
): boolean => {
  const core = realm.core;
  const active = core.active;
  const outerPlace = core.place;
  core.active = undefined;
  core.place = nextPlace(outerPlace, placeKind.recipeEquals);
  try {
    return box.source.equals(left, right);
  } catch (error) {
    if (realm.stackReports === undefined) realm.stackReports = [error];
    else realm.stackReports.push(error);
    return false;
  } finally {
    core.active = active;
    core.place = outerPlace;
  }
};

export class Stack implements VisibleStack {
  readonly stages: Array<StageState> = [];
  private boxes = new Map<BoxCell<unknown>, UnderBox>();
  private rows = new Map<KeyedCollection<unknown, unknown>, UnderRows>();
  private atoms = new Set<AtomCell>();
  /** Atoms an applied stage showed: neither its landing nor its leaving marks them. */
  private readonly applied = new Set<AtomCell>();
  /** True while the cells hold the base. */
  window = false;
  /**
   * True while the stack writes cells raw (opening the window, showing
   * again, the install pass): no application code may run then. Read by
   * the stack's tests alone.
   */
  installing = false;
  /** The lowest stage whose overlay is out of date for a reason no input records. */
  private dirtyFrom = Number.POSITIVE_INFINITY;
  /** A replay ran or the stack changed in this window: the shown values are worked out again. */
  private changed = false;
  /** A stage stopped showing in this window: the realm's stage listeners hear it once the window closes. */
  private stopped = false;

  constructor(readonly realm: ObservableRealm) {}

  open(): void {
    if (this.window) return;
    this.window = true;
    this.installing = true;
    try {
      this.swapToBase();
    } finally {
      this.installing = false;
    }
  }

  /** The base back in every covered cell, raw. */
  private swapToBase(): void {
    for (const [box, under] of this.boxes) {
      restoreIfMoved(box, under.baseValue, under.baseVersion);
    }
    for (const [collection, under] of this.rows) {
      for (const [key, entry] of under.keys) {
        collection.putHeld(key, entry.basePresent, entry.baseRow);
        const made = collection.cellAt(key) as BoxCell<unknown> | undefined;
        const cell = made ?? entry.cell;
        if (cell === undefined) continue;
        if (cell !== entry.cell) {
          // Made by a reader at rest, from the shown row.
          entry.cell = cell;
          entry.shownValue = peekCell(cell.source);
          entry.shownVersion = cell.source.version;
        }
        const present = entry.basePresent;
        const value = present ? entry.baseRow : undefined;
        if (!Object.is(peekCell(cell.source), value)) {
          cell.restore(value, this.realm.core.nextCellVersion());
        }
        collection.placeCell(key, present ? (cell as BoxCell<unknown>) : undefined);
      }
    }
  }

  close(): void {
    // The cells hold the base here: the window opened, or the stack was
    // made in this update and covered nothing.
    this.window = true;
    this.refresh(this.stages.length - 1);
    if (this.changed) {
      this.show();
    } else {
      this.installing = true;
      try {
        this.reshow();
      } finally {
        this.installing = false;
      }
    }
    this.window = false;
    this.changed = false;
    this.dirtyFrom = Number.POSITIVE_INFINITY;
    this.applied.clear();
    if (this.stages.length === 0 && this.realm.stack === this) {
      this.realm.stack = undefined;
    }
    if (this.stopped) {
      this.stopped = false;
      noteStageChange(this.realm);
    }
  }

  dispose(): void {
    this.open();
    this.boxes = new Map();
    this.rows = new Map();
    this.atoms = new Set();
    this.window = false;
    this.stages.length = 0;
    if (this.realm.stack === this) {
      this.realm.stack = undefined;
    }
  }

  invalidate(): void {
    this.dirtyFrom = 0;
  }

  covering(box: BoxCell<unknown>): ReadonlyArray<string> {
    const names: Array<string> = [];
    for (const stage of this.stages) {
      if (stage.showing && stage.boxes.has(box)) names.push(stage.name ?? "<anonymous>");
    }
    return names;
  }

  /** The base value and version of `box`: the cell's own outside what the stack covers, and in the window. */
  baseOf(box: BoxCell<unknown>): { readonly value: unknown; readonly version: number } {
    const under = this.window ? undefined : this.boxes.get(box);
    return under === undefined
      ? { value: peekCell(box.source), version: box.source.version }
      : { value: under.baseValue, version: under.baseVersion };
  }

  /** The box whose graph node is `node`, when the stack covers it: for devtools, which holds nodes. */
  boxOfNode(node: object): BoxCell<unknown> | undefined {
    for (const box of this.boxes.keys()) {
      if (box.source === node) return box;
    }
    return undefined;
  }

  /** The base rows of a covered collection at rest, when it shows others; `undefined` otherwise. */
  baseRows(collection: object): ReadonlyMap<unknown, unknown> | undefined {
    if (this.window) return undefined;
    return this.rows.get(collection as KeyedCollection<unknown, unknown>)?.base;
  }

  /**
   * The value and version shown at rest when `value` equals the value shown
   * there by the box's `equals`, for a landing: the shown value lands with
   * the version readers hold, so applying the stage reruns nobody.
   */
  shownMatch(
    box: BoxCell<unknown>,
    value: unknown,
  ): { readonly value: unknown; readonly version: number } | undefined {
    const under = this.boxes.get(box);
    if (under === undefined) return undefined;
    return Object.is(under.shownValue, value) || box.source.equals(under.shownValue, value)
      ? { value: under.shownValue, version: under.shownVersion }
      : undefined;
  }

  showsAtom(atom: AtomCell): boolean {
    return this.atoms.has(atom);
  }

  /** Puts a stage on top. */
  push(state: StageState): void {
    this.stages.push(state);
  }

  /** Takes a stage off the stack: the stages above it replay without it. */
  leave(state: StageState): void {
    const index = this.stages.indexOf(state);
    if (index === -1) return;
    this.stages.splice(index, 1);
    this.dirtyFrom = Math.min(this.dirtyFrom, index);
    this.changed = true;
  }

  /**
   * `Stage.apply` of `state` replayed over the base and is about to land:
   * the marks it showed stay landed, so the shown set does not withdraw
   * them. Called only then, so an apply that fails withdraws its marks as a
   * drop does.
   */
  keepMarks(state: StageState): void {
    for (const atom of state.atoms) {
      if (this.atoms.has(atom)) this.applied.add(atom);
    }
  }

  /** A stage call on `state` reads through its root: brings the root's overlay up to date. */
  prepare(state: StageState): void {
    const root = state.root;
    if (!root.visible) return;
    const index = this.stages.indexOf(root);
    if (index !== -1) this.refresh(index);
    if (this.realm.stackReports !== undefined && this.realm.updateDepth === 0) {
      sendStackReports(this.realm);
    }
    // `showing`, not the error, says a stage stopped: a recipe can throw `undefined`.
    if (root.status === "open" && !root.showing) throw root.failure;
  }

  /** Links each stage up to `upTo` to the nearest showing stage beneath it. */
  private link(upTo: number): void {
    let below: StageState | undefined;
    for (let index = 0; index <= upTo; index++) {
      const stage = this.stages[index] as StageState;
      stage.below = below;
      if (stage.showing) below = stage;
    }
  }

  /** `Stage.update` changed a visible stage's overlay: the stages above it replay. */
  updated(state: StageState): void {
    const index = this.stages.indexOf(state);
    if (index === -1) return;
    this.dirtyFrom = Math.min(this.dirtyFrom, index + 1);
    this.changed = true;
  }

  /** Whether a change to the base since the stage's last replay reached something it read or wrote. */
  private stale(state: StageState): boolean {
    if (!state.showing) return false;
    for (const [cell, version] of state.inputs ?? []) {
      if (cell.source.version !== version) return true;
    }
    for (const [cell, read] of state.reads ?? []) {
      if (readVersion(cell) !== read.version) return true;
    }
    return false;
  }

  /** Replays every stage up to `upTo` from the lowest one out of date. */
  private refresh(upTo: number): void {
    this.link(upTo);
    let from = Math.min(this.dirtyFrom, upTo + 1);
    for (let index = 0; index < from; index++) {
      if (this.stale(this.stages[index] as StageState)) {
        from = index;
        break;
      }
    }
    if (from > upTo) return;
    for (let index = from; index <= upTo; index++) {
      this.replay(index);
    }
    this.changed = true;
    this.dirtyFrom = upTo + 1 < this.stages.length ? upTo + 1 : Number.POSITIVE_INFINITY;
  }

  /** Rules 1 to 4 for one visible stage, over the base and the showing stages below it. */
  private replay(index: number): void {
    const state = this.stages[index] as StageState;
    if (!state.showing) return;
    const conflict = findConflict(state);
    if (conflict !== undefined) {
      this.stop(state, conflict);
      return;
    }
    clearOverlay(state);
    const journal = state.journal;
    const reads = state.reads;
    state.journal = [];
    // Under "fail", the replay records what it reads apart: a box it reads
    // or writes for the first time, such as through a branch a stage below
    // now opens, joins the stage's reads at its version now, and the
    // versions read first stay. A replay that throws adds nothing.
    const replayReads: typeof reads = reads === undefined ? undefined : new Map();
    state.reads = replayReads;
    state.inputs = new Map();
    let failed = true;
    try {
      runRecipes(state, journal);
      failed = false;
    } catch (error) {
      state.journal = journal;
      this.stop(state, error);
    } finally {
      state.reads = reads;
      if (!failed && reads !== undefined && replayReads !== undefined) {
        for (const [cell, read] of replayReads) {
          if (!reads.has(cell)) reads.set(cell, read);
        }
      }
    }
  }

  /** Rule 5: the stage stops showing, for good, and keeps the error its next call throws. */
  private stop(state: StageState, error: unknown): void {
    this.stopped = true;
    state.showing = false;
    state.failure = error;
    state.below = undefined;
    state.inputs = undefined;
    clearOverlay(state);
    this.changed = true;
    // The stages above read past it from now on.
    this.link(this.stages.length - 1);
    if (!isPinnaError(error, "StageConflictError")) {
      // A guess that is never applied would hide a broken recipe for good.
      // Sent once the walk is over (`sendStackReports`): a handler that
      // writes or drops a stage must not change the stack under the walk.
      const realm = this.realm;
      if (realm.stackReports === undefined) realm.stackReports = [error];
      else realm.stackReports.push(error);
    }
  }

  /** The cells shown again as they were: nothing under the stack changed. */
  private reshow(): void {
    for (const [box, under] of this.boxes) {
      restoreIfMoved(box, under.shownValue, under.shownVersion);
    }
    for (const [collection, under] of this.rows) {
      const held = collection.heldRows();
      for (const [key, entry] of under.keys) {
        // A write in the window may have changed the base row.
        entry.basePresent = held.has(key);
        entry.baseRow = held.get(key);
        collection.putHeld(key, entry.shownPresent, entry.shownValue);
        const cell = (collection.cellAt(key) as BoxCell<unknown> | undefined) ?? entry.cell;
        if (cell === undefined) continue;
        if (cell === entry.cell) {
          restoreIfMoved(cell, entry.shownValue, entry.shownVersion);
        } else {
          cell.restore(entry.shownValue, this.realm.core.nextCellVersion());
          entry.cell = cell;
          entry.shownVersion = cell.source.version;
        }
        collection.placeCell(key, entry.shownPresent ? (cell as BoxCell<unknown>) : undefined);
      }
    }
  }

  /**
   * Works out what each covered cell shows from the stages' overlays, then
   * shows it, in two passes. The plan pass makes every `equals` call and no
   * raw write; the install pass makes raw writes alone. So no application
   * code runs between the first and the last raw install, and the cells
   * never stand half shown where a box's `equals` could read them.
   */
  private show(): void {
    const plan = this.plan();
    this.install(plan.boxes, plan.rows, plan.atoms);
  }

  /** The plan pass: the shown value and version of every covered cell. Writes nothing. */
  private plan(): {
    readonly boxes: Map<BoxCell<unknown>, UnderBox>;
    readonly rows: Map<KeyedCollection<unknown, unknown>, UnderRows>;
    readonly atoms: Set<AtomCell>;
  } {
    const core = this.realm.core;
    const top = new Map<BoxCell<unknown>, unknown>();
    const topRows = new Map<
      KeyedCollection<unknown, unknown>,
      { rows: ReadonlyMap<unknown, unknown>; readonly keys: Set<unknown> }
    >();
    const atoms = new Set<AtomCell>();
    for (const stage of this.stages) {
      if (!stage.showing) continue;
      for (const [box, value] of stage.boxes) top.set(box, orderValue(value));
      for (const [collection, rows] of stage.rows) {
        const entry = topRows.get(collection);
        if (entry === undefined) {
          topRows.set(collection, { rows, keys: new Set() });
        } else {
          entry.rows = rows;
        }
      }
      for (const [collection, keys] of stage.rowWrites) {
        const entry = topRows.get(collection);
        if (entry !== undefined) for (const key of keys) entry.keys.add(key);
      }
      for (const atom of stage.atoms) atoms.add(atom);
    }
    const boxes = new Map<BoxCell<unknown>, UnderBox>();
    const settle = (box: BoxCell<unknown>, value: unknown, fresh: boolean): void => {
      const baseValue = peekCell(box.source);
      const baseVersion = box.source.version;
      const previous = this.boxes.get(box);
      let shownValue = value;
      let shownVersion: number;
      if (previous !== undefined && !fresh && same(this.realm, box, previous.shownValue, value)) {
        // The value shown before stays, with its version: nobody reruns.
        shownValue = previous.shownValue;
        shownVersion = previous.shownVersion;
      } else if (!fresh && same(this.realm, box, baseValue, value)) {
        shownValue = baseValue;
        shownVersion = baseVersion;
      } else {
        shownVersion = core.nextCellVersion();
      }
      boxes.set(box, { baseValue, baseVersion, shownValue, shownVersion });
    };
    for (const [box, value] of top) settle(box, value, false);
    const rows = new Map<KeyedCollection<unknown, unknown>, UnderRows>();
    for (const [collection, { rows: staged, keys }] of topRows) {
      // The rows held change in place, at the keys the stack wrote alone.
      const held = collection.heldRows();
      const previous = this.rows.get(collection);
      const changes = collection.changesCell as BoxCell<unknown>;
      const baseChanges = changes.source.version;
      let moved =
        previous === undefined ||
        previous.baseChanges !== baseChanges ||
        previous.keys.size !== keys.size;
      const entries = new Map<unknown, UnderKey>();
      for (const key of keys) {
        const before = previous?.keys.get(key);
        const present = staged.has(key);
        const value = present ? staged.get(key) : undefined;
        if (before === undefined || !Object.is(before.shownValue, value)) moved = true;
        const cell =
          (collection.cellAt(key) as BoxCell<unknown> | undefined) ??
          (before?.cell !== undefined && !held.has(key) ? before.cell : undefined);
        let version = 0;
        if (cell !== undefined) {
          version =
            before !== undefined && before.cell === cell && Object.is(before.shownValue, value)
              ? before.shownVersion
              : Object.is(peekCell(cell.source), value)
                ? cell.source.version
                : core.nextCellVersion();
        }
        entries.set(key, {
          cell,
          shownPresent: present,
          shownValue: value,
          shownVersion: version,
          basePresent: held.has(key),
          baseRow: held.get(key),
        });
      }
      // `rows` reads `changesCell`: its shown version moves when the shown rows do.
      settle(changes, peekCell(changes.source), moved);
      rows.set(collection, { keys: entries, base: new BaseRows(collection, entries), baseChanges });
    }
    return { boxes, rows, atoms };
  }

  /**
   * The install pass: raw writes alone (`BoxCell.restore`, the rows held,
   * a key's cell, an atom's mark), each of which only marks the graph
   * inside the update's batch. No `equals`, listener, recipe, or `onError`
   * runs here; `installing` says so to the stack's tests.
   */
  private install(
    boxes: Map<BoxCell<unknown>, UnderBox>,
    rows: Map<KeyedCollection<unknown, unknown>, UnderRows>,
    atoms: Set<AtomCell>,
  ): void {
    this.installing = true;
    try {
      for (const [collection, under] of rows) {
        for (const [key, entry] of under.keys) {
          const cell = entry.cell;
          if (cell === undefined) continue;
          restoreIfMoved(cell, entry.shownValue, entry.shownVersion);
          collection.placeCell(key, entry.shownPresent ? cell : undefined);
        }
        for (const [key, entry] of under.keys) {
          collection.putHeld(key, entry.shownPresent, entry.shownValue);
        }
      }
      for (const [box, under] of boxes) {
        restoreIfMoved(box, under.shownValue, under.shownVersion);
      }
      this.boxes = boxes;
      this.rows = rows;
      // An atom marks when its mark enters the shown set and when it leaves
      // by a drop or a stop, never again at apply.
      const shownAtoms = this.atoms;
      this.atoms = atoms;
      for (const atom of atoms) {
        if (!shownAtoms.has(atom)) atom.mark();
      }
      for (const atom of shownAtoms) {
        if (!atoms.has(atom) && !this.applied.has(atom)) atom.mark();
      }
    } finally {
      this.installing = false;
    }
  }
}

/**
 * Runs a stage call where the realm's covered cells hold the base: inside a
 * `Realm.update` while a visible stage is open, so the call reads base
 * values and base versions through the code that exists. Its error reaches
 * the caller after the stack shows again, not as a rollback.
 */
export const inWindow = <Result>(realm: ObservableRealm, run: () => Result): Result => {
  if (realm.stack === undefined) return run();
  let result: Result | undefined;
  let thrown = false;
  let failure: unknown;
  update(realm, () => {
    try {
      result = run();
    } catch (error) {
      thrown = true;
      failure = error;
    }
  });
  if (thrown) throw failure;
  return result as Result;
};

/** The base value and version of `box` while visible stages may cover it: for the change stream and tools. */
export const baseOf = (
  box: BoxCell<unknown>,
): { readonly value: unknown; readonly version: number } => {
  const stack = box.realm.stack as Stack | undefined;
  return stack === undefined
    ? { value: peekCell(box.source), version: box.source.version }
    : stack.baseOf(box);
};
/**
 * The names of the showing stages over the box whose graph node is `node`,
 * bottom first, and its base value; `undefined` when no visible stage covers
 * it. For devtools, which reaches boxes through the graph.
 */
export const coverOfNode = (
  realm: Realm,
  node: object,
): { readonly stages: ReadonlyArray<string>; readonly base: unknown } | undefined => {
  const stack = (realm as ObservableRealm).stack as Stack | undefined;
  const box = stack?.boxOfNode(node);
  if (stack === undefined || box === undefined) return undefined;
  const stages = stack.covering(box);
  return stages.length === 0 ? undefined : { stages, base: stack.baseOf(box).value };
};
