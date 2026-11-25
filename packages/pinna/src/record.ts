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
import { type AtomCell, type BoxCell, CollectionCell } from "./box.ts";
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

const keyText = (key: unknown): string => {
  try {
    return typeof key === "string" ? `"${key}"` : String(key);
  } catch {
    return "a key";
  }
};

const notApplicable = (
  verb: string,
  collection: Collection<unknown, unknown>,
  key: unknown,
): PinnaUsageError =>
  new PinnaUsageError(
    "pinna/record-not-applicable",
    `pinna: ${verb} needs the row under ${keyText(key)} of ${describeCollection(collection)}, which neither the record nor the collection holds; apply records in the order they landed, each to the state the previous one left`,
  );

/**
 * Applies `record` through `write`, forward (`after`) or backward
 * (`before`): boxes, then collections, then atoms. A collection whose key
 * order changed gets its whole order back through `write.replaceAll`, with
 * each unchanged key's row as `read.row` holds it now; one whose order did
 * not change gets `write.upsert` or `write.remove` per row, which keeps
 * each position.
 */
export const applyRecord = (
  read: Read,
  write: Write,
  record: UpdateRecord,
  forward: boolean,
  verb: string,
): void => {
  for (const change of record.boxes) {
    write(change.box, forward ? change.after : change.before);
  }
  for (const change of record.collections) {
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
      continue;
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
        throw notApplicable(verb, collection, key);
      }
      values[index] = value;
    }
    write.replaceAll(collection, values);
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
  const collections = realm.recordedCollections;
  if (collections !== undefined) {
    realm.recordedCollections = undefined;
    for (const collection of collections) {
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
