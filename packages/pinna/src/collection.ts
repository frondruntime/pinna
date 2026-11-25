/**
 * A keyed collection: a box for each key a reader reads and one for the
 * order of the keys, so a write to one row costs the readers of that row,
 * not the readers of the list. `Collection.make` makes one without a schema;
 * pinna-effect's `Model.collectionField` makes one a `Model.Schema` field, checked
 * by the field's schema.
 *
 * The rows live in a map, `held`, that holds exactly the present keys. A
 * key's cell is made from its row on the key's first read, so a load of rows
 * nobody reads alone makes no cell, and a write to a row with no cell checks
 * the row as a cell's write would. A reader of a key reads that key's cell,
 * or, while the key is missing, the order; a removed key's cell is set to
 * `undefined` before it leaves, so its readers rerun and find it gone. `rows`
 * reads the order and `Program.changes`, a box every change to `held` writes. Map
 * changes are put back by the realm when an update fails, like box writes.
 */

import {
  type Equals,
  forgetValue,
  PinnaUsageError,
  peekCell,
  readCell,
  restoreCell,
  touchSource,
} from "@frondruntime/pinna-core";
import {
  acceptAll,
  type BoxCell,
  type Check,
  type Collection,
  CollectionCell,
  type Computed,
  ComputedValue,
  checkName,
  computedFunction,
  nameSource,
  type Realm,
  verifyValue,
} from "./box.ts";
import { equalKey, hashKey, identityHash } from "./identity.ts";
import { deleteMember, deleteMembers, type UndoTarget } from "./journal.ts";
import { beforeAllChange, beforeKeyChanges, type RowPatch } from "./patch.ts";
import {
  assertNotInRecipe,
  assertUpdateCanRun,
  inRecipe,
  type ObservableRealm,
  orderOwners,
  type RecordedCollection,
  recipeMakeError,
  update,
  type VisibleStack,
} from "./realm.ts";
import { type CollectionChange, noteCollection } from "./record.ts";
import { collectionKey } from "./snapshot.ts";
import type { Read, StagedPlace, UpsertOptions, Write } from "./verbs.ts";

/**
 * The order of the keys notifies only when a key is added, removed, or
 * moved, and `rows` only when it holds another row.
 */
const sameElements = <Element>(
  previous: ReadonlyArray<Element>,
  next: ReadonlyArray<Element>,
): boolean => {
  // The same array holds the same elements: an elementwise pass would say so too.
  if (previous === next) {
    return true;
  }
  if (previous.length !== next.length) {
    return false;
  }
  for (let index = 0; index < next.length; index++) {
    if (!Object.is(previous[index], next[index])) {
      return false;
    }
  }
  return true;
};

/**
 * Where `key` sits in `keys`, found as the cells' `Map` finds a key: NaN
 * matches NaN, and 0 matches -0. `indexOf` is native, so a removal from
 * 10,000 keys costs a scan and a copy, not a closure call per key.
 */
const indexOfKey = <Key>(keys: ReadonlyArray<Key>, key: Key): number =>
  typeof key === "number" && Number.isNaN(key)
    ? keys.findIndex((kept) => typeof kept === "number" && Number.isNaN(kept))
    : keys.indexOf(key);

/** The first key that appears twice in `keys`, if any. */
export const repeatedKey = <Key>(keys: ReadonlyArray<Key>): { readonly key: Key } | undefined => {
  const seen = new Set<Key>();
  for (const key of keys) {
    if (seen.has(key)) {
      return { key };
    }
    seen.add(key);
  }
  return undefined;
};

/**
 * Names a key, or its type when it has no string form, such as an object
 * with no prototype: the name goes in a message that reports a rejected
 * key, and a throw while writing it would replace that message, and inside
 * an Effect schema filter turn a failure into a defect.
 */
export const keyName = (key: unknown): string => {
  try {
    return String(key);
  } catch {
    return `(an unprintable ${typeof key})`;
  }
};

export const repeatedKeyMessage = (key: unknown): string =>
  `pinna: the collection key ${keyName(key)} appears twice`;

const undefinedRow = (): PinnaUsageError =>
  new PinnaUsageError("pinna/undefined-row", "pinna: a collection row cannot be undefined");

/**
 * Plans the merge of `fresh` into `held` and writes nothing: `false` when
 * `fresh` replaces `held`, otherwise `held` stays, and the answer is the
 * writes that bring it to `fresh`, or `undefined` when there are none. It
 * reads `held`'s boxes through `read`, and its writes go through `write`: an
 * update's, or a stage recipe's, so a refetch merges through a stage too.
 */
export type Merge<Value> = (
  held: Value,
  fresh: Value,
  read: Read,
  write: Write,
) => (() => void) | undefined | false;

/**
 * What a computed value of a collection reads, for a stage: its own values
 * read the collection's internals, not the `read` they are handed, so a
 * stage reads the rows it holds in their place. `key` is `undefined` for
 * `rows`.
 */
export interface CollectionRead {
  readonly collection: KeyedCollection<unknown, unknown>;
  readonly all: boolean;
  readonly key: unknown;
}

/**
 * The first record of a key order changed in place: the order the update
 * began with is the array the box holds once the later changes are undone,
 * so nothing is copied to keep it. `OrderCell.before` builds it when asked.
 */
const unchangedOrder = Object.freeze({}) as ReadonlyArray<never>;

/** Undoes one change in place: `-1` an append, `-2` a prepend, an index a removal of `key` from it. */
const unchange = <Key>(order: Array<Key>, index: number, key: Key): void => {
  if (index === -1) {
    order.pop();
  } else if (index === -2) {
    order.shift();
  } else {
    order.splice(index, 0, key);
  }
};

/**
 * The key-order box, which `keys` is. The collection changes the array it
 * holds in place while `live` is that array; a read or a peek hands the
 * array out, so it clears `live` and the next write copies.
 */
class OrderCell<Key> extends CollectionCell<ReadonlyArray<Key>> {
  /**
   * The array the box holds while nothing outside the collection holds it,
   * `undefined` once anything may: a reader, a stage, the visible stack, or
   * the change stream. A write that finds it changes the order in place;
   * one that does not copies, and the copy is live.
   */
  declare live: Array<Key> | undefined;
  /**
   * Three slots for each change in place in the outermost update: the
   * operation, the key, and the box's version before it. A rollback takes
   * each back with its version; `before` undoes them on a copy.
   */
  declare log: Array<unknown>;
  /** The order's length when the outermost update began, while its first record is `unchangedOrder`. */
  declare startLength: number;
  /** The journal's target for a change in place, made on the first one. */
  declare target: UndoTarget | undefined;

  constructor(realm: ObservableRealm, keys: Array<Key>) {
    super(realm, acceptAll, keys, sameElements);
    this.live = keys;
    this.log = [];
    this.startLength = 0;
    this.target = undefined;
  }

  override read(): ReadonlyArray<Key> {
    this.live = undefined;
    return readCell(this.source);
  }

  override peek(): ReadonlyArray<Key> {
    this.live = undefined;
    return peekCell(this.source);
  }

  /**
   * The live array, while a change may be made in place: no update listener
   * needs the order before and no visible stage covers it. `undefined` when
   * the write copies.
   */
  inPlace(): Array<Key> | undefined {
    const live = this.live;
    const realm = this.realm;
    return live !== undefined &&
      live === peekCell(this.source) &&
      realm.updateListeners === undefined &&
      realm.stack === undefined
      ? live
      : undefined;
  }

  /**
   * Changes the live array in place: appends or prepends `key` (`index` -1
   * or -2), or removes it from `index`. Its first record keeps
   * `unchangedOrder`, a journal step puts the change back, and an order equal
   * to the one the update began with puts that version back, as a box's
   * write does.
   */
  change(live: Array<Key>, index: number, key: Key): void {
    const realm = this.realm;
    const source = this.source;
    if (this.nextRecorded === undefined) {
      realm.recordFirst(this as BoxCell<unknown>, unchangedOrder, source.version);
      this.log.length = 0;
      this.startLength = live.length;
    }
    this.log.push(index, key, source.version);
    if (index === -1) {
      live.push(key);
    } else if (index === -2) {
      live.unshift(key);
    } else {
      live.splice(index, 1);
    }
    this.target ??= { undo: (index, key) => this.undoChange(index as number, key as Key) };
    realm.step(this.target, index, key);
    const before = this.valueBefore as ReadonlyArray<Key>;
    const marked = before === unchangedOrder;
    if (live.length === (marked ? this.startLength : before.length)) {
      if (sameElements(marked ? this.before() : before, live)) {
        // A box's write that puts back its first value puts back its version.
        restoreCell(source, marked ? live : before, this.versionBefore);
        if (!marked) this.live = undefined;
        return;
      }
    }
    touchSource(source);
  }

  /** Puts back the last change in place, with the version the box had before it. */
  private undoChange(index: number, key: Key): void {
    const log = this.log;
    const version = log[log.length - 1] as number;
    log.length -= 3;
    const current = peekCell(this.source);
    const order = current === this.live ? (current as Array<Key>) : current.slice();
    unchange(order, index, key);
    this.live = order;
    restoreCell(this.source, order, version);
  }

  /** The order the outermost update began with, built from the live array and the log. */
  private before(): ReadonlyArray<Key> {
    const order = peekCell(this.source).slice();
    const log = this.log;
    for (let index = log.length - 3; index >= 0; index -= 3) {
      unchange(order, log[index] as number, log[index + 1] as Key);
    }
    return order;
  }

  /** Replaces `unchangedOrder` in the first record with the order it stands for: a caller reads `valueBefore`. */
  settleBefore(): void {
    if (this.nextRecorded !== undefined && this.valueBefore === unchangedOrder) {
      this.valueBefore = this.before();
    }
  }

  /** A rollback's or the visible stack's put-back; `unchangedOrder` keeps the array, its changes already undone. */
  override restore(value: unknown, version: number): void {
    restoreCell(
      this.source,
      value === unchangedOrder ? peekCell(this.source) : (value as ReadonlyArray<Key>),
      version,
    );
  }

  /** Writes a new order array, which the collection made and nobody holds yet. */
  replace(order: Array<Key>): void {
    this.settleBefore();
    this.write(order);
    this.live = order;
  }
}

/** The collection behind each `rows` and `row(key)` computed value, set once when it is made. */
export const collectionReads = new WeakMap<object, CollectionRead>();

/** The collection behind each key-order box, which `keys` is: a stage reports the collection, not the box. */
export const collectionOfOrder = new WeakMap<object, KeyedCollection<unknown, unknown>>();

/**
 * The rows a stage holds for one collection, and how it changes them: the
 * stage keeps them in its overlay, and puts them back when a recipe throws.
 */
export interface StagedRows<Key, Value> {
  readonly rows: ReadonlyMap<Key, Value>;
  readonly order: ReadonlyArray<Key>;
  /** Root replay normalizes existing row cells before listeners or later reads. */
  readonly cellValue?:
    | ((key: Key, cell: BoxCell<Value | undefined>, value: Value, current: Value) => Value)
    | undefined;
  setRow(key: Key, row: Value): void;
  deleteRow(key: Key): void;
  /** Adds `key`, absent from the rows, to the order at its start or end. */
  addKey(key: Key, at: "start" | "end"): void;
  /** Removes `key`, present in the rows, from the order. */
  removeKey(key: Key): void;
  setOrder(order: ReadonlyArray<Key>): void;
  setAll(rows: Map<Key, Value>, order: ReadonlyArray<Key>, written: ReadonlySet<Key>): void;
}

/**
 * One row as one write left it. `before` is `undefined` when the write added
 * the key, `after` when it removed it; a replaced row has both.
 */
export interface RowChange<Key, Value> {
  readonly key: Key;
  readonly before: Value | undefined;
  readonly after: Value | undefined;
}

/** What `Collection.onRowChange` calls: inside the writer's update, with its `read` and `write`. */
export type RowListener<Key, Value> = (
  change: RowChange<Key, Value>,
  read: Read,
  write: Write,
) => undefined;

const ignore = (): undefined => undefined;

/** A key the outermost update added: it had no row when the update began. */
const absent: unique symbol = Symbol("absent");

/** A step's row when the step made the key's cell: the rollback empties and drops it. */
const madeCell: unique symbol = Symbol("made cell");

/** A step's key when the step replaced every row: its row is the `held` map before. */
const replacedAll: unique symbol = Symbol("replaced all");

/** A step's row when the step let go of the key's cell and row computed: the rollback puts both back. */
class Forgotten {
  constructor(
    readonly cell: BoxCell<unknown> | undefined,
    readonly row: ComputedValue<unknown> | undefined,
  ) {}
}

export class KeyedCollection<Key, Value> implements Collection<Key, Value>, RecordedCollection {
  readonly keys: Computed<ReadonlyArray<Key>>;
  /** The key order: a write changes it in place while its `live` is the array it holds. */
  private readonly order: OrderCell<Key>;
  /**
   * The row of every present key. A key is present exactly while it is here,
   * and a key's cell, when it has one, holds the same row.
   */
  private held: Map<Key, Value>;
  /** The cell of each present key a reader read. A cell holds `undefined` only once its key is removed. */
  private readonly cells = new Map<Key, BoxCell<Value | undefined>>();
  /**
   * Written by every write that changes `held`: what `rows` reads instead of
   * a cell per key, and what tells `cellOf` that the open update changed
   * `held`.
   */
  private readonly changes: BoxCell<number>;
  /** The check of a row about to land, and of a cell's write. */
  private readonly check: Check;
  private readonly cellCheck: Check;
  private readonly equals: Equals<Value>;
  private readonly cellEquals: Equals<Value | undefined>;
  /**
   * Plans the merge of a row arriving under a held key into the row held: a
   * `Model.collectionField` of models gives one. Asked before `equals`; a row it
   * keeps notifies nobody that reads the row, only the readers of what its
   * writes changed.
   */
  private readonly merge: Merge<Value> | undefined;
  private readonly lookup: (key: Key) => Computed<Value | undefined>;
  /**
   * The row computed of each present key that `row` was asked for, so every
   * call returns the same one. A removed key's entry goes; a holder keeps a
   * working computed, which reads the order while its key is missing.
   */
  private readonly rowsByKey = new Map<Key, ComputedValue<Value | undefined>>();
  /**
   * `rows`, once read. Nothing observing it, `changed` empties it, as
   * `forgetRow` does a row computed: its last value holds every row it
   * returned, and a `replaceAll` would otherwise keep a whole generation of
   * rows, and their boxes, alive.
   */
  private allRows: ComputedValue<ReadonlyArray<Value>> | undefined = undefined;
  /**
   * The `Collection.onRowChange` listeners, or `undefined` when there are none, so a
   * collection nobody listens to pays one check a write. Replaced whole on
   * each change: a report runs the listeners it began with.
   */
  private listeners: ReadonlyArray<RowListener<Key, Value>> | undefined = undefined;
  /** True while a listener runs: its collection takes no write and no new listener. */
  reporting = false;
  /**
   * True when every row is a `Model.Schema` instance, as pinna-effect sets
   * for a collection of a model class: `write.restore` then refuses to add a
   * row from plain data, even while no row is held.
   */
  holdsModels = false;
  /** True while the realm's record of the outermost update lists this collection. */
  recording = false;
  /**
   * The open stages' patches that read through the base rows: a base change
   * hands each the row it is about to replace (`patch.ts`). `undefined` when
   * none, so a write without stages pays one check.
   */
  patches: Set<RowPatch<Key, Value>> | undefined = undefined;
  /**
   * The row each key had when the outermost update began, kept on the first
   * write to the key while the realm has a `Realm.onUpdate` listener, or
   * `undefined`: a collection nobody records keeps nothing.
   */
  private rowsBefore: Map<Key, Value | typeof absent> | undefined = undefined;

  /**
   * Every key the collection keeps something for: its row, its cell, or its
   * row computed value. A copy, for `retainedKeys` in the testing entry.
   */
  retainedKeys(): ReadonlySet<Key> {
    const keys = new Set<Key>(this.held.keys());
    for (const key of this.cells.keys()) keys.add(key);
    for (const key of this.rowsByKey.keys()) keys.add(key);
    return keys;
  }

  constructor(
    /** The realm the rows belong to: a realm's `write` checks it. */
    readonly realm: ObservableRealm,
    check: Check,
    equals: Equals<Value>,
    /** The key of a row: `Collection.make`'s `keyOf`. */
    readonly keyOf: (value: Value) => Key,
    values: ReadonlyArray<Value>,
    merge?: Merge<Value>,
    /** A name for `Source.inspect`, errors, and a stage's reports; its keys are `<name>.keys`. */
    readonly name?: string,
  ) {
    if (inRecipe(realm.core)) {
      throw recipeMakeError("a collection");
    }
    checkName(name);
    this.check = check;
    this.merge = merge;
    // Incoming rows reject undefined before reaching a cell. Only removal
    // writes undefined here, so the schema checks every incoming row.
    // A check that accepts every value is kept as is: a cell's write skips the call.
    this.cellCheck =
      check === acceptAll
        ? acceptAll
        : (value, previous) => (value === undefined ? undefined : check(value, previous));
    // A row that can merge with itself must be replaced when its merge
    // refuses a fresh row. Its equality cannot override that refusal.
    this.equals =
      merge === undefined
        ? equals
        : (previous, next) => {
            if (Object.is(previous, next)) {
              return true;
            }
            // Planned where the write runs, an update or a stage recipe; it writes nothing.
            const place = realm.place();
            return (
              merge(previous, previous, place.read, place.write) === false && equals(previous, next)
            );
          };
    this.cellEquals = (previous, next) =>
      previous === undefined || next === undefined
        ? previous === next
        : this.equals(previous as Value, next as Value);
    // The values come checked: from a decode, or none at all.
    const held = new Map<Key, Value>();
    const keys = new Array<Key>(values.length);
    for (let index = 0; index < values.length; index++) {
      const value = values[index] as Value;
      if (value === undefined) {
        throw undefinedRow();
      }
      const key = keyOf(value);
      if (held.has(key)) {
        throw new PinnaUsageError("pinna/repeated-key", repeatedKeyMessage(key));
      }
      held.set(key, value);
      keys[index] = key;
    }
    this.held = held;
    this.order = new OrderCell<Key>(realm, keys);
    this.changes = new CollectionCell<number>(realm, acceptAll, 0, Object.is);
    orderOwners.set(this.order, this);
    this.keys = this.order;
    if (name !== undefined) {
      nameSource(this.order.source, `${name}.keys`);
    }
    collectionOfOrder.set(this.order, this as KeyedCollection<unknown, unknown>);
    this.lookup = computedFunction(realm, (_read, key: Key) => this.read(key));
  }

  /**
   * A key's row: its cell's value, or, while the key is missing, `undefined`
   * and the order. Runs only inside the collection's own computed values, so
   * it reads the graph nodes directly: the place check would always pass.
   */
  private read(key: Key): Value | undefined {
    if (!this.held.has(key)) {
      readCell(this.order.source);
      return undefined;
    }
    return readCell(this.cellOf(key).source);
  }

  /**
   * The key's cell, made from its row on the first read. A cell made after
   * the open update changed `held` holds a row a rollback would take back:
   * the rollback empties it with a new version, as a removed key's cell is,
   * so its readers rerun and read the row `held` holds then.
   */
  private cellOf(key: Key): BoxCell<Value | undefined> {
    let cell = this.cells.get(key);
    if (cell !== undefined) {
      return cell;
    }
    const made = new CollectionCell<Value | undefined>(
      this.realm,
      this.cellCheck,
      this.held.get(key),
      this.cellEquals,
      true,
    );
    this.cells.set(key, made);
    if (this.changes.nextRecorded !== undefined) {
      this.realm.step(this, key, madeCell);
    }
    cell = made;
    return cell;
  }

  // Effect's Equal.equals compares a collection by identity, as it does a box.
  [equalKey](that: unknown): boolean {
    return this === that;
  }

  [hashKey](): number {
    return identityHash(this);
  }

  /**
   * The row under `key`, as its cell would hold it, read without making a
   * cell or a row computed: `held` changes with every write and is put back
   * with every rollback. For `read.row` where nothing tracks.
   */
  heldRow(key: Key): Value | undefined {
    return this.held.get(key);
  }

  /** The rows held, for a stage that starts from them. Never written through. */
  heldRows(): ReadonlyMap<Key, Value> {
    return this.held;
  }

  /** The base rows, which a stage's patch reads through: the rows held, or under a showing guess its base. */
  rowsNow(): ReadonlyMap<Key, Value> {
    return (this.realm.stack?.baseRows(this) as ReadonlyMap<Key, Value> | undefined) ?? this.held;
  }

  /**
   * Puts `row` under `key` in the rows held, or removes the key when not
   * `present`, raw: no record, check, merge, report, or patch told. For a
   * visible stage's window alone, which exchanges the base row and the
   * shown row of each key the stack wrote, and moves the version of the
   * order and `changesCell` itself.
   */
  putHeld(key: Key, present: boolean, row: Value | undefined): void {
    if (present) {
      this.held.set(key, row as Value);
    } else {
      this.held.delete(key);
    }
    this.forgetAllRows();
  }

  /** The cell a reader made for `key`, if any: for a visible stage's window. */
  cellAt(key: Key): BoxCell<Value | undefined> | undefined {
    return this.cells.get(key);
  }

  /**
   * Keeps `cell` as the cell of `key`, or no cell when `undefined`, raw: for
   * a visible stage's window, which keeps a cell exactly while its key is
   * present, as every other write does.
   */
  placeCell(key: Key, cell: BoxCell<Value | undefined> | undefined): void {
    if (cell === undefined) {
      this.cells.delete(key);
    } else {
      this.cells.set(key, cell);
    }
    this.forgetRow(key);
  }

  /**
   * The box of the key order: a stage holds its staged order there, and
   * checks its version. Whoever asks may keep the array it holds, so the
   * next write copies.
   */
  get orderCell(): BoxCell<ReadonlyArray<Key>> {
    this.order.live = undefined;
    this.order.settleBefore();
    return this.order;
  }

  /** The box every change to the rows writes: a stage checks its version for a read of the rows. */
  get changesCell(): BoxCell<number> {
    return this.changes;
  }

  row(key: Key): Computed<Value | undefined> {
    if (!this.held.has(key)) {
      const entry = this.lookup(key);
      // Missing keys alone pay the lookup: a present key's computed is tagged once, when made.
      if (!collectionReads.has(entry)) {
        collectionReads.set(entry, this.tag(false, key));
      }
      return entry;
    }
    let row = this.rowsByKey.get(key);
    if (row === undefined) {
      // Not `Computed.make`, which a stage recipe refuses: reading a row there makes this one.
      row = new ComputedValue(this.realm, () => this.read(key), Object.is);
      collectionReads.set(row, this.tag(false, key));
      this.rowsByKey.set(key, row);
    }
    return row;
  }

  private tag(all: boolean, key: unknown): CollectionRead {
    return { collection: this as KeyedCollection<unknown, unknown>, all, key };
  }

  /**
   * Made on first read, so a collection nobody reads whole costs no computed
   * value. It reads the order and `Program.changes`, not a cell per key, so it makes
   * no cell.
   */
  get rows(): Computed<ReadonlyArray<Value>> {
    if (this.allRows === undefined) {
      this.allRows = new ComputedValue(
        this.realm,
        () => {
          const keys = readCell(this.order.source);
          readCell(this.changes.source);
          const held = this.held;
          return keys.map((key) => held.get(key) as Value);
        },
        sameElements,
        this.name === undefined ? undefined : `${this.name}.rows`,
      );
      collectionReads.set(this.allRows, this.tag(true, undefined));
    }
    return this.allRows;
  }

  upsertRow(value: Value, options: UpsertOptions | undefined): void {
    this.realm.assertWritable();
    // Checked before the listeners, so a listener that removed itself still
    // cannot write the collection it is reporting.
    this.assertNotReporting("write.upsert");
    if (value === undefined) {
      throw undefinedRow();
    }
    if (this.listeners === undefined) {
      this.upsertAccepted(value, options);
      return;
    }
    // A listener that throws puts back the row too, even when the caller
    // catches the error: no listener's state is left behind the rows.
    this.realm.undoOnThrow(() => {
      const key = this.keyOf(value);
      const before = this.held.get(key);
      this.upsertAccepted(value, options);
      this.report(key, before, this.held.get(key));
    });
  }

  private upsertAccepted(value: Value, options: UpsertOptions | undefined): void {
    const key = this.keyOf(value);
    const held = this.held;
    if (this.merges(held, key, value)) {
      return;
    }
    const cell = this.cells.get(key);
    if (cell !== undefined) {
      const previous = held.get(key) as Value;
      cell.write(value);
      this.hold(held, key, peekCell(cell.source) as Value, previous, true);
      return;
    }
    const present = held.has(key);
    const previous = held.get(key);
    const kept = this.landing(value, previous, present);
    if (present) {
      this.hold(held, key, kept, previous as Value, true);
      return;
    }
    // The order is written before `Program.changes`, in every write that changes both.
    const live = this.order.inPlace();
    if (live !== undefined) {
      this.order.change(live, options?.at === "end" ? -1 : -2, key);
    } else {
      const order = peekCell(this.order.source).slice();
      if (options?.at === "end") {
        order.push(key);
      } else {
        order.unshift(key);
      }
      this.order.replace(order);
    }
    this.hold(held, key, kept, undefined, false);
  }

  removeRow(key: Key): void {
    this.realm.assertWritable();
    this.assertNotReporting("write.remove");
    if (this.listeners === undefined) {
      this.removeAccepted(key);
      return;
    }
    this.realm.undoOnThrow(() => {
      const before = this.held.get(key);
      this.removeAccepted(key);
      this.report(key, before, undefined);
    });
  }

  private removeAccepted(key: Key): void {
    const held = this.held;
    if (!held.has(key)) {
      return;
    }
    this.forget(key);
    const previous = held.get(key) as Value;
    if (this.realm.updateListeners !== undefined) {
      this.noteRow(key, true, previous);
    }
    if (this.patches !== undefined) beforeKeyChanges(this, key);
    held.delete(key);
    this.realm.step(this, key, previous);
    const order = peekCell(this.order.source);
    const index = indexOfKey(order, key);
    if (index !== -1) {
      const live = this.order.inPlace();
      if (live !== undefined) {
        this.order.change(live, index, key);
      } else {
        const next = order.slice();
        next.splice(index, 1);
        this.order.replace(next);
      }
    }
    this.changed();
  }

  replaceRows(values: ReadonlyArray<Value>): void {
    this.realm.assertWritable();
    this.assertNotReporting("write.replaceAll");
    const count = values.length;
    const { keys, next } = this.keyed(values);
    // A row the check rejects puts back the rows already dropped or
    // written, even when the caller catches the error.
    this.realm.undoOnThrow(() => {
      const held = this.held;
      const heldOrder = peekCell(this.order.source);
      const cells = this.cells;
      let changed = held.size !== count;
      // Only a key a reader read has a cell or a row computed to let go of.
      for (const key of cells.keys()) {
        if (!next.has(key)) {
          this.forget(key);
        }
      }
      for (const key of this.rowsByKey.keys()) {
        if (!next.has(key)) {
          this.forget(key);
        }
      }
      for (let index = 0; index < count; index++) {
        const key = keys[index] as Key;
        const value = values[index] as Value;
        if (this.merges(held, key, value)) {
          next.set(key, held.get(key) as Value);
          continue;
        }
        const cell = cells.get(key);
        if (cell !== undefined) {
          const previous = held.get(key);
          cell.write(value);
          const kept = peekCell(cell.source) as Value;
          next.set(key, kept);
          if (!Object.is(kept, previous)) {
            changed = true;
            this.forgetRow(key);
          }
          continue;
        }
        const present = held.has(key);
        const previous = held.get(key);
        // A row the collection holds was checked when it landed.
        if (present && Object.is(value, previous)) {
          continue;
        }
        const kept = this.landing(value, previous, present);
        next.set(key, kept);
        if (!present || !Object.is(kept, previous)) {
          changed = true;
          this.forgetRow(key);
        }
      }
      if (this.realm.updateListeners !== undefined) {
        this.noteRows(held, next);
      }
      if (this.patches !== undefined) beforeAllChange(this);
      this.held = next;
      this.realm.step(this, replacedAll, held);
      // Made here from the rows: nothing else holds it.
      this.order.replace(keys);
      if (changed) {
        this.changed();
        if (this.listeners !== undefined) {
          this.reportReplaced(heldOrder, held, next);
        }
      }
    });
  }

  /**
   * Keeps the row `key` had when the outermost update began, on the first
   * write to it, for the change stream; a rollback takes the note back.
   */
  private noteRow(key: Key, present: boolean, previous: Value | undefined): void {
    let notes = this.rowsBefore;
    if (notes === undefined) {
      notes = new Map();
      this.rowsBefore = notes;
    }
    if (notes.has(key)) {
      return;
    }
    notes.set(key, present ? (previous as Value) : absent);
    noteCollection(this.realm, this as KeyedCollection<unknown, unknown>);
    this.realm.step(deleteMember, notes, key);
  }

  /**
   * `noteRow` for every key `replaceAll` may change, the held ones and the
   * new ones, under one undo entry rather than one per key.
   */
  private noteRows(held: ReadonlyMap<Key, Value>, next: ReadonlyMap<Key, Value>): void {
    let notes = this.rowsBefore;
    if (notes === undefined) {
      notes = new Map();
      this.rowsBefore = notes;
    }
    const added: Array<Key> = [];
    for (const [key, row] of held) {
      if (!notes.has(key)) {
        notes.set(key, row);
        added.push(key);
      }
    }
    for (const key of next.keys()) {
      if (!held.has(key) && !notes.has(key)) {
        notes.set(key, absent);
        added.push(key);
      }
    }
    if (added.length === 0) {
      return;
    }
    noteCollection(this.realm, this as KeyedCollection<unknown, unknown>);
    this.realm.step(deleteMembers, notes, added);
  }

  /**
   * The collection's part of the record: each noted key whose base row now
   * differs from the one it had, and the key order when its box moved.
   * Forgets the notes.
   */
  takeChange(stack: VisibleStack | undefined): CollectionChange | undefined {
    this.recording = false;
    const notes = this.rowsBefore;
    this.rowsBefore = undefined;
    const base = stack?.baseRows(this) ?? this.held;
    const rows: Array<RowChange<unknown, unknown>> = [];
    if (notes !== undefined) {
      for (const [key, noted] of notes) {
        const before = noted === absent ? undefined : noted;
        const after = base.get(key);
        if (!Object.is(before, after)) {
          rows.push(Object.freeze({ key, before, after }));
        }
      }
    }
    let keys: CollectionChange["keys"];
    const order = this.order;
    // The record keeps the array the order holds: the next write copies.
    order.live = undefined;
    order.settleBefore();
    if (order.nextRecorded !== undefined) {
      const now =
        stack === undefined
          ? { value: peekCell(order.source), version: order.source.version }
          : stack.baseOf(order as BoxCell<unknown>);
      if (now.version !== order.versionBefore) {
        keys = Object.freeze({
          before: order.valueBefore as ReadonlyArray<unknown>,
          after: now.value as ReadonlyArray<unknown>,
        });
      }
    }
    if (rows.length === 0 && keys === undefined) {
      return undefined;
    }
    return Object.freeze({
      collection: this as Collection<unknown, unknown>,
      rows: Object.freeze(rows),
      keys,
    });
  }

  /**
   * Adds `listener`, and returns what removes it. A write reports to it
   * from here on; `replay` reports the rows already held.
   */
  listen(listener: RowListener<Key, Value>): () => void {
    // Its own entry, so one function added twice is two listeners.
    const entry: RowListener<Key, Value> = (change, read, write) => listener(change, read, write);
    this.listeners = this.listeners === undefined ? [entry] : [...this.listeners, entry];
    return () => {
      const listeners = this.listeners;
      if (listeners === undefined || !listeners.includes(entry)) {
        return;
      }
      const next = listeners.filter((kept) => kept !== entry);
      this.listeners = next.length === 0 ? undefined : next;
    };
  }

  private assertNotReporting(verb: string): void {
    if (this.reporting) {
      throw new PinnaUsageError(
        "pinna/row-listener-reentrant",
        `pinna: ${verb} on the collection a Collection.onRowChange listener is reporting; ` +
          "a listener writes other boxes and collections, never its own",
      );
    }
  }

  /** Runs every listener for one row, unless the write left the row as it was. */
  private report(key: Key, before: Value | undefined, after: Value | undefined): void {
    this.reportTo(this.listeners, key, before, after, this.realm.read, this.realm.write);
  }

  /**
   * Runs `listeners` for one row, unless the write left the row as it was,
   * with `read` and `write`: the update's, or a stage recipe's.
   */
  private reportTo(
    listeners: ReadonlyArray<RowListener<Key, Value>> | undefined,
    key: Key,
    before: Value | undefined,
    after: Value | undefined,
    read: Read,
    write: Write,
  ): void {
    if (Object.is(before, after)) {
      return;
    }
    if (listeners === undefined) {
      return;
    }
    this.reporting = true;
    try {
      const change: RowChange<Key, Value> = { key, before, after };
      for (const listener of listeners) {
        this.call(listener, change, read, write);
      }
    } finally {
      this.reporting = false;
    }
  }

  /** Reports each row held to `listener` alone, in key order, as added. */
  replay(listener: RowListener<Key, Value>): void {
    const held = this.held;
    this.reporting = true;
    try {
      for (const key of peekCell(this.order.source)) {
        this.call(
          listener,
          { key, before: undefined, after: held.get(key) as Value },
          this.realm.read,
          this.realm.write,
        );
      }
    } finally {
      this.reporting = false;
    }
  }

  private call(
    listener: RowListener<Key, Value>,
    change: RowChange<Key, Value>,
    read: Read,
    write: Write,
  ): void {
    const result: unknown = listener(change, read, write);
    if (result !== undefined) {
      if (typeof (result as { readonly then?: unknown }).then === "function") {
        (result as PromiseLike<unknown>).then(undefined, ignore);
      }
      throw new PinnaUsageError(
        "pinna/row-listener-returns-value",
        "pinna: a Collection.onRowChange listener is synchronous and returns nothing",
      );
    }
  }

  /**
   * Reports a `replaceAll`, a row at a time, to the listeners it began with:
   * the removed keys and the replaced rows in the old key order, then the
   * added keys in the new.
   */
  private reportReplaced(
    heldOrder: ReadonlyArray<Key>,
    held: ReadonlyMap<Key, Value>,
    next: ReadonlyMap<Key, Value>,
    read: Read = this.realm.read,
    write: Write = this.realm.write,
  ): void {
    const listeners = this.listeners;
    for (const key of heldOrder) {
      this.reportTo(listeners, key, held.get(key), next.get(key), read, write);
    }
    for (const [key, after] of next) {
      if (!held.has(key)) {
        this.reportTo(listeners, key, undefined, after, read, write);
      }
    }
  }

  /**
   * The row a write of `value` leaves under a key with no cell: checked as a
   * cell's write is, and the row held kept when `equals` finds the two equal.
   */
  private landing(value: Value, previous: Value | undefined, present: boolean): Value {
    if (present && Object.is(value, previous)) {
      return value;
    }
    if (this.check !== acceptAll) {
      verifyValue(this.realm, this.check, value, previous);
    }
    return present && this.equals(previous as Value, value) ? (previous as Value) : value;
  }

  /**
   * Whether the row held under `key` stays, with `value` merged into it:
   * `value` is checked as a landing row is, then the merge's writes run.
   */
  /** The key of each of `values`, and the rows by key: throws on an `undefined` row or a repeated key. */
  private keyed(values: ReadonlyArray<Value>): { keys: Array<Key>; next: Map<Key, Value> } {
    const keyOf = this.keyOf;
    const count = values.length;
    const keys = new Array<Key>(count);
    const next = new Map<Key, Value>();
    for (let index = 0; index < count; index++) {
      const value = values[index] as Value;
      if (value === undefined) {
        throw undefinedRow();
      }
      const key = keyOf(value);
      if (next.has(key)) {
        throw new PinnaUsageError("pinna/repeated-key", repeatedKeyMessage(key));
      }
      next.set(key, value);
      keys[index] = key;
    }
    return { keys, next };
  }

  private merges(held: Map<Key, Value>, key: Key, value: Value): boolean {
    const merge = this.merge;
    if (merge === undefined || !held.has(key)) {
      return false;
    }
    const previous = held.get(key) as Value;
    if (Object.is(previous, value)) {
      return false;
    }
    const place = this.realm.place();
    const realm = this.realm;
    return this.mergeInto(merge, previous, value, place.read, place.write, (writes) =>
      realm.undoOnThrow(writes),
    );
  }

  /**
   * Runs the merge of `value` into `previous`: `false` when it declines,
   * otherwise the check runs on `value` and the merge's writes run in a
   * scope of their own (`undoOnThrow`), so a throw from a nested write,
   * such as a nested collection's listener, puts back the whole merge, not
   * half of it, even when the caller catches the error.
   */
  private mergeInto(
    merge: NonNullable<typeof this.merge>,
    previous: Value,
    value: Value,
    read: Read,
    write: Write,
    undoOnThrow: (writes: () => void) => unknown,
  ): boolean {
    const writes = merge(previous, value, read, write);
    if (writes === false) {
      return false;
    }
    if (this.check !== acceptAll) {
      verifyValue(this.realm, this.check, value, previous);
    }
    if (writes !== undefined) {
      undoOnThrow(writes);
    }
    return true;
  }

  /**
   * `write.upsert` through a stage: the same check, equality, merge, and
   * reports as `upsertRow`, over the rows the stage holds, with the stage
   * recipe's `read` and `write`.
   */
  stagedUpsert(
    target: StagedRows<Key, Value>,
    value: Value,
    options: UpsertOptions | undefined,
    read: Read,
    write: Write,
  ): void {
    this.assertNotReporting("write.upsert");
    if (value === undefined) {
      throw undefinedRow();
    }
    const key = this.keyOf(value);
    const present = target.rows.has(key);
    const previous = target.rows.get(key);
    if (present && this.mergesStaged(previous as Value, value, read, write)) {
      return;
    }
    const cell = present ? this.cells.get(key) : undefined;
    const kept =
      cell !== undefined && target.cellValue !== undefined
        ? target.cellValue(key, cell, value, previous as Value)
        : this.landing(value, previous, present);
    if (present && Object.is(kept, previous)) {
      return;
    }
    target.setRow(key, kept);
    if (!present) {
      target.addKey(key, options?.at === "end" ? "end" : "start");
    }
    this.reportTo(this.listeners, key, previous, kept, read, write);
  }

  /** `write.remove` through a stage. */
  stagedRemove(target: StagedRows<Key, Value>, key: Key, read: Read, write: Write): void {
    this.assertNotReporting("write.remove");
    if (!target.rows.has(key)) {
      return;
    }
    const previous = target.rows.get(key);
    target.deleteRow(key);
    target.removeKey(key);
    this.reportTo(this.listeners, key, previous, undefined, read, write);
  }

  /** `write.replaceAll` through a stage. */
  stagedReplace(
    target: StagedRows<Key, Value>,
    values: ReadonlyArray<Value>,
    read: Read,
    write: Write,
  ): void {
    this.assertNotReporting("write.replaceAll");
    const count = values.length;
    const { keys, next } = this.keyed(values);
    const held = target.rows;
    const heldOrder = target.order;
    let changed = held.size !== count;
    const written = new Set<Key>();
    for (const key of held.keys()) {
      if (!next.has(key)) written.add(key);
    }
    for (let index = 0; index < count; index++) {
      const key = keys[index] as Key;
      const value = values[index] as Value;
      const present = held.has(key);
      const previous = held.get(key);
      if (present && this.mergesStaged(previous as Value, value, read, write)) {
        next.set(key, previous as Value);
        continue;
      }
      if (present && Object.is(value, previous)) {
        continue;
      }
      const cell = present ? this.cells.get(key) : undefined;
      const kept =
        cell !== undefined && target.cellValue !== undefined
          ? target.cellValue(key, cell, value, previous as Value)
          : this.landing(value, previous, present);
      next.set(key, kept);
      if (!present || !Object.is(kept, previous)) {
        changed = true;
        written.add(key);
      }
    }
    if (!changed) {
      // The same rows: only the order can differ, and the stage keeps its overlay otherwise.
      if (!sameElements(keys, heldOrder)) {
        target.setOrder(keys);
      }
      return;
    }
    target.setAll(next, keys, written);
    if (this.listeners !== undefined) {
      this.reportReplaced(heldOrder, held, next, read, write);
    }
  }

  /** `merges` over a stage's row: the merge's writes go to the stage. */
  private mergesStaged(previous: Value, value: Value, read: Read, write: Write): boolean {
    const merge = this.merge;
    if (merge === undefined || Object.is(previous, value)) {
      return false;
    }
    const place = this.realm.stagedPlace as StagedPlace;
    return this.mergeInto(merge, previous, value, read, write, (writes) =>
      place.undoOnThrow(writes),
    );
  }

  /**
   * Prepares only the keys a replay wrote. Rows passed here already went
   * through `landing` with this collection's check and equality. Final
   * equality runs under the recipe guard; the returned landing records the
   * same cells, row changes, cache releases, and undo as ordinary writes,
   * without running key functions, checks, merges, or listeners again.
   * The order is landed separately through its box.
   */
  prepareStageRows(
    rows: ReadonlyMap<Key, Value>,
    keys: ReadonlySet<Key>,
    prepareBox: <Item>(box: BoxCell<Item>, value: Item) => Item,
  ): () => void {
    const operations: Array<() => void> = [];
    const held = this.held;
    for (const key of keys) {
      const previous = held.get(key);
      const value = rows.get(key);
      if (Object.is(previous, value)) continue;
      if (value === undefined) {
        operations.push(() => {
          // Removal's cell check and equality accept undefined without user code.
          this.forget(key);
          if (this.realm.updateListeners !== undefined) {
            this.noteRow(key, true, previous);
          }
          if (this.patches !== undefined) beforeKeyChanges(this, key);
          held.delete(key);
          this.realm.step(this, key, previous);
          this.changed();
        });
      } else {
        const cell = this.cells.get(key);
        const kept =
          cell !== undefined
            ? (prepareBox(cell, value) as Value)
            : held.has(key) && this.equals(previous as Value, value)
              ? (previous as Value)
              : value;
        if (!Object.is(previous, kept)) {
          operations.push(() => {
            this.hold(held, key, kept, previous, previous !== undefined);
          });
        }
      }
    }
    return () => {
      for (const land of operations) land();
    };
  }

  /** Puts `row` under `key` in `held`, and a rollback puts back what was there. */
  private hold(
    held: Map<Key, Value>,
    key: Key,
    row: Value,
    previous: Value | undefined,
    present: boolean,
  ): void {
    if (present && Object.is(row, previous)) {
      return;
    }
    if (this.realm.updateListeners !== undefined) {
      this.noteRow(key, present, previous);
    }
    if (this.patches !== undefined) beforeKeyChanges(this, key);
    held.set(key, row);
    this.forgetRow(key);
    this.realm.step(this, key, present ? previous : absent);
    this.changed();
  }

  /**
   * Empties the row computed of `key` when nothing observes it: its last
   * value is the row `held` no longer holds under the key.
   */
  private forgetRow(key: Key): void {
    const row = this.rowsByKey.get(key);
    if (row !== undefined) {
      forgetValue(row.source);
    }
  }

  /**
   * Marks `held` changed: `rows` reruns, and a cell made from here on is
   * undone with the update. An unobserved `rows` lets go of the rows it
   * returned, which `held` may no longer hold.
   */
  private changed(): void {
    this.changes.write(peekCell(this.changes.source) + 1);
    this.forgetAllRows();
  }

  /**
   * Empties `rows` when nothing observes it: a write or a rollback leaves its
   * last value holding rows `held` no longer holds.
   */
  private forgetAllRows(): void {
    if (this.allRows !== undefined) {
      forgetValue(this.allRows.source);
    }
  }

  /**
   * Lets go of a leaving key's cell and row computed. The cell is emptied
   * first, so its readers rerun and find the key gone; a rollback puts both
   * back.
   */
  private forget(key: Key): void {
    const cell = this.cells.get(key);
    const row = this.rowsByKey.get(key);
    if (cell === undefined && row === undefined) {
      return;
    }
    if (cell !== undefined) {
      cell.write(undefined);
      this.cells.delete(key);
    }
    // A row computed a caller still holds would otherwise keep the leaving row.
    if (row !== undefined) {
      forgetValue(row.source);
    }
    this.rowsByKey.delete(key);
    this.realm.step(this, key, new Forgotten(cell as BoxCell<unknown> | undefined, row));
  }

  /**
   * A journal step on the collection, the last first: `before` is the row
   * `key` held (`absent` when it held none), `madeCell` for a cell the step
   * made, or a `Forgotten` cell and row computed; under `replacedAll`, the
   * `held` map a whole replace swapped out.
   */
  undo(key: unknown, before: unknown): void {
    if (key === replacedAll) {
      const held = before as Map<Key, Value>;
      if (this.patches !== undefined) beforeAllChange(this);
      this.held = held;
      // A key the replace added leaves, with any row computed asked for since;
      // a kept key's row computed lets go of a row the replace put there.
      for (const rowKey of this.rowsByKey.keys()) {
        this.forgetRow(rowKey);
        if (!held.has(rowKey)) {
          this.rowsByKey.delete(rowKey);
        }
      }
    } else if (before === madeCell) {
      // A cell made after the update changed `held` holds a row the rollback
      // takes back: it empties with a new version, so its readers rerun.
      const cell = this.cells.get(key as Key);
      if (cell !== undefined) {
        cell.restore(undefined, this.realm.core.nextCellVersion());
        this.cells.delete(key as Key);
      }
      return;
    } else if (before instanceof Forgotten) {
      if (before.cell !== undefined) {
        this.cells.set(key as Key, before.cell as BoxCell<Value | undefined>);
      }
      if (before.row !== undefined) {
        forgetValue(before.row.source);
        this.rowsByKey.set(key as Key, before.row as ComputedValue<Value | undefined>);
      }
      return;
    } else if (before === absent) {
      if (this.patches !== undefined) beforeKeyChanges(this, key as Key);
      this.held.delete(key as Key);
      this.forgetRow(key as Key);
      this.rowsByKey.delete(key as Key);
    } else {
      if (this.patches !== undefined) beforeKeyChanges(this, key as Key);
      this.held.set(key as Key, before as Value);
      this.forgetRow(key as Key);
    }
    this.forgetAllRows();
  }
}

// `write.restore` tells a collection by this mark, without importing the class.
Object.defineProperty(KeyedCollection.prototype, collectionKey, { value: true });

/** What `Collection.make` takes. */
export interface CollectionOptions<Key, Value> {
  /** The key of a row; two rows with one key are an error. */
  readonly keyOf: (value: Value) => Key;
  /**
   * A name for tools: `Source.inspect` reports its `keys` as `<name>.keys` and its
   * `rows` as `<name>.rows`, and a stage's conflict error and `Stage.inspect`
   * name the collection by it.
   */
  readonly name?: string;
  /**
   * Compares a row written under a key with the row it holds; an equal row
   * notifies nobody and the collection keeps the row it holds. Defaults to
   * `Object.is`.
   */
  readonly equals?: Equals<Value>;
}

/**
 * An empty keyed collection: a box for each key a reader reads, made on its
 * first read, and one for the order of the keys, so a write to one row reruns the readers of that row, not the readers
 * of the list. It rejects `undefined` rows and takes no schema;
 * `write.upsert`, `write.remove`, and
 * `write.replaceAll` change it.
 */
export const collection = <Key, Value>(
  realm: Realm,
  options: CollectionOptions<Key, Value>,
): Collection<Key, Value> =>
  new KeyedCollection<Key, Value>(
    realm as ObservableRealm,
    acceptAll,
    options.equals ?? Object.is,
    options.keyOf,
    [],
    undefined,
    options.name,
  );

/**
 * Calls `listener` for every row a write adds, replaces, or removes in
 * `Collection.make`, inside the writer's update, after the row is written, with
 * that update's `read` and `write`. What the listener writes commits and
 * rolls back with the row, so state it keeps in boxes, such as an index of
 * the rows, never falls behind them. A listener that throws fails the write:
 * the row is put back, and the error reaches the writer.
 *
 * Every write path reports: `write.upsert`, `write.remove`,
 * `write.replaceAll` (a row at a time), and a `Model.collectionField`'s reconcile.
 * A write that leaves a row as it was reports nothing, and so does a model
 * row whose box fields alone differ: it is merged in place, so its boxes
 * change, not the row, and a reader of those boxes sees it. A listener
 * writes other boxes and collections, never the collection it listens to.
 *
 * The listener first hears each row already held, in key order, as added,
 * so what it keeps starts in step with the rows. That runs in an update of
 * its own, nested in the caller's when there is one: a throw from it adds
 * no listener, puts back what it wrote, and reaches the caller. If settling
 * watchers throws after replay commits, the listener is removed and the
 * replay's writes stay committed.
 *
 * The listener sees rows the collection replaces, never a write to a box
 * inside a row: a sum over a `Model.boxField` is a `Computed.make`. `replaceAll` writes
 * every row before its first report, so a listener that reads the
 * collection sees rows ahead of their reports.
 *
 * Returns the function that removes the listener, for good: an update that
 * fails after calling it does not add it back. Added inside an update that
 * fails, the listener is removed with the update's writes. A listener added
 * while one of the collection's listeners runs throws, and so does
 * `Collection.onRowChange` in a computed value or a watch's select, where an update
 * cannot run. Each call replays the held rows to its listener, so a host
 * adds a listener once, beside the boxes it fills.
 */
export const onRowChange = <Key, Value>(
  collection: Collection<Key, Value>,
  listener: RowListener<Key, Value>,
): (() => void) => listenRows(collection, listener, "Collection.onRowChange", "onRowChange");

/**
 * `Collection.onRowChange` for a caller inside Pinna, such as a view: `call`
 * names it in errors, and `label` in the realm's registrations, so
 * `testRealm` reports it by what made it.
 */
export const listenRows = <Key, Value>(
  collection: Collection<Key, Value>,
  listener: RowListener<Key, Value>,
  call: string,
  label: string,
  onStopped?: () => void,
): (() => void) => {
  if (!(collection instanceof KeyedCollection)) {
    throw new PinnaUsageError(
      "pinna/not-made-by-pinna",
      `pinna: ${call} needs a collection made by Pinna`,
    );
  }
  const keyed = collection as KeyedCollection<Key, Value>;
  const realm = keyed.realm;
  assertUpdateCanRun(realm, call);
  assertNotInRecipe(realm, call);
  realm.assertOpen(call === "Collection.onRowChange" ? "a Collection.onRowChange listener" : call);
  let stop: () => void = () => undefined;
  // A recipe failure undoes replay writes; a settle failure keeps them.
  // Both remove the listener, since the caller receives no stop function.
  try {
    update(realm, () => {
      if (keyed.reporting) {
        throw new PinnaUsageError(
          "pinna/row-listener-reentrant",
          `pinna: ${call} on the collection a Collection.onRowChange listener is reporting`,
        );
      }
      const listening = keyed.listen(listener);
      // A visible stage that wrote the collection replays through the new
      // listener as this update ends, so what it shows includes the listener's writes.
      realm.stack?.invalidate();
      // Every way the listener ends tells the caller: its stop, a rollback
      // of the update that added it, and `Realm.dispose`.
      const remove =
        onStopped === undefined
          ? listening
          : () => {
              listening();
              onStopped();
            };
      stop = realm.register(label, remove);
      realm.recordUndo(stop);
      keyed.replay(listener);
    });
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
};
