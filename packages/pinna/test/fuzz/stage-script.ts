import {
  Atom,
  Box,
  Collection,
  Computed,
  type Read,
  Realm,
  type RowChange,
  Stage,
  type UpdateRecipe,
  View,
  type Write,
} from "../../src/index.ts";
import { expectFailedRecipeKeepsNoPatch, expectNothingHeld } from "../rest.ts";
import { Random } from "./random.ts";

/**
 * The property visible stages are built against (ruling 68): a visible stage
 * ends with the values the same stage would end with hidden, and at rest the
 * realm shows what applying every showing stage, bottom first, would land.
 *
 * A seed makes a script of base updates and stage calls over a few boxes, a
 * box with its own `equals`, an atom, and one collection whose keys are
 * `NaN`, `0`, `-0`, `1`, and two objects. The script runs twice, with its
 * stages visible and with them hidden: both end with the same base, stored
 * keys included. With them visible, at every rest point the realm's values
 * equal the oracle's: a scratch realm that starts from the base and applies
 * every showing stage's recipes, bottom first, as hidden stages.
 *
 * Running throughout: a row listener that keeps a sum, an ordered view, a
 * computed total, and an autorun on each of them, on each box, and on the
 * atom. At every rest point each autorun has seen the value shown, runs at
 * most once per update, and a no-op update runs none. An `onError` handler
 * chosen per seed does nothing, updates a box, or drops a stage. Every
 * application function (a recipe, `equals`, the listener, `compare`,
 * `onError`, an autorun, the computed) counts its entries while the stack
 * writes cells raw: none may run then (the install rule, `docs/design.md`,
 * "Visible stages").
 */

const dataBoxes = 3;
/** Boxes no stage writes: a recipe's throw reads them, so staging decides the same either way. */
const controlBoxes = 2;
const objectA = { name: "a" };
const objectB = { name: "b" };
/** Key equality is the Map's: `NaN` is one key, `0` and `-0` are one key. */
export const keys: ReadonlyArray<unknown> = [Number.NaN, 0, -0, 1, objectA, objectB];

export const keyToken = (key: unknown): string => {
  if (key === objectA) return "a";
  if (key === objectB) return "b";
  if (Object.is(key, -0)) return "-0";
  return String(key);
};

/** The view's tie order, one rank per Map key. */
const keyRank = (key: unknown): number => {
  if (key === objectA) return 3;
  if (key === objectB) return 4;
  if (Number.isNaN(key)) return 0;
  return key === 0 ? 1 : 2;
};

interface Row {
  readonly id: unknown;
  readonly value: number;
}

/** The box with its own `equals`: values in one pair (0 and 1, 2 and 3, ...) are equal. */
interface Pair {
  readonly n: number;
}
const pairOf = (value: Pair): number => Math.floor(value.n / 2);

/** A recipe as data, so the oracle can run it again. */
export type RecipeSpec =
  | { readonly kind: "add"; readonly box: number; readonly by: number }
  | { readonly kind: "set"; readonly box: number; readonly value: number }
  | { readonly kind: "copy"; readonly from: number; readonly to: number }
  | { readonly kind: "upsert"; readonly key: number; readonly value: number; readonly end: boolean }
  | { readonly kind: "bump"; readonly key: number; readonly by: number }
  | { readonly kind: "remove"; readonly key: number }
  | {
      readonly kind: "replaceAll";
      readonly keys: ReadonlyArray<number>;
      readonly value: number;
    }
  | { readonly kind: "pairSet"; readonly n: number }
  | { readonly kind: "pairAdd"; readonly by: number }
  | { readonly kind: "pairCopy"; readonly to: number }
  | { readonly kind: "mark" }
  | { readonly kind: "readAtom"; readonly box: number; readonly value: number }
  | {
      readonly kind: "throwAbove";
      readonly control: number;
      readonly limit: number;
      readonly otherwise: RecipeSpec;
    }
  /** A conditional recipe on what the stages below may write: a data box, a row, or the pair box. */
  | {
      readonly kind: "when";
      readonly test:
        | { readonly on: "box"; readonly box: number; readonly above: number }
        | { readonly on: "row"; readonly key: number }
        | { readonly on: "pair"; readonly above: number };
      readonly holds: RecipeSpec;
      readonly otherwise: RecipeSpec | undefined;
    };

export type Step =
  | { readonly kind: "baseSet"; readonly box: number; readonly value: number }
  | { readonly kind: "baseAdd"; readonly box: number; readonly by: number }
  | {
      readonly kind: "baseUpsert";
      readonly key: number;
      readonly value: number;
      readonly end: boolean;
    }
  | { readonly kind: "baseRemove"; readonly key: number }
  | { readonly kind: "baseReplace"; readonly keys: ReadonlyArray<number>; readonly value: number }
  | { readonly kind: "basePair"; readonly n: number }
  | { readonly kind: "baseMark" }
  | { readonly kind: "noop" }
  | { readonly kind: "open"; readonly fail: boolean }
  | { readonly kind: "stage"; readonly stage: number; readonly recipe: RecipeSpec }
  | { readonly kind: "apply"; readonly stage: number }
  | { readonly kind: "drop"; readonly stage: number }
  /** A settle: a base write, then applying one stage and dropping another, in one update. */
  | {
      readonly kind: "settle";
      readonly box: number;
      readonly value: number;
      readonly apply: number;
      readonly drop: number;
    }
  /**
   * An update that applies a stage, then throws, so the landing rolls back:
   * the apply in the outer update, or in a nested update the outer one
   * catches before it writes a box.
   */
  | {
      readonly kind: "rollbackApply";
      readonly stage: number;
      readonly nested: boolean;
      readonly box: number;
      readonly value: number;
    };

/** What `onError` does in the oracle run: nothing, an update of a data box, or a drop of the lowest open stage. */
export type Handler = "none" | "update" | "drop";

const anyKey = (random: Random): number => random.integer(0, keys.length - 1);
/** Indexes of keys for a `replaceAll`: `0` and `-0` are one key, so at most one of them. */
const someKeys = (random: Random, chance: number): ReadonlyArray<number> => {
  const chosen = keys.map((_, index) => index).filter(() => random.chance(chance));
  if (!chosen.includes(1) || !chosen.includes(2)) return chosen;
  const dropped = random.chance(0.5) ? 1 : 2;
  return chosen.filter((index) => index !== dropped);
};
const anyData = (random: Random): number => random.integer(0, dataBoxes - 1);

const recipeSpec = (random: Random, depth = 0): RecipeSpec =>
  random.weighted<() => RecipeSpec>([
    [3, () => ({ kind: "add", box: anyData(random), by: random.integer(1, 3) })],
    [2, () => ({ kind: "set", box: anyData(random), value: random.integer(0, 9) })],
    [1, () => ({ kind: "copy", from: anyData(random), to: anyData(random) })],
    [
      2,
      () => ({
        kind: "upsert",
        key: anyKey(random),
        value: random.integer(0, 9),
        end: random.chance(0.5),
      }),
    ],
    [2, () => ({ kind: "bump", key: anyKey(random), by: random.integer(1, 3) })],
    [1, () => ({ kind: "remove", key: anyKey(random) })],
    [
      0.5,
      () => ({
        kind: "replaceAll",
        keys: someKeys(random, 0.4),
        value: random.integer(0, 9),
      }),
    ],
    [1, () => ({ kind: "pairSet", n: random.integer(0, 9) })],
    [1, () => ({ kind: "pairAdd", by: random.integer(1, 2) })],
    [0.5, () => ({ kind: "pairCopy", to: anyData(random) })],
    [1, () => ({ kind: "mark" })],
    [1, () => ({ kind: "readAtom", box: anyData(random), value: random.integer(0, 9) })],
    [
      depth === 0 ? 1 : 0,
      () => ({
        kind: "throwAbove",
        control: random.integer(0, controlBoxes - 1),
        limit: random.integer(2, 6),
        otherwise: recipeSpec(random, 1),
      }),
    ],
    [
      depth < 2 ? 3 : 0,
      () => ({
        kind: "when",
        test: random.weighted<() => Extract<RecipeSpec, { kind: "when" }>["test"]>([
          [3, () => ({ on: "box", box: anyData(random), above: random.integer(0, 5) })],
          [2, () => ({ on: "row", key: anyKey(random) })],
          [1, () => ({ on: "pair", above: random.integer(0, 4) })],
        ])(),
        holds: recipeSpec(random, depth + 1),
        otherwise: random.chance(0.5) ? recipeSpec(random, depth + 1) : undefined,
      }),
    ],
  ])();

export const generate = (seed: number): ReadonlyArray<Step> => {
  const random = new Random(seed);
  const steps: Array<Step> = [];
  let stages = 0;
  const length = random.integer(10, 40);
  for (let index = 0; index < length; index++) {
    const anyStage = () => random.integer(0, Math.max(0, stages - 1));
    const step = random.weighted<() => Step | undefined>([
      [2, () => ({ kind: "open", fail: random.chance(0.4) })],
      [
        6,
        () =>
          stages === 0
            ? undefined
            : { kind: "stage", stage: anyStage(), recipe: recipeSpec(random) },
      ],
      [2, () => (stages === 0 ? undefined : { kind: "apply", stage: anyStage() })],
      [2, () => (stages === 0 ? undefined : { kind: "drop", stage: anyStage() })],
      [2, () => ({ kind: "baseSet", box: anyData(random), value: random.integer(0, 9) })],
      // Control boxes only grow: a recipe that throws over one throws for
      // good, as a stopped stage stays stopped.
      [
        2,
        () => ({
          kind: "baseAdd",
          box: random.integer(0, dataBoxes + controlBoxes - 1),
          by: random.integer(1, 3),
        }),
      ],
      [
        2,
        () => ({
          kind: "baseUpsert",
          key: anyKey(random),
          value: random.integer(0, 9),
          end: random.chance(0.5),
        }),
      ],
      [1, () => ({ kind: "baseRemove", key: anyKey(random) })],
      [
        1,
        () => ({
          kind: "baseReplace",
          keys: someKeys(random, 0.5),
          value: random.integer(0, 9),
        }),
      ],
      [1, () => ({ kind: "basePair", n: random.integer(0, 9) })],
      [1, () => ({ kind: "baseMark" })],
      [0.5, () => ({ kind: "noop" })],
      [
        1,
        () =>
          stages < 2
            ? undefined
            : {
                kind: "settle",
                box: anyData(random),
                value: random.integer(0, 9),
                apply: anyStage(),
                drop: anyStage(),
              },
      ],
      [
        1,
        () =>
          stages === 0
            ? undefined
            : {
                kind: "rollbackApply",
                stage: anyStage(),
                nested: random.chance(0.5),
                box: anyData(random),
                value: random.integer(0, 9),
              },
      ],
    ])();
    if (step === undefined) continue;
    if (step.kind === "open") stages++;
    steps.push(step);
  }
  return steps;
};

/** Application functions entered, and those entered while the stack wrote cells raw. */
export interface Entries {
  entered: number;
  duringInstall: Array<string>;
}

interface Snapshot {
  readonly boxes: ReadonlyArray<number>;
  readonly pair: Pair;
  readonly rows: ReadonlyArray<Row>;
  /** The stored keys, in order. */
  readonly keys: ReadonlyArray<unknown>;
  readonly sum: number;
}

interface World {
  readonly realm: Realm;
  readonly boxes: ReadonlyArray<Box<number>>;
  readonly pair: Box<Pair>;
  readonly atom: Atom;
  readonly rows: Collection<unknown, Row>;
  readonly sum: Box<number>;
  /** Wraps an application function so it counts its entries. */
  readonly guard: <Arguments extends ReadonlyArray<unknown>, Result>(
    name: string,
    run: (...values: Arguments) => Result,
  ) => (...values: Arguments) => Result;
}

const makeWorld = (
  options: {
    readonly values?: Snapshot;
    readonly entries?: Entries;
    readonly onError?: (error: unknown) => void;
    readonly installing?: ((realm: Realm) => boolean) | undefined;
  } = {},
): World => {
  const { values, entries } = options;
  let realm: Realm | undefined;
  const guard = <Arguments extends ReadonlyArray<unknown>, Result>(
    name: string,
    run: (...values: Arguments) => Result,
  ): ((...values: Arguments) => Result) => {
    if (entries === undefined) return run;
    return (...values) => {
      entries.entered++;
      if (realm !== undefined && options.installing?.(realm) === true) {
        entries.duringInstall.push(name);
      }
      return run(...values);
    };
  };
  realm = Realm.make({ onError: guard("onError", options.onError ?? (() => undefined)) });
  const made = realm;
  const boxes = Array.from({ length: dataBoxes + controlBoxes }, (_, index) =>
    Box.make(made, values?.boxes[index] ?? 0),
  );
  const pair = Box.make<Pair>(made, values?.pair ?? { n: 0 }, {
    equals: guard("equals", (left: Pair, right: Pair) => pairOf(left) === pairOf(right)),
  });
  const atom = Atom.make(made);
  const rows = Collection.make<unknown, Row>(made, { keyOf: (row) => row.id });
  const sum = Box.make(made, 0);
  if (values !== undefined) {
    Realm.update(made, (_read, write) => {
      write.replaceAll(
        rows,
        values.rows.map((row) => ({ ...row })),
      );
    });
  }
  // A listener that keeps a sum of the rows' values, so replays run it.
  Collection.onRowChange(
    rows,
    guard("listener", (change: RowChange<unknown, Row>, read: Read, write: Write): undefined => {
      write(sum, read(sum) - (change.before?.value ?? 0) + (change.after?.value ?? 0));
      return undefined;
    }),
  );
  return { realm: made, boxes, pair, atom, rows, sum, guard };
};

const recipeOf = (world: World, spec: RecipeSpec): UpdateRecipe => {
  const { boxes, rows, pair, atom } = world;
  const box = (index: number) => boxes[index] as Box<number>;
  const key = (index: number) => keys[index];
  switch (spec.kind) {
    case "add":
      return (read, write) => write(box(spec.box), read(box(spec.box)) + spec.by);
    case "set":
      return (_read, write) => write(box(spec.box), spec.value);
    case "copy":
      return (read, write) => write(box(spec.to), read(box(spec.from)));
    case "upsert":
      return (_read, write) =>
        write.upsert(
          rows,
          { id: key(spec.key), value: spec.value },
          { at: spec.end ? "end" : "start" },
        );
    case "bump":
      return (read, write) => {
        const row = read.row(rows, key(spec.key));
        if (row !== undefined) write.upsert(rows, { id: row.id, value: row.value + spec.by });
      };
    case "remove":
      return (_read, write) => write.remove(rows, key(spec.key));
    case "replaceAll":
      return (_read, write) =>
        write.replaceAll(
          rows,
          spec.keys.map((index) => ({ id: key(index), value: spec.value })),
        );
    case "pairSet":
      return (_read, write) => write(pair, { n: spec.n });
    case "pairAdd":
      // An even step keeps the pair: the shown representative and the oracle's agree.
      return (read, write) => write(pair, { n: read(pair).n + 2 * spec.by });
    case "pairCopy":
      return (read, write) => write(box(spec.to), pairOf(read(pair)));
    case "mark":
      return (_read, write) => write.changed(atom);
    case "readAtom":
      return (read, write) => {
        read(atom);
        write(box(spec.box), spec.value);
      };
    case "throwAbove": {
      const otherwise = recipeOf(world, spec.otherwise);
      return (read, write) => {
        if (read(box(dataBoxes + spec.control)) > spec.limit) throw new Error("above the limit");
        otherwise(read, write);
      };
    }
    case "when": {
      const whenHolds = recipeOf(world, spec.holds);
      const otherwise = spec.otherwise === undefined ? undefined : recipeOf(world, spec.otherwise);
      const test = spec.test;
      return (read, write) => {
        const holds =
          test.on === "box"
            ? read(box(test.box)) > test.above
            : test.on === "row"
              ? read.row(rows, key(test.key)) !== undefined
              : pairOf(read(pair)) > test.above;
        if (holds) whenHolds(read, write);
        else otherwise?.(read, write);
      };
    }
  }
};

const snapshotOf = (world: World): Snapshot =>
  Realm.untracked(world.realm, (read) => ({
    boxes: world.boxes.map((box) => read(box)),
    pair: read(world.pair),
    rows: read(world.rows.rows).map((row) => ({ id: row.id, value: row.value })),
    keys: read(world.rows.keys),
    sum: read(world.sum),
  }));

/**
 * A snapshot as text, each key and row id exact: `-0` apart from `0`, so a
 * key stored with another sign on one path shows. The pair box is its pair:
 * its `equals` keeps whichever representative was shown first.
 */
const textOf = (snapshot: Snapshot): string =>
  JSON.stringify({
    boxes: snapshot.boxes,
    pair: pairOf(snapshot.pair),
    rows: snapshot.rows.map((row) => [keyToken(row.id), row.value]),
    keys: snapshot.keys.map(keyToken),
    sum: snapshot.sum,
  });

class RolledBack extends Error {}

const settleQuietly = (run: () => void): void => {
  try {
    run();
  } catch (error) {
    // A conflict or a replay throw from Stage.apply, or a staged recipe that
    // threw: the script carries on, as an application would.
    if (!(error instanceof Error) || error instanceof RolledBack) throw error;
  }
};

interface Run {
  readonly finalBase: string;
  readonly failures: ReadonlyArray<string>;
  readonly entries: Entries;
}

/** An autorun's last seen value as text, and how many times it ran. */
interface Watched {
  seen: string;
  runs: number;
}

export const run = (
  steps: ReadonlyArray<Step>,
  visible: boolean,
  checkOracle: boolean,
  handler: Handler,
  /** Whether the realm's stack writes cells raw now: given, every application function counts entries then. */
  installing?: (realm: Realm) => boolean,
): Run => {
  const entries: Entries = { entered: 0, duringInstall: [] };
  const stages: Array<Stage> = [];
  /** Updates `onError` ran in the current step. */
  let handled = 0;
  let worldRealm: Realm | undefined;
  const onError = (error: unknown): void => {
    if (handler === "none" || worldRealm === undefined) return;
    if (!(error instanceof Error) || error.message !== "above the limit") return;
    handled++;
    if (handler === "update") {
      Realm.update(worldRealm, (read, write) => {
        const target = world.boxes[0] as Box<number>;
        write(target, read(target) + 1);
      });
    } else {
      const open = stages.find((stage) => Stage.status(stage) === "open");
      if (open !== undefined) Stage.drop(open);
    }
  };
  const world = makeWorld({ entries, onError, installing });
  worldRealm = world.realm;
  const { guard } = world;
  const view = View.ordered(world.rows, {
    compare: guard(
      "compare",
      // The view keeps the returned comparator and calls it directly: it counts too.
      () =>
        guard(
          "comparator",
          (left: Row, right: Row) =>
            left.value - right.value || keyRank(left.id) - keyRank(right.id),
        ),
    ),
  });
  const total = Computed.make(
    world.realm,
    guard("computed", (read: Read) =>
      world.boxes.slice(0, dataBoxes).reduce((sum, box) => sum + read(box), 0),
    ),
  );
  const box = (index: number) => world.boxes[index] as Box<number>;
  // Each autorun keeps what it last saw.
  const watched = new Map<string, Watched>();
  const stops: Array<() => void> = [];
  const watch = (name: string, see: (read: Read) => string): void => {
    const entry: Watched = { seen: "", runs: 0 };
    watched.set(name, entry);
    stops.push(
      Realm.autorun(
        world.realm,
        guard(`autorun ${name}`, (read: Read) => {
          entry.seen = see(read);
          entry.runs++;
          return undefined;
        }),
      ),
    );
  };
  for (let index = 0; index < dataBoxes; index++) {
    watch(`box ${index}`, (read) => String(read(box(index))));
  }
  watch("pair", (read) => String(pairOf(read(world.pair))));
  watch("sum", (read) => String(read(world.sum)));
  watch("total", (read) => String(read(total)));
  watch("view", (read) => read(view.keys).map(keyToken).join(","));
  watch("atom", (read) => {
    read(world.atom);
    return "";
  });
  const journals: Array<Array<RecipeSpec>> = [];
  const failures: Array<string> = [];
  const runsNow = (): Map<string, number> =>
    new Map([...watched].map(([name, entry]) => [name, entry.runs]));
  /** Whether a showing stage's mark is in the shown set, by the oracle; `undefined` before the first check. */
  let shownMark: boolean | undefined;
  const check = (index: number, step: Step, runsBefore: Map<string, number>): void => {
    if (!visible || !checkOracle) return;
    const runsAfter = runsNow();
    // Glitch-free: each autorun runs at most once per update, and a no-op update runs none.
    for (const [name, after] of runsAfter) {
      const ran = after - (runsBefore.get(name) ?? 0);
      const limit = step.kind === "noop" ? 0 : 1 + handled;
      if (ran > limit) failures.push(`step ${index}: autorun ${name} ran ${ran} times`);
    }
    // The base, from a hidden stage's realmRead: what every writer reads.
    const probe = Stage.make(world.realm);
    const baseValues = Stage.realmRead(probe, (read) => ({
      boxes: world.boxes.map((each) => read(each)),
      pair: read(world.pair),
      rows: read(world.rows.rows).map((row) => ({ id: row.id, value: row.value })),
      keys: read(world.rows.keys),
      sum: read(world.sum),
    }));
    Stage.drop(probe);
    for (const [name, runs] of runsNow()) {
      if (runs !== runsAfter.get(name)) {
        failures.push(`step ${index}: reading the base through a hidden stage ran autorun ${name}`);
      }
    }
    const scratch = makeWorld({ values: baseValues });
    let scratchMarks = 0;
    const stopScratch = Realm.autorun(scratch.realm, (read) => {
      read(scratch.atom);
      scratchMarks++;
      return undefined;
    });
    stages.forEach((stage, stageIndex) => {
      const inspection = Stage.inspect(stage);
      if (!inspection.showing) return;
      const hidden = Stage.make(scratch.realm);
      try {
        for (const spec of journals[stageIndex] ?? []) {
          Stage.update(hidden, recipeOf(scratch, spec));
        }
        Stage.apply(hidden);
      } catch (error) {
        failures.push(
          `step ${index}: showing stage ${stageIndex} fails in the oracle: ${String(error)}`,
        );
        Stage.drop(hidden);
      }
    });
    stopScratch();
    const expected = snapshotOf(scratch);
    const shown = snapshotOf(world);
    if (textOf(expected) !== textOf(shown)) {
      failures.push(`step ${index}: shown ${textOf(shown)}, oracle ${textOf(expected)}`);
    }
    // The view hands out the stored keys, in the order of its compare.
    const viewKeys = Realm.untracked(world.realm, (read) => read(view.keys));
    const sorted = [...shown.keys].sort((left, right) => {
      const leftRow = shown.rows.find((row) => keyRank(row.id) === keyRank(left)) as Row;
      const rightRow = shown.rows.find((row) => keyRank(row.id) === keyRank(right)) as Row;
      return leftRow.value - rightRow.value || keyRank(left) - keyRank(right);
    });
    if (
      viewKeys.length !== sorted.length ||
      viewKeys.some((key, position) => !Object.is(key, sorted[position]))
    ) {
      failures.push(
        `step ${index}: view ${viewKeys.map(keyToken)}, stored keys sorted ${sorted.map(keyToken)}`,
      );
    }
    // Each autorun has seen what is shown.
    const fresh = Realm.untracked(world.realm, (read) => ({
      total: String(read(total)),
      view: read(view.keys).map(keyToken).join(","),
    }));
    const expectSeen: Record<string, string> = {
      pair: String(pairOf(shown.pair)),
      sum: String(shown.sum),
      total: fresh.total,
      view: fresh.view,
    };
    for (let boxIndex = 0; boxIndex < dataBoxes; boxIndex++) {
      expectSeen[`box ${boxIndex}`] = String(shown.boxes[boxIndex]);
    }
    for (const [name, value] of Object.entries(expectSeen)) {
      if (watched.get(name)?.seen !== value) {
        failures.push(
          `step ${index}: autorun ${name} last saw ${watched.get(name)?.seen}, shown ${value}`,
        );
      }
    }
    if (fresh.total !== String(shown.boxes.slice(0, dataBoxes).reduce((a, b) => a + b, 0))) {
      failures.push(`step ${index}: the computed total ${fresh.total} is not the shown boxes' sum`);
    }
    // An atom marks when a mark enters or leaves the shown set, and on a base mark.
    const markNow = scratchMarks > 1;
    const atomRan = (runsAfter.get("atom") ?? 0) - (runsBefore.get("atom") ?? 0) > 0;
    const landing =
      step.kind === "apply" || step.kind === "settle" || step.kind === "rollbackApply";
    if (shownMark !== undefined && !landing && handled === 0) {
      const expectRun = step.kind === "baseMark" || markNow !== shownMark;
      if (atomRan !== expectRun) {
        failures.push(
          `step ${index}: the atom ${atomRan ? "ran" : "did not run"}; shown mark ${shownMark} to ${markNow}`,
        );
      }
    }
    shownMark = markNow;
    Realm.dispose(scratch.realm);
  };
  steps.forEach((step, index) => {
    handled = 0;
    const runsBefore = runsNow();
    switch (step.kind) {
      case "baseSet":
        Realm.update(world.realm, (_read, write) => write(box(step.box), step.value));
        break;
      case "baseAdd":
        Realm.update(world.realm, (read, write) =>
          write(box(step.box), read(box(step.box)) + step.by),
        );
        break;
      case "baseUpsert":
        Realm.update(world.realm, (_read, write) =>
          write.upsert(
            world.rows,
            { id: keys[step.key], value: step.value },
            { at: step.end ? "end" : "start" },
          ),
        );
        break;
      case "baseRemove":
        Realm.update(world.realm, (_read, write) => write.remove(world.rows, keys[step.key]));
        break;
      case "baseReplace":
        Realm.update(world.realm, (_read, write) =>
          write.replaceAll(
            world.rows,
            step.keys.map((key) => ({ id: keys[key], value: step.value })),
          ),
        );
        break;
      case "basePair":
        Realm.update(world.realm, (_read, write) => write(world.pair, { n: step.n }));
        break;
      case "baseMark":
        Realm.update(world.realm, (_read, write) => write.changed(world.atom));
        break;
      case "noop":
        Realm.update(world.realm, (): undefined => undefined);
        break;
      case "open":
        stages.push(Stage.make(world.realm, { visible, conflicts: step.fail ? "fail" : "replay" }));
        journals.push([]);
        break;
      case "stage": {
        const stage = stages[step.stage] as Stage;
        if (Stage.status(stage) !== "open") break;
        settleQuietly(() => {
          expectFailedRecipeKeepsNoPatch(stage, () =>
            Stage.update(stage, guard("recipe", recipeOf(world, step.recipe))),
          );
          (journals[step.stage] as Array<RecipeSpec>).push(step.recipe);
        });
        break;
      }
      case "apply": {
        const stage = stages[step.stage] as Stage;
        if (Stage.status(stage) !== "open") break;
        settleQuietly(() => Stage.apply(stage));
        break;
      }
      case "drop":
        Stage.drop(stages[step.stage] as Stage);
        break;
      case "settle": {
        const applied = stages[step.apply] as Stage;
        const dropped = stages[step.drop] as Stage;
        Realm.update(world.realm, (_read, write) => {
          write(box(step.box), step.value);
          if (Stage.status(applied) === "open") settleQuietly(() => Stage.apply(applied));
          Stage.drop(dropped);
        });
        break;
      }
      case "rollbackApply": {
        const stage = stages[step.stage] as Stage;
        if (Stage.status(stage) !== "open") break;
        const applyThenThrow = (): undefined => {
          settleQuietly(() => Stage.apply(stage));
          throw new RolledBack("rolled back");
        };
        try {
          Realm.update(world.realm, (_read, write) => {
            if (step.nested) {
              try {
                Realm.update(world.realm, applyThenThrow);
              } catch (error) {
                if (!(error instanceof RolledBack)) throw error;
              }
              write(box(step.box), step.value);
            } else {
              applyThenThrow();
            }
          });
        } catch (error) {
          if (!(error instanceof RolledBack)) throw error;
        }
        break;
      }
    }
    check(index, step, runsBefore);
    expectNothingHeld(world.realm, [world.rows]);
  });
  for (const stage of stages) Stage.drop(stage);
  for (const stop of stops) stop();
  const finalBase = textOf(snapshotOf(world));
  View.dispose(view);
  Realm.dispose(world.realm);
  return { finalBase, failures, entries };
};

export const handlerOf = (seed: number): Handler =>
  (["none", "update", "drop"] as const)[seed % 3] as Handler;

/** `PINNA_STAGE_FUZZ_SEEDS` runs more: 20,000 is the gate of a change to `src/stack.ts`. */
export const seeds = Number(process.env["PINNA_STAGE_FUZZ_SEEDS"] ?? 200);
