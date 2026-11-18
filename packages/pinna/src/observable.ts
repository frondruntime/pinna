/**
 * Observables: a box holds state, a computed value derives it, and an atom
 * stands for state kept outside Pinna. Nothing else is observable. Every
 * observable is named with a leading `$`, so a reader sees from a line what
 * can change.
 *
 * Values are plain data, `readonly` in the types and not frozen at runtime:
 * freezing makes large arrays slow to build and to walk in JavaScriptCore. A
 * write replaces the value; the box keeps its identity.
 *
 * An observable has no read or write methods. Every place that reads hands
 * out `read`: a computed value, a computed function, a watcher's select, an autorun,
 * `useSelect`, an update, and `untracked`. `read($observable)` subscribes the place it runs in, and
 * throws outside a place of the observable's own realm, so a read that
 * nothing tracks fails loudly instead of going stale. Each realm hands out
 * its own `read` and `write`, and they throw for an observable another realm
 * made. With no method to call,
 * a read outside a place does not type-check; a `read` kept past its place
 * fails only when it runs, and only once no place of its realm is open.
 * docs/design.md lists the limits.
 *
 * Every observable is made by a realm, from `createRealm()`, and keeps it.
 * Updates, tracking, watchers, and the verbs belong to one realm; nothing is
 * shared through the module.
 *
 * Writes happen only inside `update`, through the `write` it hands out. An
 * update is atomic: if its recipe throws, every box it wrote gets its old
 * value back before the error leaves it, and watchers see only the end state.
 * An update runs from an event, a watch's effect, or an autorun's body; a
 * computed value, a watch's select, and a selector are derivations, and an
 * update there throws.
 */
import {
  type AtomNode,
  type CellNode,
  Graph as CoreGraph,
  type DerivedNode,
  dependenciesOf,
  type Equals,
  hasRun,
  isAtom,
  isDerived,
  lastReason,
  observerCount,
  peekCell,
  peekDerived,
  readAtom,
  readCell,
  readDerived,
  reportUncaught,
  restoreCell,
  type Source,
  touchSource,
  writeCell,
} from "@frondruntime/pinna-core";

type Primitive = string | number | boolean | bigint | symbol | null | undefined;
type Opaque = Primitive | RegExp | ((...args: never) => unknown);

// Phantom keys: they carry an observable's type and exist only in the types.
declare const readsAs: unique symbol;
declare const writesAs: unique symbol;
declare const atomKind: unique symbol;

/**
 * An observable value derived from other observables. Cached; recomputes when
 * they change. Read it with `read` in a place.
 */
export interface Computed<Value> {
  readonly [readsAs]: () => Value;
}

/**
 * Observable state. Read it with `read` in a place; write it with `write`
 * inside `update`. A box reads as a computed value does, so whatever takes a
 * `Computed` takes a box.
 */
export interface Box<Value> extends Computed<Value> {
  readonly [writesAs]: (value: Value) => void;
}

/**
 * State kept outside Pinna. Code that reads that state calls `read($atom)`,
 * and code that changes it calls `write.changed($atom)` inside `update`; a
 * rolled-back update still reruns what observed it once. An atom has no
 * value of its own.
 */
export interface Atom {
  readonly [atomKind]: true;
}

/**
 * Rows by key, in order: a cell for each key a reader reads, and one for the order. A write to
 * one key reruns only what read that key; adding, removing, or moving a key
 * reruns only what read `keys`. Written inside `update`, like a box, through
 * `write.upsert`, `write.remove`, and `write.replaceAll`; a `CollectionField`
 * field checks each row against its schema and is a plain array on the wire,
 * and `collection` rejects `undefined` rows and checks nothing else.
 */
export interface Collection<Key, Value> {
  /**
   * The row under `key`, or `undefined`. Tracks that key alone, so a key that
   * is missing now reruns its reader when it is added. While the key is
   * present, it returns the same computed value; while it is missing, only
   * while something observes it. One taken while the key was missing keeps
   * working once it is added, though `row` then returns another.
   */
  row(key: Key): Computed<Value | undefined>;
  /** The keys in order. Changes only when a key is added, removed, or moved. */
  readonly keys: Computed<ReadonlyArray<Key>>;
  /**
   * Every row in key order. Its reader reruns when any row or the order
   * changes, so a list that renders one row per key reads `keys` and `row`.
   */
  readonly rows: Computed<ReadonlyArray<Value>>;
}

/** Where `upsert` puts a new key: first by default. */
export interface UpsertOptions {
  readonly at?: "start" | "end";
}

declare const classInstance: unique symbol;

/**
 * Marks a model instance in the types, a `Model` or a pinna-effect
 * `SchemaModel`. A draft leaves a marked value read-only: it is not drafted,
 * so writing its fields would change the shared instance and notify nobody.
 */
export interface ClassInstance {
  readonly [classInstance]: true;
}

/**
 * A model that checks nothing: a class whose fields are boxes, computed
 * values, and collections in one realm. Extending it marks the instance, so
 * a draft leaves it read-only, and gives field initializers `this.realm`.
 */
export abstract class Model {
  declare readonly [classInstance]: true;
  constructor(readonly realm: Realm) {}
}

/** A `Date` without its `set` methods. */
type ReadonlyDate = {
  readonly [Key in keyof Date as Key extends `set${string}` ? never : Key]: Date[Key];
};

/**
 * A value a draft does not copy, read-only all the way down: a draft hands
 * back the held value itself, so a write in place would change it and notify
 * nobody.
 */
type DeepReadonly<Value> = Value extends Opaque
  ? Value
  : Value extends Date
    ? ReadonlyDate
    : Value extends Box<unknown> | Computed<unknown> | Collection<unknown, unknown> | ClassInstance
      ? Value
      : Value extends ReadonlyMap<infer Key, infer Item>
        ? ReadonlyMap<DeepReadonly<Key>, DeepReadonly<Item>>
        : Value extends ReadonlySet<infer Item>
          ? ReadonlySet<DeepReadonly<Item>>
          : Value extends ReadonlyArray<infer Element>
            ? ReadonlyArray<DeepReadonly<Element>>
            : { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> };

/**
 * What a `modify` recipe may write: arrays and plain objects, drafted down to
 * boxes. A `Date`, `Map` or `Set` is not drafted, so it is read-only; replace
 * it with a new one.
 */
export type Draft<Value> = Value extends Opaque
  ? Value
  : Value extends Box<unknown> | Computed<unknown> | Collection<unknown, unknown> | ClassInstance
    ? Value
    : Value extends Date | ReadonlyMap<unknown, unknown> | ReadonlySet<unknown>
      ? DeepReadonly<Value>
      : Value extends ReadonlyArray<infer Element>
        ? Array<Draft<Element>>
        : { -readonly [Key in keyof Value]: Draft<Value[Key]> };

export interface Options<Value> {
  /**
   * Compares a new value with the current one; an equal value notifies
   * nobody and the observable keeps its current value. A box with a schema
   * defaults to the schema's equivalence; anything else to `Object.is`.
   */
  readonly equals?: Equals<Value>;
  /**
   * A name for tools, reported by `inspect`. A named computed value
   * also keeps why it last recomputed, and its errors name it.
   */
  readonly name?: string;
}

/**
 * What `inspect` reports. Dependencies are what the last run read,
 * each once, in read order; inspecting runs nothing, so a stale value
 * reports its last run.
 */
export interface Inspection {
  readonly name: string | undefined;
  /** The name of the realm that made the value, from `createRealm({ name })`. */
  readonly realm: string | undefined;
  /** An unnamed dependency is `"<anonymous>"`. */
  readonly dependencies: ReadonlyArray<string>;
  readonly observers: number;
  /** Why a named computed value last recomputed; `undefined` for anything else. */
  readonly lastReason: string | undefined;
}

/**
 * Names, by graph node. Written only when a name is given, so an unnamed
 * observable, and so a decoded row, costs nothing here.
 */
const names = new WeakMap<Source, string>();

const nameOf = (source: Source): string => names.get(source) ?? "<anonymous>";

/** Why a named computed value runs. An atom nothing observes counts as changed on every check. */
const explain = (cause: Source | null): string => {
  if (cause === null) {
    return "the first run";
  }
  if (isAtom(cause) && observerCount(cause) === 0) {
    return `${nameOf(cause)} is an atom nothing observes, so it counts as changed`;
  }
  return `${nameOf(cause)} changed`;
};

/** Thrown by `read.row` outside every place of its realm. */
const readRowError = (): Error =>
  new Error(
    "pinna: read.row($collection, key) runs outside a place. In a handler, use untracked; elsewhere, read inside computed, computedFunction, watch, autorun, or update of its own realm",
  );

const checkName = (name: string | undefined): void => {
  if (name === "") {
    throw new Error("pinna: a name is a non-empty string");
  }
};

/** Thrown by a read outside every place of its realm; names the observable when it has a name. */
const readError = (source: Source): Error => {
  const name = names.get(source);
  const what = name === undefined ? "$observable" : `"${name}"`;
  return new Error(
    `pinna: read(${what}) runs outside a place. In a component, use useValue($observable) or useSelect; in a handler, untracked; elsewhere, read inside computed, computedFunction, watch, autorun, or update of its own realm`,
  );
};

/** Both realms' names, for an error about observables of two realms; empty when neither has one. */
export const realmsOf = (theirs: ObservableRealm, ours: ObservableRealm): string =>
  theirs.name === undefined && ours.name === undefined
    ? ""
    : ` (realm ${theirs.name === undefined ? "unnamed" : `"${theirs.name}"`}, not ${ours.name === undefined ? "unnamed" : `"${ours.name}"`})`;

/**
 * Thrown by a realm's verb handed an observable of another realm; names it
 * when it has a name, and each realm that has one. Realms are told apart by
 * identity, never by name.
 */
const otherRealmError = (
  verb: string,
  source: Source | undefined,
  theirs: ObservableRealm,
  ours: ObservableRealm,
): Error => {
  const name = source === undefined ? undefined : names.get(source);
  const what = name === undefined ? "$observable" : `"${name}"`;
  return new Error(
    `pinna: ${verb}(${what}) is handed an observable of another realm${realmsOf(theirs, ours)}. A realm's read and write take only what that realm made`,
  );
};

// Walking values

const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** Visits each own key. Arrays by index: `Object.keys` on a large array is ten times slower in JavaScriptCore. */
const forEachKey = (value: object, visit: (key: PropertyKey) => void): void => {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      visit(index);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    visit(key);
  }
};

// Drafts

const draftKey: unique symbol = Symbol("pinna.draft");

/** One recipe's drafts share it; they are revoked when the recipe returns. */
interface DraftSession {
  open: boolean;
}

interface DraftState {
  readonly base: Record<PropertyKey, unknown>;
  copy: Record<PropertyKey, unknown> | undefined;
  /** Read children stay here until a write needs the parent copy. */
  children: Map<PropertyKey, Record<PropertyKey, unknown>> | undefined;
  readonly parent: DraftState | undefined;
  readonly session: DraftSession;
  /** Assigned containers can hold drafts even at keys never read or written. */
  readonly supplied: boolean;
  modified: boolean;
  /** Keys written or drafted in the copy; only these can differ from the base. */
  readonly touched: Set<PropertyKey>;
}

const isDraftable = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" &&
  value !== null &&
  (Array.isArray(value) || isPlainObject(value)) &&
  !(draftKey in value);

const latest = (state: DraftState): Record<PropertyKey, unknown> => state.copy ?? state.base;

const ensureCopy = (state: DraftState): Record<PropertyKey, unknown> => {
  if (state.copy === undefined) {
    state.copy = Array.isArray(state.base)
      ? (state.base.slice() as unknown as Record<PropertyKey, unknown>)
      : { ...state.base };
    if (state.children !== undefined) {
      for (const [key, child] of state.children) {
        state.copy[key] = child;
      }
      state.children = undefined;
    }
  }
  return state.copy;
};

const markModified = (start: DraftState): void => {
  for (let state: DraftState | undefined = start; state !== undefined && !state.modified; ) {
    state.modified = true;
    state = state.parent;
  }
};

const assertDraftOpen = (state: DraftState): void => {
  if (!state.session.open) {
    throw new Error("pinna: a draft is used after its recipe returned");
  }
};

/** A draft's state, or `undefined` when `value` is not a draft. */
const draftStateOf = (value: unknown): DraftState | undefined =>
  typeof value === "object" && value !== null
    ? (value as { [draftKey]?: DraftState })[draftKey]
    : undefined;

const indexOfKey = (key: PropertyKey): number | undefined =>
  typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) : undefined;

/**
 * Runs `move` on the copy itself and shifts the touched keys with the
 * elements, so the elements it moves stay undrafted: a read drafts them
 * wherever they now sit. `move` removes `removed` elements at `start` and
 * inserts `inserted`. The removed ones come back as a read would give them.
 */
const moveElements = (
  state: DraftState,
  start: number,
  removed: number,
  inserted: number,
  move: (copy: Array<unknown>) => Array<unknown>,
): Array<unknown> => {
  const copy = ensureCopy(state) as unknown as Array<unknown>;
  const removedOrigins: Array<"base" | "supplied" | undefined> = [];
  for (let index = start; index < start + removed; index++) {
    removedOrigins.push(
      isDraftable(copy[index])
        ? state.supplied || state.touched.has(String(index))
          ? "supplied"
          : "base"
        : undefined,
    );
  }
  const out = move(copy);
  const touched = [...state.touched];
  state.touched.clear();
  for (const key of touched) {
    const index = indexOfKey(key);
    if (index === undefined || index < start) {
      state.touched.add(key);
    } else if (index >= start + removed) {
      state.touched.add(String(index - removed + inserted));
    }
  }
  for (let index = start; index < start + inserted; index++) {
    state.touched.add(String(index));
  }
  if (removed > 0 || inserted > 0) {
    markModified(state);
  }
  return out.map((value, index) =>
    removedOrigins[index] !== undefined
      ? createDraft(
          value as Record<PropertyKey, unknown>,
          state,
          state.session,
          removedOrigins[index] === "supplied",
        )
      : value,
  );
};

/** `Array.prototype` turns a start or count argument into an integer this way. */
const toInteger = (value: unknown): number => Math.trunc(Number(value)) || 0;

/**
 * `shift`, `unshift`, and `splice` for a draft array. The native methods read
 * every element after the change through the draft, which drafts each one: a
 * shift of 5,000 rows made 5,000 drafts. These run on the copy instead. Called
 * on anything but a draft array, they are the native methods.
 */
const arrayMoves = {
  shift(this: unknown): unknown {
    const state = draftStateOf(this);
    if (state === undefined || !Array.isArray(state.base)) {
      return Array.prototype.shift.call(this);
    }
    assertDraftOpen(state);
    if ((latest(state) as unknown as Array<unknown>).length === 0) {
      return undefined;
    }
    return moveElements(state, 0, 1, 0, (copy) => [copy.shift()])[0];
  },
  unshift(this: unknown, ...items: Array<unknown>): number {
    const state = draftStateOf(this);
    if (state === undefined || !Array.isArray(state.base)) {
      return Array.prototype.unshift.apply(this, items);
    }
    assertDraftOpen(state);
    moveElements(state, 0, 0, items.length, (copy) => {
      copy.unshift(...items);
      return [];
    });
    return (latest(state) as unknown as Array<unknown>).length;
  },
  splice(this: unknown, ...args: Array<unknown>): Array<unknown> {
    const state = draftStateOf(this);
    if (state === undefined || !Array.isArray(state.base)) {
      return Array.prototype.splice.apply(this, args as [number, number, ...Array<unknown>]);
    }
    assertDraftOpen(state);
    const length = (latest(state) as unknown as Array<unknown>).length;
    const relative = toInteger(args[0]);
    const start = relative < 0 ? Math.max(length + relative, 0) : Math.min(relative, length);
    const removed =
      args.length === 0
        ? 0
        : args.length === 1
          ? length - start
          : Math.min(Math.max(toInteger(args[1]), 0), length - start);
    const items = args.slice(2);
    return moveElements(state, start, removed, items.length, (copy) =>
      copy.splice(start, removed, ...items),
    );
  },
};

const draftHandler: ProxyHandler<object> = {
  get(target, key) {
    const state = (target as { [draftKey]: DraftState })[draftKey];
    if (key === draftKey) {
      return state;
    }
    assertDraftOpen(state);
    const source = latest(state);
    if (!Object.hasOwn(source, key)) {
      if (Array.isArray(state.base) && typeof key === "string" && Object.hasOwn(arrayMoves, key)) {
        return arrayMoves[key as keyof typeof arrayMoves];
      }
      return Reflect.get(source, key);
    }
    const value = source[key];
    if (isDraftable(value)) {
      const cached = state.children?.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const child = createDraft(
        value,
        state,
        state.session,
        state.supplied || state.touched.has(key),
      );
      if (state.copy === undefined) {
        state.children ??= new Map();
        state.children.set(key, child);
      } else {
        state.copy[key] = child;
      }
      state.touched.add(key);
      return child;
    }
    return value;
  },
  set(target, key, value) {
    const state = (target as { [draftKey]: DraftState })[draftKey];
    assertDraftOpen(state);
    const copy = ensureCopy(state);
    if (Object.hasOwn(copy, key) && Object.is(copy[key], value)) {
      return true;
    }
    copy[key] = value;
    state.touched.add(key);
    markModified(state);
    return true;
  },
  deleteProperty(target, key) {
    const state = (target as { [draftKey]: DraftState })[draftKey];
    assertDraftOpen(state);
    delete ensureCopy(state)[key];
    markModified(state);
    return true;
  },
  has(target, key) {
    return key === draftKey || key in latest((target as { [draftKey]: DraftState })[draftKey]);
  },
  ownKeys(target) {
    return Reflect.ownKeys(latest((target as { [draftKey]: DraftState })[draftKey]));
  },
  getOwnPropertyDescriptor(target, key) {
    const state = (target as { [draftKey]: DraftState })[draftKey];
    const source = latest(state);
    const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined) {
      return undefined;
    }
    const isLength = Array.isArray(state.base) && key === "length";
    return {
      writable: true,
      configurable: !isLength,
      enumerable: descriptor.enumerable ?? false,
      value: source[key],
    };
  },
  defineProperty() {
    throw new Error("pinna: a draft does not take defineProperty; assign instead");
  },
  getPrototypeOf(target) {
    return Object.getPrototypeOf((target as { [draftKey]: DraftState })[draftKey].base);
  },
  setPrototypeOf() {
    throw new Error("pinna: a draft cannot change its prototype");
  },
};

/**
 * The proxy target holds the state under `draftKey`. It is a fresh array or
 * object, never the base, so writes cannot reach the base. The key is
 * configurable so `ownKeys` and `getOwnPropertyDescriptor` may leave it out.
 */
const createDraft = (
  base: Record<PropertyKey, unknown>,
  parent: DraftState | undefined,
  session: DraftSession,
  supplied = false,
): Record<PropertyKey, unknown> => {
  const state: DraftState = {
    base,
    copy: undefined,
    children: undefined,
    parent,
    session,
    supplied,
    modified: false,
    touched: new Set(),
  };
  const target: object = Array.isArray(base) ? [] : {};
  Object.defineProperty(target, draftKey, { value: state, configurable: true });
  return new Proxy(target, draftHandler) as Record<PropertyKey, unknown>;
};

interface FinalizedValue {
  value: Record<PropertyKey, unknown>;
  /** Supplied containers notify back-references if finalization copies them. */
  readonly onCopy?: Array<(copy: Record<PropertyKey, unknown>) => void>;
}

/**
 * Replaces drafts with their values, inside supplied arrays and objects too.
 * Draft outputs are recorded before descending, so a back-reference resolves
 * to the output. Supplied containers copy only when a child needs replacing.
 * Drafts over supplied containers walk every child; base drafts walk touched keys.
 */
const finalize = (value: unknown, visited: WeakMap<object, FinalizedValue>): unknown => {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const previous = visited.get(value);
  if (previous !== undefined) {
    return previous.value;
  }
  const state = (value as { [draftKey]?: DraftState })[draftKey];
  if (state !== undefined && !state.supplied) {
    if (!state.modified) {
      return state.base;
    }
    const copy = ensureCopy(state);
    visited.set(value, { value: copy });
    const base = state.base;
    for (const key of state.touched) {
      if (Object.hasOwn(copy, key) && copy[key] !== base[key]) {
        const child = copy[key];
        copy[key] = finalize(child, visited);
        if (typeof child === "object" && child !== null && copy[key] === child) {
          visited.get(child)?.onCopy?.push((replacement) => {
            copy[key] = replacement;
          });
        }
      }
    }
    return copy;
  }
  const source = state === undefined ? value : state.modified ? ensureCopy(state) : state.base;
  if (Array.isArray(source) || isPlainObject(source)) {
    const object = source as Record<PropertyKey, unknown>;
    const existing = visited.get(object);
    if (existing !== undefined) {
      visited.set(value, existing);
      return existing.value;
    }
    const entry: FinalizedValue = { value: object, onCopy: [] };
    visited.set(value, entry);
    visited.set(object, entry);
    const replace = (key: PropertyKey, child: unknown): void => {
      if (Object.is(entry.value[key], child)) {
        return;
      }
      if (entry.value === object && state?.modified !== true) {
        entry.value = Array.isArray(object)
          ? (object.slice() as unknown as Record<PropertyKey, unknown>)
          : { ...object };
        for (const notify of entry.onCopy as NonNullable<FinalizedValue["onCopy"]>) {
          notify(entry.value);
        }
      }
      entry.value[key] = child;
    };
    forEachKey(object, (key) => {
      const child = object[key];
      replace(key, finalize(child, visited));
      if (typeof child === "object" && child !== null && entry.value[key] === child) {
        visited.get(child)?.onCopy?.push((replacement) => replace(key, replacement));
      }
    });
    return entry.value;
  }
  return value;
};

const produce = <Value>(base: Value, recipe: (draft: Draft<Value>) => undefined): Value => {
  if (!isDraftable(base)) {
    throw new Error(
      "pinna: write.modify drafts arrays and plain objects; write other values whole with write($box, value)",
    );
  }
  const session: DraftSession = { open: true };
  const draft = createDraft(base, undefined, session);
  try {
    const result: unknown = recipe(draft as Draft<Value>);
    if (result !== undefined) {
      throw new Error("pinna: a modify recipe returns nothing; write through the draft");
    }
    return finalize(draft, new WeakMap()) as Value;
  } finally {
    session.open = false;
  }
};

// Identity under Effect's Equal and Hash

/**
 * The keys of Effect's `Equal` and `Hash` protocols, spelled out so this
 * package imports nothing from Effect. An observable defines both, so
 * `Equal.equals` compares it by identity and never walks its fields; a test
 * in pinna-effect checks that Effect still uses these keys.
 */
export const equalKey = "~effect/Equal";
export const hashKey = "~effect/Hash";

/**
 * The key an Effect schema carries, spelled out for the same reason, so a
 * bare box can refuse a schema left over from a call meant for the Effect
 * entry's box.
 */
export const schemaKey = "~effect/Schema/Schema";

const identityHashes = new WeakMap<object, number>();

/** A random hash per object, kept for its life: what Effect's `Hash.random` gives. */
export const identityHash = (self: object): number => {
  let hash = identityHashes.get(self);
  if (hash === undefined) {
    hash = (Math.random() * 0x100000000) | 0;
    identityHashes.set(self, hash);
  }
  return hash;
};

// Checks

/** Why a check rejects a value: the message, and the error behind it when there is one. */
export interface Rejection {
  readonly message: string;
  readonly cause: unknown;
}

/**
 * Returns why a box's check rejects `value`, or `undefined` when it accepts it.
 * `previous` is a value the same check accepted before; elements it still
 * holds in the same place, counted after any it dropped from or added to the
 * front, are not checked again.
 */
export type Check = (value: unknown, previous?: unknown) => Rejection | undefined;

/** The check of a box with no schema: every value fits. */
export const acceptAll: Check = () => undefined;

// Observables

/** Marks an async recipe's rejection handled: the update has thrown for it already. */
const ignore = (): void => {};

declare const realmBrand: unique symbol;

/**
 * A reactive realm and everything made from it. Make one per host with
 * `createRealm()` and hand it to whatever builds state.
 */
export interface Realm {
  /** Only `createRealm` makes a realm; the realm functions take it. */
  readonly [realmBrand]: true;
}

/**
 * The `nextRecorded` of the box recorded first, and the realm's list when
 * none is, so that a set link means recorded. Only compared, never read.
 */
const endOfRecorded = {} as BoxCell<unknown>;

/** How a realm is made. */
export interface RealmOptions {
  /**
   * Where an error with no caller goes: a watch effect's error, a reaction's
   * error, an `onObserved` hook's or cleanup's error, and the error for
   * watchers or hooks that never settle. The write has
   * landed, so the writer is not the place. The host's `reportError` by
   * default. If it throws, the other watchers still run, and its first error
   * then throws to the writer.
   */
  readonly onError?: (error: unknown) => void;
  /**
   * A name for tools: `inspect` reports it, and an error about an
   * observable of another realm names both realms. It is a label only;
   * realms are told apart by identity, so two realms may share a name.
   */
  readonly name?: string;
}

export class ObservableRealm implements Realm {
  declare readonly [realmBrand]: true;
  readonly core: CoreGraph;
  updateDepth = 0;
  /**
   * How many updates and untracked runs are open: `read` outside a tracked
   * run asks this one field, inline, instead of calling to ask.
   */
  openDepth = 0;
  /**
   * The tracked run of the autorun whose body runs, innermost: `update` runs
   * there and nowhere else that tracks. A compute, a select, or a selector
   * the body starts tracks as its own run, so it does not match.
   */
  autorunRun: unknown = undefined;
  /**
   * What a failed update puts back, besides each box's first record, four
   * slots a step: a box, the value it had, its version, and `recordedCount`
   * when the step was taken; or `undefined`, an undo function, 0, and
   * `recordedCount`. Slots past `journalLength` are empty, and the array
   * keeps its storage between updates: Hermes drops it on `length = 0`, and
   * plain objects per step cost every write.
   *
   * A box's first record in the outermost update is kept on the box: the
   * value and version it had when that update began, and the update scope
   * that last recorded it. A nested update that rolls the record back puts
   * back that same value and version, and the box records anew.
   */
  private readonly journal: Array<unknown> = [];
  journalLength = 0;
  /**
   * The boxes the outermost update has recorded, the last recorded first,
   * linked through each box's `nextRecorded` down to `endOfRecorded`: a
   * write records a box without growing an array.
   */
  recorded: BoxCell<unknown> = endOfRecorded;
  /**
   * How many boxes `recorded` holds. A step of the journal keeps the count
   * at the time it was taken, so a rollback restores boxes and steps in the
   * reverse of the order they were recorded in.
   */
  recordedCount = 0;
  scope = 0;
  scopes = 0;
  /**
   * Set by `testRealm` only: counts a running listener that no graph watch
   * stands for, such as `onRowChange`'s, and returns the stop to hand out.
   */
  running: ((label: string, stop: () => void) => () => void) | undefined = undefined;

  /** The realm's verbs, made once: each throws for an observable of another realm. */
  readonly read: Read;
  readonly write: Write;
  readonly name: string | undefined;

  constructor(options?: RealmOptions) {
    checkName(options?.name);
    this.name = options?.name;
    this.core = new CoreGraph(options?.onError ?? reportUncaught);
    this.read = readIn(this);
    this.write = writeIn(this);
    // Every compute, select, and tracked run is handed the realm's `read`: one function per realm, no closure per node.
    this.core.argument = this.read;
  }

  // Effect's Equal.equals compares a realm, and anything live in it, by identity: never by walking it.
  [equalKey](that: unknown): boolean {
    return this === that;
  }

  [hashKey](): number {
    return identityHash(this);
  }

  assertWritable(): void {
    const core = this.core;
    // Read inline: a write pays no call to ask.
    if (core.deriving !== undefined) {
      throw core.derivingWriteError();
    }
    if (this.updateDepth === 0) {
      throw new Error("pinna: write inside update");
    }
  }

  /**
   * Records the value `box` holds before a write: in the journal once per
   * update scope, and as its value before once per outermost update.
   */
  record(box: BoxCell<unknown>, value: unknown): void {
    // The box was recorded in this outermost update: `write` sends a first write to `recordFirst`.
    if (box.recordedScope !== this.scope) {
      box.recordedScope = this.scope;
      this.journalStep(box, value, box.source.version);
    }
  }

  /** `record` for a box the outermost update has not recorded: its `nextRecorded` is `undefined`. */
  recordFirst(box: BoxCell<unknown>, value: unknown, version: number): void {
    box.valueBefore = value;
    box.versionBefore = version;
    box.recordedScope = this.scope;
    box.nextRecorded = this.recorded;
    this.recorded = box;
    this.recordedCount++;
  }

  /** Runs `undo` if the update this runs in fails: for state that is not a box. */
  recordUndo(undo: () => void): void {
    this.journalStep(undefined, undo, 0);
  }

  /**
   * Runs `write` in its own scope of the open update: a throw puts back only
   * what `write` wrote, even when the caller catches it. Unlike a nested
   * `update`, it runs wherever a write may, a tracked run included.
   */
  undoOnThrow(write: () => void): void {
    const outer = this.scope;
    const savepoint = this.journalLength;
    const recordedAt = this.recordedCount;
    this.scope = ++this.scopes;
    try {
      write();
    } catch (error) {
      this.rollback(savepoint, recordedAt);
      throw error;
    } finally {
      this.scope = outer;
    }
  }

  private journalStep(box: BoxCell<unknown> | undefined, value: unknown, version: number): void {
    const journal = this.journal;
    const end = this.journalLength;
    journal[end] = box;
    journal[end + 1] = value;
    journal[end + 2] = version;
    journal[end + 3] = this.recordedCount;
    this.journalLength = end + 4;
  }

  /**
   * Puts back what was recorded since `savepoint` and `recordedAt`, the
   * journal's length and `recordedCount` when the failed scope began: the
   * steps and the boxes' first records together, the last recorded first.
   */
  rollback(savepoint: number, recordedAt: number): void {
    const journal = this.journal;
    const end = this.journalLength;
    // The boxes first recorded after the savepoint leave the list before any
    // undo runs, so a box an undo records lands where they began, as a step
    // an undo records does.
    let box = this.recorded;
    let count = this.recordedCount;
    let remaining = box;
    for (let index = count; index > recordedAt; index--) {
      remaining = remaining.nextRecorded as BoxCell<unknown>;
    }
    this.recorded = remaining;
    this.recordedCount = recordedAt;
    try {
      for (let index = end - 4; index >= savepoint; index -= 4) {
        // The boxes first recorded after this step are put back before it.
        const countAtStep = journal[index + 3] as number;
        while (count > countAtStep) {
          const restored = box;
          const value = restored.valueBefore;
          box = restored.nextRecorded as BoxCell<unknown>;
          count--;
          restored.nextRecorded = undefined;
          restored.valueBefore = undefined;
          restored.restore(value, restored.versionBefore);
        }
        const stepBox = journal[index] as BoxCell<unknown> | undefined;
        if (stepBox === undefined) {
          (journal[index + 1] as () => void)();
        } else {
          stepBox.restore(journal[index + 1], journal[index + 2] as number);
        }
      }
      while (count > recordedAt) {
        const restored = box;
        const value = restored.valueBefore;
        box = restored.nextRecorded as BoxCell<unknown>;
        count--;
        restored.nextRecorded = undefined;
        restored.valueBefore = undefined;
        restored.restore(value, restored.versionBefore);
      }
    } finally {
      // The records rolled back are gone, and with them the first record of
      // a box first recorded after the savepoint: it records anew.
      while (count > recordedAt) {
        const dropped = box;
        box = dropped.nextRecorded as BoxCell<unknown>;
        count--;
        dropped.nextRecorded = undefined;
        dropped.valueBefore = undefined;
      }
      // A step an undo recorded lands where they began, as if they had been
      // taken out before any ran.
      const recorded = this.journalLength - end;
      for (let index = 0; index < recorded; index++) {
        journal[savepoint + index] = journal[end + index];
      }
      const length = savepoint + recorded;
      for (let index = length; index < this.journalLength; index++) {
        journal[index] = undefined;
      }
      this.journalLength = length;
    }
  }

  /** Forgets what the outermost update recorded, so it holds no value it replaced. */
  forget(): void {
    for (let box = this.recorded; box !== endOfRecorded; ) {
      const next = box.nextRecorded as BoxCell<unknown>;
      box.nextRecorded = undefined;
      box.valueBefore = undefined;
      box = next;
    }
    this.recorded = endOfRecorded;
    this.recordedCount = 0;
    const journal = this.journal;
    const end = this.journalLength;
    // A step's version and count are numbers: they hold nothing.
    for (let index = 0; index < end; index += 4) {
      journal[index] = undefined;
      journal[index + 1] = undefined;
    }
    this.journalLength = 0;
  }

  /** `untracked` for one computed value, without a closure: what `peek` costs on Hermes. */
  peekDerived<Value>(derived: DerivedNode<Value>): Value {
    this.openDepth++;
    try {
      return peekDerived(derived);
    } finally {
      this.openDepth--;
    }
  }
}

// The realm's operations: each takes the realm first, or reads it from the observable.

/** A new realm, with nothing shared with any other. */
export const createRealm = (options?: RealmOptions): Realm => new ObservableRealm(options);

/**
 * A box over `check` and `equals`: what every box constructor builds. Throws
 * when `name` is empty or `check` rejects `initial`.
 */
export const makeBox = <Value>(
  realm: Realm,
  check: Check,
  equals: Equals<Value>,
  initial: Value,
  name: string | undefined,
): Box<Value> => {
  checkName(name);
  const cell = new BoxCell(realm as ObservableRealm, check, initial, equals);
  if (name !== undefined) {
    names.set(cell.source, name);
  }
  return cell;
};

/**
 * A box starting at `initial`. It checks nothing, and compares values with
 * `Object.is` unless `options.equals` says otherwise. Throws when `initial` is
 * an Effect schema: a box that checks one is pinna-effect's `schemaBox`.
 */
export const box = <Value>(realm: Realm, initial: Value, options?: Options<Value>): Box<Value> => {
  if (
    (typeof initial === "object" || typeof initial === "function") &&
    initial !== null &&
    schemaKey in initial
  ) {
    throw new Error(
      "pinna: box takes a value, not a schema; a box that checks a schema is schemaBox from @frondruntime/pinna-effect",
    );
  }
  return makeBox(realm, acceptAll, options?.equals ?? Object.is, initial, options?.name);
};

/** A value derived from the observables `compute` reads. */
export const computed = <Value>(
  realm: Realm,
  compute: (read: Read) => Value,
  options?: Options<Value>,
): Computed<Value> =>
  new ComputedValue(realm as ObservableRealm, compute, options?.equals ?? Object.is, options?.name);

/**
 * A computed value per argument tuple. Arguments are compared by identity,
 * one per position. While something observes an argument tuple's computed
 * value, calls with those arguments return it; when the last observer
 * leaves, it is dropped, and a later call makes a new one.
 */
export const computedFunction = <Args extends ReadonlyArray<unknown>, Value>(
  realm: Realm,
  compute: (read: Read, ...args: Args) => Value,
  options?: Options<Value>,
): ((...args: Args) => Computed<Value>) => {
  const owner = realm as ObservableRealm;
  const equals = options?.equals ?? Object.is;
  const name = options?.name;
  checkName(name);
  let entries: ComputedFunctionEntries<Value> | undefined;
  return (...args) => {
    if (entries === undefined) {
      entries = new ComputedFunctionEntries();
    }
    const found = entries.find(args);
    if (found !== undefined) {
      return found;
    }
    const entry = new ComputedValue(owner, (read) => compute(read, ...args), equals, name);
    const kept = entries;
    const hold = () => {
      kept.add(args, entry);
      return () => {
        kept.remove(args, entry);
      };
    };
    // Inside an update, a flush, an observing call, or a read's compute,
    // an observer's hooks wait for the settle, so the entry is cached at
    // once: a second read of the same arguments before then finds it. It
    // leaves the cache at the settle if nothing observes it then.
    if (owner.core.defersHooks()) {
      owner.core.onObservedNow(entry.source, hold);
    } else {
      owner.core.onObserved(entry.source, hold);
    }
    return entry;
  };
};

/**
 * An atom for state kept outside Pinna. Pair it with `onObserved` to listen
 * to that state only while something observes the atom.
 */
export const atom = (realm: Realm): Atom => new AtomCell(realm as ObservableRealm);

/**
 * Why `update`, or `name` that runs one, refuses to run where reads are
 * tracked outside an autorun's body.
 */
const refusedUpdate = (core: CoreGraph, name = "update"): Error =>
  new Error(
    core.deriving !== undefined
      ? `pinna: ${name} cannot run in a computed value; write from an event, a watch's effect, or an autorun`
      : `pinna: ${name} cannot run in a watch's select or a selector; write from an event, a watch's effect, or an autorun`,
  );

/**
 * Throws what `update` would, named for `name`, where an update cannot run:
 * for a function that runs one on the caller's behalf.
 */
export const assertUpdateCanRun = (realm: ObservableRealm, name: string): void => {
  const core = realm.core;
  const untracked = core.untrackedActive;
  if (
    core.deriving !== undefined ||
    (core.active !== undefined && core.active !== realm.autorunRun) ||
    (untracked !== undefined &&
      untracked !== realm.autorunRun &&
      (untracked.effect !== undefined || untracked.compute === undefined))
  ) {
    throw refusedUpdate(core, name);
  }
};

/**
 * `update` in an autorun's body, untracked: the recipe's reads do not
 * subscribe the autorun, and the body tracks again once it ends. A function
 * of its own, so `update` keeps no closure or second scope.
 */
const updateInAutorun = (
  owner: ObservableRealm,
  recipe: (read: Read, write: Write) => undefined,
): void => {
  const core = owner.core;
  const active = core.active;
  core.active = undefined;
  try {
    update(owner, recipe);
  } finally {
    core.active = active;
  }
};

/**
 * The one place boxes are written. Nested updates join the outermost one;
 * watchers see its end state once. If `recipe` throws, every box it wrote
 * gets its old value back and the error is rethrown.
 */
export const update = (realm: Realm, recipe: (read: Read, write: Write) => undefined): void => {
  const owner = realm as ObservableRealm;
  // The batch is opened and closed by hand: a closure here would cost
  // every update its scope on Hermes.
  const core = owner.core;
  // A watch select has an effect, and a renderer's selector has no compute.
  // An autorun's cleanup runs before `autorunRun` is set, in a watch with
  // a compute and no separate effect; it retains permission to update.
  const untracked = core.untrackedActive;
  if (
    core.deriving !== undefined ||
    (untracked !== undefined &&
      untracked !== owner.autorunRun &&
      (untracked.effect !== undefined || untracked.compute === undefined))
  ) {
    throw refusedUpdate(core);
  }
  if (core.active !== undefined) {
    if (core.active !== owner.autorunRun) {
      throw refusedUpdate(core);
    }
    updateInAutorun(owner, recipe);
    return;
  }
  core.beginBatch();
  const outer = owner.scope;
  const savepoint = owner.journalLength;
  const recordedAt = owner.recordedCount;
  owner.scope = ++owner.scopes;
  owner.updateDepth++;
  owner.openDepth++;
  // One try: nothing before it throws, and its finally closes the scope,
  // then the batch.
  let failed = true;
  try {
    const result: unknown = recipe(owner.read, owner.write);
    if (result !== undefined) {
      if (typeof (result as { readonly then?: unknown }).then === "function") {
        (result as PromiseLike<unknown>).then(undefined, ignore);
        throw new Error("pinna: update recipes are synchronous; await outside, then update");
      }
      throw new Error("pinna: an update recipe returns nothing");
    }
    failed = false;
  } catch (error) {
    owner.rollback(savepoint, recordedAt);
    throw error;
  } finally {
    owner.updateDepth--;
    owner.openDepth--;
    owner.scope = outer;
    if (owner.updateDepth === 0) {
      owner.forget();
    }
    core.endBatch(failed);
  }
};

/** Reads observables without tracking them: for event handlers and effects. */
export const untracked = <Result>(realm: Realm, run: (read: Read) => Result): Result => {
  const owner = realm as ObservableRealm;
  owner.openDepth++;
  try {
    return owner.core.untracked(run);
  } finally {
    owner.openDepth--;
  }
};

/**
 * Runs `effect`, untracked, whenever `select`'s result changes. `select` is
 * tracked and must not write. Returns the function that stops watching. An
 * error from `select`'s first run is thrown here and nothing is watched; an
 * error from an `onObserved` hook it starts goes to `onError`. `effect`
 * returns `undefined`, as `update`'s recipe does, so an async function is
 * refused: its rejection would reach no one.
 */
export const watch = <Value>(
  realm: Realm,
  select: (read: Read) => Value,
  effect: (value: Value, previous: Value) => undefined,
  options?: Options<Value>,
): (() => void) => {
  const core = (realm as ObservableRealm).core;
  if (options === undefined) {
    return core.watch(select, effect);
  }
  checkName(options.name);
  return core.watch(select, effect, { equals: options.equals, label: options.name });
};

/**
 * Runs `effect` now, tracked, and again whenever what its last run read
 * changes. It may call `update`, which runs untracked: the recipe's reads do
 * not subscribe it. A run that changes what it read runs again, and one
 * that never stops changing it ends at the round limit, reported to
 * `onError`, as a watch effect that loops does. An error on the first run
 * is thrown here and nothing is watched; a later one goes to `onError`, as
 * does an error from an
 * `onObserved` hook it starts. A function `effect` returns is its cleanup: it
 * runs untracked before the next run and when the autorun stops, and its
 * error goes to `onError`. A cleanup that stops its autorun ends it there; an
 * effect that stops its autorun has its cleanup run at once. Returns the
 * function that stops it.
 */
export const autorun = (
  realm: Realm,
  effect: (read: Read) => (() => void) | undefined,
): (() => void) => {
  const owner = realm as ObservableRealm;
  const core = owner.core;
  let cleanup: (() => void) | undefined;
  let stopped = false;
  // Cleared before it runs, so a cleanup that stops its autorun, or a stop
  // called twice, runs it once.
  const clean = (): void => {
    const pending = cleanup;
    cleanup = undefined;
    if (pending !== undefined) {
      try {
        untracked(realm, pending);
      } catch (error) {
        core.reportAside(error);
      }
    }
  };
  const stop = (): void => {
    if (stopped) {
      return;
    }
    // The watch ends before the flag is set: a stop that throws, as one
    // inside a computed value does, leaves the autorun running and still
    // stoppable.
    unwatch();
    stopped = true;
    clean();
  };
  // `stop` reaches the effect only once this returns, so the first run
  // never stops it. A first run that throws leaves no cleanup; one that
  // returned before `watch` threw has its cleanup run here, since the
  // caller gets no stop function to run it.
  let unwatch: () => void;
  try {
    unwatch = core.watch(
      (read: Read) => {
        clean();
        if (stopped) {
          return;
        }
        const outerRun = owner.autorunRun;
        owner.autorunRun = core.active;
        let result: (() => void) | undefined;
        try {
          result = effect(read);
        } finally {
          owner.autorunRun = outerRun;
        }
        if (typeof result === "function") {
          cleanup = result;
          // The effect stopped its own autorun: nothing else will run this.
          if (stopped) {
            clean();
          }
        }
      },
      undefined,
      { label: "autorun" },
    );
  } catch (error) {
    stopped = true;
    clean();
    throw error;
  }
  return owner.running?.("autorun", stop) ?? stop;
};

/**
 * Runs `start` when `observable` gains its first observer, and the cleanup
 * it returns when the last one leaves. Returns the function that removes
 * the hook. A hook or cleanup that throws does not stop the others on the
 * same observable; its error goes to its realm's `onError`, never to the
 * caller.
 */
export const onObserved = (
  observable: Box<unknown> | Computed<unknown> | Atom,
  start: () => (() => void) | undefined,
): (() => void) => {
  const node = sourceNode("onObserved", observable);
  return node.graph.onObserved(node, start);
};

/**
 * Holds `observable` observed until the returned release runs: its
 * `onObserved` hooks stay started, and a computed value stays cached. It
 * subscribes nothing that is tracking, so it works anywhere. Releasing twice
 * does nothing. A computed value that throws is held, its error kept for
 * the next read. An `onObserved` hook that throws sends its error to
 * `onError`; the observable stays observed until the release runs.
 */
export const observe = (observable: Box<unknown> | Computed<unknown> | Atom): (() => void) => {
  const cell = madeByPinna("observe", observable);
  return cell.source.graph.watch(() => {
    try {
      cell.read();
    } catch {
      // The computed value keeps its error for the next read.
    }
  });
};

/**
 * True while reads are tracked: in a computed value, a watch's `select`, or
 * an autorun. False in an update, `untracked`, a watch's effect, and a hook.
 */
export const isTracking = (realm: Realm): boolean => (realm as ObservableRealm).core.isTracking();

/** Whether `observable` is a box, a computed value, or an atom made by Pinna. */
const isMadeByPinna = (
  observable: Box<unknown> | Computed<unknown> | Atom,
): observable is BoxCell<unknown> | ComputedValue<unknown> | AtomCell =>
  observable instanceof BoxCell ||
  observable instanceof ComputedValue ||
  observable instanceof AtomCell;

/** The box, computed value, or atom behind `observable`; throws for one Pinna did not make. */
const madeByPinna = (
  what: string,
  observable: Box<unknown> | Computed<unknown> | Atom,
): BoxCell<unknown> | ComputedValue<unknown> | AtomCell => {
  if (!isMadeByPinna(observable)) {
    throw new Error(`pinna: ${what} needs a box, a computed value, or an atom`);
  }
  return observable;
};

/** The graph node behind a box, a computed value, or an atom. */
const sourceNode = (
  what: string,
  observable: Box<unknown> | Computed<unknown> | Atom,
): CellNode<unknown> | DerivedNode<unknown> | AtomNode => madeByPinna(what, observable).source;

/**
 * Runs `check` on a value about to land, untracked: a run tracked inside an
 * update does not read what the check reads. Throws the box's rejection.
 * A plain function, not a closure: a closure would cost every write its
 * scope on Hermes.
 */
export const verifyValue = (
  realm: ObservableRealm,
  check: Check,
  value: unknown,
  previous: unknown,
): void => {
  const core = realm.core;
  const active = core.active;
  core.active = undefined;
  let problem: Rejection | undefined;
  try {
    problem = check(value, previous);
  } finally {
    core.active = active;
  }
  if (problem !== undefined) {
    throw new Error(`pinna: the box rejects this value: ${problem.message}`, {
      cause: problem.cause,
    });
  }
};

/** A box: its graph node, its check, and what an update recorded of it. No closures. */
export class BoxCell<Value> implements Box<Value> {
  declare readonly [readsAs]: () => Value;
  declare readonly [writesAs]: (value: Value) => void;
  readonly realm: ObservableRealm;
  private readonly check: Check;
  private readonly equals: Equals<Value>;
  /** The graph node: what `read` reads. */
  readonly source: CellNode<Value>;
  /**
   * The next box in the realm's `recorded` list while the outermost update
   * has recorded this one, `undefined` otherwise. The four fields below are
   * the box's first record, kept on the box so a write grows no array.
   */
  declare nextRecorded: BoxCell<unknown> | undefined;
  /** The value the box had when the outermost update began, while recorded. */
  declare valueBefore: unknown;
  /** The version the box had when the outermost update began, while recorded. */
  declare versionBefore: number;
  /** The update scope that last recorded the box: a scope records it once. */
  declare recordedScope: number;

  /**
   * Every field is assigned here, in one order, rather than by class field
   * initializers: Hermes runs those as a separate step of each construction,
   * and a load makes a box per reactive field of every row.
   */
  constructor(
    realm: ObservableRealm,
    check: Check,
    value: Value,
    equals: Equals<Value>,
    /** True only where a decode by the same schema made `value`: its check ran there. */
    checked?: boolean,
  ) {
    // A check that accepts every value rejects nothing: a plain box skips the call.
    if (checked !== true && check !== acceptAll) {
      verifyValue(realm, check, value, undefined);
    }
    this.realm = realm;
    this.check = check;
    this.equals = equals;
    this.source = realm.core.cellComparing(value, equals);
    this.nextRecorded = undefined;
    this.valueBefore = undefined;
    this.versionBefore = 0;
    this.recordedScope = 0;
  }

  [equalKey](that: unknown): boolean {
    return this === that;
  }

  [hashKey](): number {
    return identityHash(this);
  }

  /** Reads the box's node, recorded in the active run. */
  read(): Value {
    return readCell(this.source);
  }

  modifyValue(recipe: (draft: Draft<Value>) => undefined): void {
    this.realm.assertWritable();
    this.write(produce(peekCell(this.source), recipe));
  }

  write(value: Value): void {
    this.realm.assertWritable();
    const current = peekCell(this.source);
    // The value the box holds was checked when it landed, and writing it changes nothing.
    if (Object.is(value, current)) {
      return;
    }
    // A check that accepts every value reads nothing and rejects nothing.
    if (this.check !== acceptAll) {
      verifyValue(this.realm, this.check, value, current);
    }
    const realm = this.realm;
    if (this.nextRecorded === undefined) {
      // The first write in the outermost update: the box holds the value it
      // had when the update began, and the write cannot put it back.
      realm.recordFirst(this as BoxCell<unknown>, current, this.source.version);
      writeCell(this.source, value);
      return;
    }
    realm.record(this as BoxCell<unknown>, current);
    // A value equal to the one the box had when the outermost update began
    // puts that value and its version back, as a rollback would: a reader
    // that read it then has nothing new, and one that read a value in
    // between holds a version the box no longer has.
    const version = this.versionBefore;
    if (version !== this.source.version) {
      const before = this.valueBefore as Value;
      if (this.equals(before, value)) {
        restoreCell(this.source, before, version);
        return;
      }
    }
    writeCell(this.source, value);
  }

  /**
   * Puts back a value and its version from before a failed update, so a
   * reader that saw only that value does not run again. Unchecked: it was
   * checked when it landed.
   */
  restore(value: unknown, version: number): void {
    restoreCell(this.source, value as Value, version);
  }
}

/** The options of every unnamed computed value that compares with `Object.is`: made once, not per value. */
const unnamedComputed = { equals: Object.is, label: "a computed value" };

class ComputedValue<Value> implements Computed<Value> {
  declare readonly [readsAs]: () => Value;
  /** The graph node: what `read` reads. */
  readonly source: DerivedNode<Value>;

  constructor(
    readonly realm: ObservableRealm,
    compute: (read: Read) => Value,
    equals: Equals<Value>,
    name?: string,
  ) {
    if (name === undefined) {
      this.source = realm.core.derived(
        compute,
        equals === Object.is ? unnamedComputed : { equals, label: unnamedComputed.label },
      );
    } else {
      checkName(name);
      this.source = realm.core.derived(compute, { equals, label: `the computed value "${name}"` });
      names.set(this.source, name);
    }
  }

  [equalKey](that: unknown): boolean {
    return this === that;
  }

  [hashKey](): number {
    return identityHash(this);
  }

  /** Reads the computed value's node, recorded in the active run. */
  read(): Value {
    return readDerived(this.source);
  }
}

/** Maps distinguish every argument with `Object.is`, including signed zero. */
const negativeZeroArgument: unique symbol = Symbol("pinna.negativeZeroArgument");
const argumentKey = (value: unknown): unknown =>
  Object.is(value, -0) ? negativeZeroArgument : value;

/**
 * The observed entries of one `computedFunction`: a map keyed by argument count,
 * then one map per argument, the last holding the entry. An entry goes in when
 * it gains its first observer and out when it loses its last, taking the maps
 * it leaves empty with it, so nothing unobserved is kept.
 */
class ComputedFunctionEntries<Value> {
  private readonly root = new Map<unknown, unknown>();

  find(args: ReadonlyArray<unknown>): ComputedValue<Value> | undefined {
    let level: unknown = this.root.get(args.length);
    for (let index = 0; index < args.length && level !== undefined; index++) {
      level = (level as Map<unknown, unknown>).get(argumentKey(args[index]));
    }
    return level as ComputedValue<Value> | undefined;
  }

  /** Keeps the first entry observed for `args`; another made before it was is not kept. */
  add(args: ReadonlyArray<unknown>, entry: ComputedValue<Value>): void {
    if (this.find(args) !== undefined) {
      return;
    }
    let map = this.root;
    let key: unknown = args.length;
    for (let index = 0; index < args.length; index++) {
      let next = map.get(key) as Map<unknown, unknown> | undefined;
      if (next === undefined) {
        next = new Map();
        map.set(key, next);
      }
      map = next;
      key = argumentKey(args[index]);
    }
    map.set(key, entry);
  }

  remove(args: ReadonlyArray<unknown>, entry: ComputedValue<Value>): void {
    const maps: Array<Map<unknown, unknown>> = [this.root];
    const keys: Array<unknown> = [args.length];
    for (let index = 0; index < args.length; index++) {
      keys.push(argumentKey(args[index]));
      const next = (maps[index] as Map<unknown, unknown>).get(keys[index]);
      if (next === undefined) {
        return;
      }
      maps.push(next as Map<unknown, unknown>);
    }
    const last = maps.length - 1;
    if ((maps[last] as Map<unknown, unknown>).get(keys[last]) !== entry) {
      return;
    }
    for (let index = last; index >= 0; index--) {
      const map = maps[index] as Map<unknown, unknown>;
      map.delete(keys[index]);
      if (map.size > 0) {
        return;
      }
    }
  }
}

class AtomCell implements Atom {
  declare readonly [atomKind]: true;
  /** The graph node: what `read` reads. */
  readonly source: AtomNode;

  constructor(readonly realm: ObservableRealm) {
    this.source = realm.core.atom();
  }

  [equalKey](that: unknown): boolean {
    return this === that;
  }

  [hashKey](): number {
    return identityHash(this);
  }

  /** Reads the atom's node, recorded in the active run. */
  read(): undefined {
    return readAtom(this.source);
  }

  change(): void {
    this.realm.assertWritable();
    touchSource(this.source);
  }
}

/** The realm an observable was made in. */
export const realmOf = (observable: Box<unknown> | Computed<unknown> | Atom): ObservableRealm => {
  if (!isMadeByPinna(observable)) {
    throw new Error("pinna: expected a box, a computed value, or an atom");
  }
  return observable.realm;
};

/** A value's name, its realm's name, what it last read, how many observe it, and why it last recomputed. */
export const inspect = (observable: Box<unknown> | Computed<unknown> | Atom): Inspection => {
  const node = sourceNode("inspect", observable);
  let dependencies: ReadonlyArray<string> = [];
  let reason: string | undefined;
  if (isDerived(node)) {
    dependencies = dependenciesOf(node).map(nameOf);
    if (names.has(node) && hasRun(node)) {
      reason = explain(lastReason(node) ?? null);
    }
  }
  return {
    name: names.get(node),
    realm: realmOf(observable).name,
    dependencies,
    observers: observerCount(node),
    lastReason: reason,
  };
};

// The verbs every place hands out

/**
 * Reads an observable and subscribes the tracked place it runs in; an atom
 * it subscribes and returns nothing. Handed to every place that reads: a
 * computed value, a computed function, a watch's select, an autorun, `useSelect`,
 * `update`, and `untracked`. With no place of the observable's realm open,
 * it throws.
 */
export interface Read {
  <Value>(observable: Computed<Value>): Value;
  (atom: Atom): undefined;
  /**
   * The row under `key`, or `undefined`. In a tracked place it is
   * `read($rows.row(key))` and tracks that key alone. Where nothing tracks
   * (an update's recipe, `untracked`, a watch's effect), it reads the row the
   * collection holds and makes no row computed and no cell, which a first
   * read of a key would otherwise keep for as long as the key is present.
   */
  row<Key, Value>(collection: Collection<Key, Value>, key: NoInfer<Key>): Value | undefined;
}

/** Writes, handed out by `update` alone. Each returns `undefined`, so a recipe can end in one. */
export interface Write {
  /** Replaces the box's value, through the box's check: pinna-effect's `schemaBox` checks its schema. */
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
}

/**
 * The realm's reader, made once per realm: the observable must be the realm's
 * own. Inside a tracked run, the common read, the checks are two fields;
 * outside, three.
 */
const readIn = (owner: ObservableRealm): Read => {
  function read<Value>(observable: Computed<Value>): Value;
  function read(atom: Atom): undefined;
  function read(observable: Computed<unknown> | Atom): unknown {
    const cell = observable as BoxCell<unknown> | ComputedValue<unknown> | AtomCell;
    if (cell.realm !== owner) {
      throw otherRealmError("read", cell.source, cell.realm, owner);
    }
    if (owner.core.active === undefined && owner.openDepth === 0) {
      throw readError(cell.source);
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
    if (owner.openDepth === 0) {
      throw readRowError();
    }
    return reader.heldRow(key);
  };
  return Object.assign(read, { row });
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
  return cell instanceof BoxCell ? peekCell(cell.source) : cell.realm.peekDerived(cell.source);
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
const writeIn = (owner: ObservableRealm): Write => {
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
  return Object.assign(writeBox, {
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
  });
};
