/**
 * The change stream: one record per landed outermost update, holding the net
 * change of each box, each collection, and each atom it wrote. `Realm.onUpdate`
 * hands each record to a listener after the update's watchers ran;
 * `write.replay` and `write.revert` apply one forward or backward, as writes.
 *
 * A record reports base values only: a visible stage's shown values never
 * reach one, since showing and withdrawing a stage swap cells raw, outside
 * any update's record (`docs/design.md`, "Change stream").
 */
import { nextPlace, PinnaUsageError, peekCell, placeKind } from "@frondruntime/pinna-core";
import { type AtomCell, type BoxCell, CollectionCell, names } from "./box.ts";
import type { RowChange } from "./collection.ts";
import { deleteMember } from "./journal.ts";
import type { Atom } from "./modules/atom.ts";
import type { Box } from "./modules/box.ts";
import type { Collection } from "./modules/collection.ts";
import {
  endOfRecorded,
  type ObservableRealm,
  orderOwners,
  type QueuedRecord,
  type RecordedCollection,
  type RegistrationRows,
  type UpdateListenerEntry,
} from "./realm.ts";
import type { Read, Write } from "./verbs.ts";

/** What `Realm.update` takes besides its recipe. */
export interface UpdateOptions {
  /**
   * A name for the outermost update's record, for devtools and logs. A
   * nested update's name is ignored, as its batch is. Empty throws.
   */
  readonly name?: string;
}

/** One box an update changed: its value when the update began and when it landed. */
export interface BoxChange {
  /** Any box: a box is invariant in its value, so `Box<unknown>` would refuse a `Box<number>`. */
  // biome-ignore lint/suspicious/noExplicitAny: a record lists boxes of every value type.
  readonly box: Box<any>;
  readonly before: unknown;
  readonly after: unknown;
}

/** One collection an update changed: each row's net change, and the key order when it moved. */
export interface CollectionChange {
  readonly collection: Collection<unknown, unknown>;
  /** One `RowChange` per key the update changed, net over the update, as `Collection.onRowChange` reports one. */
  readonly rows: ReadonlyArray<RowChange<unknown, unknown>>;
  /** The key order before and after, when the update changed it; `undefined` when it did not. */
  readonly keys:
    | { readonly before: ReadonlyArray<unknown>; readonly after: ReadonlyArray<unknown> }
    | undefined;
}

/** What one landed outermost update changed, net, in base values. Frozen. */
export interface UpdateRecord {
  /** The outermost update's `{ name }`, or `undefined`. */
  readonly name: string | undefined;
  /** The stages `Stage.apply` landed in this update, in order: each one's name, or `undefined` when unnamed. */
  readonly stages: ReadonlyArray<string | undefined>;
  /** Each plain box the update changed, in the order it was first written. */
  readonly boxes: ReadonlyArray<BoxChange>;
  /** Each collection the update changed, in the order its change was first seen. */
  readonly collections: ReadonlyArray<CollectionChange>;
  /** Each atom the update changed, in the order it first changed. */
  readonly atoms: ReadonlyArray<Atom>;
}

/** Takes each record, after the update's watchers ran. It may call `Realm.update`. */
export type UpdateListener = (record: UpdateRecord) => void;

const describeCollection = (collection: Collection<unknown, unknown>): string => {
  const name = (collection as { readonly name?: string }).name;
  return name === undefined ? "a collection" : `the collection "${name}"`;
};

const describeBox = (box: Box<unknown>): string => {
  const name = names.get((box as unknown as BoxCell<unknown>).source);
  return name === undefined ? "a box" : `the box "${name}"`;
};

const keyText = (key: unknown): string => {
  try {
    return typeof key === "string" ? `"${key}"` : String(key);
  } catch {
    return "a key";
  }
};

const inOrder = "apply records in the order they landed, each to the state the previous one left";

const notApplicable = (message: string): PinnaUsageError =>
  new PinnaUsageError("pinna/record-not-applicable", `pinna: ${message}`);

/**
 * The `Collection.onRowChange` registrations a collection had counted when
 * the update that made a `CollectionChange` ended: its listeners up to that
 * count stay silent when the change is restored. Kept beside the change, so
 * the public record keeps its shape; a change made outside Pinna has none.
 */
export const listenerCounts = new WeakMap<CollectionChange, number>();

/**
 * The collections a record's update added a `Collection.onRowChange`
 * listener to, whether or not it changed their rows. A record
 * with any is refused: what the new listener wrote as it heard the rows
 * held is in the record, and its `before` holds that state from before the
 * listener existed.
 */
const registeredIn = new WeakMap<UpdateRecord, ReadonlyArray<Collection<unknown, unknown>>>();

/**
 * The records of an update `Collection.onRowChange` opened at rest for its
 * listener's replay, a view's included, each with the rows that listener
 * heard. Such a record holds what the new listener wrote as it heard them,
 * and that listener still runs. Its revert writes nothing, since the
 * listener's state follows the rows, and an older record's restore reaches
 * it, as it was registered after that record. Its replay writes each
 * `after` again: a listener that heard older restores rebuilt its state
 * with new objects, and the records made after it hold the objects it made
 * first, which their check compares by `Object.is`. Both require the rows
 * it heard.
 */
const registrationRecords = new WeakMap<UpdateRecord, RegistrationRows>();

/** Every record `takeRecord` built: `write.revert` and `write.replay` take no other. */
const madeRecords = new WeakSet<UpdateRecord>();

/** Throws `pinna/record-not-applicable` unless the collection holds `heard`'s rows, in its key order. */
const assertRowsHeld = (read: Read, heard: RegistrationRows, verb: string): void => {
  const { collection, keys, rows } = heard;
  const now = read(collection.keys);
  let same = now.length === keys.length;
  for (let index = 0; same && index < keys.length; index++) {
    const key = keys[index];
    same = Object.is(now[index], key) && Object.is(read.row(collection, key), rows[index]);
  }
  if (!same) {
    throw notApplicable(
      `${verb} needs ${describeCollection(collection)} to hold the rows its Collection.onRowChange listener heard when it was added, and they changed since; ${inOrder}`,
    );
  }
};

/**
 * What part of `change`'s collection differs from the record's `before`
 * (`before` true) or `after`, compared by `Object.is`: a row, named by its
 * key, or the key order when it moved. `undefined` when none does.
 */
const collectionDiffers = (
  read: Read,
  change: CollectionChange,
  before: boolean,
): string | undefined => {
  const { collection, rows, keys } = change;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index] as RowChange<unknown, unknown>;
    const expected = before ? row.before : row.after;
    if (!Object.is(read.row(collection, row.key), expected)) {
      return `the row under ${keyText(row.key)}`;
    }
  }
  if (keys !== undefined) {
    const expected = before ? keys.before : keys.after;
    const now = read(collection.keys);
    let same = now.length === expected.length;
    for (let index = 0; same && index < expected.length; index++) {
      same = Object.is(now[index], expected[index]);
    }
    if (!same) {
      return "the key order";
    }
  }
  return undefined;
};

/**
 * Throws `pinna/record-not-applicable` unless the state holds what the
 * record left on the side it starts from: `after` for a revert, `before`
 * for a replay, for every box, every row, and a moved key order, key by
 * key, by `Object.is`. Also throws for a record whose update added a
 * listener to a collection: the record's `before` holds
 * the state from before that listener existed. Runs before the first
 * write, so a refused record writes nothing.
 */
const assertApplicable = (
  read: Read,
  record: UpdateRecord,
  forward: boolean,
  verb: string,
): void => {
  const side = forward ? "before" : "after";
  const registered = registeredIn.get(record);
  if (registered !== undefined) {
    throw notApplicable(
      `${verb} cannot apply a record whose update added a Collection.onRowChange listener to ${describeCollection(registered[0] as Collection<unknown, unknown>)}: the record holds what that listener wrote and its state from before it existed`,
    );
  }
  for (const change of record.collections) {
    const differs = collectionDiffers(read, change, forward);
    if (differs !== undefined) {
      throw notApplicable(
        `${verb} needs ${differs} of ${describeCollection(change.collection)} to be the record's ${side}, and it changed since; ${inOrder}`,
      );
    }
  }
  for (const change of record.boxes) {
    const expected = forward ? change.before : change.after;
    if (!Object.is(read(change.box), expected)) {
      throw notApplicable(
        `${verb} needs ${describeBox(change.box)} to hold the record's ${side}, and it changed since; ${inOrder}`,
      );
    }
  }
};

/** Writes one collection's part of a record, forward (`after`) or backward (`before`). */
const applyCollection = (
  read: Read,
  write: Write,
  change: CollectionChange,
  forward: boolean,
  verb: string,
): void => {
  const { collection, rows, keys } = change;
  if (keys === undefined) {
    for (const row of rows) {
      const value = forward ? row.after : row.before;
      if (value === undefined) {
        write.remove(collection, row.key);
      } else {
        write.upsert(collection, value);
      }
    }
    return;
  }
  const target = new Map<unknown, unknown>();
  for (const row of rows) {
    target.set(row.key, forward ? row.after : row.before);
  }
  const order = forward ? keys.after : keys.before;
  const values = new Array<unknown>(order.length);
  for (let index = 0; index < order.length; index++) {
    const key = order[index];
    const value = target.has(key) ? target.get(key) : read.row(collection, key);
    if (value === undefined) {
      throw notApplicable(
        `${verb} needs the row under ${keyText(key)} of ${describeCollection(collection)}, which neither the record nor the collection holds; ${inOrder}`,
      );
    }
    values[index] = value;
  }
  write.replaceAll(collection, values);
};

/** What a restore left in one collection: each recorded key's row, and the key order when the record moved it. */
interface LandedCollection {
  readonly rows: ReadonlyArray<unknown>;
  readonly keys: ReadonlyArray<unknown> | undefined;
}

const landedOf = (read: Read, change: CollectionChange): LandedCollection => {
  const { collection, rows, keys } = change;
  const held = new Array<unknown>(rows.length);
  for (let index = 0; index < rows.length; index++) {
    held[index] = read.row(collection, (rows[index] as RowChange<unknown, unknown>).key);
  }
  return { rows: held, keys: keys === undefined ? undefined : read(collection.keys) };
};

/** The part of `change`'s collection that differs from `landed` by `Object.is`, or `undefined`. */
const movedSince = (
  read: Read,
  change: CollectionChange,
  landed: LandedCollection,
): string | undefined => {
  const { collection, rows } = change;
  for (let index = 0; index < rows.length; index++) {
    const key = (rows[index] as RowChange<unknown, unknown>).key;
    if (!Object.is(read.row(collection, key), landed.rows[index])) {
      return `the row under ${keyText(key)}`;
    }
  }
  if (landed.keys !== undefined) {
    const now = read(collection.keys);
    let same = now.length === landed.keys.length;
    for (let index = 0; same && index < now.length; index++) {
      same = Object.is(now[index], landed.keys[index]);
    }
    if (!same) {
      return "the key order";
    }
  }
  return undefined;
};

/**
 * Applies `record` through `write`, forward (`after`) or backward
 * (`before`), once `assertApplicable` found the state on the record's other
 * side: collections, then boxes, then atoms.
 *
 * A `Collection.onRowChange` listener registered when the record's update
 * ended does not hear a collection's restore: the record already holds what
 * it wrote, in the boxes and collections it lists, and those land at the
 * record's values as they are written. A listener registered later, a
 * view's among them, hears each row change as any write reports it, since
 * the record holds nothing of its state. Boxes go after collections, so a
 * recorded value wins over what a later listener wrote to the same box. A
 * later listener that, hearing one collection's restore, changes a
 * recorded row or a moved key order of a collection restored before it
 * throws once every collection is written, and the update rolls back: that
 * collection is not written again, since that would run its later
 * listeners again.
 *
 * A collection whose key order changed gets its whole order back through
 * `write.replaceAll`, with each unchanged key's row as `read.row` holds it
 * now; one whose order did not change gets `write.upsert` or
 * `write.remove` per row, which keeps each position.
 */
export const applyRecord = (
  read: Read,
  write: Write,
  record: UpdateRecord,
  forward: boolean,
  verb: string,
): void => {
  if (!madeRecords.has(record)) {
    throw notApplicable(
      `${verb} takes a record Realm.onUpdate handed out, and this is not one: a copy or a record made by hand loses what the realm kept beside it, such as which listeners its update had`,
    );
  }
  const heard = registrationRecords.get(record);
  if (heard === undefined) {
    assertApplicable(read, record, forward, verb);
  } else {
    assertRowsHeld(read, heard, verb);
    if (!forward) {
      assertApplicable(read, record, false, verb);
      return;
    }
  }
  const collections = record.collections;
  // What each collection held once its part was written, kept only when a
  // later collection's restore can run a listener that writes it.
  const landed: Array<LandedCollection> | undefined =
    collections.length > 1 ? new Array(collections.length) : undefined;
  for (let index = 0; index < collections.length; index++) {
    const change = collections[index] as CollectionChange;
    const count = listenerCounts.get(change) as number;
    const recorded = change.collection as unknown as RecordedCollection;
    recorded.restoreHeardAfter(count, () => {
      applyCollection(read, write, change, forward, verb);
    });
    if (landed !== undefined) {
      landed[index] = landedOf(read, change);
    }
  }
  if (landed !== undefined) {
    // A listener added after the record hears a later collection's restore
    // and may write one restored before it. A collection is not written
    // again, since that would run its later listeners again: a change
    // throws, and the update rolls back rather than land a value the
    // record does not hold.
    for (let index = 0; index < collections.length; index++) {
      const change = collections[index] as CollectionChange;
      const moved = movedSince(read, change, landed[index] as LandedCollection);
      if (moved !== undefined) {
        throw notApplicable(
          `${verb} wrote ${moved} of ${describeCollection(change.collection)}, and a Collection.onRowChange listener added after the record changed it as it heard the restore of another collection; stop that listener first, or apply the change with Realm.update`,
        );
      }
    }
  }
  for (const change of record.boxes) {
    write(change.box, forward ? change.after : change.before);
  }
  for (const atom of record.atoms) {
    write.changed(atom);
  }
};

/* -------------------------------------------- building and handing out */

/** A collection changed in the outermost update: its part of the record is asked for at the end. */
export const noteCollection = (realm: ObservableRealm, collection: RecordedCollection): void => {
  if (collection.recording) {
    return;
  }
  collection.recording = true;
  if (realm.recordedCollections === undefined) {
    realm.recordedCollections = [collection];
  } else {
    realm.recordedCollections.push(collection);
  }
};

/** An atom changed in the open update; a rollback takes the note back. */
export const noteAtom = (realm: ObservableRealm, atom: AtomCell): void => {
  if (realm.updateListeners === undefined) {
    return;
  }
  let atoms = realm.recordedAtoms;
  if (atoms === undefined) {
    atoms = new Set();
    realm.recordedAtoms = atoms;
  }
  if (atoms.has(atom)) {
    return;
  }
  atoms.add(atom);
  realm.step(deleteMember, atoms, atom);
};

/** `Stage.apply` landed a stage in the open update; a rollback takes the note back. */
export const noteStage = (realm: ObservableRealm, name: string | undefined): void => {
  if (realm.updateListeners === undefined) {
    return;
  }
  let stages = realm.landedStages;
  if (stages === undefined) {
    stages = [];
    realm.landedStages = stages;
  }
  stages.push(name);
  realm.recordUndo(() => {
    stages.pop();
  });
};

/**
 * Builds the outermost update's record from what it recorded, before
 * `forget` lets go of it, and queues it when anything changed. A covered
 * box is read through the visible stack's base: the record holds base
 * values only.
 */
export const takeRecord = (realm: ObservableRealm): void => {
  const stack = realm.stack;
  const written: Array<BoxChange> = [];
  for (
    let box = realm.recorded;
    box !== endOfRecorded;
    box = box.nextRecorded as BoxCell<unknown>
  ) {
    if (box instanceof CollectionCell) {
      // A collection's own box: its order, its change counter, or a row's cell.
      const owner = orderOwners.get(box);
      if (owner !== undefined) {
        noteCollection(realm, owner);
      }
      continue;
    }
    let value: unknown;
    let version: number;
    if (stack === undefined) {
      value = peekCell(box.source);
      version = box.source.version;
    } else {
      const base = stack.baseOf(box);
      value = base.value;
      version = base.version;
    }
    if (version === box.versionBefore) {
      continue;
    }
    written.push(Object.freeze({ box, before: box.valueBefore, after: value }));
  }
  // The list holds the last recorded first.
  written.reverse();
  const changed: Array<CollectionChange> = [];
  const registered: Array<Collection<unknown, unknown>> = [];
  // The rows a registration at rest heard mark this update's record alone:
  // a record a watcher or a `Realm.onUpdate` listener makes while that
  // registration's update settles is its own.
  const heard = realm.registrationRows;
  realm.registrationRows = undefined;
  const collections = realm.recordedCollections;
  if (collections !== undefined) {
    realm.recordedCollections = undefined;
    for (const collection of collections) {
      if (collection.registeredInUpdate() && heard === undefined) {
        registered.push(collection as unknown as Collection<unknown, unknown>);
      }
      const change = collection.takeChange(stack);
      if (change !== undefined) {
        changed.push(change);
      }
    }
  }
  const atoms = realm.recordedAtoms;
  realm.recordedAtoms = undefined;
  const stages = realm.landedStages;
  realm.landedStages = undefined;
  const name = realm.updateName;
  realm.updateName = undefined;
  // A listener added inside this update takes records from the next one.
  const taking: Array<UpdateListenerEntry> = [];
  for (const entry of realm.updateListeners as ReadonlyArray<UpdateListenerEntry>) {
    if (entry.active) {
      taking.push(entry);
    } else {
      entry.active = true;
    }
  }
  if ((realm.updateListeners as ReadonlyArray<UpdateListenerEntry>).length === 0) {
    // The last listener stopped inside the update: kept empty until here, so this clears.
    realm.updateListeners = undefined;
  }
  if (
    taking.length === 0 ||
    (written.length === 0 && changed.length === 0 && (atoms === undefined || atoms.size === 0))
  ) {
    return;
  }
  const record: UpdateRecord = Object.freeze({
    name,
    stages: Object.freeze(stages ?? []),
    boxes: Object.freeze(written),
    collections: Object.freeze(changed),
    atoms: Object.freeze(atoms === undefined ? [] : [...atoms]),
  });
  madeRecords.add(record);
  if (heard !== undefined) {
    registrationRecords.set(record, heard);
  } else if (registered.length > 0) {
    registeredIn.set(record, registered);
  }
  const queued: QueuedRecord = { record, listeners: taking };
  if (realm.recordQueue === undefined) {
    realm.recordQueue = [queued];
  } else {
    realm.recordQueue.push(queued);
  }
};

/**
 * Hands each queued record to the listeners, in the order the updates
 * landed, once the realm is at rest: outside every update, settle, and
 * observing call. A listener's update queues its record behind the one
 * running. A listener's error goes to `onError`; the others still run.
 */
export const drainRecords = (realm: ObservableRealm): void => {
  if (realm.draining) {
    return;
  }
  if (realm.updateDepth !== 0 || realm.core.depth !== 0) {
    // Queued inside a settle or an observing call that no update of this
    // realm encloses, such as a hook's write as a renderer mounts: the
    // update or call that encloses it drains, or else a microtask does.
    if (!realm.drainScheduled) {
      realm.drainScheduled = true;
      queueMicrotask(() => {
        realm.drainScheduled = false;
        drainRecords(realm);
      });
    }
    return;
  }
  const queue = realm.recordQueue;
  if (queue === undefined) {
    return;
  }
  realm.draining = true;
  const core = realm.core;
  const outerPlace = core.place;
  core.place = nextPlace(outerPlace, placeKind.listening);
  try {
    for (let index = 0; index < queue.length; index++) {
      const { record, listeners } = queue[index] as QueuedRecord;
      if (realm.status !== "open") {
        break;
      }
      for (const entry of listeners) {
        if (entry.stopped) {
          continue;
        }
        try {
          entry.listener(record);
        } catch (error) {
          realm.core.reportAside(error);
        }
      }
    }
  } finally {
    core.place = outerPlace;
    realm.recordQueue = undefined;
    realm.draining = false;
  }
};
