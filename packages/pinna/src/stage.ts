/**
 * Stages: the writes of asynchronous work, landed in one update when it
 * succeeds or dropped when it fails. Until then no box changes, so nothing
 * renders a half-done result and nothing needs undoing.
 *
 * A stage is an overlay and a journal. The overlay holds a value for each box
 * the stage wrote, and only those; the journal holds the recipes in the order
 * they ran. `stageUpdate` runs its recipe at once against the stage's `read`
 * and `write` to fill the overlay, and keeps the recipe. `applyStage` replays
 * the journal in one `update` over the realm's values at that moment, and
 * joins an `update` already open. `dropStage` discards both. Nothing copies
 * the realm, a stage makes no graph node, and its values are not observable.
 *
 * Every call takes the stage first, as `update` takes the realm: the realm
 * keeps no current stage, so `update` and `read` pay nothing for stages.
 * A stage reads and writes boxes; a computed value, a collection write, and
 * an atom's `changed` throw through it.
 */
import { peekCell } from "@frondruntime/pinna-core";
import {
  type Atom,
  AtomCell,
  assertUpdateCanRun,
  type Box,
  BoxCell,
  type Collection,
  type Computed,
  type Draft,
  describeSource,
  type ObservableRealm,
  otherRealmError,
  produce,
  type Read,
  type Realm,
  untracked,
  update,
  type Write,
} from "./observable.ts";

declare const stageBrand: unique symbol;

/**
 * Writes held back from the realm until `applyStage` lands them in one
 * update, or `dropStage` discards them. Made by `openStage`; closes once.
 */
export interface Stage {
  readonly [stageBrand]: true;
}

type Recipe = (read: Read, write: Write) => undefined;

/** Marks an async recipe's rejection handled: `stageUpdate` has thrown for it already. */
const ignore = (): void => {};

class StageState implements Stage {
  declare readonly [stageBrand]: true;
  readonly realm: ObservableRealm;
  /** The value of each box the stage wrote. */
  overlay = new Map<BoxCell<unknown>, unknown>();
  /** The recipes that ran without throwing, in order. */
  journal: Array<Recipe> = [];
  open = true;
  /** True while one of its recipes runs: a call on the stage there throws. */
  running = false;
  /** Set under `testRealm` only: tells it the stage closed. */
  release: (() => void) | undefined = undefined;

  constructor(realm: ObservableRealm) {
    this.realm = realm;
  }
}

/**
 * What a recipe or a read function was handed is good while it runs: `undo`
 * lists the overlay entries a recipe replaced, three slots a write (the box,
 * whether the overlay held it, and the value it held).
 */
interface Session {
  open: boolean;
  readonly undo: Array<unknown> | undefined;
}

const closedError = (call: string): Error =>
  new Error(
    `pinna: ${call} runs on a stage that was already applied or dropped; open a new one with openStage`,
  );

const keptError = (verb: string): Error =>
  new Error(
    `pinna: ${verb} of a stage runs after its recipe returned; read and write inside the recipe`,
  );

const refusedWrite = (verb: string): Error =>
  new Error(
    `pinna: ${verb} does not run in a stage, which writes boxes only; write it in update, or in a watch after applyStage`,
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

/** The stage behind `stage`, open and not running one of its recipes. */
const openState = (stage: Stage, call: string): StageState => {
  const state = stage as StageState;
  if (!state.open) {
    throw closedError(call);
  }
  if (state.running) {
    throw new Error(`pinna: ${call} runs inside a recipe of the same stage`);
  }
  return state;
};

/** Closes the stage once, and lets go of what it held. */
const close = (state: StageState): void => {
  if (!state.open) {
    return;
  }
  state.open = false;
  state.overlay = new Map();
  state.journal = [];
  const release = state.release;
  state.release = undefined;
  release?.();
};

/** The staged value of `box`, or the realm's when the stage did not write it. */
const stagedValue = <Value>(state: StageState, box: BoxCell<Value>): Value => {
  const overlay = state.overlay;
  return overlay.has(box as BoxCell<unknown>)
    ? (overlay.get(box as BoxCell<unknown>) as Value)
    : peekCell(box.source);
};

const ownRealm = (
  state: StageState,
  verb: string,
  observable: { readonly realm: ObservableRealm; readonly source?: unknown },
): void => {
  if (observable.realm !== state.realm) {
    throw otherRealmError(
      verb,
      observable.source as Parameters<typeof otherRealmError>[1],
      observable.realm,
      state.realm,
    );
  }
};

/** The `read` a stage hands out: the overlay's value of a box it wrote, the realm's of the rest. */
const stageReader = (state: StageState, session: Session): Read => {
  function read<Value>(observable: Computed<Value>): Value;
  function read(atom: Atom): undefined;
  function read(observable: Computed<unknown> | Atom): unknown {
    if (!session.open) {
      throw keptError("read");
    }
    const cell = observable as unknown as {
      readonly realm: ObservableRealm;
      readonly source: Parameters<typeof describeSource>[0];
    };
    ownRealm(state, "read", cell);
    if (cell instanceof BoxCell) {
      return stagedValue(state, cell);
    }
    if (cell instanceof AtomCell) {
      return undefined;
    }
    throw new Error(
      `pinna: read(${describeSource(cell.source)}) of a computed value does not run through a stage, which holds no computed value over its staged boxes; read the boxes, or the realm's value with realmRead`,
    );
  }
  const row = <Key, Value>(collection: Collection<Key, Value>, key: Key): Value | undefined => {
    if (!session.open) {
      throw keptError("read.row");
    }
    const reader = collection as unknown as {
      readonly realm: ObservableRealm;
      heldRow(key: Key): Value | undefined;
    };
    ownRealm(state, "read.row", reader);
    // No collection write is staged, so the realm's row is the stage's.
    return reader.heldRow(key);
  };
  return Object.assign(read, { row });
};

/** Writes `value` to the overlay, through the box's check, and keeps what it replaced. */
const stageWrite = <Value>(
  state: StageState,
  session: Session,
  box: BoxCell<Value>,
  value: Value,
): void => {
  const current = stagedValue(state, box);
  if (Object.is(value, current)) {
    return;
  }
  box.verify(value, current);
  const overlay = state.overlay;
  const key = box as BoxCell<unknown>;
  (session.undo as Array<unknown>).push(key, overlay.has(key), overlay.get(key));
  overlay.set(key, value);
};

/** The `write` a stage hands out: boxes only. */
const stageWriter = (state: StageState, session: Session): Write => {
  const ownBox = <Value>(verb: string, box: Box<Value>): BoxCell<Value> => {
    if (!session.open) {
      throw keptError(verb);
    }
    const cell = box as BoxCell<Value>;
    ownRealm(state, verb, cell);
    return cell;
  };
  const refuse = (verb: string) => (): undefined => {
    if (!session.open) {
      throw keptError(verb);
    }
    throw refusedWrite(verb);
  };
  const writeBox = <Value>(box: Box<Value>, value: Value): undefined => {
    stageWrite(state, session, ownBox("write", box), value);
    return undefined;
  };
  return Object.assign(writeBox, {
    modify: <Value>(box: Box<Value>, recipe: (draft: Draft<Value>) => undefined): undefined => {
      const cell = ownBox("write.modify", box);
      stageWrite(state, session, cell, produce(stagedValue(state, cell), recipe));
      return undefined;
    },
    upsert: refuse("write.upsert"),
    remove: refuse("write.remove"),
    replaceAll: refuse("write.replaceAll"),
    changed: refuse("write.changed"),
  }) as Write;
};

/** Puts back the overlay entries a failed recipe replaced, the last first. */
const undoWrites = (state: StageState, undo: Array<unknown>): void => {
  const overlay = state.overlay;
  for (let index = undo.length - 3; index >= 0; index -= 3) {
    const box = undo[index] as BoxCell<unknown>;
    if (undo[index + 1] === true) {
      overlay.set(box, undo[index + 2]);
    } else {
      overlay.delete(box);
    }
  }
};

/**
 * A new stage over `realm`, holding nothing. A stage neither applied nor
 * dropped holds its overlay until it is collected; under `testRealm`, the
 * realm's dispose reports it.
 */
export const openStage = (realm: Realm): Stage => {
  const owner = realm as ObservableRealm;
  const state = new StageState(owner);
  // Under testRealm alone: an application's realm keeps no record of its stages.
  if (owner.running !== undefined) {
    state.release = owner.running("stage", () => close(state));
  }
  return state;
};

/**
 * Runs `recipe` at once against the stage, and keeps it for `applyStage`.
 * Its `read` returns the stage's value of a box the stage wrote and the
 * realm's current value of any other; its `write` writes boxes alone, each
 * through the box's check. A recipe that throws puts back what it wrote to
 * the stage, is not kept, and its error is rethrown; one that returns a
 * promise throws at once. Throws where `update` would: in a computed value,
 * a watch's select, or a selector.
 */
export const stageUpdate = (
  stage: Stage,
  recipe: (read: Read, write: Write) => undefined,
): void => {
  const state = openState(stage, "stageUpdate");
  const realm = state.realm;
  assertUpdateCanRun(realm, "stageUpdate");
  const session: Session = { open: true, undo: [] };
  // Untracked, as `update` is in an autorun's body.
  const core = realm.core;
  const active = core.active;
  core.active = undefined;
  state.running = true;
  try {
    const result: unknown = recipe(stageReader(state, session), stageWriter(state, session));
    if (result !== undefined) {
      if (typeof (result as { readonly then?: unknown }).then === "function") {
        (result as PromiseLike<unknown>).then(undefined, ignore);
        throw new Error(
          "pinna: stageUpdate recipes are synchronous; await outside, then stageUpdate",
        );
      }
      throw new Error("pinna: a stageUpdate recipe returns nothing");
    }
  } catch (error) {
    undoWrites(state, session.undo as Array<unknown>);
    throw error;
  } finally {
    session.open = false;
    state.running = false;
    core.active = active;
  }
  state.journal.push(recipe);
};

/**
 * What `run` returns, reading through the stage: the stage's value of a box
 * it wrote, the realm's current value of any other. Not a snapshot: a box
 * the stage did not write can change between two calls. Untracked, so it
 * throws in a computed value, a watch's select, or a selector.
 */
export const stageRead = <Result>(stage: Stage, run: (read: Read) => Result): Result => {
  const state = openState(stage, "stageRead");
  assertReadCanRun(state.realm, "stageRead");
  const session: Session = { open: true, undo: undefined };
  try {
    return run(stageReader(state, session));
  } finally {
    session.open = false;
  }
};

/**
 * What `run` returns, reading the realm's values, as `untracked` does: the
 * overlay is ignored, so the work compares the stage with the realm without
 * holding the realm. Throws where `stageRead` does.
 */
export const realmRead = <Result>(stage: Stage, run: (read: Read) => Result): Result => {
  const state = openState(stage, "realmRead");
  const realm = state.realm;
  assertReadCanRun(realm, "realmRead");
  const session: Session = { open: true, undo: undefined };
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
 * Closes the stage and replays its recipes, in order, in one `update` over
 * the realm's values at this moment: a recipe that read a box another update
 * changed since reads the new value, and nothing detects the conflict.
 * Inside an open `update` of the realm it joins that update, so watchers see
 * its writes and the outer recipe's together. A recipe that throws on replay,
 * or a write a box's check refuses, throws here and rolls back the update it
 * joined; the stage is closed either way. Throws where `update` would, and
 * leaves the stage open then.
 */
export const applyStage = (stage: Stage): void => {
  const state = openState(stage, "applyStage");
  const realm = state.realm;
  assertUpdateCanRun(realm, "applyStage");
  const journal = state.journal;
  close(state);
  if (journal.length === 0) {
    return;
  }
  update(realm, () => {
    // Each recipe in a nested update: it joins this one, and is held to
    // what `update` holds a recipe to.
    for (const recipe of journal) {
      update(realm, recipe);
    }
  });
};

/** Closes the stage and discards what it holds. No box changes and no watcher runs. */
export const dropStage = (stage: Stage): void => {
  close(openState(stage, "dropStage"));
};
