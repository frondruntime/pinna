/**
 * `read.snapshot` and `write.restore`: `read` and `write` applied across a
 * shape the caller declares, of boxes, collections, and `Model.Schema`
 * instances, in plain objects and arrays. Each leaf is a verb Pinna already
 * has, so a snapshot tracks, stages, and lands as the verbs do
 * (`docs/api.md`, ruling 64).
 */
import { PinnaUsageError } from "@frondruntime/pinna-core";
import { AtomCell, BoxCell, ComputedValue, Model } from "./box.ts";
import type { ClassInstance } from "./draft.ts";
import type { Atom } from "./modules/atom.ts";
import type { Box } from "./modules/box.ts";
import type { Collection } from "./modules/collection.ts";
import type { Computed } from "./modules/computed.ts";
import { type ObservableRealm, otherRealmError } from "./realm.ts";
import type { Read, Write } from "./verbs.ts";

/** Phantom key: the plain data a model's snapshot is, in the types only. */
export declare const snapshotType: unique symbol;

/**
 * Marks a model instance type with the plain data its snapshot is, `Data`: a
 * `Model.Schema` instance's wire keys, each `$` field's snapshot in place of
 * its box. `Restore` is what `write.restore` takes in its place: the same
 * keys, where an instance may stand in for a model row's data. Exists only in
 * the types.
 */
export interface ModelData<Data, Restore = Data> {
  readonly [snapshotType]: readonly [Data, Restore];
}

/** A collection row's snapshot: a model's data, any other row as held. */
type RowSnapshot<Row> = Row extends ModelData<infer Data, infer _Restore> ? Data : Row;

/** What a restore takes for a collection row: a model's restore data or the instance, any other row as held. */
type RowRestore<Row> = Row extends ModelData<infer _Data, infer Restore> ? Restore | Row : Row;

/**
 * What `read.snapshot(shape)` returns: a box's value as held, a collection's
 * rows in key order, a `Model.Schema` instance's data under its wire keys, and
 * a plain object or array of those in the same structure.
 */
export type Snapshot<Shape> =
  Shape extends Box<infer Value>
    ? Value
    : Shape extends ModelData<infer Data, infer _Restore>
      ? Data
      : Shape extends Collection<unknown, infer Row>
        ? ReadonlyArray<RowSnapshot<Row>>
        : Shape extends Computed<unknown> | Atom | ClassInstance
          ? never
          : Shape extends object
            ? { readonly [Key in keyof Shape]: Snapshot<Shape[Key]> }
            : never;

/**
 * What `write.restore(shape, data)` takes: a snapshot of `shape`, where a
 * `Model.Schema` instance, at a model's place or as a collection row, may
 * stand in for its data.
 */
export type RestoreData<Shape> =
  Shape extends Box<infer Value>
    ? Value
    : Shape extends ModelData<infer _Data, infer Restore>
      ? Restore | Shape
      : Shape extends Collection<unknown, infer Row>
        ? ReadonlyArray<RowRestore<Row>>
        : Shape extends Computed<unknown> | Atom | ClassInstance
          ? never
          : Shape extends object
            ? { readonly [Key in keyof Shape]: RestoreData<Shape[Key]> }
            : never;

/** One field of a `Model.Schema` instance, as its class describes it. */
export interface ModelField {
  /** The wire key: the key in the snapshot, a string or a symbol. */
  readonly key: PropertyKey;
  /** A box or a collection for a `$` field; the plain value for any other. */
  readonly value: unknown;
  /** True for a `$` field. */
  readonly state: boolean;
  /** A plain field's equivalence, from its schema. */
  readonly equals: (self: unknown, that: unknown) => boolean;
}

/** What a `Model.Schema` instance tells a snapshot about itself: pinna-effect defines it. */
export interface ModelShape {
  /** The class's identifier, for errors. */
  readonly name: string;
  readonly realm: ObservableRealm;
  /** The fields the instance holds, in declaration order. */
  readonly fields: ReadonlyArray<ModelField>;
}

/** The method a `Model.Schema` instance describes its fields with. */
export const modelShapeKey: unique symbol = Symbol("pinna/model-shape");

/** Marks `Collection.make`'s class, which `collection.ts` defines, on its prototype. */
export const collectionKey: unique symbol = Symbol("pinna/collection");

/** What a snapshot needs of a collection: `KeyedCollection` in `collection.ts`. */
interface SnapshotCollection {
  readonly [collectionKey]: true;
  readonly realm: ObservableRealm;
  readonly rows: Computed<ReadonlyArray<unknown>>;
  readonly keyOf: (row: unknown) => unknown;
  /**
   * True when the collection holds `Model.Schema` rows: set by pinna-effect
   * for a collection of a model class, and here once a snapshot or a
   * restore finds a model row in it, so a restore after its last model row
   * was removed still refuses plain data.
   */
  holdsModels: boolean;
  readonly name?: string | undefined;
}

interface Shaped {
  readonly [modelShapeKey]: () => ModelShape;
}

const isShaped = (value: unknown): value is Shaped =>
  typeof value === "object" && value !== null && modelShapeKey in value;

const isCollection = (value: unknown): value is SnapshotCollection =>
  typeof value === "object" && value !== null && collectionKey in value;

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const at = (path: string, key: PropertyKey): string =>
  typeof key === "symbol" ? `${path}[${String(key)}]` : `${path}.${key}`;

/**
 * The keys a shape's plain object holds: its own enumerable string keys,
 * then its own enumerable symbol keys, as the `Snapshot` type maps them.
 */
const shapeKeys = (object: object): Array<PropertyKey> => {
  const keys: Array<PropertyKey> = Object.keys(object);
  for (const key of Object.getOwnPropertySymbols(object)) {
    if (Object.prototype.propertyIsEnumerable.call(object, key)) {
      keys.push(key);
    }
  }
  return keys;
};

const keyName = (key: PropertyKey): string =>
  typeof key === "symbol" ? String(key) : `"${String(key)}"`;
const atIndex = (path: string, index: number): string => `${path}[${index}]`;
const atKey = (path: string, key: unknown): string =>
  `${path}[key ${typeof key === "string" ? JSON.stringify(key) : String(key)}]`;

const describe = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (value instanceof ComputedValue) return "a computed value";
  if (value instanceof AtomCell) return "an atom";
  if (value instanceof Model) return `a Model.Class instance (${value.constructor.name})`;
  if (isShaped(value)) return `a ${value[modelShapeKey]().name}`;
  if (isCollection(value)) return "a collection";
  if (value instanceof BoxCell) return "a box";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
};

const notState = (verb: string, path: string, value: unknown): Error =>
  new PinnaUsageError(
    "pinna/snapshot-not-state",
    `pinna: ${verb} at ${path} finds ${describe(value)}; a shape holds boxes, collections, Model.Schema instances, and plain objects and arrays of them. Put the boxes a computed value reads in the shape, and a Model.Class instance's boxes by name`,
  );

const cycle = (verb: string, path: string): Error =>
  new PinnaUsageError(
    "pinna/snapshot-cycle",
    `pinna: ${verb} at ${path} reaches an object that holds it; a shape is a tree`,
  );

const shapeError = (path: string, expected: string, data: unknown): Error =>
  new PinnaUsageError(
    "pinna/restore-shape",
    `pinna: write.restore at ${path} takes ${expected}, and the data holds ${describe(data)}`,
  );

const keysError = (
  path: string,
  missing: ReadonlyArray<PropertyKey>,
  extra: ReadonlyArray<PropertyKey>,
) =>
  new PinnaUsageError(
    "pinna/restore-shape",
    `pinna: write.restore at ${path} takes the shape's keys exactly; ${[
      missing.length === 0 ? "" : `the data lacks ${missing.map(keyName).join(", ")}`,
      extra.length === 0 ? "" : `the data adds ${extra.map(keyName).join(", ")}`,
    ]
      .filter((part) => part !== "")
      .join(", and ")}`,
  );

// Reading

/** Sets an own data property: an assignment to `__proto__` would call its setter instead. */
const setOwn = (data: Record<PropertyKey, unknown>, key: PropertyKey, value: unknown): void => {
  Object.defineProperty(data, key, { value, enumerable: true, writable: true, configurable: true });
};

const snapshotModel = (read: Read, model: Shaped, path: string, on: Set<object>): unknown => {
  const shape = model[modelShapeKey]();
  const data: Record<string, unknown> = {};
  for (const field of shape.fields) {
    setOwn(
      data,
      field.key,
      field.state ? snapshotOf(read, field.value, at(path, field.key), on) : field.value,
    );
  }
  return data;
};

const snapshotOf = (read: Read, shape: unknown, path: string, on: Set<object>): unknown => {
  if (shape instanceof BoxCell) {
    return read(shape as Box<unknown>);
  }
  if (typeof shape !== "object" || shape === null) {
    throw notState("read.snapshot", path, shape);
  }
  if (on.has(shape)) {
    throw cycle("read.snapshot", path);
  }
  on.add(shape);
  try {
    if (isCollection(shape)) {
      const rows = read(shape.rows);
      return rows.map((row, index) => {
        if (isShaped(row)) {
          shape.holdsModels = true;
          return snapshotModel(read, row, atKey(path, shape.keyOf(row)), on);
        }
        if (row instanceof Model) {
          throw notState("read.snapshot", atIndex(path, index), row);
        }
        return row;
      });
    }
    if (isShaped(shape)) {
      return snapshotModel(read, shape, path, on);
    }
    if (Array.isArray(shape)) {
      return shape.map((entry, index) => snapshotOf(read, entry, atIndex(path, index), on));
    }
    if (isPlainObject(shape)) {
      const data: Record<PropertyKey, unknown> = {};
      for (const key of shapeKeys(shape)) {
        setOwn(
          data,
          key,
          snapshotOf(read, (shape as Record<PropertyKey, unknown>)[key], at(path, key), on),
        );
      }
      return data;
    }
    throw notState("read.snapshot", path, shape);
  } finally {
    on.delete(shape);
  }
};

/** `read.snapshot(shape)`: `read` applied across `shape`. */
export const snapshotShape = (read: Read, shape: unknown): unknown =>
  snapshotOf(read, shape, "shape", new Set());

// Writing

/** Checks that `data` has exactly `keys`, naming what is missing and what is added. */
const exactKeys = (
  path: string,
  keys: ReadonlyArray<PropertyKey>,
  data: Readonly<Record<PropertyKey, unknown>>,
): void => {
  const given = shapeKeys(data);
  const expected = new Set(keys);
  const missing = keys.filter((key) => !Object.hasOwn(data, key));
  const extra = given.filter((key) => !expected.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw keysError(path, missing, extra);
  }
};

const plainFieldError = (path: string, name: string, key: PropertyKey): Error =>
  new PinnaUsageError(
    "pinna/restore-plain-field",
    `pinna: write.restore at ${path} finds ${keyName(key)} of the ${name} held there different in the data; a plain field is never written after the model is made, so restore into a model whose plain fields match, or make a new one with Model.decode`,
  );

/**
 * The fields of `source` by wire key, after checking that it is an instance
 * of `held`'s class, in its realm, holding the same fields: an optional plain
 * field present on one and absent on the other is a plain field that differs.
 */
const sourceFields = (
  held: Shaped,
  shape: ModelShape,
  source: Shaped,
  path: string,
): ReadonlyMap<PropertyKey, ModelField> => {
  if (source.constructor !== held.constructor) {
    throw shapeError(path, `a ${shape.name} or its data`, source);
  }
  const fields = source[modelShapeKey]();
  if (fields.realm !== shape.realm) {
    throw otherRealmError("write.restore", undefined, fields.realm, shape.realm);
  }
  const byKey = new Map(fields.fields.map((field) => [field.key, field] as const));
  for (const field of shape.fields) {
    if (!byKey.has(field.key)) {
      throw plainFieldError(path, shape.name, field.key);
    }
  }
  for (const key of byKey.keys()) {
    if (!shape.fields.some((field) => field.key === key)) {
      throw plainFieldError(path, shape.name, key);
    }
  }
  return byKey;
};

/** Whether every plain field of `source`, an instance of `held`'s class, equals `held`'s. */
const samePlainFields = (held: Shaped, source: Shaped): boolean => {
  if (source.constructor !== held.constructor) {
    return false;
  }
  const fields = held[modelShapeKey]().fields;
  const from = source[modelShapeKey]().fields;
  if (fields.length !== from.length) {
    return false;
  }
  for (const field of fields) {
    const other = from.find((candidate) => candidate.key === field.key);
    if (other === undefined || (!field.state && !field.equals(field.value, other.value))) {
      return false;
    }
  }
  return true;
};

/** Restores `held` in place from the data at its place: plain data, or another instance of its class. */
const restoreModel = (
  read: Read,
  write: Write,
  held: Shaped,
  data: unknown,
  path: string,
  on: Set<object>,
): void => {
  if (data === held) {
    return;
  }
  const shape = held[modelShapeKey]();
  if (isShaped(data)) {
    const source = sourceFields(held, shape, data, path);
    for (const field of shape.fields) {
      const from = source.get(field.key) as ModelField;
      const fieldPath = at(path, field.key);
      if (!field.state) {
        if (!field.equals(field.value, from.value)) {
          throw plainFieldError(path, shape.name, field.key);
        }
      } else if (field.value instanceof BoxCell) {
        write(field.value as Box<unknown>, read(from.value as Box<unknown>));
      } else {
        // A collection field: the source's rows are instances, which a new key takes as they are.
        restoreCollection(
          read,
          write,
          field.value as SnapshotCollection,
          read((from.value as SnapshotCollection).rows),
          fieldPath,
          on,
        );
      }
    }
    return;
  }
  if (!isPlainObject(data)) {
    throw shapeError(path, `a ${shape.name} or its data`, data);
  }
  exactKeys(
    path,
    shape.fields.map((field) => field.key),
    data,
  );
  for (const field of shape.fields) {
    const value = (data as Readonly<Record<PropertyKey, unknown>>)[field.key];
    if (!field.state) {
      if (!field.equals(field.value, value)) {
        throw plainFieldError(path, shape.name, field.key);
      }
    } else {
      restoreOf(read, write, field.value, value, at(path, field.key), on);
    }
  }
};

const cannotMakeRow = (path: string, key: unknown): Error =>
  new PinnaUsageError(
    "pinna/restore-cannot-make-row",
    `pinna: write.restore at ${atKey(path, key)} adds a model row from plain data; a restore never makes a model. Pass the instance in the data, made with Model.decode or make, or decode the whole input with Model.restore`,
  );

/**
 * The key of a data row: `keyOf` runs on the data, so for a model row it
 * reads a plain field, which the data holds under the same name. One that
 * calls a method of the instance throws, named here.
 */
const keyOfData = (collection: SnapshotCollection, row: unknown, path: string): unknown => {
  try {
    return collection.keyOf(row);
  } catch (error) {
    throw new PinnaUsageError(
      "pinna/restore-shape",
      `pinna: write.restore at ${path} cannot key a data row: the collection's keyOf throws on it; a keyOf that reads a plain field of the row works on its data too`,
      { cause: error },
    );
  }
};

/**
 * Makes the collection's rows the data's, by key: a held model row is restored
 * in place from its data, or from an instance of its class whose plain fields
 * match; any other instance replaces the row held under its key, or is
 * added; a plain row is written as it is; and the order is the data's.
 */
const restoreCollection = (
  read: Read,
  write: Write,
  collection: SnapshotCollection,
  data: unknown,
  path: string,
  on: Set<object>,
): void => {
  if (!Array.isArray(data)) {
    throw shapeError(path, "an array of rows", data);
  }
  const heldRows = read(collection.rows);
  const held = new Map<unknown, unknown>();
  for (const row of heldRows) {
    held.set(collection.keyOf(row), row);
    if (isShaped(row)) collection.holdsModels = true;
  }
  const holdsModels = collection.holdsModels;
  const rows = data.map((row: unknown) => {
    if (row instanceof Model) {
      throw notState("write.restore", path, row);
    }
    const key = isShaped(row) ? collection.keyOf(row) : keyOfData(collection, row, path);
    const previous = held.get(key);
    if (isShaped(row)) {
      const realm = row[modelShapeKey]().realm;
      if (realm !== collection.realm) {
        throw otherRealmError("write.restore", undefined, realm, collection.realm);
      }
      // Known from here on; this restore keeps the answer it read above.
      collection.holdsModels = true;
      // A refetched row whose plain fields differ replaces the held one, as ruling 51 merges.
      if (isShaped(previous) && previous !== row && samePlainFields(previous, row)) {
        restoreModel(read, write, previous, row, atKey(path, key), on);
        return previous;
      }
      return row;
    }
    if (isShaped(previous)) {
      restoreModel(read, write, previous, row, atKey(path, key), on);
      return previous;
    }
    // A plain row held under the key stays restorable beside model rows.
    if (previous === undefined && holdsModels) {
      throw cannotMakeRow(path, key);
    }
    return row;
  });
  write.replaceAll(collection as unknown as Collection<unknown, unknown>, rows);
};

const restoreOf = (
  read: Read,
  write: Write,
  shape: unknown,
  data: unknown,
  path: string,
  on: Set<object>,
): void => {
  if (shape instanceof BoxCell) {
    write(shape as Box<unknown>, data);
    return;
  }
  if (typeof shape !== "object" || shape === null) {
    throw notState("write.restore", path, shape);
  }
  if (on.has(shape)) {
    throw cycle("write.restore", path);
  }
  on.add(shape);
  try {
    if (isCollection(shape)) {
      restoreCollection(read, write, shape, data, path, on);
    } else if (isShaped(shape)) {
      restoreModel(read, write, shape, data, path, on);
    } else if (Array.isArray(shape)) {
      if (!Array.isArray(data) || data.length !== shape.length) {
        throw shapeError(path, `an array of ${shape.length}`, data);
      }
      // A hole in the shape is a hole in its snapshot, as `map` leaves it.
      for (let index = 0; index < shape.length; index++) {
        if (!(index in shape)) {
          if (index in data) {
            throw shapeError(atIndex(path, index), "an empty slot", data[index]);
          }
          continue;
        }
        restoreOf(read, write, shape[index], data[index], atIndex(path, index), on);
      }
    } else if (isPlainObject(shape)) {
      if (!isPlainObject(data)) {
        throw shapeError(path, "an object", data);
      }
      const keys = shapeKeys(shape);
      exactKeys(path, keys, data);
      for (const key of keys) {
        restoreOf(
          read,
          write,
          (shape as Record<PropertyKey, unknown>)[key],
          (data as Record<PropertyKey, unknown>)[key],
          at(path, key),
          on,
        );
      }
    } else {
      throw notState("write.restore", path, shape);
    }
  } finally {
    on.delete(shape);
  }
};

/**
 * `write.restore(shape, data)`: `write` applied across `shape`, reading what
 * it compares through `read`. The caller runs it in a scope that puts back
 * its writes on a throw.
 */
export const restoreShape = (read: Read, write: Write, shape: unknown, data: unknown): void => {
  restoreOf(read, write, shape, data, "shape", new Set());
};
