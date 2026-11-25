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
 * `useSelect`, an update, and `Realm.untracked`. `read($observable)` subscribes the place it runs in, and
 * throws outside a place of the observable's own realm, so a read that
 * nothing tracks fails loudly instead of going stale. Each realm hands out
 * its own `read` and `write`, and they throw for an observable another realm
 * made. With no method to call,
 * a read outside a place does not type-check; a `read` kept past its place
 * fails only when it runs, and only once no place of its realm is open.
 * docs/design.md lists the limits.
 *
 * Every observable is made by a realm, from `Realm.make()`, and keeps it.
 * Updates, tracking, watchers, and the verbs belong to one realm; nothing is
 * shared through the module.
 *
 * Writes happen only inside `Realm.update`, through the `write` it hands out. An
 * update is atomic: if its recipe throws, every box it wrote gets its old
 * value back before the error leaves it, and watchers see only the end state.
 * An update runs from an event, a watch's effect, or an autorun's body; a
 * computed value, a watch's select, and a selector are derivations, and an
 * update there throws.
 */

import {
  type AtomNode,
  type CellNode,
  type Node as CoreNode,
  type DerivedNode,
  dependenciesOf,
  type Equals,
  hasRun,
  isAtom,
  isDerived,
  kindOf,
  lastReason,
  observerCount,
  PinnaError,
  PinnaUsageError,
  peekCell,
  readAtom,
  readCell,
  readDerived,
  restoreCell,
  type Source,
  setCell,
  touchSource,
} from "@frondruntime/pinna-core";
import { classInstance, type Draft, produce } from "./draft.ts";
import { equalKey, hashKey, identityHash, schemaKey } from "./identity.ts";
import type { Atom } from "./modules/atom.ts";
import type { Box } from "./modules/box.ts";
import type { Collection } from "./modules/collection.ts";
import type { Computed } from "./modules/computed.ts";
import type { Realm } from "./modules/realm.ts";
import { inRecipe, type ObservableRealm, recipeMakeError } from "./realm.ts";
import { noteAtom } from "./record.ts";
import type { Read } from "./verbs.ts";

// Each instance type is declared beside its module, where the package's entry
// exports it, so declarations in other packages can name it.
export type { Atom, Box, Collection, Computed, Realm };
// Phantom keys: they carry an observable's type and exist only in the types.
export declare const readsAs: unique symbol;
export declare const writesAs: unique symbol;
export declare const atomKind: unique symbol;
/**
 * A model that checks nothing: a class whose fields are boxes, computed
 * values, and collections in one realm. Extending it marks the instance, so
 * a draft leaves it read-only, and gives field initializers `this.realm`.
 */
export abstract class Model {
  declare readonly [classInstance]: true;
  constructor(readonly realm: Realm) {
    if (inRecipe((realm as ObservableRealm).core)) {
      throw recipeMakeError("a model");
    }
  }
}
export interface ValueOptions<Value> {
  /**
   * Compares a new value with the current one; an equal value notifies
   * nobody and the observable keeps its current value. A box with a schema
   * defaults to the schema's equivalence; anything else to `Object.is`.
   */
  readonly equals?: Equals<Value>;
  /**
   * A name for tools, reported by `Source.inspect`. A named computed value
   * also keeps why it last recomputed, and its errors name it.
   */
  readonly name?: string;
}
/**
 * What `Source.inspect` reports. Dependencies are what the last run read,
 * each once, in read order; inspecting runs nothing, so a stale value
 * reports its last run.
 */
export interface Inspection {
  readonly name: string | undefined;
  /** The name of the realm that made the value, from `Realm.make({ name })`. */
  readonly realm: string | undefined;
  /** An unnamed dependency is `"<anonymous>"`. */
  readonly dependencies: ReadonlyArray<string>;
  readonly observers: number;
  /** Why a named computed value last recomputed; `undefined` for anything else. */
  readonly lastReason: string | undefined;
  /**
   * The names of the visible stages showing a value of this box, bottom
   * first: an unnamed stage is `"<anonymous>"`. Empty for a box no visible
   * stage covers, and for a computed value or an atom.
   */
  readonly stages: ReadonlyArray<string>;
}
/**
 * Names, by graph node. Written only when a name is given, so an unnamed
 * observable, and so a decoded row, costs nothing here.
 */
export const names = new WeakMap<Source, string>();

export const nameOf = (source: Source): string => names.get(source) ?? "<anonymous>";

/** Names a graph node for `Source.inspect` and errors: for a collection's own boxes and values. */
export const nameSource = (source: Source, name: string): void => {
  names.set(source, name);
};

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
export const checkName = (name: string | undefined): void => {
  if (name === "") {
    throw new PinnaUsageError("pinna/empty-name", "pinna: a name is a non-empty string");
  }
};

/** How an error names an observable: its name in quotes, or `$observable`. */
export const describeSource = (source: Source): string => {
  const name = names.get(source);
  return name === undefined ? "$observable" : `"${name}"`;
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

/**
 * Thrown by a write that a box's check rejects, such as a `Box.schema` whose
 * schema refuses the value: a condition code handles, such as a form that
 * shows why. The update rolls back. `cause` is the error behind the
 * rejection, a `Schema.SchemaError` for a schema.
 */
export class ValueRejectedError extends PinnaError {
  readonly _tag = "ValueRejectedError" as const;
  /** Why the check rejected the value, without the `pinna: ` prefix. */
  readonly reason: string;

  constructor(rejection: Rejection) {
    super(`pinna: the box rejects this value: ${rejection.message}`, { cause: rejection.cause });
    this.name = "ValueRejectedError";
    this.reason = rejection.message;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), reason: this.reason };
  }
}

declare module "@frondruntime/pinna-core" {
  interface PinnaErrorByTag {
    ValueRejectedError: ValueRejectedError;
  }
}

/** The check of a box with no schema: every value fits. */
export const acceptAll: Check = () => undefined;
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
 * an Effect schema: a box that checks one is pinna-effect's `Box.schema`.
 */
export const box = <Value>(
  realm: Realm,
  initial: Value,
  options?: ValueOptions<Value>,
): Box<Value> => {
  if (
    (typeof initial === "object" || typeof initial === "function") &&
    initial !== null &&
    schemaKey in initial
  ) {
    throw new PinnaUsageError(
      "pinna/box-takes-schema",
      "pinna: Box.make takes a value, not a schema; a box that checks a schema is Box.schema from @frondruntime/pinna-effect",
    );
  }
  return makeBox(realm, acceptAll, options?.equals ?? Object.is, initial, options?.name);
};

/** A value derived from the observables `compute` reads. */
export const computed = <Value>(
  realm: Realm,
  compute: (read: Read) => Value,
  options?: ValueOptions<Value>,
): Computed<Value> => {
  const owner = realm as ObservableRealm;
  if (inRecipe(owner.core)) {
    throw recipeMakeError("a computed value");
  }
  return new ComputedValue(owner, compute, options?.equals ?? Object.is, options?.name);
};

/**
 * A computed value per argument tuple. Arguments are compared by identity,
 * one per position. While something observes an argument tuple's computed
 * value, calls with those arguments return it; when the last observer
 * leaves, it is dropped, and a later call makes a new one.
 */
export const computedFunction = <Args extends ReadonlyArray<unknown>, Value>(
  realm: Realm,
  compute: (read: Read, ...args: Args) => Value,
  options?: ValueOptions<Value>,
): ((...args: Args) => Computed<Value>) => {
  const owner = realm as ObservableRealm;
  if (inRecipe(owner.core)) {
    throw recipeMakeError("a computed function");
  }
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
 * An atom for state kept outside Pinna. Pair it with `Source.onObserved` to listen
 * to that state only while something observes the atom.
 */
export const atom = (realm: Realm): Atom => {
  const owner = realm as ObservableRealm;
  if (inRecipe(owner.core)) {
    throw recipeMakeError("an atom");
  }
  return new AtomCell(owner);
};
/** Whether `observable` is a box, a computed value, or an atom made by Pinna. */
const isMadeByPinna = (
  observable: Box<unknown> | Computed<unknown> | Atom,
): observable is BoxCell<unknown> | ComputedValue<unknown> | AtomCell =>
  observable instanceof BoxCell ||
  observable instanceof ComputedValue ||
  observable instanceof AtomCell;

/** The box, computed value, or atom behind `observable`; throws for one Pinna did not make. */
export const madeByPinna = (
  what: string,
  observable: Box<unknown> | Computed<unknown> | Atom,
): BoxCell<unknown> | ComputedValue<unknown> | AtomCell => {
  if (!isMadeByPinna(observable)) {
    throw new PinnaUsageError(
      "pinna/not-made-by-pinna",
      `pinna: ${what} needs a box, a computed value, or an atom`,
    );
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
    throw new ValueRejectedError(problem);
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
    // A recipe runs twice, so a box it made would split in two.
    if (inRecipe(realm.core)) {
      throw recipeMakeError("a box");
    }
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

  /** Reads the box's node without recording it. */
  peek(): Value {
    return peekCell(this.source);
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
      setCell(this.source, value);
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
    setCell(this.source, value);
  }

  /**
   * Throws the box's rejection of `value`, which would replace `previous`, a
   * value the check accepted: for a write that lands elsewhere first, such as
   * a stage's overlay.
   */
  verify(value: Value, previous: Value): void {
    if (this.check !== acceptAll) {
      verifyValue(this.realm, this.check, value, previous);
    }
  }

  /**
   * Puts back a value and its version from before a failed update, so a
   * reader that saw only that value does not run again. Unchecked: it was
   * checked when it landed.
   */
  restore(value: unknown, version: number): void {
    restoreCell(this.source, value as Value, version);
  }

  /** A journal step on the box: `restore`. */
  undo(value: unknown, version: unknown): void {
    restoreCell(this.source, value as Value, version as number);
  }
}

/**
 * A box a collection owns: its key order, its change counter, or a row's
 * cell. Its own class, so the change stream leaves it out of a record's
 * boxes, at no cost to a box's size, and reports the collection instead.
 */
export class CollectionCell<Value> extends BoxCell<Value> {}

/** The options of every unnamed computed value that compares with `Object.is`: made once, not per value. */
const unnamedComputed = { equals: Object.is, label: "a computed value" };

export class ComputedValue<Value> implements Computed<Value> {
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
 * The observed entries of one `Computed.fn`: a map keyed by argument count,
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

export class AtomCell implements Atom {
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
    const realm = this.realm;
    realm.assertWritable();
    if (realm.updateListeners !== undefined) {
      noteAtom(realm, this);
    }
    touchSource(this.source);
  }

  /** Reruns the atom's observers raw, outside any record: a visible stage showing or withdrawing a mark. */
  mark(): void {
    touchSource(this.source);
  }
}

/** The realm an observable was made in. */
export const realmOf = (observable: Box<unknown> | Computed<unknown> | Atom): ObservableRealm => {
  if (!isMadeByPinna(observable)) {
    throw new PinnaUsageError(
      "pinna/not-made-by-pinna",
      "pinna: expected a box, a computed value, or an atom",
    );
  }
  return observable.realm;
};

/** The graph node behind a box, a computed value, or an atom: for devtools. */
export const nodeOf = (observable: Box<unknown> | Computed<unknown> | Atom): Source =>
  sourceNode("Devtools.source", observable);

/**
 * A graph node's name: an observable's from `{ name }`, a watch's from
 * `Realm.watch`'s `{ name }` or `"autorun"`, a reaction's (`"useValue"`,
 * `"useSelect"`); `undefined` for an unnamed observable.
 */
export const nameOfNode = (node: CoreNode): string | undefined => {
  const name = names.get(node as Source);
  if (name !== undefined) return name;
  const kind = kindOf(node);
  return kind === "watch" || kind === "reaction" ? node.label : undefined;
};

/** A value's name, its realm's name, what it last read, how many observe it, and why it last recomputed. */
export const inspect = (observable: Box<unknown> | Computed<unknown> | Atom): Inspection => {
  const node = sourceNode("Source.inspect", observable);
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
    stages:
      observable instanceof BoxCell && observable.realm.stack !== undefined
        ? observable.realm.stack.covering(observable as BoxCell<unknown>)
        : [],
  };
};
