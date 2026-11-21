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
 * `applyStage` replays the journal into a fresh overlay over the realm's
 * values at that moment, under the same recipe guard. It then lands the
 * overlay's final values and atom marks in one `update`, nested in an update
 * already open, without calling user code in the landing recipe. A child
 * stage, opened over a stage, replays into its parent instead: a savepoint.
 * `dropStage` discards a stage and its open children.
 *
 * A recipe runs once when staged and once per apply through its parents to
 * the realm, so it is a function of its `read`: while it runs, the realm's
 * own `read`, `write`, `update`, a watch, and making an observable all throw.
 * The core's `deriving` slot
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
  produce,
  type Read,
  type Realm,
  type Recipe,
  type StagedPlace,
  stageMarker,
  type UpsertOptions,
  untracked,
  update,
  updateRefused,
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
  /** The collections this stage wrote, by name; an unnamed one is `"a collection"`. */
  readonly collections: ReadonlyArray<string>;
  /**
   * What this stage read from the realm and `applyStage` checks, by name:
   * filled only under `{ conflicts: "fail" }`, empty otherwise.
   */
  readonly read: ReadonlyArray<string>;
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
  /** The name of each box or collection that changed: `"<anonymous>"` for an unnamed box, `"a collection"` for an unnamed collection. */
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

/** How a stage's reports name a box or a collection. */
const describeRead = (observable: object, box: BoxCell<unknown>): string =>
  observable instanceof KeyedCollection
    ? ((observable as KeyedCollection<unknown, unknown>).name ?? "a collection")
    : nameOf(box.source);

/** A version the stage read, and what to report when it changed. */
interface ReadVersion {
  readonly version: number;
  readonly observable: object;
}

/** The realm versions a row copy came from, and the keys the stage chain replaced. */
interface CollectionProvenance {
  readonly changes: number;
  readonly order: number;
  readonly written: Set<unknown>;
}

/** A computed result, including a thrown value, kept until the overlay or realm changes. */
interface CachedResult {
  readonly failed: boolean;
  readonly value: unknown;
}

class StageState implements Stage {
  declare readonly [stageBrand]: true;
  readonly realm: ObservableRealm;
  readonly parent: StageState | undefined;
  /** The stage over the realm at the top of the chain: it numbers the chain's revisions. */
  readonly root: StageState;
  /** The last revision the root handed out; read on the root alone. */
  revisions = 0;
  readonly name: string | undefined;
  readonly conflicts: "replay" | "fail";
  /** The value of each box this stage wrote, a collection's key order among them. */
  boxes = new Map<BoxCell<unknown>, unknown>();
  /** The rows of each collection this stage wrote, copied on its first write. */
  rows = new Map<KeyedCollection<unknown, unknown>, Map<unknown, unknown>>();
  /** Keys written in this overlay, including removed keys: landing visits these alone. */
  rowWrites = new Map<KeyedCollection<unknown, unknown>, Set<unknown>>();
  /** A removed row no longer uses its realm cell's write-back value during replay. */
  rowRemovals = new Map<KeyedCollection<unknown, unknown>, Set<unknown>>();
  atoms = new Set<AtomCell>();
  provenance = new Map<KeyedCollection<unknown, unknown>, CollectionProvenance>();
  /** The recipes that ran without throwing, in order. */
  journal: Array<Recipe> = [];
  status: StageStatus = "open";
  readonly children = new Set<StageState>();
  /** Set from the root's count by each write to this overlay, so a cache knows its chain changed. */
  revision = 0;
  /** Computed values evaluated through this stage, valid while `cacheClock` and `cacheRevision` hold. */
  cache = new Map<ComputedValue<unknown>, CachedResult>();
  cacheClock = -1;
  cacheRevision = -1;
  readonly evaluating = new Set<ComputedValue<unknown>>();
  /** The innermost computed value running in this chain; held on the root alone. */
  computing: ComputedValue<unknown> | undefined = undefined;
  /** What this stage read from the realm, by box, when its root checks conflicts. */
  reads: Map<BoxCell<unknown>, ReadVersion> | undefined;
  /** Set under `testRealm` only: tells it the stage closed. */
  release: (() => void) | undefined = undefined;

  constructor(
    realm: ObservableRealm,
    parent: StageState | undefined,
    name: string | undefined,
    conflicts: "replay" | "fail",
    readonly replaying = false,
  ) {
    this.realm = realm;
    this.parent = parent;
    this.root = parent === undefined ? this : parent.root;
    this.name = name;
    this.conflicts = conflicts;
    this.reads = conflicts === "fail" ? new Map() : undefined;
  }
}

/**
 * The `read` and `write` handed to one recipe or read function: good while
 * it runs. Replayed recipes share `undo`, which puts back their overlay
 * writes, the last first.
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
  // Where an update is refused, an untracked read inside a derivation included.
  if (updateRefused(realm)) {
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
  state.rowWrites = new Map();
  state.rowRemovals = new Map();
  state.atoms = new Set();
  state.provenance = new Map();
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
const recordRead = (
  state: StageState,
  box: BoxCell<unknown>,
  observable: object,
  version = box.source.version,
): void => {
  const reads = state.reads;
  const held = reads?.get(box);
  if (reads === undefined) return;
  if (held === undefined) {
    reads.set(box, { version, observable });
  } else if (held.version !== version) {
    // Rollback restores earlier versions. Two observed versions cannot
    // both match at apply; NaN matches neither, and keeps the first name.
    reads.set(box, { version: Number.NaN, observable: held.observable });
  }
};

/** The stage's value of `box`: its own overlay's, an ancestor's, or the realm's. */
const boxValue = <Value>(state: StageState, box: BoxCell<Value>, record: boolean): Value => {
  const key = box as BoxCell<unknown>;
  for (let stage: StageState | undefined = state; stage !== undefined; stage = stage.parent) {
    if (stage.boxes.has(key)) {
      if (record) {
        const collection = collectionOfOrder.get(box);
        const provenance = collection === undefined ? undefined : stage.provenance.get(collection);
        if (provenance !== undefined && collection !== undefined) {
          recordRead(state, key, collection, provenance.order);
        }
      }
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
  rowKey?: Key,
  singleRow = false,
): ReadonlyMap<Key, Value> => {
  const key = collection as KeyedCollection<unknown, unknown>;
  for (let stage: StageState | undefined = state; stage !== undefined; stage = stage.parent) {
    const rows = stage.rows.get(key);
    if (rows !== undefined) {
      const provenance = stage.provenance.get(key);
      if (record && provenance !== undefined && !(singleRow && provenance.written.has(rowKey))) {
        recordRead(
          state,
          collection.changesCell as BoxCell<unknown>,
          collection,
          provenance.changes,
        );
        recordRead(state, collection.orderCell as BoxCell<unknown>, collection, provenance.order);
      }
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
  if (tag !== undefined && !tag.all) {
    return rowsOf(state, tag.collection, true, tag.key, true).get(tag.key);
  }
  const clock = state.realm.core.clock;
  const revision = chainRevision(state);
  if (state.cacheClock !== clock || state.cacheRevision !== revision) {
    state.cache.clear();
    state.cacheClock = clock;
    state.cacheRevision = revision;
  }
  const cache = state.cache;
  const cached = cache.get(computed);
  if (cached !== undefined) {
    if (cached.failed) {
      throw cached.value;
    }
    return cached.value;
  }
  if (state.evaluating.has(computed)) {
    throw new Error(
      `pinna: ${describeSource(computed.source)} is read while a stage evaluates it (cycle)`,
    );
  }
  state.evaluating.add(computed);
  const computing = state.root.computing;
  state.root.computing = computed;
  try {
    let value: unknown;
    if (tag !== undefined) {
      const rows = rowsOf(state, tag.collection, true);
      value = boxValue(state, tag.collection.orderCell, true).map((key) => rows.get(key));
    } else {
      const compute = (computed.source as unknown as { readonly compute: (read: Read) => unknown })
        .compute;
      value = compute(read);
    }
    cache.set(computed, { failed: false, value });
    return value;
  } catch (error) {
    cache.set(computed, { failed: true, value: error });
    throw error;
  } finally {
    state.root.computing = computing;
    state.evaluating.delete(computed);
  }
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
    return rowsOf(state, collection as unknown as KeyedCollection<Key, Value>, true, key, true).get(
      key,
    );
  };
  const reader: Read = Object.assign(read, { row });
  return reader;
};

// Writing to the overlay

const changedOverlay = (state: StageState): void => {
  state.revision = ++state.root.revisions;
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
      let ancestor = state.parent;
      while (ancestor !== undefined && !ancestor.rows.has(key)) {
        ancestor = ancestor.parent;
      }
      const inherited = ancestor?.provenance.get(key);
      const provenance =
        ancestor === undefined
          ? {
              changes: collection.changesCell.source.version,
              order: collection.orderCell.source.version,
              written: new Set<unknown>(),
            }
          : inherited === undefined
            ? undefined
            : { ...inherited, written: new Set(inherited.written) };
      if (provenance !== undefined) {
        state.provenance.set(key, provenance);
      }
      // The order is held with the rows, so the two never disagree.
      if (!state.boxes.has(orderCell)) {
        setBox(state, session, orderCell, boxValue(state, collection.orderCell, false));
      }
      state.rows.set(key, rows as Map<unknown, unknown>);
      session.undo.push(() => {
        state.rows.delete(key);
        state.provenance.delete(key);
      });
    }
    return rows;
  };
  const wrote = (rowKey: Key): void => {
    let keys = state.rowWrites.get(key);
    if (keys === undefined) {
      keys = new Set();
      state.rowWrites.set(key, keys);
      session.undo.push(() => {
        state.rowWrites.delete(key);
      });
    }
    if (!keys.has(rowKey)) {
      const written = keys;
      written.add(rowKey);
      session.undo.push(() => {
        written.delete(rowKey);
      });
    }
    const written = state.provenance.get(key)?.written;
    if (written !== undefined && !written.has(rowKey)) {
      session.undo.push(() => {
        written.delete(rowKey);
      });
      written.add(rowKey);
    }
  };
  const removed = (rowKey: Key): void => {
    if (!state.replaying) return;
    let keys = state.rowRemovals.get(key);
    if (keys === undefined) {
      keys = new Set();
      state.rowRemovals.set(key, keys);
      session.undo.push(() => {
        state.rowRemovals.delete(key);
      });
    }
    if (!keys.has(rowKey)) {
      const removals = keys;
      removals.add(rowKey);
      session.undo.push(() => {
        removals.delete(rowKey);
      });
    }
  };
  return {
    get rows() {
      return rowsOf(state, collection, false);
    },
    get order() {
      return boxValue(state, collection.orderCell, false);
    },
    cellValue: state.replaying
      ? (rowKey, cell, value, current) =>
          checkedValue(
            cell,
            current,
            value,
            !state.rowRemovals.get(key)?.has(rowKey),
            state.rowWrites.get(key)?.has(rowKey) ?? false,
          ) as Value
      : undefined,
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
      wrote(rowKey);
      changedOverlay(state);
    },
    deleteRow(rowKey) {
      const rows = own();
      const prior = rows.get(rowKey) as Value;
      session.undo.push(() => {
        rows.set(rowKey, prior);
      });
      rows.delete(rowKey);
      removed(rowKey);
      wrote(rowKey);
      changedOverlay(state);
    },
    setOrder(order) {
      own();
      setBox(state, session, orderCell, order);
    },
    setAll(rows, order, written) {
      // Replaced whole: no copy of the rows held first.
      for (const rowKey of written) {
        wrote(rowKey);
        if (!rows.has(rowKey)) removed(rowKey);
      }
      const prior = state.rows.get(key);
      const provenance = state.provenance.get(key);
      session.undo.push(() => {
        if (prior === undefined) {
          state.rows.delete(key);
        } else {
          state.rows.set(key, prior);
        }
        if (provenance === undefined) {
          state.provenance.delete(key);
        } else {
          state.provenance.set(key, provenance);
        }
      });
      state.rows.set(key, rows as Map<unknown, unknown>);
      state.provenance.delete(key);
      setBox(state, session, orderCell, order);
    },
  };
};

/** The value an overlay write keeps, checked before either equality comparison. */
const checkedValue = <Value>(
  cell: BoxCell<Value>,
  current: Value,
  value: Value,
  replaying: boolean,
  written: boolean,
): Value => {
  if (Object.is(value, current)) return current;
  cell.verify(value, current);
  if (replaying) {
    const recorded = cell.nextRecorded !== undefined;
    if (recorded || written) {
      // An enclosing write supplies the outermost update's original;
      // otherwise the first replay write would record the realm's value.
      const before = recorded ? (cell.valueBefore as Value) : peekCell(cell.source);
      // Before an overlay write, the realm's versions decide whether a
      // write-back is possible. After one, original identity means its
      // version was restored; any other overlay value has a new version.
      const changed = written
        ? !Object.is(current, before)
        : cell.versionBefore !== cell.source.version;
      if (changed && cell.source.equals(before, value)) return before;
    }
  }
  return cell.source.equals(current, value) ? current : value;
};

/** The `write` a stage hands out: boxes, collections, and atoms. */
const stageWriter = (state: StageState, session: Session, reader: Read): Write => {
  const open = (verb: string): void => {
    const computing = state.root.computing;
    if (computing !== undefined) {
      throw new Error(
        `pinna: ${computing.source.label ?? "a computed value"} cannot write while it computes`,
      );
    }
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
    const key = cell as BoxCell<unknown>;
    const kept = checkedValue(cell, current, value, state.replaying, state.boxes.has(key));
    if (!Object.is(kept, current)) setBox(state, session, key, kept);
  };
  const writeBox = <Value>(box: Box<Value>, value: Value): undefined => {
    writeValue(ownBox("write", box), value);
    return undefined;
  };
  const writer: Write = Object.assign(writeBox, {
    modify: <Value>(box: Box<Value>, recipe: (draft: Draft<Value>) => undefined): undefined => {
      const cell = ownBox("write.modify", box);
      // Drafted from the stage's value: a draft of the realm's would change it in place.
      writeValue(cell, produce(boxValue(state, cell, true), recipe));
      return undefined;
    },
    upsert: <Key, Value>(
      collection: Collection<Key, Value>,
      value: Value,
      options?: UpsertOptions,
    ): undefined => {
      const keyed = ownCollection("write.upsert", collection);
      undoOnThrow(state, session, () => {
        keyed.stagedUpsert(stagedRows(state, session, keyed), value, options, reader, writer);
      });
      return undefined;
    },
    remove: <Key, Value>(collection: Collection<Key, Value>, key: Key): undefined => {
      const keyed = ownCollection("write.remove", collection);
      undoOnThrow(state, session, () => {
        keyed.stagedRemove(stagedRows(state, session, keyed), key, reader, writer);
      });
      return undefined;
    },
    replaceAll: <Key, Value>(
      collection: Collection<Key, Value>,
      values: ReadonlyArray<Value>,
    ): undefined => {
      const keyed = ownCollection("write.replaceAll", collection);
      undoOnThrow(state, session, () => {
        keyed.stagedReplace(stagedRows(state, session, keyed), values, reader, writer);
      });
      return undefined;
    },
    // An atom holds no value; a successful replay lands its marks once.
    changed: (atom: Atom): undefined => {
      open("write.changed");
      ownRealm(state, "write.changed", atom as unknown as { readonly realm: ObservableRealm });
      const cell = atom as AtomCell;
      if (!state.atoms.has(cell)) {
        state.atoms.add(cell);
        session.undo.push(() => {
          state.atoms.delete(cell);
        });
      }
      return undefined;
    },
  }) as Write;
  return writer;
};

/** Puts back the overlay writes after a savepoint, the last first. */
const undoSession = (state: StageState, session: Session, savepoint = 0): void => {
  const undo = session.undo;
  for (let index = undo.length - 1; index >= savepoint; index--) {
    (undo[index] as () => void)();
  }
  undo.length = savepoint;
  changedOverlay(state);
};

/** A caught failure undoes the operation and its listeners, leaving earlier writes in place. */
const undoOnThrow = <Result>(state: StageState, session: Session, run: () => Result): Result => {
  const savepoint = session.undo.length;
  try {
    return run();
  } catch (error) {
    undoSession(state, session, savepoint);
    throw error;
  }
};

/**
 * Runs `run` as a stage's place: untracked, with the realm's own `read`,
 * `write`, `update`, watches, and new observables refused, and the stage's
 * `read` and `write` where a merge looks for them.
 */
const asPlace = <Result>(state: StageState, place: StagedPlace, run: () => Result): Result => {
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
 * Runs `recipes` with one undo boundary and a session per recipe: all of
 * them, or none, with the overlay as it was. Root replay prepares its
 * landing under the same guard, with every recipe's handles closed, through
 * a read-only session of its own.
 */
const runRecipes = (
  state: StageState,
  recipes: ReadonlyArray<Recipe>,
  prepare?: () => void,
): void => {
  const boundary: Session = { open: false, writable: false, undo: [] };
  try {
    for (const recipe of recipes) {
      const session: Session = { open: true, writable: true, undo: boundary.undo };
      const read = stageReader(state, session);
      const write = stageWriter(state, session, read);
      try {
        asPlace(
          state,
          { read, write, undoOnThrow: (run) => undoOnThrow(state, session, run) },
          () => {
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
          },
        );
      } finally {
        session.open = false;
      }
    }
    if (prepare !== undefined) {
      // Its own read-only session: merge planning reads through the field
      // codecs, and a recipe's handles are closed by now.
      const session: Session = { open: true, writable: false, undo: boundary.undo };
      const read = stageReader(state, session);
      try {
        asPlace(
          state,
          {
            read,
            write: stageWriter(state, session, read),
            undoOnThrow: (run) => undoOnThrow(state, session, run),
          },
          prepare,
        );
      } finally {
        session.open = false;
      }
    }
  } catch (error) {
    undoSession(state, boundary);
    throw error;
  } finally {
    boundary.undo.length = 0;
  }
  for (const recipe of recipes) {
    state.journal.push(recipe);
  }
};

/**
 * Prepares final values under the recipe guard, including equality with the
 * realm and an enclosing update's starting value. Landing calls no user
 * check or equality: the replay checked every value with the box's check.
 */
const prepareLanding = (state: StageState): (() => void) => {
  const boxes: Array<() => void> = [];
  const rows: Array<() => void> = [];
  const prepareBox = <Value>(box: BoxCell<Value>, value: Value): Value => {
    const current = peekCell(box.source);
    if (Object.is(current, value)) return current;
    let version: number | undefined;
    if (
      box.nextRecorded !== undefined &&
      box.versionBefore !== box.source.version &&
      box.source.equals(box.valueBefore as Value, value)
    ) {
      value = box.valueBefore as Value;
      version = box.versionBefore;
    } else if (box.source.equals(current, value)) {
      return current;
    }
    boxes.push(() => {
      const realm = box.realm;
      if (box.nextRecorded === undefined) {
        realm.recordFirst(box as BoxCell<unknown>, current, box.source.version);
      } else {
        realm.record(box as BoxCell<unknown>, current);
      }
      box.restore(value, version ?? realm.core.nextCellVersion());
    });
    return value;
  };
  for (const [box, value] of state.boxes) prepareBox(box, value);
  for (const [collection, keys] of state.rowWrites) {
    rows.push(
      collection.prepareStageRows(
        state.rows.get(collection) as Map<unknown, unknown>,
        keys,
        prepareBox,
      ),
    );
  }
  return () => {
    for (const land of boxes) land();
    for (const land of rows) land();
    for (const atom of state.atoms) atom.change();
  };
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
  const conflicts = options?.conflicts;
  if (conflicts !== undefined && conflicts !== "replay" && conflicts !== "fail") {
    throw new Error(`pinna: conflicts is "replay" or "fail", not ${JSON.stringify(conflicts)}`);
  }
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
    return asPlace(
      state,
      {
        read,
        write: stageWriter(state, session, read),
        undoOnThrow: (run) => undoOnThrow(state, session, run),
      },
      () => run(read),
    );
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
 * Replays the stage's recipes in order, then closes it and lands their final values.
 *
 * Over a realm, replay runs in a fresh overlay over its current values,
 * under the stage recipe guard. One `update` lands the final values and atom
 * marks without user code in its recipe, nested in an update already open.
 * A replay throw, including a refused write, drops the stage and reaches the
 * caller without changing the realm; the caller's update keeps its own
 * writes if it catches it. With `{ conflicts: "fail" }`, the stage's recorded
 * reads are checked first; a changed box or collection drops the stage and
 * throws `StageConflictError`, landing nothing. Final values equal to the
 * realm's values change no version and notify nobody.
 *
 * Over a parent stage, the replay runs against the parent, as one
 * `stageUpdate` of every recipe: a throw leaves the parent as it was. The
 * parent keeps the recipes, and what the child read, for its own apply.
 *
 * An open child, or a call where `update` is refused, throws and leaves the
 * stage open. Apply or drop the child first. After landing, watch effects
 * and autoruns report errors to `onError`; the stage stays `"applied"`.
 * An enclosing update's rollback undoes the landing and marks the stage
 * `"dropped"`; an empty journal has no landing to undo and stays `"applied"`.
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
    const priorReads = parent.reads === undefined ? undefined : new Map(parent.reads);
    try {
      runRecipes(parent, journal);
    } catch (error) {
      parent.reads = priorReads;
      close(state, "dropped");
      throw error;
    }
    // Replay and the child's earlier decisions must agree on one version.
    const reads = state.reads;
    const parentReads = parent.reads;
    if (reads !== undefined && parentReads !== undefined) {
      for (const [box, read] of reads) {
        recordRead(parent, box, read.observable, read.version);
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
        changed.push(describeRead(read.observable, box));
      }
    }
    if (changed.length > 0) {
      close(state, "dropped");
      throw new StageConflictError(state.name, changed, observables);
    }
  }
  if (journal.length === 0) {
    close(state, "applied");
    return;
  }
  const replay = new StageState(realm, undefined, state.name, "replay", true);
  let land: () => void = () => undefined;
  try {
    runRecipes(replay, journal, () => {
      land = prepareLanding(replay);
    });
  } catch (error) {
    close(replay, "dropped");
    close(state, "dropped");
    throw error;
  }
  close(state, "applied");
  try {
    update(realm, () => {
      realm.recordUndo(() => {
        state.status = "dropped";
      });
      land();
    });
  } finally {
    close(replay, "applied");
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
export const stageStatus = (stage: Stage): StageStatus => {
  const state = stage as StageState;
  assertNotInRecipe(state.realm, "stageStatus");
  return state.status;
};

/**
 * What the stage read and `applyStage` checks, by name, once per box or
 * collection: a collection records two boxes, and two unnamed boxes are two
 * entries.
 */
const readNames = (state: StageState): ReadonlyArray<string> => {
  const names: Array<string> = [];
  const seen = new Set<object>();
  for (const [box, read] of state.reads ?? []) {
    if (!seen.has(read.observable)) {
      seen.add(read.observable);
      names.push(describeRead(read.observable, box));
    }
  }
  return names;
};

/** The stage's name, realm, parent, status, and what it holds now. */
export const inspectStage = (stage: Stage): StageInspection => {
  const state = stage as StageState;
  assertNotInRecipe(state.realm, "inspectStage");
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
    collections: [...state.rows.keys()].map((collection) => collection.name ?? "a collection"),
    read: readNames(state),
    recipes: state.journal.length,
    children: state.children.size,
  };
};
