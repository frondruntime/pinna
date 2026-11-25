/**
 * A stage's rows of one collection, without a copy. A patch holds the
 * stage's own writes over the rows beneath it: the collection's base rows,
 * or the patch of the stage beneath. It shows the rows beneath as they were
 * when it began, as the copy it replaces did: before the rows beneath change
 * a key, they hand the patch the row the key had, and it keeps that row.
 * A base change costs one entry per key per open patch; a whole replace
 * beneath saves every row once.
 */
import type { UndoTarget } from "./journal.ts";

/** A key the stage removed, in `own`. */
export const removedRow: unique symbol = Symbol("removed row");

/** A key that was missing beneath when the patch began, in `saved`. */
const absentRow: unique symbol = Symbol("absent row");

/** What a patch reads through: the rows beneath it, and the patches that read through it. */
export interface RowLayer<Key, Value> {
  /** The rows as this layer shows them now. */
  rowsNow(): ReadonlyMap<Key, Value>;
  /** The patches over this layer, `undefined` when there are none. */
  patches: Set<RowPatch<Key, Value>> | undefined;
}

/** Tells each patch over `layer` that `key` is about to change there, with the row it shows now. */
export const beforeKeyChanges = <Key, Value>(layer: RowLayer<Key, Value>, key: Key): void => {
  const patches = layer.patches;
  if (patches === undefined) return;
  const rows = layer.rowsNow();
  const present = rows.has(key);
  const row = rows.get(key);
  for (const patch of patches) patch.save(key, present, row);
};

/** Tells each patch over `layer` that every key is about to change there: each keeps every row. */
export const beforeAllChange = <Key, Value>(layer: RowLayer<Key, Value>): void => {
  const patches = layer.patches;
  if (patches === undefined) return;
  const rows = layer.rowsNow();
  for (const patch of [...patches]) patch.freeze(rows);
};

export class RowPatch<Key, Value> implements ReadonlyMap<Key, Value>, RowLayer<Key, Value> {
  /** The stage's own writes: a row, or `removedRow`. */
  readonly own = new Map<Key, Value | typeof removedRow>();
  /** The row each key had beneath when the patch began, for the keys beneath changed since. */
  private saved: Map<Key, Value | typeof absentRow> | undefined = undefined;
  /** The layer it reads through, `undefined` once it no longer does: `saved` then holds every row. */
  private beneath: RowLayer<Key, Value> | undefined;
  patches: Set<RowPatch<Key, Value>> | undefined = undefined;
  /** Set when its stage let go of it: it leaves the layer beneath once no patch reads through it. */
  private retired = false;

  /**
   * Over `beneath`; or, with `rows`, a whole replace: the patch holds every
   * row itself and reads through nothing.
   */
  constructor(beneath: RowLayer<Key, Value> | undefined, rows?: ReadonlyMap<Key, Value>) {
    this.beneath = beneath;
    if (rows !== undefined) {
      this.saved = new Map();
      for (const [key, row] of rows) this.own.set(key, row);
    } else if (beneath !== undefined) {
      if (beneath.patches === undefined) beneath.patches = new Set();
      beneath.patches.add(this);
    }
  }

  /** The row `key` had beneath when the patch began: kept once, before the first change beneath. */
  save(key: Key, present: boolean, row: Value | undefined): void {
    let saved = this.saved;
    if (saved === undefined) {
      saved = new Map();
      this.saved = saved;
    } else if (saved.has(key)) {
      return;
    }
    saved.set(key, present ? (row as Value) : absentRow);
  }

  /** Keeps every row beneath, as `rows` shows them, and stops reading through. */
  freeze(rows: ReadonlyMap<Key, Value>): void {
    const beneath = this.beneath;
    if (beneath === undefined) return;
    let saved = this.saved;
    if (saved === undefined) {
      saved = new Map();
      this.saved = saved;
    }
    for (const [key, row] of rows) {
      if (!saved.has(key)) saved.set(key, row);
    }
    this.beneath = undefined;
    beneath.patches?.delete(this);
    // A key missing from `saved` was missing beneath: `beneath` is gone, so it reads as absent.
  }

  /** The row `key` shows beneath this patch's own writes. */
  private under(key: Key): { readonly present: boolean; readonly row: Value | undefined } {
    const saved = this.saved;
    if (saved !== undefined && saved.has(key)) {
      const row = saved.get(key);
      return row === absentRow ? missingUnder : { present: true, row: row as Value };
    }
    const beneath = this.beneath;
    if (beneath === undefined) return missingUnder;
    const rows = beneath.rowsNow();
    return rows.has(key) ? { present: true, row: rows.get(key) } : missingUnder;
  }

  get(key: Key): Value | undefined {
    const own = this.own;
    if (own.has(key)) {
      const row = own.get(key);
      return row === removedRow ? undefined : (row as Value);
    }
    const saved = this.saved;
    if (saved !== undefined && saved.has(key)) {
      const row = saved.get(key);
      return row === absentRow ? undefined : (row as Value);
    }
    return this.beneath?.rowsNow().get(key);
  }

  has(key: Key): boolean {
    const own = this.own;
    if (own.has(key)) return own.get(key) !== removedRow;
    return this.under(key).present;
  }

  /** The rows as this patch shows them: for a patch over it. */
  rowsNow(): ReadonlyMap<Key, Value> {
    return this;
  }

  /** Puts `row` under `key`, or removes the key with `removedRow`; the patches over it keep what it showed. */
  set(key: Key, row: Value | typeof removedRow): void {
    beforeKeyChanges(this, key);
    this.own.set(key, row);
  }

  /** A journal step on the patch: puts back the own write of `key`, `missing`-like `undefined` when there was none. */
  readonly target: UndoTarget = {
    undo: (key, had, row) => {
      beforeKeyChanges(this, key as Key);
      if (had === true) {
        this.own.set(key as Key, row as Value | typeof removedRow);
      } else {
        this.own.delete(key as Key);
      }
    },
  };

  /** Lets go of the layer beneath once no patch reads through this one. */
  retire(): void {
    this.retired = true;
    this.leaveIfUnread();
  }

  private leaveIfUnread(): void {
    if (!this.retired || (this.patches !== undefined && this.patches.size > 0)) return;
    const beneath = this.beneath;
    if (beneath === undefined) return;
    this.beneath = undefined;
    beneath.patches?.delete(this);
    if (beneath instanceof RowPatch) beneath.leaveIfUnread();
  }

  get size(): number {
    let size = 0;
    for (const _ of this.keys()) size++;
    return size;
  }

  *entries(): MapIterator<[Key, Value]> {
    const own = this.own;
    const saved = this.saved;
    const beneath = this.beneath?.rowsNow();
    // The rows beneath in their order, as a copy would hold them, then the keys beneath lost, then the keys added.
    if (beneath !== undefined) {
      for (const [key, row] of beneath) {
        if (own.has(key)) {
          const mine = own.get(key);
          if (mine !== removedRow) yield [key, mine as Value];
        } else if (saved !== undefined && saved.has(key)) {
          const kept = saved.get(key);
          if (kept !== absentRow) yield [key, kept as Value];
        } else {
          yield [key, row];
        }
      }
    }
    if (saved !== undefined) {
      for (const [key, kept] of saved) {
        if (beneath !== undefined && beneath.has(key)) continue;
        if (own.has(key)) {
          const mine = own.get(key);
          if (mine !== removedRow) yield [key, mine as Value];
        } else if (kept !== absentRow) {
          yield [key, kept as Value];
        }
      }
    }
    for (const [key, mine] of own) {
      if (mine === removedRow) continue;
      if (beneath !== undefined && beneath.has(key)) continue;
      if (saved !== undefined && saved.has(key)) continue;
      yield [key, mine as Value];
    }
  }

  *keys(): MapIterator<Key> {
    for (const [key] of this.entries()) yield key;
  }

  *values(): MapIterator<Value> {
    for (const [, row] of this.entries()) yield row;
  }

  [Symbol.iterator](): MapIterator<[Key, Value]> {
    return this.entries();
  }

  forEach(callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void): void {
    for (const [key, row] of this.entries()) callback(row, key, this);
  }
}

const missingUnder = { present: false, row: undefined } as const;

/**
 * A stage's key order without a copy: the order beneath, which nobody
 * changes in place once handed out, and the adds and removes the stage made
 * over it, newest first. Each change makes a new patch, so the stage's
 * journal puts back the one before. The array is built once, on the first
 * read.
 */
export class OrderPatch<Key> {
  private built: ReadonlyArray<Key> | undefined = undefined;

  private constructor(
    readonly base: ReadonlyArray<Key>,
    private readonly previous: OrderPatch<Key> | undefined,
    /** `"start"` or `"end"` for an add there, `"remove"` for a remove. */
    private readonly operation: "start" | "end" | "remove" | undefined,
    private readonly key: Key | undefined,
  ) {}

  /** No change yet over `base`. */
  static over<Key>(base: ReadonlyArray<Key>): OrderPatch<Key> {
    return new OrderPatch(base, undefined, undefined, undefined);
  }

  /** The patch with `key` added at the start or the end: the key is absent here. */
  add(key: Key, at: "start" | "end"): OrderPatch<Key> {
    return new OrderPatch(this.base, this, at, key);
  }

  /** The patch with `key` removed: the key is present here. */
  remove(key: Key): OrderPatch<Key> {
    return new OrderPatch(this.base, this, "remove", key);
  }

  /** The order this patch shows. */
  array(): ReadonlyArray<Key> {
    const built = this.built;
    if (built !== undefined) return built;
    if (this.operation === undefined) return this.base;
    const changes: Array<OrderPatch<Key>> = [];
    for (let patch: OrderPatch<Key> | undefined = this; patch !== undefined; ) {
      if (patch.operation === undefined) break;
      changes.push(patch);
      patch = patch.previous;
    }
    // Keys added at the start, last added first; at the end, in order; and base keys removed.
    const starts: Array<Key> = [];
    const ends: Array<Key> = [];
    let removed: Set<Key> | undefined;
    for (let index = changes.length - 1; index >= 0; index--) {
      const change = changes[index] as OrderPatch<Key>;
      const key = change.key as Key;
      if (change.operation === "start") {
        starts.push(key);
      } else if (change.operation === "end") {
        ends.push(key);
      } else {
        const atStart = starts.lastIndexOf(key);
        if (atStart !== -1) {
          starts.splice(atStart, 1);
          continue;
        }
        const atEnd = ends.lastIndexOf(key);
        if (atEnd !== -1) {
          ends.splice(atEnd, 1);
          continue;
        }
        if (removed === undefined) removed = new Set();
        removed.add(key);
      }
    }
    const base = this.base;
    let result: Array<Key>;
    if (removed === undefined) {
      result = starts.length === 0 ? base.slice() : starts.reverse().concat(base);
    } else {
      result = starts.reverse();
      const gone = removed;
      for (const key of base) {
        if (!gone.has(key)) result.push(key);
      }
    }
    for (const key of ends) result.push(key);
    this.built = result;
    return result;
  }
}

/** The array an order box holds in a stage: built from its patch when it holds one. */
export const orderValue = (value: unknown): unknown =>
  value instanceof OrderPatch ? value.array() : value;
