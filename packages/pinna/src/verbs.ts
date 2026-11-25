/**
 * The verbs every place hands out: `read`, with its `row` and `snapshot`, and
 * `write`, with its collection, atom, restore, and record verbs, made once per
 * realm; `peek` and `Source.peek`.
 */
import { PinnaUsageError, placeOpen, type Source } from "@frondruntime/pinna-core";
import { AtomCell, BoxCell, type ComputedValue, describeSource, names, realmOf } from "./box.ts";
import type { Draft } from "./draft.ts";
import type { Atom } from "./modules/atom.ts";
import type { Box } from "./modules/box.ts";
import type { Collection } from "./modules/collection.ts";
import type { Computed } from "./modules/computed.ts";
import { inRecipe, type ObservableRealm, otherRealmError, recipeReadError } from "./realm.ts";
import { applyRecord, type UpdateRecord } from "./record.ts";
import { type RestoreData, restoreShape, type Snapshot, snapshotShape } from "./snapshot.ts";

/** Where `upsert` puts a new key: first by default. */
export interface UpsertOptions {
  readonly at?: "start" | "end";
}
/** Thrown by `read.row` outside every place of its realm. */
const readRowError = (): Error =>
  new PinnaUsageError(
    "pinna/read-outside-place",
    "pinna: read.row($collection, key) runs outside a place. In a handler, use Realm.untracked; elsewhere, read inside Computed.make, Computed.fn, Realm.watch, Realm.autorun, or Realm.update of its own realm",
  );
/** Thrown by a read outside every place of its realm; names the observable when it has a name. */
const readError = (source: Source, owner: ObservableRealm): Error => {
  if (inRecipe(owner.core)) {
    return recipeReadError(`read(${describeSource(source)})`);
  }
  const name = names.get(source);
  const what = name === undefined ? "$observable" : `"${name}"`;
  return new PinnaUsageError(
    "pinna/read-outside-place",
    `pinna: read(${what}) runs outside a place. In a component, use useValue($observable) or useSelect; in a handler, Realm.untracked; elsewhere, read inside Computed.make, Computed.fn, Realm.watch, Realm.autorun, or Realm.update of its own realm`,
  );
};
// The verbs every place hands out

/**
 * Reads an observable and subscribes the tracked place it runs in; an atom
 * it subscribes and returns nothing. Handed to every place that reads: a
 * computed value, a computed function, a watch's select, an autorun, `useSelect`,
 * `Realm.update`, and `Realm.untracked`. With no place of the observable's realm open,
 * it throws.
 */
export interface Read {
  <Value>(observable: Computed<Value>): Value;
  (atom: Atom): undefined;
  /**
   * The row under `key`, or `undefined`. In a tracked place it is
   * `read($rows.row(key))` and tracks that key alone. Where nothing tracks
   * (an update's recipe, `Realm.untracked`, a watch's effect), it reads the row the
   * collection holds and makes no row computed and no cell, which a first
   * read of a key would otherwise keep for as long as the key is present.
   */
  row<Key, Value>(collection: Collection<Key, Value>, key: NoInfer<Key>): Value | undefined;
  /**
   * `read` applied across `shape`: each box's value, each collection's rows
   * in key order, and each `Model.Schema` instance's data under its wire
   * keys, in the shape's structure. It reads as `read` does where it runs, so
   * in a tracked place it tracks every box and collection in the shape.
   */
  snapshot<Shape>(shape: Shape): Snapshot<Shape>;
}

/**
 * What `Realm.update` and `Stage.update` run: it reads and writes through what it is
 * handed, and returns nothing. A function that hands back a change for its
 * caller to run returns a `UpdateRecipe`.
 */
export type UpdateRecipe = (read: Read, write: Write) => undefined;

/** Where a merge into a held model reads and writes: a stage recipe's place, or the realm's. */
export interface Place {
  readonly read: Read;
  readonly write: Write;
}

/** A stage's place can put back an operation's overlay writes when it throws. */
export interface StagedPlace extends Place {
  readonly undoOnThrow: <Result>(run: () => Result) => Result;
}

/**
 * A `read` that reads what the realm holds and subscribes nothing, for a
 * merge planned outside any place: a box's value, a computed value's, and a
 * collection's held row.
 */
export const peekReader = (): Read => {
  function read<Value>(observable: Computed<Value>): Value;
  function read(atom: Atom): undefined;
  function read(observable: Computed<unknown> | Atom): unknown {
    if (observable instanceof AtomCell) {
      return undefined;
    }
    return peek(observable as Computed<unknown>);
  }
  const row = <Key, Value>(collection: Collection<Key, Value>, key: Key): Value | undefined =>
    (collection as unknown as CollectionReader<Key, Value>).heldRow(key);
  return withSnapshot(read, row);
};

/** A `read` with its `row` and its `snapshot`, which reads through the `read` itself. */
export const withSnapshot = (read: (observable: never) => unknown, row: Read["row"]): Read => {
  const reader = Object.assign(read, {
    row,
    snapshot: <Shape>(shape: Shape): Snapshot<Shape> =>
      snapshotShape(reader, shape) as Snapshot<Shape>,
  }) as unknown as Read;
  return reader;
};

/** Writes, handed out by `Realm.update` alone. Each returns `undefined`, so a recipe can end in one. */
export interface Write {
  /** Replaces the box's value, through the box's check: pinna-effect's `Box.schema` checks its schema. */
  <Value>(box: Box<Value>, value: NoInfer<Value>): undefined;
  /** Writes through a draft of the box's array or plain object. */
  modify<Value>(box: Box<Value>, recipe: (draft: Draft<Value>) => undefined): undefined;
  /** Replaces the row with the same key in place, or adds it first, or last with `{ at: "end" }`. */
  upsert<Key, Value>(
    collection: Collection<Key, Value>,
    value: NoInfer<Value>,
    options?: UpsertOptions,
  ): undefined;
  /** Removes the row under `key`; a missing key changes nothing. */
  remove<Key, Value>(collection: Collection<Key, Value>, key: NoInfer<Key>): undefined;
  /** Makes the rows `values`, in their order. */
  replaceAll<Key, Value>(
    collection: Collection<Key, Value>,
    values: ReadonlyArray<NoInfer<Value>>,
  ): undefined;
  /** Reruns what observed the atom. */
  changed(atom: Atom): undefined;
  /**
   * `write` applied across `shape`, from `data` in the form `read.snapshot`
   * returns: each box written through its check, each collection's rows made
   * the data's by key, each `Model.Schema` instance restored in place. The
   * data's shape must match exactly. A throw puts back every write the
   * restore made, even when the caller catches it.
   */
  restore<Shape>(shape: Shape, data: NoInfer<RestoreData<Shape>>): undefined;
  /**
   * Applies a `Realm.onUpdate` record forward: each box gets its `after`,
   * each collection its rows after and, when it moved, its key order after,
   * and each atom is changed. A throw puts back every write it made.
   */
  replay(record: UpdateRecord): undefined;
  /** Applies a record backward, to each `before`: undo. A throw puts back every write it made. */
  revert(record: UpdateRecord): undefined;
}

/**
 * The realm's reader, made once per realm: the observable must be the realm's
 * own. Inside a tracked run, the common read, the checks are two fields;
 * outside, three.
 */
export const readIn = (owner: ObservableRealm): Read => {
  function read<Value>(observable: Computed<Value>): Value;
  function read(atom: Atom): undefined;
  function read(observable: Computed<unknown> | Atom): unknown {
    const cell = observable as BoxCell<unknown> | ComputedValue<unknown> | AtomCell;
    if (cell.realm !== owner) {
      throw otherRealmError("read", cell.source, cell.realm, owner);
    }
    // 1 is `placeOpen`, written out as in `Realm.assertWritable`.
    if (owner.core.active === undefined && (owner.core.place & 1) === 0) {
      throw readError(cell.source, owner);
    }
    // A method on each wrapper class: the kind is chosen by its class, not by a branch.
    return cell.read();
  }
  const row = <Key, Value>(collection: Collection<Key, Value>, key: Key): Value | undefined => {
    const reader = collection as CollectionReader<Key, Value>;
    if (reader.realm !== owner) {
      throw otherRealmError("read.row", undefined, reader.realm, owner);
    }
    if (owner.core.active !== undefined) {
      return (reader.row(key) as ComputedValue<Value | undefined>).read();
    }
    if ((owner.core.place & placeOpen) === 0) {
      throw inRecipe(owner.core) ? recipeReadError("read.row") : readRowError();
    }
    return reader.heldRow(key);
  };
  return withSnapshot(read, row);
};

/** What `read.row` needs of a collection, which `KeyedCollection` in `collection.ts` defines. */
interface CollectionReader<Key, Value> extends Collection<Key, Value> {
  readonly realm: ObservableRealm;
  heldRow(key: Key): Value | undefined;
}

/**
 * Reads a box or a computed value anywhere and subscribes nothing: for sibling
 * packages (`pinna-react`, `pinna-effect`), never a place's read. A computed
 * value nothing observes computes, and caches nothing.
 */
export const peek = <Value>(observable: Computed<Value>): Value => {
  const cell = observable as BoxCell<Value> | ComputedValue<Value>;
  return cell instanceof BoxCell ? cell.peek() : cell.realm.peekDerived(cell.source);
};

/**
 * `Source.peek`: reads one box or computed value without tracking, from an
 * event handler or a test. Throws where a read would be tracked or staged,
 * so it cannot go stale silently: inside a computed value, a watch's select,
 * or an autorun (`Realm.isTracking`), and inside a stage recipe, where it would
 * read the value from before the stage. `Realm.untracked` reads several values.
 */
export const peekOutside = <Value>(observable: Computed<Value>): Value => {
  const realm = realmOf(observable);
  if (inRecipe(realm.core)) {
    throw new PinnaUsageError(
      "pinna/peek-in-recipe",
      "pinna: Source.peek runs inside a stage recipe, where it would read the value from before the stage; read through the recipe's own read",
    );
  }
  if (realm.core.isTracking()) {
    throw new PinnaUsageError(
      "pinna/peek-while-tracking",
      "pinna: Source.peek runs where reads are tracked, in a computed value, a watch's select, or an autorun, so the result would go stale; read with read",
    );
  }
  return peek(observable);
};

/** The collection's writers, which `KeyedCollection` in `collection.ts` defines. */
interface CollectionWriter<Key, Value> extends Collection<Key, Value> {
  readonly realm: ObservableRealm;
  upsertRow(value: Value, options: UpsertOptions | undefined): void;
  removeRow(key: Key): void;
  replaceRows(values: ReadonlyArray<Value>): void;
}

/**
 * The realm's writer, made once per realm: each verb takes only the realm's
 * own boxes, collections, and atoms, and then checks the realm's update.
 */
export const writeIn = (owner: ObservableRealm): Write => {
  const ownBox = <Value>(verb: string, box: Box<Value>): BoxCell<Value> => {
    const cell = box as BoxCell<Value>;
    if (cell.realm !== owner) {
      throw otherRealmError(verb, cell.source, cell.realm, owner);
    }
    return cell;
  };
  const ownCollection = <Key, Value>(
    verb: string,
    collection: Collection<Key, Value>,
  ): CollectionWriter<Key, Value> => {
    const writer = collection as CollectionWriter<Key, Value>;
    if (writer.realm !== owner) {
      throw otherRealmError(verb, undefined, writer.realm, owner);
    }
    return writer;
  };
  const writeBox = <Value>(box: Box<Value>, value: Value): undefined => {
    ownBox("write", box).write(value);
    return undefined;
  };
  const writer: Write = Object.assign(writeBox, {
    modify: <Value>(box: Box<Value>, recipe: (draft: Draft<Value>) => undefined): undefined => {
      ownBox("write.modify", box).modifyValue(recipe);
      return undefined;
    },
    upsert: <Key, Value>(
      collection: Collection<Key, Value>,
      value: Value,
      options?: UpsertOptions,
    ): undefined => {
      ownCollection("write.upsert", collection).upsertRow(value, options);
      return undefined;
    },
    remove: <Key, Value>(collection: Collection<Key, Value>, key: Key): undefined => {
      ownCollection("write.remove", collection).removeRow(key);
      return undefined;
    },
    replaceAll: <Key, Value>(
      collection: Collection<Key, Value>,
      values: ReadonlyArray<Value>,
    ): undefined => {
      ownCollection("write.replaceAll", collection).replaceRows(values);
      return undefined;
    },
    changed: (atom: Atom): undefined => {
      const cell = atom as AtomCell;
      if (cell.realm !== owner) {
        throw otherRealmError("write.changed", cell.source, cell.realm, owner);
      }
      cell.change();
      return undefined;
    },
    restore: <Shape>(shape: Shape, data: RestoreData<Shape>): undefined => {
      owner.assertWritable();
      // Reads what the realm holds now, as a merge does: the open update's values.
      owner.undoOnThrow(() => {
        restoreShape(owner.place().read, writer, shape, data);
      });
      return undefined;
    },
    replay: (record: UpdateRecord): undefined => {
      owner.assertWritable();
      owner.undoOnThrow(() => {
        applyRecord(owner.place().read, writer, record, true, "write.replay");
      });
      return undefined;
    },
    revert: (record: UpdateRecord): undefined => {
      owner.assertWritable();
      owner.undoOnThrow(() => {
        applyRecord(owner.place().read, writer, record, false, "write.revert");
      });
      return undefined;
    },
  });
  return writer;
};
