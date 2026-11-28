/**
 * The realm: the graph it owns, the update and its journal, the record a
 * landed update hands to `Realm.onUpdate`, and the calls that start and stop
 * what runs in it (`Realm.update`, `Realm.untracked`, `Realm.watch`,
 * `Realm.autorun`, `Source.onObserved`, `Source.observe`, `Realm.dispose`).
 */
import {
  Graph as CoreGraph,
  type DerivedNode,
  nextPlace,
  PinnaUsageError,
  peekDerived,
  placeAllows,
  placeDeriving,
  placeDisposed,
  placeKind,
  placeOpen,
  placeRecipe,
  placeSelecting,
  placeUnderSelect,
  reportUncaught,
  type Source,
} from "@frondruntime/pinna-core";
import {
  type AtomCell,
  type BoxCell,
  checkName,
  madeByPinna,
  names,
  type ValueOptions,
} from "./box.ts";
import { equalKey, hashKey, identityHash } from "./identity.ts";
import { Journal, runUndo, type UndoTarget } from "./journal.ts";
import type { Atom } from "./modules/atom.ts";
import type { Box } from "./modules/box.ts";
import type { Collection } from "./modules/collection.ts";
import type { Computed } from "./modules/computed.ts";
import type { Realm } from "./modules/realm.ts";
import {
  type CollectionChange,
  drainRecords,
  takeRecord,
  type UpdateListener,
  type UpdateOptions,
  type UpdateRecord,
} from "./record.ts";
import { ScheduledReaction, type Scheduler } from "./scheduled.ts";
import {
  type Place,
  peekReader,
  type Read,
  readIn,
  type StagedPlace,
  type UpdateRecipe,
  type Write,
  writeIn,
} from "./verbs.ts";

/** `Realm.watch`'s options: `ValueOptions`, and when its effect runs. */
export interface WatchOptions<Value> extends ValueOptions<Value> {
  /**
   * Runs the watch when the scheduler calls the `run` it is handed, rather
   * than before `Realm.update` returns. Every write before that joins one run,
   * which reads the values current when it starts.
   */
  readonly scheduler?: Scheduler;
  /**
   * Also runs the effect once when `Realm.watch` is called, after `select`'s
   * first run, with `previous` `undefined`. That run ignores `equals`, and an
   * error from it is thrown from `Realm.watch` with nothing watched. Refused
   * inside an update (`pinna/watch-immediate-in-update`).
   */
  readonly immediate?: boolean;
}

/**
 * `Realm.watch`'s type: without `immediate`, `previous` is a `Value`; with
 * it, `previous` is `undefined` on the run at the call.
 */
export interface Watch {
  <Value>(
    realm: Realm,
    select: (read: Read) => Value,
    effect: (value: Value, previous: Value) => undefined,
    options?: WatchOptions<Value> & { readonly immediate?: false },
  ): () => void;
  <Value>(
    realm: Realm,
    select: (read: Read) => Value,
    effect: (value: Value, previous: Value | undefined) => undefined,
    options: WatchOptions<Value>,
  ): () => void;
}

/** `Realm.autorun`'s options. */
export interface AutorunOptions {
  /** As `WatchOptions.scheduler`: the autorun runs again when the scheduler calls `run`. */
  readonly scheduler?: Scheduler;
}
/**
 * The open visible stages of a realm, as `Realm.update` and `Realm.dispose`
 * see them: `src/stage.ts` implements it. While a stack is open, the boxes
 * it covers hold their base values for the length of every outermost update
 * and the shown values at rest (the window, `docs/design.md`, "Stages").
 */
export interface VisibleStack {
  /** True while the covered cells hold the base: inside an outermost update. */
  readonly window: boolean;
  /** As an outermost update begins: the covered cells get their base values back, raw. */
  open(): void;
  /**
   * As an outermost update ends, after its recipe returned or its rollback
   * ran: the stack replays where the base or the stack changed, and shows.
   */
  close(): void;
  /** `Realm.dispose`: the base back in every covered cell, and the stack gone. */
  dispose(): void;
  /** The stack replays at the next window: a row listener was added. */
  invalidate(): void;
  /** The names of the showing stages that cover `box`, bottom first. */
  covering(box: BoxCell<unknown>): ReadonlyArray<string>;
  /** The base value and version of `box`, whatever the cell shows: for the change stream. */
  baseOf(box: BoxCell<unknown>): { readonly value: unknown; readonly version: number };
  /** The base rows of `collection` while the stack shows others in its place, or `undefined`. */
  baseRows(collection: object): ReadonlyMap<unknown, unknown> | undefined;
}
/**
 * Whether a stage's recipe or read function runs in `core`: the place word's
 * recipe condition. The core refuses a write, a watch, and an observe there
 * through its deriving condition, so a recipe cannot write the realm around
 * its stage, and `Realm.update` and `read` pay nothing more for the check.
 */
export const inRecipe = (core: CoreGraph): boolean => (core.place & placeRecipe) !== 0;

/** Thrown by a realm's own `read` inside a stage recipe, where it would skip the stage's values. */
export const recipeReadError = (verb: string): Error =>
  new PinnaUsageError(
    "pinna/realm-read-in-recipe",
    `pinna: ${verb} of the realm runs inside a stage recipe, where it would skip the stage's values; read through the recipe's own read`,
  );

/** Thrown by what makes an observable inside a stage recipe, which runs again when the stage is applied. */
export const recipeMakeError = (what: string): Error =>
  new PinnaUsageError(
    "pinna/made-in-recipe",
    `pinna: ${what} is made inside a stage recipe, which runs again when the stage is applied, so it would be made twice; make it outside the recipe and close over it`,
  );

/** Throws when a stage recipe runs in `realm`: for a call whose effect a replay would repeat. */
export const assertNotInRecipe = (realm: ObservableRealm, call: string): void => {
  if (inRecipe(realm.core)) {
    throw new PinnaUsageError(
      "pinna/call-in-recipe",
      `pinna: ${call} runs inside a stage recipe, which runs again when the stage is applied; call it outside the recipe`,
    );
  }
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
export const otherRealmError = (
  verb: string,
  source: Source | undefined,
  theirs: ObservableRealm,
  ours: ObservableRealm,
): Error => {
  const name = source === undefined ? undefined : names.get(source);
  const what = name === undefined ? "$observable" : `"${name}"`;
  return new PinnaUsageError(
    "pinna/foreign-realm",
    `pinna: ${verb}(${what}) is handed an observable of another realm${realmsOf(theirs, ours)}. A realm's read and write take only what that realm made`,
  );
};
/** Marks an async recipe's rejection handled: the update has thrown for it already. */
const ignore = (): void => {};

export declare const realmBrand: unique symbol;

/**
 * Where a realm is in its life: `"open"` until `Realm.dispose`,
 * `"disposing"` while it stops what runs, then `"disposed"`.
 */
export type RealmStatus = "open" | "disposing" | "disposed";

/**
 * The `nextRecorded` of the box recorded first, and the realm's list when
 * none is, so that a set link means recorded. Only compared, never read.
 */
export const endOfRecorded = {} as BoxCell<unknown>;

/**
 * What a collection does for the change stream, which `KeyedCollection` in
 * `collection.ts` implements: the realm asks each collection that changed
 * for its part of the record as the outermost update ends.
 */
/** The rows a listener registered at rest heard first: its collection's key order and each key's row, in base values. */
export interface RegistrationRows {
  readonly collection: Collection<unknown, unknown>;
  readonly keys: ReadonlyArray<unknown>;
  readonly rows: ReadonlyArray<unknown>;
}

export interface RecordedCollection {
  /** True while the realm's `recordedCollections` holds it. */
  recording: boolean;
  /**
   * The collection's net change since the outermost update began, or
   * `undefined`; forgets it. A change it returns has its listener counts in
   * `listenerCounts` (`record.ts`).
   */
  takeChange(stack: VisibleStack | undefined): CollectionChange | undefined;
  /** True when the outermost update added a `Collection.onRowChange` listener to it; `takeChange` forgets it. */
  registeredInUpdate(): boolean;
  /**
   * Runs `restore`, a `write.revert` or `write.replay` of this collection's
   * rows, with only the `Collection.onRowChange` listeners registered after
   * the first `count` hearing its writes.
   */
  restoreHeardAfter(count: number, restore: () => void): void;
}

/**
 * The collection that owns each key-order box, so a record finds an order
 * that changed with no row (a stage that lands a new order alone).
 */
export const orderOwners = new WeakMap<object, RecordedCollection>();

/**
 * An entry of the realm's completion list: `complete` runs once, when the
 * outermost update that added it ends, and does not throw.
 */
export interface Completion {
  complete(): void;
}

/** A `Realm.onUpdate` listener, and whether it takes records yet: one added in an update starts at the next. */
export interface UpdateListenerEntry {
  readonly listener: UpdateListener;
  active: boolean;
  /** Set by its stop: a record queued before the stop is not handed to it. */
  stopped: boolean;
}

/** A record and the listeners it goes to: those that took records when its update ended. */
export interface QueuedRecord {
  readonly record: UpdateRecord;
  readonly listeners: ReadonlyArray<UpdateListenerEntry>;
}

/** How a realm is made. */
export interface RealmOptions {
  /**
   * Where an error with no caller goes: a watch effect's error, a reaction's
   * error, a `Source.onObserved` hook's or cleanup's error, and the error for
   * watchers or hooks that never settle. The write has
   * landed, so the writer is not the place. The host's `reportError` by
   * default. If it throws, the other watchers still run, and its first error
   * then throws to the writer.
   */
  readonly onError?: (error: unknown) => void;
  /**
   * A name for tools: `Source.inspect` reports it, and an error about an
   * observable of another realm names both realms. It is a label only;
   * realms are told apart by identity, so two realms may share a name.
   */
  readonly name?: string;
}

export class ObservableRealm implements Realm {
  declare readonly [realmBrand]: true;
  /** `Realm.dispose(this)`, set on the prototype where the runtime has `Symbol.dispose`. */
  declare [Symbol.dispose]: () => void;
  readonly core: CoreGraph;
  /** How many updates are open: the outermost update is the one that makes it 1. */
  updateDepth = 0;
  /**
   * What a failed update puts back, besides each box's first record. A
   * step's last argument is `recordedCount` when it was taken, so a rollback
   * puts back steps and first records in the reverse of the order they were
   * taken in. A box's step is the box, its value, and its version.
   *
   * A box's first record in the outermost update is kept on the box: the
   * value and version it had when that update began, and the update scope
   * that last recorded it. A nested update that rolls the record back puts
   * back that same value and version, and the box records anew.
   */
  readonly journal: Journal = new Journal();
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
   * `"open"`, then `"disposing"` while `Realm.dispose` stops what runs, then
   * `"disposed"`. `Realm.update` refuses once disposed; every call that starts an
   * observer, a hook, a listener, or a stage refuses from `"disposing"` on.
   */
  status: RealmStatus = "open";
  /**
   * Scheduled watches and autoruns running now, from their scheduler's
   * `run`: the graph is at depth 0 there, so `Realm.dispose` asks this too.
   */
  scheduledRuns = 0;
  /**
   * What `Realm.dispose` stops besides the graph's own watches and reactions:
   * each autorun, `Collection.onRowChange` listener, and open stage, by its label for
   * `testRealm`'s report. Added when each starts and deleted when it stops,
   * never on a read or a write.
   */
  readonly registered = new Set<{ readonly label: string; readonly stop: () => void }>();
  /**
   * What sibling packages run when the realm is disposed, before anything
   * stops: `pinna-effect` ends `Program.changes` and interrupts `Program.watchScoped` there.
   * Not counted by `testRealm`, since the watch under each is.
   */
  readonly disposeListeners = new Set<() => void>();
  /**
   * The `Realm.onUpdate` listeners, or `undefined` while none is added: an
   * outermost update's end, a row write, and an atom's change each ask this
   * one field, and keep nothing for the change stream while it is unset.
   * Replaced whole on each change, so a drain runs the listeners it began with.
   */
  updateListeners: ReadonlyArray<UpdateListenerEntry> | undefined = undefined;
  /** The outermost update's `{ name }`. */
  updateName: string | undefined = undefined;
  /** The collections the outermost update changed, while a listener exists. */
  recordedCollections: Array<RecordedCollection> | undefined = undefined;
  /** The atoms the outermost update changed, in order, while a listener exists. */
  recordedAtoms: Set<AtomCell> | undefined = undefined;
  /** The names of the stages `Stage.apply` landed in the outermost update, while a listener exists. */
  landedStages: Array<string | undefined> | undefined = undefined;
  /**
   * While the outermost update is the one `Collection.onRowChange` opens
   * at rest for its listener's replay, the rows that listener hears, in
   * key order; else `undefined`. Its record holds that listener's writes
   * alone, and a restore of it checks these rows (`record.ts`).
   */
  registrationRows: RegistrationRows | undefined = undefined;
  /**
   * The completion list: what the outermost update acquired and releases
   * when it ends, failed or not, each entry once, in the order added
   * (`forget` drains it). A key order's log of changes in place
   * (`OrderCell` in `collection.ts`) is one, so a removed key is not held
   * past its update. A failure's release is a journal step instead. One
   * flat array, reused between updates: an entry is the object itself, so
   * the list adds no wrapper objects. Emptied with `length = 0`, which on
   * Hermes drops its storage: the next update's first entry allocates it.
   */
  readonly completions: Array<Completion> = [];
  /**
   * Errors that stopped a visible stage in the last walk of the stack, not
   * yet sent to `onError`. Sent once the outermost update is over, or once
   * the stage call that walked the stack outside an update returns its
   * walk, so a handler that writes or drops a stage starts its own update
   * instead of changing the stack mid-walk. `undefined` when none.
   */
  stackReports: Array<unknown> | undefined = undefined;
  /** Records built and not yet handed to the listeners, oldest first. */
  recordQueue: Array<QueuedRecord> | undefined = undefined;
  /** True while the listeners take records: a record built meanwhile joins the queue. */
  draining = false;
  /** True while a microtask is due to drain records queued where the realm was not at rest. */
  drainScheduled = false;

  /** Keeps `stop` for `Realm.dispose` and returns the stop to hand out, which forgets it. */
  register(label: string, stop: () => void): () => void {
    const entry = {
      label,
      // Forgotten once `stop` returns: one that throws stays kept, and
      // `Realm.dispose` stops it again.
      stop: () => {
        stop();
        this.registered.delete(entry);
      },
    };
    this.registered.add(entry);
    return entry.stop;
  }

  /** Throws once disposal began: `what` cannot start in this realm. */
  assertOpen(what: string): void {
    if (this.status !== "open") {
      throw disposedError(this, what);
    }
  }
  /**
   * The `read` and `write` of the stage recipe or read function running now,
   * or `undefined`. Only slow paths ask it: a merge into a held model and
   * `Collection.reconcile`'s writes, which have no `read` or `write` of their own.
   */
  stagedPlace: StagedPlace | undefined = undefined;
  /**
   * The open visible stages, or `undefined` while none is open: an
   * outermost `Realm.update` tests this one field as it begins and ends.
   */
  stack: VisibleStack | undefined = undefined;
  /** What a merge reads and writes outside a stage: the held values, and the update's `write`. */
  private realmPlace: Place | undefined = undefined;

  /**
   * The `read` a read with none of its own reads through now, such as an
   * encode of a `Model.Schema` instance: a running stage recipe's, the
   * realm's in a tracked run, so the read is tracked, or else what the realm
   * holds.
   */
  readerNow(): Read {
    if (this.stagedPlace === undefined && this.core.active !== undefined) {
      return this.read;
    }
    return this.place().read;
  }

  /** Where a merge reads and writes now: the running stage recipe, or the realm. */
  place(): Place {
    if (this.stagedPlace !== undefined) {
      return this.stagedPlace;
    }
    this.realmPlace ??= { read: peekReader(), write: this.write };
    return this.realmPlace;
  }

  /** The realm's verbs, made once: each throws for an observable of another realm. */
  readonly read: Read;
  readonly write: Write;
  readonly name: string | undefined;

  constructor(options?: RealmOptions) {
    checkName(options?.name);
    this.name = options?.name;
    this.core = new CoreGraph(options?.onError ?? reportUncaught);
    this.core.name = options?.name;
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
    // `placeAllows.write`, inline: a write pays no call to ask. The numbers
    // are `placeUpdating | placeDeriving` and `placeUpdating`, written out:
    // an interpreter pays a load for each imported constant (see `graph.ts`,
    // after `hookKeeps`), and `place.test.ts` pins them to the table.
    if ((core.place & 6) !== 2) {
      throw writeRefused(core);
    }
  }

  /**
   * Records the value `Box.make` holds before a write: in the journal once per
   * update scope, and as its value before once per outermost update.
   */
  record(box: BoxCell<unknown>, value: unknown): void {
    // The box was recorded in this outermost update: `write` sends a first write to `recordFirst`.
    if (box.recordedScope !== this.scope) {
      box.recordedScope = this.scope;
      // `Journal.step`, inline.
      const journal = this.journal;
      const slots = journal.slots;
      const end = journal.length;
      slots[end] = box;
      slots[end + 1] = value;
      slots[end + 2] = box.source.version;
      slots[end + 3] = this.recordedCount;
      journal.length = end + 4;
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

  /** Runs `undo` if the update this runs in fails: for state no target owns. */
  recordUndo(undo: () => void): void {
    this.journal.step(runUndo, undo, undefined, this.recordedCount);
  }

  /** Takes a step of the journal: `target.undo(a, b)` runs if the update this runs in fails. */
  step(target: UndoTarget, a: unknown, b: unknown): void {
    // `Journal.step`, inline.
    const journal = this.journal;
    const slots = journal.slots;
    const end = journal.length;
    slots[end] = target;
    slots[end + 1] = a;
    slots[end + 2] = b;
    slots[end + 3] = this.recordedCount;
    journal.length = end + 4;
  }

  /**
   * Runs `write` in its own scope of the open update: a throw puts back only
   * what `write` wrote, even when the caller catches it. Unlike a nested
   * `Realm.update`, it runs wherever a write may, a tracked run included.
   */
  undoOnThrow(write: () => void): void {
    const outer = this.scope;
    const savepoint = this.journal.length;
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

  /**
   * Puts back what was recorded since `savepoint` and `recordedAt`, the
   * journal's length and `recordedCount` when the failed scope began: the
   * steps and the boxes' first records together, the last recorded first.
   */
  rollback(savepoint: number, recordedAt: number): void {
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
    // The boxes first recorded after a step are put back before it.
    const putBackAbove = (countAtStep: number): void => {
      while (count > countAtStep) {
        const restored = box;
        const value = restored.valueBefore;
        box = restored.nextRecorded as BoxCell<unknown>;
        count--;
        restored.nextRecorded = undefined;
        restored.valueBefore = undefined;
        restored.restore(value, restored.versionBefore);
      }
    };
    try {
      this.journal.rollback(savepoint, putBackAbove as (c: unknown) => void);
      putBackAbove(recordedAt);
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
    }
  }

  /** Forgets what the outermost update recorded, so it holds no value it replaced. */
  forget(): void {
    if (this.updateListeners !== undefined) {
      takeRecord(this);
    }
    for (let box = this.recorded; box !== endOfRecorded; ) {
      const next = box.nextRecorded as BoxCell<unknown>;
      box.nextRecorded = undefined;
      box.valueBefore = undefined;
      box = next;
    }
    this.recorded = endOfRecorded;
    this.recordedCount = 0;
    this.journal.forget(0);
    // After the record: a collection's part of it reads an order's log.
    const completions = this.completions;
    if (completions.length !== 0) {
      for (let index = 0; index < completions.length; index++) {
        (completions[index] as Completion).complete();
      }
      completions.length = 0;
    }
  }

  /** `Realm.untracked` for one computed value, without a closure: what `peek` costs on Hermes. */
  peekDerived<Value>(derived: DerivedNode<Value>): Value {
    const core = this.core;
    const outerPlace = core.place;
    // `nextPlace(outerPlace, placeKind.peek)`, written out: the conditions
    // kept, open, and the kind. The table's switch costs a peek, which a
    // hook makes on every render, a compare per kind before it on Hermes.
    core.place = (outerPlace & 4095) | 45057;
    try {
      return peekDerived(derived);
    } finally {
      core.place = outerPlace;
    }
  }
}

/** Sends the errors that stopped visible stages to `onError`, oldest first, each once. */
export const sendStackReports = (realm: ObservableRealm): void => {
  const reports = realm.stackReports;
  if (reports === undefined) return;
  realm.stackReports = undefined;
  for (const error of reports) {
    realm.core.reportAside(error);
  }
};

// The realm's operations: each takes the realm first, or reads it from the observable.

/** A new realm, with nothing shared with any other. */
export const createRealm = (options?: RealmOptions): Realm => new ObservableRealm(options);

/** What a call that cannot run in a disposed or disposing realm throws. */
const disposedError = (realm: ObservableRealm, what: string): Error =>
  new PinnaUsageError(
    "pinna/realm-disposed",
    `pinna: ${what} cannot start in the disposed realm${realm.name === undefined ? "" : ` "${realm.name}"`}; make a new realm`,
  );

/** The realm behind `realm`; throws for a value `Realm.make` did not make. */
const ownRealm = (what: string, realm: Realm): ObservableRealm => {
  if (!(realm instanceof ObservableRealm)) {
    throw new PinnaUsageError(
      "pinna/not-made-by-pinna",
      `pinna: ${what} needs a realm made by Realm.make()`,
    );
  }
  return realm;
};

/**
 * Ends everything that runs in `realm`, then refuses to run anything more
 * there. In order: `pinna-effect`'s `Program.changes` end and its `Program.watchScoped`
 * effects are interrupted; each autorun stops and runs its cleanup, each
 * `Collection.onRowChange` listener stops, and each open stage is dropped, newest
 * first; then every `Source.onObserved` hook that has begun runs its cleanup, newest
 * first. All of it runs in one batch, so no hook ends before the last
 * autorun cleanup. A cleanup may write through `Realm.update`; no watch runs for
 * it. A cleanup's error goes to `onError`.
 *
 * A watch, a `Source.observe`, or a mounted hook stays linked, and never runs
 * again: nothing can write. A mounted hook that reads a source for the
 * first time after disposal starts none of its `Source.onObserved` hooks. Afterward reads still work and return the last
 * values, a stop function or release does nothing more, and `Realm.update`,
 * `Realm.watch`, `Realm.autorun`, `Source.observe`, `Source.onObserved`, `Collection.onRowChange`, `Stage.make`,
 * and a hook mounting throw. Disposing twice does nothing. Throws, and
 * stops nothing, inside an update, a computed value, a watch's select or
 * effect, an autorun, a `Realm.untracked` read, a hook, a stage recipe, or a row
 * listener: dispose once the realm is at rest, from an event handler or a
 * teardown.
 */
export const disposeRealm = (realm: Realm): void => {
  const owner = ownRealm("Realm.dispose", realm);
  if (owner.status !== "open") {
    return;
  }
  const core = owner.core;
  if (core.depth !== 0 || !placeAllows.rest(core.place) || owner.scheduledRuns !== 0) {
    throw new PinnaUsageError(
      "pinna/dispose-not-at-rest",
      "pinna: Realm.dispose runs while the realm is running an update, a derivation, a watch, an autorun, a hook, or a Realm.onUpdate listener; dispose from an event handler or a teardown, once the realm is at rest",
    );
  }
  owner.status = "disposing";
  // Records not yet handed out are dropped: no listener runs from here on.
  owner.recordQueue = undefined;
  core.closed = true;
  try {
    // One batch, so the unlinks a stop makes settle once, after every
    // cleanup: no source's hook ends before a newer listener or autorun
    // that may still use it, and the cleanups' writes settle once. A closed
    // graph runs no watcher at that settle.
    core.batch(() => {
      // The base back in every cell a visible stage covers, before the
      // stages drop: a read after disposal returns confirmed values.
      const stack = owner.stack;
      if (stack !== undefined) {
        try {
          stack.dispose();
        } catch (error) {
          core.reportAside(error);
        }
      }
      for (const listener of [...owner.disposeListeners].reverse()) {
        try {
          listener();
        } catch (error) {
          core.reportAside(error);
        }
      }
      owner.disposeListeners.clear();
      for (const entry of [...owner.registered].reverse()) {
        try {
          entry.stop();
        } catch (error) {
          core.reportAside(error);
        }
      }
      // The graph is closed: it ends each begun hook and begins none again.
      core.endBegunHooks();
    });
  } finally {
    owner.status = "disposed";
    // At rest, the word is the realm's base: every update from here on is refused.
    core.place |= placeDisposed;
  }
};

/** Whether `realm` is open, disposing, or disposed. */
export const realmStatus = (realm: Realm): RealmStatus => ownRealm("Realm.status", realm).status;

/**
 * Hands `listener` one record per landed outermost update of `realm`: the
 * net change of each box, collection, and atom it wrote, in base values,
 * after the update's watchers ran and outside any update, in the order the
 * updates landed. A listener may call `Realm.update`; its record follows the
 * one running. One added inside an update takes records from the next
 * update on. Its error goes to the realm's `onError`, and the other
 * listeners still run. Returns the stop, which does nothing the second
 * time; `Realm.dispose` stops it and drops records not yet handed out.
 *
 * Throws in a computed value, a watch's select, a selector, and a stage
 * recipe, as `Collection.onRowChange` does, and from `"disposing"` on.
 */
export const onUpdate = (realm: Realm, listener: UpdateListener): (() => void) => {
  const owner = ownRealm("Realm.onUpdate", realm);
  assertUpdateCanRun(owner, "Realm.onUpdate");
  assertNotInRecipe(owner, "Realm.onUpdate");
  owner.assertOpen("a Realm.onUpdate listener");
  // Its own entry, so one function added twice is two listeners.
  const entry: UpdateListenerEntry = {
    listener,
    active: owner.updateDepth === 0,
    stopped: false,
  };
  const listeners = owner.updateListeners;
  if (listeners === undefined && owner.updateDepth === 0) {
    // A name an update stored while nobody listened.
    owner.updateName = undefined;
  }
  owner.updateListeners = listeners === undefined ? [entry] : [...listeners, entry];
  return owner.register("Realm.onUpdate", () => {
    if (entry.stopped) {
      return;
    }
    entry.stopped = true;
    const next = (owner.updateListeners ?? []).filter((kept) => kept !== entry);
    // Inside an update an empty list stays set, so the update's end clears what it noted.
    owner.updateListeners = next.length === 0 && owner.updateDepth === 0 ? undefined : next;
  });
};

// `using realm = Realm.make()` disposes it. A runtime without
// `Symbol.dispose`, as Hermes is, has `Realm.dispose` alone.
if (typeof Symbol.dispose === "symbol") {
  Object.defineProperty(ObservableRealm.prototype, Symbol.dispose, {
    value(this: ObservableRealm): void {
      disposeRealm(this);
    },
    configurable: true,
    writable: true,
  });
}
/**
 * Why `Realm.update`, or `name` that runs one, refuses to run where reads are
 * tracked outside an autorun's body.
 */
const refusedUpdate = (core: CoreGraph, name = "Realm.update"): Error => {
  const recipe = inRecipe(core);
  return new PinnaUsageError(
    !recipe
      ? "pinna/update-in-derivation"
      : name === "Realm.update"
        ? "pinna/realm-write-in-recipe"
        : "pinna/call-in-recipe",
    recipe
      ? name === "Realm.update"
        ? recipeWriteMessage
        : `pinna: ${name} runs inside a stage recipe, which runs again when the stage is applied; call it outside the recipe`
      : (core.place & placeDeriving) !== 0
        ? `pinna: ${name} cannot run in a computed value; write from an event, a watch's effect, or an autorun`
        : `pinna: ${name} cannot run in a watch's select or a selector; write from an event, a watch's effect, or an autorun`,
  );
};

const recipeWriteMessage =
  "pinna: a stage recipe writes the realm, through Realm.update or a write kept from one; write through the recipe's own write, which the stage holds until Stage.apply";

/** Why a write verb refuses to run here: in a stage recipe, a derivation, or outside an update. */
const writeRefused = (core: CoreGraph): Error =>
  inRecipe(core)
    ? new PinnaUsageError("pinna/realm-write-in-recipe", recipeWriteMessage)
    : (core.place & placeDeriving) !== 0
      ? core.derivingWriteError()
      : new PinnaUsageError("pinna/write-outside-update", "pinna: write inside Realm.update");

/**
 * Whether `Realm.update` refuses to run here: in a derivation, a watch's select, a
 * selector, or a `Realm.untracked` call inside one, but not in an autorun's body.
 * Unlike `Realm.update` itself, a disposed realm does not refuse here.
 */
export const updateRefused = (realm: ObservableRealm): boolean =>
  (realm.core.place & (placeDeriving | placeSelecting | placeUnderSelect)) !== 0;

/**
 * Throws what `Realm.update` would, named for `name`, where an update cannot run:
 * for a function that runs one on the caller's behalf.
 */
export const assertUpdateCanRun = (realm: ObservableRealm, name: string): void => {
  if (updateRefused(realm)) {
    throw refusedUpdate(realm.core, name);
  }
};

/**
 * `Realm.update` in an autorun's body, untracked: the recipe's reads do not
 * subscribe the autorun, and the body tracks again once it ends. A function
 * of its own, so `Realm.update` keeps no closure or second scope.
 */
const updateInAutorun = (
  owner: ObservableRealm,
  recipe: UpdateRecipe,
  options: UpdateOptions | undefined,
): void => {
  const core = owner.core;
  const active = core.active;
  const outerPlace = core.place;
  core.active = undefined;
  core.place = nextPlace(outerPlace, placeKind.autorunUpdate);
  try {
    update(owner, recipe, options);
  } finally {
    core.active = active;
    core.place = outerPlace;
  }
};

/**
 * The one place boxes are written. Nested updates join the outermost one;
 * watchers see its end state once. If `recipe` throws, every box it wrote
 * gets its old value back and the error is rethrown.
 */
export const update = (realm: Realm, recipe: UpdateRecipe, options?: UpdateOptions): void => {
  const owner = realm as ObservableRealm;
  // The batch is opened and closed by hand: a closure here would cost
  // every update its scope on Hermes.
  const core = owner.core;
  // `placeAllows.update`, inline. A disposed realm's refusal comes first.
  const outerPlace = core.place;
  // The numbers are `placeDeriving | placeSelecting | placeUnderSelect |
  // placeDisposed` and `placeDisposed`, written out as in `assertWritable`.
  if ((outerPlace & 420) !== 0) {
    throw (outerPlace & 256) !== 0 ? disposedError(owner, "Realm.update") : refusedUpdate(core);
  }
  // An autorun's body tracks: its update runs untracked.
  if (core.active !== undefined) {
    updateInAutorun(owner, recipe, options);
    return;
  }
  if (options !== undefined) {
    checkName(options.name);
  }
  core.beginBatch();
  const outer = owner.scope;
  const savepoint = owner.journal.length;
  const recordedAt = owner.recordedCount;
  owner.scope = ++owner.scopes;
  owner.updateDepth++;
  // `nextPlace(outerPlace, placeKind.update)`, written out: the conditions
  // kept, and open, updating, and the kind.
  core.place = (outerPlace & 4095) | 4099;
  // One try: nothing before it throws, and its finally closes the scope,
  // then the batch.
  let failed = true;
  try {
    // The record carries the outermost update's name; a nested one's is
    // ignored. An unnamed update stores nothing: the last record cleared the
    // name, and the first listener added at rest clears one left before it.
    if (options !== undefined && owner.updateDepth === 1) {
      owner.updateName = options.name;
    }
    // While visible stages are open, the outermost recipe reads and writes
    // the base: the covered cells hold it until the stack shows again.
    if (owner.stack !== undefined && owner.updateDepth === 1) {
      owner.stack.open();
    }
    const result: unknown = recipe(owner.read, owner.write);
    if (result !== undefined) {
      if (typeof (result as { readonly then?: unknown }).then === "function") {
        (result as PromiseLike<unknown>).then(undefined, ignore);
        throw new PinnaUsageError(
          "pinna/async-recipe",
          "pinna: Realm.update recipes are synchronous; await outside, then Realm.update",
        );
      }
      throw new PinnaUsageError(
        "pinna/recipe-returns-value",
        "pinna: a Realm.update recipe returns nothing",
      );
    }
    if (owner.stack !== undefined && owner.updateDepth === 1) {
      owner.stack.close();
    }
    failed = false;
  } catch (error) {
    owner.rollback(savepoint, recordedAt);
    if (owner.stack !== undefined && owner.updateDepth === 1) {
      // Stage calls are not rolled back: the stack shows what it holds now.
      try {
        owner.stack.close();
      } catch (hidden) {
        core.reportAside(hidden);
      }
    }
    throw error;
  } finally {
    owner.updateDepth--;
    core.place = outerPlace;
    owner.scope = outer;
    if (owner.updateDepth === 0) {
      owner.forget();
    }
    try {
      core.endBatch(failed);
    } finally {
      // Records go out once the watchers ran, an update a watcher ran queued
      // behind, and also when the settle throws to the writer: the update
      // landed, so its record is owed.
      if (owner.recordQueue !== undefined) {
        drainRecords(owner);
      }
      if (owner.stackReports !== undefined && owner.updateDepth === 0) {
        sendStackReports(owner);
      }
    }
  }
};

/** Reads observables without tracking them: for event handlers and effects. */
export const untracked = <Result>(realm: Realm, run: (read: Read) => Result): Result => {
  const owner = realm as ObservableRealm;
  const core = owner.core;
  if (inRecipe(core)) {
    throw recipeReadError("Realm.untracked");
  }
  // Open for the realm's `read`; the graph's `untracked` enters its own place inside.
  const outerPlace = core.place;
  core.place = outerPlace | placeOpen;
  try {
    return core.untracked(run);
  } finally {
    core.place = outerPlace;
  }
};

/**
 * Runs `effect`, untracked, whenever `select`'s result changes. `select` is
 * tracked and must not write. Returns the function that stops watching. An
 * error from `select`'s first run is thrown here and nothing is watched; an
 * error from a `Source.onObserved` hook it starts goes to `onError`. `effect`
 * returns `undefined`, as `Realm.update`'s recipe does, so an async function is
 * refused: its rejection would reach no one.
 */
export const watch: Watch = <Value>(
  realm: Realm,
  select: (read: Read) => Value,
  effect: (value: Value, previous: Value) => undefined,
  options?: WatchOptions<Value>,
): (() => void) => {
  const owner = realm as ObservableRealm;
  owner.assertOpen("a watch");
  const core = owner.core;
  if (options === undefined) {
    return core.watch(select, effect);
  }
  checkName(options.name);
  if (options.immediate === true) {
    return immediateWatch(owner, select, effect, options);
  }
  if (options.scheduler !== undefined) {
    return scheduledWatch(owner, select, effect, options, options.scheduler, false);
  }
  return core.watch(select, effect, { equals: options.equals, label: options.name });
};

/**
 * `Realm.watch` with `{ immediate: true }`: the effect runs once at the call
 * with `select`'s first result and `previous` `undefined`, then as a plain or
 * a scheduled watch. Inside an update it throws: the run would come before
 * the update lands, with a value a rollback could take back.
 */
const immediateWatch = <Value>(
  owner: ObservableRealm,
  select: (read: Read) => Value,
  effect: (value: Value, previous: Value) => undefined,
  options: WatchOptions<Value>,
): (() => void) => {
  if (owner.updateDepth > 0) {
    throw new PinnaUsageError(
      "pinna/watch-immediate-in-update",
      `pinna: ${options.name ?? "a watch"} with { immediate: true } is made inside Realm.update, where its first effect would run before the update lands; make the watch outside the update`,
    );
  }
  if (options.scheduler !== undefined) {
    return scheduledWatch(owner, select, effect, options, options.scheduler, true);
  }
  // The value the run at the call delivers: the select's first result, or a
  // later one when a `Source.onObserved` hook the watch starts writes what it
  // reads before `core.watch` returns. A change before that run is held, not
  // delivered, so the effect never sees a value older than one it saw.
  // Every select run before that run sets it, so an `equals` that finds the
  // hook's write unchanged, and so delivers no change, still leaves it current.
  let delivered = false;
  let latest: Value | undefined;
  const stop = owner.core.watch(
    (read: Read) => {
      const value = select(read);
      if (!delivered) {
        latest = value;
      }
      return value;
    },
    (value: Value, previous: Value) => {
      if (!delivered) {
        latest = value;
        return undefined;
      }
      return effect(value, previous);
    },
    { equals: options.equals, label: options.name },
  );
  delivered = true;
  // In one batch, so a write the run makes settles once it returns, as an
  // autorun's first run's does: no watcher, this one included, runs inside
  // it, and the effect never starts again before its run at the call ends.
  const core = owner.core;
  try {
    core.beginBatch();
    let failed = true;
    try {
      untracked(owner, () => {
        // Let go of it, so the watch does not keep its first value alive
        // after it changes: a local of this function alone, since a variable
        // the watch's closures share stays as long as they do.
        const first = latest as Value;
        latest = undefined;
        return effect(first, undefined as Value);
      });
      failed = false;
    } finally {
      core.endBatch(failed);
    }
  } catch (error) {
    stop();
    throw error;
  } finally {
    // The run's updates go out now, as an autorun's first run's do: inside
    // the batch they were queued. Also when the run throws: an update it
    // made landed, so its record is owed before the caller sees the error.
    if (owner.recordQueue !== undefined) {
      drainRecords(owner);
    }
  }
  return stop;
};

/** `Realm.watch` with a scheduler: its first run is synchronous, each later one the scheduler's. */
const scheduledWatch = <Value>(
  owner: ObservableRealm,
  select: (read: Read) => Value,
  effect: (value: Value, previous: Value) => undefined,
  options: WatchOptions<Value>,
  scheduler: Scheduler,
  immediate: boolean,
): (() => void) => {
  const equals = options.equals ?? Object.is;
  let value: Value;
  let started = false;
  const scheduled = new ScheduledReaction(
    owner,
    scheduler,
    options.name ?? "scheduled watch",
    (reaction) => {
      const next = reaction.track(select as (read: never) => Value);
      if (!started) {
        started = true;
        value = next;
        if (immediate) {
          // Untracked, as a plain immediate watch's run: a scheduled watch
          // made inside an autorun's body runs this inside the autorun's
          // tracked run, whose reads it must not join.
          untracked(owner, () => effect(next, undefined as Value));
        }
        return;
      }
      // As a plain watch: `previous` is the last result, even one `equals`
      // found equal.
      const previous = value;
      value = next;
      // A hook the run started may have stopped the watch, as `runWatch`
      // checks `linked`.
      // `stopped` again after `equals`, which may stop the watch.
      if (!scheduled.stopped && !equals(previous, next) && !scheduled.stopped) {
        effect(next, previous);
      }
    },
  );
  try {
    scheduled.start();
  } finally {
    // An immediate watch's first run may update, inside the start's batch:
    // its updates go out now, as an autorun's first run's do, also when the
    // run throws after one landed.
    if (owner.recordQueue !== undefined) {
      drainRecords(owner);
    }
  }
  return owner.register("scheduled watch", () => scheduled.stop());
};

/**
 * Runs `effect` now, tracked, and again whenever what its last run read
 * changes. It may call `Realm.update`, which runs untracked: the recipe's reads do
 * not subscribe it. A run that changes what it read runs again, and one
 * that never stops changing it ends at the round limit, reported to
 * `onError`, as a watch effect that loops does. An error on the first run
 * is thrown here and nothing is watched; a later one goes to `onError`, as
 * does an error from an
 * `Source.onObserved` hook it starts. A function `effect` returns is its cleanup: it
 * runs untracked before the next run and when the autorun stops, and its
 * error goes to `onError`. A cleanup that stops its autorun ends it there; an
 * effect that stops its autorun has its cleanup run at once. Returns the
 * function that stops it.
 */
export const autorun = (
  realm: Realm,
  effect: (read: Read) => (() => void) | undefined,
  options?: AutorunOptions,
): (() => void) => {
  const owner = realm as ObservableRealm;
  owner.assertOpen("an autorun");
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
  // returned before `Realm.watch` threw has its cleanup run here, since the
  // caller gets no stop function to run it.
  const body = (read: Read): void => {
    // Set for the cleanup too, so its `Realm.update` runs as the body's does.
    const outerPlace = core.place;
    core.place = nextPlace(outerPlace, placeKind.autorun);
    let result: (() => void) | undefined;
    try {
      clean();
      if (stopped) {
        return;
      }
      result = effect(read);
    } finally {
      core.place = outerPlace;
    }
    if (typeof result === "function") {
      cleanup = result;
      // The effect stopped its own autorun: nothing else will run this.
      if (stopped) {
        clean();
      }
    }
  };
  const scheduler = options?.scheduler;
  let unwatch: () => void;
  try {
    if (scheduler === undefined) {
      unwatch = core.watch(body, undefined, { label: "autorun" });
    } else {
      const scheduled = new ScheduledReaction(owner, scheduler, "scheduled autorun", (reaction) =>
        reaction.track(body as (read: never) => void),
      );
      scheduled.start();
      unwatch = () => scheduled.stop();
    }
  } catch (error) {
    stopped = true;
    clean();
    throw error;
  }
  // The first run's updates go out now, not at the next landing.
  if (owner.recordQueue !== undefined) {
    drainRecords(owner);
  }
  return owner.register(scheduler === undefined ? "autorun" : "scheduled autorun", stop);
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
  const cell = madeByPinna("Source.onObserved", observable);
  assertNotInRecipe(cell.realm, "Source.onObserved");
  const owner = cell.realm as ObservableRealm;
  owner.assertOpen("a Source.onObserved hook");
  // The graph keeps the begun hooks: `Realm.dispose` closes it and ends them.
  return cell.source.graph.onObserved(cell.source, start);
};

/**
 * Holds `observable` observed until the returned release runs: its
 * `Source.onObserved` hooks stay started, and a computed value stays cached. It
 * subscribes nothing that is tracking, so it works anywhere. Releasing twice
 * does nothing. A computed value that throws is held, its error kept for
 * the next read. A `Source.onObserved` hook that throws sends its error to
 * `onError`; the observable stays observed until the release runs.
 */
export const observe = (observable: Box<unknown> | Computed<unknown> | Atom): (() => void) => {
  const cell = madeByPinna("Source.observe", observable);
  (cell.realm as ObservableRealm).assertOpen("Source.observe");
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
 * an autorun. False in an update, `Realm.untracked`, a watch's effect, and a hook.
 */
export const isTracking = (realm: Realm): boolean => (realm as ObservableRealm).core.isTracking();

/* ------------------------------------------- for Pinna's sibling packages */

/** The graph of `realm`: for `pinna-react`, which runs its reactions on it. */
export const graphOf = (realm: Realm): CoreGraph => (realm as ObservableRealm).core;

/** Sends `error`, which has no caller, to `realm`'s `onError`. */
export const reportAside = (realm: Realm, error: unknown): void => {
  (realm as ObservableRealm).core.reportAside(error);
};

/** Where a merge reads and writes in `realm` now: the running stage recipe, or the realm. */
export const currentPlace = (realm: Realm): Place => (realm as ObservableRealm).place();

/**
 * The `read` a read with none of its own reads through in `realm` now: a
 * running stage recipe's, the realm's tracked one in a tracked run, or else
 * an untracked one. For an encode of a `Model.Schema` instance.
 */
export const readerNow = (realm: Realm): Read => (realm as ObservableRealm).readerNow();

/**
 * Runs `write` where `realm` writes now: in a running stage recipe, whose
 * session puts it back on a throw; in the open update, where a throw part
 * way puts back every write of it even when the caller catches the error;
 * or in an update of its own.
 */
export const writeNow = (realm: Realm, write: () => void): void => {
  const owner = realm as ObservableRealm;
  const place = owner.stagedPlace;
  if (place !== undefined) {
    place.undoOnThrow(write);
    return;
  }
  if (owner.updateDepth > 0) {
    owner.undoOnThrow(write);
    return;
  }
  update(owner, () => {
    write();
  });
};

/**
 * Runs `listener` when `realm` is disposed, or at once when it is no longer
 * open. Returns the function that removes it; removing twice does nothing.
 */
export const onDispose = (realm: Realm, listener: () => void): (() => void) => {
  const owner = realm as ObservableRealm;
  if (owner.status !== "open") {
    listener();
    return () => {};
  }
  owner.disposeListeners.add(listener);
  return () => {
    owner.disposeListeners.delete(listener);
  };
};
