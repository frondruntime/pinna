/**
 * Stages: the writes of asynchronous work, landed in one update when it
 * succeeds or dropped when it fails. Until then no box changes, so nothing
 * renders a half-done result and nothing needs undoing.
 *
 * A stage is an overlay and a journal. The overlay holds a value for each box
 * the stage wrote and the rows of each collection it wrote; the journal holds
 * the recipes in the order they ran. `stageUpdate` runs its recipe at once
 * against the stage's `read` and `write` to fill the overlay, and keeps the
 * recipe. A read through the stage sees its own writes everywhere: a box, a
 * collection's keys, rows, and row, and a computed value, which the stage
 * evaluates over its own values, outside the graph, and caches until the
 * stage or the realm changes.
 *
 * `applyStage` replays the journal in one `update` over the realm's values at
 * that moment, nested in an update already open. A child stage, opened over
 * a stage, replays into its parent instead: a savepoint. `dropStage`
 * discards a stage and its open children.
 *
 * A recipe runs twice, once staged and once applied, so it is a function of
 * its `read`: while it runs, the realm's own `read`, `write`, `update`, a
 * watch, and making an observable all throw. The core's `deriving` slot
 * carries the check, so `update` and `read` pay nothing for it.
 */
import { peekCell } from "@frondruntime/pinna-core";
import {
  collectionOfOrder,
  collectionReads,
  KeyedCollection,
  type StagedRows,
} from "./collection.ts";
import {
  type Atom,
  AtomCell,
  assertNotInRecipe,
  assertUpdateCanRun,
  type Box,
  BoxCell,
  type Collection,
  type Computed,
  type ComputedValue,
  checkName,
  type Draft,
  describeSource,
  nameOf,
  type ObservableRealm,
  otherRealmError,
  type Place,
  produce,
  type Read,
  type Realm,
  type Recipe,
  stageMarker,
  type UpsertOptions,
  untracked,
  update,
  type Write,
} from "./observable.ts";

declare const stageBrand: unique symbol;

/**
 * Writes held back from the realm until `applyStage` lands them, or
 * `dropStage` discards them. Made by `openStage`, over a realm or over
 * another stage; closes once.
 */
export interface Stage {
  readonly [stageBrand]: true;
}

/** Where a stage is in its life: open, or closed by `applyStage` or `dropStage`. */
export type StageStatus = "open" | "applied" | "dropped";

/** How `openStage` makes a stage. */
export interface StageOptions {
  /** A name for errors, `inspectStage`, and the test realm's report. */
  readonly name?: string;
  /**
   * What `applyStage` does when a box or collection the stage read changed in
   * the realm since: `"replay"`, the default, replays over the new values;
   * `"fail"` throws a `StageConflictError` and lands nothing. Only a stage
   * over a realm takes it; a child stage records its reads for its root.
   */
  readonly conflicts?: "replay" | "fail";
}

/** What `inspectStage` reports. */
export interface StageInspection {
  readonly name: string | undefined;
  /** The name of the realm the stage writes, from `createRealm({ name })`. */
  readonly realm: string | undefined;
  /** The parent stage's name, `"<anonymous>"` when it has none, or `undefined` over a realm. */
  readonly parent: string | undefined;
  readonly status: StageStatus;
  readonly conflicts: "replay" | "fail";
  /** The boxes this stage wrote, by name; an unnamed box is `"<anonymous>"`. */
  readonly boxes: ReadonlyArray<string>;
  /** How many collections this stage wrote. */
  readonly collections: number;
  /** How many recipes this stage keeps for its replay. */
  readonly recipes: number;
  /** How many child stages are open over this one. */
  readonly children: number;
}

const describeStage = (state: StageState): string =>
  state.name === undefined ? "a stage" : `the stage "${state.name}"`;

/** Thrown by a call on a stage that `applyStage` or `dropStage` closed: a bug in the caller. */
export class StageClosedError extends Error {
  /** The stage's name, when it has one. */
  readonly stage: string | undefined;
  readonly status: StageStatus;

  constructor(call: string, stage: string | undefined, status: StageStatus) {
    super(
      `pinna: ${call} runs on ${stage === undefined ? "a stage" : `the stage "${stage}"`} after it was ${status}; open a new one with openStage`,
    );
    this.name = "StageClosedError";
    this.stage = stage;
    this.status = status;
  }
}

/**
 * Thrown by `applyStage` on a stage opened with `{ conflicts: "fail" }` when
 * a box or collection it read changed in the realm since. Nothing lands.
 */
export class StageConflictError extends Error {
  /** The stage's name, when it has one. */
  readonly stage: string | undefined;
  /** The name of each box that changed, or `"<anonymous>"`; a collection is `"a collection"`. */
  readonly changed: ReadonlyArray<string>;
  /** The boxes and collections that changed, for code that compares them. */
  readonly observables: ReadonlyArray<object>;

  constructor(
    stage: string | undefined,
    changed: ReadonlyArray<string>,
    observables: ReadonlyArray<object>,
  ) {
    super(
      `pinna: applyStage finds that ${changed.join(", ")} changed since ${stage === undefined ? "the stage" : `the stage "${stage}"`} read ${changed.length === 1 ? "it" : "them"}; nothing lands`,
    );
    this.name = "StageConflictError";
    this.stage = stage;
    this.changed = changed;
    this.observables = observables;
  }
}

/** A version the stage read, and what to report when it changed. */
interface ReadVersion {
  readonly version: number;
  readonly observable: object;
}

/** Bumped by every write to any stage's overlay, so a cache knows its chain changed. */
let revisions = 0;

class StageState implements Stage {
  declare readonly [stageBrand]: true;
  readonly realm: ObservableRealm;
  readonly parent: StageState | undefined;
  readonly name: string | undefined;
  readonly conflicts: "replay" | "fail";
  /** The value of each box this stage wrote, a collection's key order among them. */
  boxes = new Map<BoxCell<unknown>, unknown>();
  /** The rows of each collection this stage wrote, copied on its first write. */
  rows = new Map<KeyedCollection<unknown, unknown>, Map<unknown, unknown>>();
  /** The recipes that ran without throwing, in order. */
  journal: Array<Recipe> = [];
  status: StageStatus = "open";
  readonly children = new Set<StageState>();
  /** Raised by each write to this overlay. */
  revision = 0;
  /** Computed values evaluated through this stage, valid while `cacheClock` and `cacheRevision` hold. */
  cache = new Map<ComputedValue<unknown>, unknown>();
  cacheClock = -1;
  cacheRevision = -1;
  readonly evaluating = new Set<ComputedValue<unknown>>();
  /** What this stage read from the realm, by box, when its root checks conflicts. */
  reads: Map<BoxCell<unknown>, ReadVersion> | undefined;
  /** Set under `testRealm` only: tells it the stage closed. */
  release: (() => void) | undefined = undefined;

  constructor(
    realm: ObservableRealm,
    parent: StageState | undefined,
    name: string | undefined,
    conflicts: "replay" | "fail",
  ) {
    this.realm = realm;
    this.parent = parent;
    this.name = name;
    this.conflicts = conflicts;
    this.reads = conflicts === "fail" ? new Map() : undefined;
  }
}

/**
 * The `read` and `write` handed to one recipe, read function, or replay into
 * a parent: good while it runs. `undo` puts back what it wrote to the
 * overlay, the last first.
 */
interface Session {
  open: boolean;
  readonly writable: boolean;
  readonly undo: Array<() => void>;
}

const keptError = (verb: string): Error =>
  new Error(
    `pinna: ${verb} of a stage runs after its recipe returned; read and write inside the recipe`,
  );

/** Why `stageRead` and `realmRead` refuse a derivation: their reads are not tracked, so it would go stale. */
const assertReadCanRun = (realm: ObservableRealm, call: string): void => {
  const core = realm.core;
  if (core.active !== undefined && core.active !== realm.autorunRun) {
    throw new Error(
      core.deriving !== undefined
        ? `pinna: ${call} cannot run in a computed value; a stage's reads are not tracked, so read it from an event, a watch's effect, or an autorun`
        : `pinna: ${call} cannot run in a watch's select or a selector; a stage's reads are not tracked, so read it from an event, a watch's effect, or an autorun`,
    );
  }
};

/** The stage behind `stage`, open, with no stage recipe running. */
const openState = (stage: Stage, call: string): StageState => {
  const state = stage as StageState;
  assertNotInRecipe(state.realm, call);
  if (state.status !== "open") {
    throw new StageClosedError(call, state.name, state.status);
  }
  return state;
};

/** Closes the stage and its open children once, and lets go of what they held. */
const close = (state: StageState, status: "applied" | "dropped"): void => {
  if (state.status !== "open") {
    return;
  }
  for (const child of state.children) {
    close(child, "dropped");
  }
  state.status = status;
  state.boxes = new Map();
  state.rows = new Map();
  state.journal = [];
  state.cache = new Map();
  state.reads = undefined;
  state.parent?.children.delete(state);
  const release = state.release;
  state.release = undefined;
  release?.();
};

// Reading through the chain of overlays

/** Records a read of the realm's `box`, when the stage's root checks conflicts. */
const recordRead = (state: StageState, box: BoxCell<unknown>, observable: object): void => {
  const reads = state.reads;
  if (reads !== undefined && !reads.has(box)) {
    reads.set(box, { version: box.source.version, observable });
  }
};

/** The stage's value of `box`: its own overlay's, an ancestor's, or the realm's. */
const boxValue = <Value>(state: StageState, box: BoxCell<Value>, record: boolean): Value => {
  const key = box as BoxCell<unknown>;
  for (let stage: StageState | undefined = state; stage !== undefined; stage = stage.parent) {
    if (stage.boxes.has(key)) {
      return stage.boxes.get(key) as Value;
    }
  }
  if (record) {
    recordRead(state, key, collectionOfOrder.get(box) ?? box);
  }
  return peekCell(box.source);
};

/** The stage's rows of `collection`: its own, an ancestor's, or the ones the realm holds. */
const rowsOf = <Key, Value>(
  state: StageState,
  collection: KeyedCollection<Key, Value>,
  record: boolean,
): ReadonlyMap<Key, Value> => {
  const key = collection as KeyedCollection<unknown, unknown>;
  for (let stage: StageState | undefined = state; stage !== undefined; stage = stage.parent) {
    const rows = stage.rows.get(key);
    if (rows !== undefined) {
      return rows as Map<Key, Value>;
    }
  }
  if (record) {
    recordRead(state, collection.changesCell as BoxCell<unknown>, collection);
    recordRead(state, collection.orderCell as BoxCell<unknown>, collection);
  }
  return collection.heldRows();
};

/** The highest revision along the chain: a child's cache is stale when an ancestor wrote. */
const chainRevision = (state: StageState): number => {
  let highest = 0;
  for (let stage: StageState | undefined = state; stage !== undefined; stage = stage.parent) {
    if (stage.revision > highest) {
      highest = stage.revision;
    }
  }
  return highest;
};

/**
 * A computed value as the stage sees it. A collection's `rows` and `row` read
 * the stage's rows; any other computed value runs its own function against
 * the stage's `read`, outside the graph, so it starts no `onObserved` source
 * and caches nothing in the realm. The result is cached on the stage until
 * the stage, an ancestor, or the realm changes.
 */
const evaluate = (state: StageState, read: Read, computed: ComputedValue<unknown>): unknown => {
  const tag = collectionReads.get(computed);
  if (tag !== undefined) {
    const rows = rowsOf(state, tag.collection, true);
    if (!tag.all) {
      return rows.get(tag.key);
    }
    return boxValue(state, tag.collection.orderCell, true).map((key) => rows.get(key));
  }
  const clock = state.realm.core.clock;
  const revision = chainRevision(state);
  if (state.cacheClock !== clock || state.cacheRevision !== revision) {
    state.cache.clear();
    state.cacheClock = clock;
    state.cacheRevision = revision;
  }
  const cache = state.cache;
  if (cache.has(computed)) {
    return cache.get(computed);
  }
  if (state.evaluating.has(computed)) {
    throw new Error(
      `pinna: ${describeSource(computed.source)} is read while a stage evaluates it (cycle)`,
    );
  }
  const compute = (computed.source as unknown as { readonly compute: (read: Read) => unknown })
    .compute;
  state.evaluating.add(computed);
  let value: unknown;
  try {
    value = compute(read);
  } finally {
    state.evaluating.delete(computed);
  }
  cache.set(computed, value);
  return value;
};

const ownRealm = (
  state: StageState,
  verb: string,
  observable: { readonly realm?: ObservableRealm; readonly source?: unknown },
): void => {
  if (observable.realm !== state.realm) {
    throw otherRealmError(
      verb,
      observable.source as Parameters<typeof otherRealmError>[1],
      observable.realm as ObservableRealm,
      state.realm,
    );
  }
};

/** The `read` a stage hands out: its own value of everything it wrote, the realm's of the rest. */
const stageReader = (state: StageState, session: Session): Read => {
  function read<Value>(observable: Computed<Value>): Value;
  function read(atom: Atom): undefined;
  function read(observable: Computed<unknown> | Atom): unknown {
    if (!session.open) {
      throw keptError("read");
    }
    const cell = observable as unknown as { readonly realm: ObservableRealm };
    ownRealm(state, "read", cell);
    if (cell instanceof BoxCell) {
      return boxValue(state, cell, true);
    }
    if (cell instanceof AtomCell) {
      return undefined;
    }
    return evaluate(state, reader, cell as unknown as ComputedValue<unknown>);
  }
  const row = <Key, Value>(collection: Collection<Key, Value>, key: Key): Value | undefined => {
    if (!session.open) {
      throw keptError("read.row");
    }
    ownRealm(state, "read.row", collection as unknown as { readonly realm: ObservableRealm });
    return rowsOf(state, collection as unknown as KeyedCollection<Key, Value>, true).get(key);
  };
  const reader: Read = Object.assign(read, { row });
  return reader;
};

// Writing to the overlay

const changedOverlay = (state: StageState): void => {
  state.revision = ++revisions;
};

/** Puts `value` in this stage's overlay for `box`, and keeps what it replaced for the undo. */
const setBox = (
  state: StageState,
  session: Session,
  box: BoxCell<unknown>,
  value: unknown,
): void => {
  const boxes = state.boxes;
  const had = boxes.has(box);
  const prior = boxes.get(box);
  session.undo.push(() => {
    if (had) {
      boxes.set(box, prior);
    } else {
      boxes.delete(box);
    }
  });
  boxes.set(box, value);
  changedOverlay(state);
};

/** The rows of `collection` this stage changes: copied from the chain or the realm on its first write. */
const stagedRows = <Key, Value>(
  state: StageState,
  session: Session,
  collection: KeyedCollection<Key, Value>,
): StagedRows<Key, Value> => {
  const key = collection as KeyedCollection<unknown, unknown>;
  const orderCell = collection.orderCell as BoxCell<unknown>;
  const own = (): Map<Key, Value> => {
    let rows = state.rows.get(key) as Map<Key, Value> | undefined;
    if (rows === undefined) {
      rows = new Map(rowsOf(state, collection, false));
      // The order is held with the rows, so the two never disagree.
      if (!state.boxes.has(orderCell)) {
        setBox(state, session, orderCell, boxValue(state, collection.orderCell, false));
      }
      state.rows.set(key, rows as Map<unknown, unknown>);
      session.undo.push(() => {
        state.rows.delete(key);
      });
    }
    return rows;
  };
  return {
    get rows() {
      return rowsOf(state, collection, false);
    },
    get order() {
      return boxValue(state, collection.orderCell, false);
    },
    setRow(rowKey, row) {
      const rows = own();
      const had = rows.has(rowKey);
      const prior = rows.get(rowKey);
      session.undo.push(() => {
        if (had) {
          rows.set(rowKey, prior as Value);
        } else {
          rows.delete(rowKey);
        }
      });
      rows.set(rowKey, row);
      changedOverlay(state);
    },
    deleteRow(rowKey) {
      const rows = own();
      const prior = rows.get(rowKey) as Value;
      session.undo.push(() => {
        rows.set(rowKey, prior);
      });
      rows.delete(rowKey);
      changedOverlay(state);
    },
    setOrder(order) {
      own();
      setBox(state, session, orderCell, order);
    },
    setAll(rows, order) {
      own();
      const prior = state.rows.get(key);
      session.undo.push(() => {
        state.rows.set(key, prior as Map<unknown, unknown>);
      });
      state.rows.set(key, rows as Map<unknown, unknown>);
      setBox(state, session, orderCell, order);
    },
  };
};

/** The `write` a stage hands out: boxes, collections, and atoms. */
const stageWriter = (state: StageState, session: Session, reader: Read): Write => {
  const open = (verb: string): void => {
    if (!session.open) {
      throw keptError(verb);
    }
    if (!session.writable) {
      throw new Error(
        `pinna: ${verb} runs in stageRead, which writes nothing; write in stageUpdate`,
      );
    }
  };
  const ownBox = <Value>(verb: string, box: Box<Value>): BoxCell<Value> => {
    open(verb);
    const cell = box as BoxCell<Value>;
    ownRealm(state, verb, cell);
    return cell;
  };
  const ownCollection = <Key, Value>(
    verb: string,
    collection: Collection<Key, Value>,
  ): KeyedCollection<Key, Value> => {
    open(verb);
    ownRealm(state, verb, collection as unknown as { readonly realm: ObservableRealm });
    return collection as unknown as KeyedCollection<Key, Value>;
  };
  const writeValue = <Value>(cell: BoxCell<Value>, value: Value): void => {
    const current = boxValue(state, cell, false);
    if (Object.is(value, current)) {
      return;
    }
    cell.verify(value, current);
    setBox(state, session, cell as BoxCell<unknown>, value);
  };
  const writeBox = <Value>(box: Box<Value>, value: Value): undefined => {
    writeValue(ownBox("write", box), value);
    return undefined;
  };
  const writer: Write = Object.assign(writeBox, {
    modify: <Value>(box: Box<Value>, recipe: (draft: Draft<Value>) => undefined): undefined => {
      const cell = ownBox("write.modify", box);
      // Drafted from the stage's value: a draft of the realm's would change it in place.
      writeValue(cell, produce(boxValue(state, cell, false), recipe));
      return undefined;
    },
    upsert: <Key, Value>(
      collection: Collection<Key, Value>,
      value: Value,
      options?: UpsertOptions,
    ): undefined => {
      const keyed = ownCollection("write.upsert", collection);
      keyed.stagedUpsert(stagedRows(state, session, keyed), value, options, reader, writer);
      return undefined;
    },
    remove: <Key, Value>(collection: Collection<Key, Value>, key: Key): undefined => {
      const keyed = ownCollection("write.remove", collection);
      keyed.stagedRemove(stagedRows(state, session, keyed), key, reader, writer);
      return undefined;
    },
    replaceAll: <Key, Value>(
      collection: Collection<Key, Value>,
      values: ReadonlyArray<Value>,
    ): undefined => {
      const keyed = ownCollection("write.replaceAll", collection);
      keyed.stagedReplace(stagedRows(state, session, keyed), values, reader, writer);
      return undefined;
    },
    // An atom holds no value to stage: the replay reruns what observed it.
    changed: (atom: Atom): undefined => {
      open("write.changed");
      ownRealm(state, "write.changed", atom as unknown as { readonly realm: ObservableRealm });
      return undefined;
    },
  }) as Write;
  return writer;
};

/** Puts back what a failed session wrote to the overlay, the last first. */
const undoSession = (state: StageState, session: Session): void => {
  const undo = session.undo;
  for (let index = undo.length - 1; index >= 0; index--) {
    (undo[index] as () => void)();
  }
  changedOverlay(state);
};

/**
 * Runs `run` as a stage's place: untracked, with the realm's own `read`,
 * `write`, `update`, watches, and new observables refused, and the stage's
 * `read` and `write` where a merge looks for them.
 */
const asPlace = <Result>(state: StageState, place: Place, run: () => Result): Result => {
  const realm = state.realm;
  const core = realm.core;
  const active = core.active;
  const deriving = core.deriving;
  const openDepth = realm.openDepth;
  const stagedPlace = realm.stagedPlace;
  core.active = undefined;
  core.deriving = stageMarker;
  realm.openDepth = 0;
  realm.stagedPlace = place;
  try {
    return run();
  } finally {
    core.active = active;
    core.deriving = deriving;
    realm.openDepth = openDepth;
    realm.stagedPlace = stagedPlace;
  }
};

/** Marks an async recipe's rejection handled: `stageUpdate` has thrown for it already. */
const ignore = (): void => {};

/**
 * Runs `recipes` against `state` as one session, and keeps them: all of them,
 * or, when one throws, none, with the overlay as it was.
 */
const runRecipes = (state: StageState, recipes: ReadonlyArray<Recipe>): void => {
  const session: Session = { open: true, writable: true, undo: [] };
  const read = stageReader(state, session);
  const write = stageWriter(state, session, read);
  try {
    asPlace(state, { read, write }, () => {
      for (const recipe of recipes) {
        const result: unknown = recipe(read, write);
        if (result !== undefined) {
          if (typeof (result as { readonly then?: unknown }).then === "function") {
            (result as PromiseLike<unknown>).then(undefined, ignore);
            throw new Error(
              "pinna: stageUpdate recipes are synchronous; await outside, then stageUpdate",
            );
          }
          throw new Error("pinna: a stageUpdate recipe returns nothing");
        }
      }
    });
  } catch (error) {
    undoSession(state, session);
    throw error;
  } finally {
    session.open = false;
  }
  for (const recipe of recipes) {
    state.journal.push(recipe);
  }
};

// The calls

/**
 * A new stage, holding nothing. Over a realm, `applyStage` lands it in the
 * realm; over another stage, a child, `applyStage` replays it into that
 * stage, and dropping the parent drops it. A stage neither applied nor
 * dropped holds its overlay until it is collected; under `testRealm`, the
 * realm's dispose reports it.
 */
export const openStage = (over: Realm | Stage, options?: StageOptions): Stage => {
  checkName(options?.name);
  let state: StageState;
  if (over instanceof StageState) {
    const parent = openState(over, "openStage");
    if (options?.conflicts !== undefined) {
      throw new Error(
        "pinna: a child stage takes no conflicts option; its root stage checks what the child read",
      );
    }
    state = new StageState(parent.realm, parent, options?.name, parent.conflicts);
    parent.children.add(state);
  } else {
    const realm = over as ObservableRealm;
    assertNotInRecipe(realm, "openStage");
    state = new StageState(realm, undefined, options?.name, options?.conflicts ?? "replay");
  }
  const running = state.realm.running;
  // Under testRealm alone: an application's realm keeps no record of its stages.
  if (running !== undefined) {
    state.release = running(state.name === undefined ? "stage" : `stage "${state.name}"`, () =>
      close(state, "dropped"),
    );
  }
  return state;
};

/**
 * Runs `recipe` at once against the stage, and keeps it for `applyStage`.
 * Its `read` sees the stage's own writes, and the realm's current values
 * elsewhere; its `write` writes the stage, through each box's and
 * collection's check. A recipe that throws puts back what it wrote to the
 * stage, is not kept, and its error is rethrown; one that returns a promise
 * throws at once. Throws where `update` would: in a computed value, a
 * watch's select, or a selector.
 */
export const stageUpdate = (stage: Stage, recipe: Recipe): void => {
  const state = openState(stage, "stageUpdate");
  assertUpdateCanRun(state.realm, "stageUpdate");
  runRecipes(state, [recipe]);
};

/**
 * What `run` returns, reading through the stage: its own writes, and the
 * realm's current values elsewhere. Not a snapshot: what the stage did not
 * write can change between two calls. Untracked, so it throws in a computed
 * value, a watch's select, or a selector.
 */
export const stageRead = <Result>(stage: Stage, run: (read: Read) => Result): Result => {
  const state = openState(stage, "stageRead");
  assertReadCanRun(state.realm, "stageRead");
  const session: Session = { open: true, writable: false, undo: [] };
  const read = stageReader(state, session);
  try {
    return asPlace(state, { read, write: stageWriter(state, session, read) }, () => run(read));
  } finally {
    session.open = false;
  }
};

/**
 * What `run` returns, reading the realm's values, as `untracked` does: the
 * stage is ignored, so the work compares the stage with the realm. Throws
 * where `stageRead` does.
 */
export const realmRead = <Result>(stage: Stage, run: (read: Read) => Result): Result => {
  const state = openState(stage, "realmRead");
  const realm = state.realm;
  assertReadCanRun(realm, "realmRead");
  const session = { open: true };
  try {
    return untracked(realm, (realmReader) => {
      function read<Value>(observable: Computed<Value>): Value;
      function read(atom: Atom): undefined;
      function read(observable: Computed<unknown> | Atom): unknown {
        if (!session.open) {
          throw keptError("read");
        }
        return realmReader(observable as Computed<unknown>);
      }
      const row = <Key, Value>(collection: Collection<Key, Value>, key: Key): Value | undefined => {
        if (!session.open) {
          throw keptError("read.row");
        }
        return realmReader.row(collection, key);
      };
      return run(Object.assign(read, { row }));
    });
  } finally {
    session.open = false;
  }
};

/**
 * Closes the stage and replays its recipes, in order.
 *
 * Over a realm, the replay is one `update` over the realm's values at this
 * moment, nested in an update already open: when a recipe throws on replay,
 * or a write a check refuses, only the stage's writes roll back, the error
 * reaches the caller, and the caller's update keeps its own writes if it
 * catches it. With `{ conflicts: "fail" }`, a box or collection the stage
 * read that changed since throws a `StageConflictError` first, and nothing
 * lands. Throws where `update` would, and leaves the stage open then.
 *
 * Over a parent stage, the replay runs against the parent, as one
 * `stageUpdate` of every recipe: a throw leaves the parent as it was. The
 * parent keeps the recipes, and what the child read, for its own apply.
 *
 * The stage ends `"applied"`, or `"dropped"` when the replay throws. A stage
 * with an open child throws: apply or drop the child first.
 */
export const applyStage = (stage: Stage): void => {
  const state = openState(stage, "applyStage");
  assertUpdateCanRun(state.realm, "applyStage");
  if (state.children.size > 0) {
    throw new Error(
      `pinna: applyStage runs on ${describeStage(state)} while a child stage of it is open; apply or drop the child first`,
    );
  }
  const journal = state.journal;
  const parent = state.parent;
  if (parent !== undefined) {
    try {
      runRecipes(parent, journal);
    } catch (error) {
      close(state, "dropped");
      throw error;
    }
    const reads = state.reads;
    if (reads !== undefined && parent.reads !== undefined) {
      for (const [box, read] of reads) {
        if (!parent.reads.has(box)) {
          parent.reads.set(box, read);
        }
      }
    }
    close(state, "applied");
    return;
  }
  const realm = state.realm;
  const reads = state.reads;
  if (reads !== undefined) {
    const changed: Array<string> = [];
    const observables: Array<object> = [];
    for (const [box, read] of reads) {
      if (box.source.version !== read.version && !observables.includes(read.observable)) {
        observables.push(read.observable);
        changed.push(
          read.observable instanceof KeyedCollection ? "a collection" : nameOf(box.source),
        );
      }
    }
    if (changed.length > 0) {
      close(state, "dropped");
      throw new StageConflictError(state.name, changed, observables);
    }
  }
  close(state, "applied");
  if (journal.length === 0) {
    return;
  }
  try {
    update(realm, () => {
      // Each recipe in a nested update: it joins this one, and is held to
      // what `update` holds a recipe to.
      for (const recipe of journal) {
        update(realm, recipe);
      }
    });
  } catch (error) {
    state.status = "dropped";
    throw error;
  }
};

/**
 * Closes the stage, and its open children, and discards what they hold. No
 * box changes and no watcher runs. A stage already closed is left as it is,
 * so a cleanup drops whether or not the work applied.
 */
export const dropStage = (stage: Stage): void => {
  const state = stage as StageState;
  if (state.status !== "open") {
    return;
  }
  close(openState(stage, "dropStage"), "dropped");
};

/** Where the stage is in its life: `"open"`, `"applied"`, or `"dropped"`. */
export const stageStatus = (stage: Stage): StageStatus => (stage as StageState).status;

/** The stage's name, realm, parent, status, and what it holds now. */
export const inspectStage = (stage: Stage): StageInspection => {
  const state = stage as StageState;
  const orders = new Set<BoxCell<unknown>>();
  for (const collection of state.rows.keys()) {
    orders.add(collection.orderCell as BoxCell<unknown>);
  }
  const boxes: Array<string> = [];
  for (const box of state.boxes.keys()) {
    if (!orders.has(box)) {
      boxes.push(nameOf(box.source));
    }
  }
  return {
    name: state.name,
    realm: state.realm.name,
    parent: state.parent === undefined ? undefined : (state.parent.name ?? "<anonymous>"),
    status: state.status,
    conflicts: state.conflicts,
    boxes,
    collections: state.rows.size,
    recipes: state.journal.length,
    children: state.children.size,
  };
};
