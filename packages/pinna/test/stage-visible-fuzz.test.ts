import { describe, expect, test } from "bun:test";
import { Box, Collection, Realm, Stage, type UpdateRecipe, View } from "../src/index.ts";
import { Random } from "./fuzz/random.ts";

/**
 * The property visible stages are built against (ruling 68): a visible stage
 * ends with the values the same stage would end with hidden, and at rest the
 * realm shows what applying every showing stage, bottom first, would land.
 *
 * A seed makes a script of base updates and stage calls over a few boxes and
 * one collection. The script runs twice, with its stages visible and with
 * them hidden: both end with the same base. With them visible, at every rest
 * point the realm's values equal the oracle's: a scratch realm that starts
 * from the base and applies every showing stage's recipes, bottom first, as
 * hidden stages. A row listener and an ordered view run on the collection
 * throughout, so replays run through them.
 */

const dataBoxes = 3;
/** Boxes no stage writes: a recipe's throw reads them, so staging decides the same either way. */
const controlBoxes = 2;
const keySpace = 4;

interface Row {
  readonly id: number;
  readonly value: number;
}

/** A recipe as data, so the oracle can run it again. */
type RecipeSpec =
  | { readonly kind: "add"; readonly box: number; readonly by: number }
  | { readonly kind: "set"; readonly box: number; readonly value: number }
  | { readonly kind: "copy"; readonly from: number; readonly to: number }
  | { readonly kind: "upsert"; readonly key: number; readonly value: number; readonly end: boolean }
  | { readonly kind: "bump"; readonly key: number; readonly by: number }
  | { readonly kind: "remove"; readonly key: number }
  | {
      readonly kind: "throwAbove";
      readonly control: number;
      readonly limit: number;
      readonly otherwise: RecipeSpec;
    };

type Step =
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
    };

const recipeSpec = (random: Random, depth = 0): RecipeSpec =>
  random.weighted<() => RecipeSpec>([
    [3, () => ({ kind: "add", box: random.integer(0, dataBoxes - 1), by: random.integer(1, 3) })],
    [
      2,
      () => ({ kind: "set", box: random.integer(0, dataBoxes - 1), value: random.integer(0, 9) }),
    ],
    [
      1,
      () => ({
        kind: "copy",
        from: random.integer(0, dataBoxes - 1),
        to: random.integer(0, dataBoxes - 1),
      }),
    ],
    [
      2,
      () => ({
        kind: "upsert",
        key: random.integer(0, keySpace - 1),
        value: random.integer(0, 9),
        end: random.chance(0.5),
      }),
    ],
    [2, () => ({ kind: "bump", key: random.integer(0, keySpace - 1), by: random.integer(1, 3) })],
    [1, () => ({ kind: "remove", key: random.integer(0, keySpace - 1) })],
    [
      depth === 0 ? 1 : 0,
      () => ({
        kind: "throwAbove",
        control: random.integer(0, controlBoxes - 1),
        limit: random.integer(2, 6),
        otherwise: recipeSpec(random, 1),
      }),
    ],
  ])();

const generate = (seed: number): ReadonlyArray<Step> => {
  const random = new Random(seed);
  const steps: Array<Step> = [];
  let stages = 0;
  const length = random.integer(10, 40);
  for (let index = 0; index < length; index++) {
    const anyStage = () => random.integer(0, Math.max(0, stages - 1));
    const step = random.weighted<() => Step | undefined>([
      [2, () => ({ kind: "open", fail: random.chance(0.3) })],
      [
        6,
        () =>
          stages === 0
            ? undefined
            : { kind: "stage", stage: anyStage(), recipe: recipeSpec(random) },
      ],
      [2, () => (stages === 0 ? undefined : { kind: "apply", stage: anyStage() })],
      [2, () => (stages === 0 ? undefined : { kind: "drop", stage: anyStage() })],
      [
        2,
        () => ({
          kind: "baseSet",
          box: random.integer(0, dataBoxes - 1),
          value: random.integer(0, 9),
        }),
      ],
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
          key: random.integer(0, keySpace - 1),
          value: random.integer(0, 9),
          end: random.chance(0.5),
        }),
      ],
      [1, () => ({ kind: "baseRemove", key: random.integer(0, keySpace - 1) })],
      [
        1,
        () => ({
          kind: "baseReplace",
          keys: [0, 1, 2, 3].filter(() => random.chance(0.6)),
          value: random.integer(0, 9),
        }),
      ],
      [
        1,
        () =>
          stages < 2
            ? undefined
            : {
                kind: "settle",
                box: random.integer(0, dataBoxes - 1),
                value: random.integer(0, 9),
                apply: anyStage(),
                drop: anyStage(),
              },
      ],
    ])();
    if (step === undefined) continue;
    if (step.kind === "open") stages++;
    steps.push(step);
  }
  return steps;
};

interface World {
  readonly realm: Realm;
  readonly boxes: ReadonlyArray<Box<number>>;
  readonly rows: Collection<number, Row>;
  readonly sum: Box<number>;
}

const makeWorld = (values?: Snapshot): World => {
  const realm = Realm.make({
    onError: () => undefined,
  });
  const boxes = Array.from({ length: dataBoxes + controlBoxes }, (_, index) =>
    Box.make(realm, values?.boxes[index] ?? 0),
  );
  const rows = Collection.make<number, Row>(realm, { keyOf: (row) => row.id });
  const sum = Box.make(realm, 0);
  if (values !== undefined) {
    Realm.update(realm, (_read, write) => {
      write.replaceAll(
        rows,
        values.rows.map((row) => ({ ...row })),
      );
    });
  }
  // A listener that keeps a sum of the rows' values, so replays run it.
  Collection.onRowChange(rows, (change, read, write) => {
    write(sum, read(sum) - (change.before?.value ?? 0) + (change.after?.value ?? 0));
  });
  return { realm, boxes, rows, sum };
};

const recipeOf = (world: World, spec: RecipeSpec): UpdateRecipe => {
  const { boxes, rows } = world;
  const box = (index: number) => boxes[index] as Box<number>;
  switch (spec.kind) {
    case "add":
      return (read, write) => write(box(spec.box), read(box(spec.box)) + spec.by);
    case "set":
      return (_read, write) => write(box(spec.box), spec.value);
    case "copy":
      return (read, write) => write(box(spec.to), read(box(spec.from)));
    case "upsert":
      return (_read, write) =>
        write.upsert(rows, { id: spec.key, value: spec.value }, { at: spec.end ? "end" : "start" });
    case "bump":
      return (read, write) => {
        const row = read.row(rows, spec.key);
        if (row !== undefined) write.upsert(rows, { id: row.id, value: row.value + spec.by });
      };
    case "remove":
      return (_read, write) => write.remove(rows, spec.key);
    case "throwAbove": {
      const otherwise = recipeOf(world, spec.otherwise);
      return (read, write) => {
        if (read(box(dataBoxes + spec.control)) > spec.limit) throw new Error("above the limit");
        otherwise(read, write);
      };
    }
  }
};

interface Snapshot {
  readonly boxes: ReadonlyArray<number>;
  readonly rows: ReadonlyArray<Row>;
  readonly sum: number;
}

const snapshotOf = (world: World): Snapshot =>
  Realm.untracked(world.realm, (read) => ({
    boxes: world.boxes.map((box) => read(box)),
    rows: read(world.rows.rows).map((row) => ({ id: row.id, value: row.value })),
    sum: read(world.sum),
  }));

const settleQuietly = (run: () => void): void => {
  try {
    run();
  } catch (error) {
    // A conflict or a replay throw from Stage.apply, or a staged recipe that
    // threw: the script carries on, as an application would.
    if (!(error instanceof Error)) throw error;
  }
};

interface Run {
  readonly finalBase: Snapshot;
  readonly failures: ReadonlyArray<string>;
}

const run = (steps: ReadonlyArray<Step>, visible: boolean, checkOracle: boolean): Run => {
  const world = makeWorld();
  const view = View.ordered(world.rows, {
    compare: () => (left, right) => left.value - right.value,
  });
  const stages: Array<Stage> = [];
  const journals: Array<Array<RecipeSpec>> = [];
  const failures: Array<string> = [];
  const check = (index: number): void => {
    if (!visible || !checkOracle) return;
    // The base, from a hidden stage's realmRead: what every writer reads.
    const probe = Stage.make(world.realm);
    const baseValues = Stage.realmRead(probe, (read) => ({
      boxes: world.boxes.map((box) => read(box)),
      rows: read(world.rows.rows).map((row) => ({ id: row.id, value: row.value })),
      sum: read(world.sum),
    }));
    Stage.drop(probe);
    const scratch = makeWorld(baseValues);
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
    const expected = snapshotOf(scratch);
    const shown = snapshotOf(world);
    if (JSON.stringify(expected) !== JSON.stringify(shown)) {
      failures.push(
        `step ${index}: shown ${JSON.stringify(shown)}, oracle ${JSON.stringify(expected)}`,
      );
    }
    const viewKeys = Realm.untracked(world.realm, (read) => read(view.keys));
    const sorted = [...shown.rows]
      .sort((left, right) => left.value - right.value || left.id - right.id)
      .map((row) => row.id);
    if (JSON.stringify(viewKeys) !== JSON.stringify(sorted)) {
      failures.push(
        `step ${index}: view ${JSON.stringify(viewKeys)}, rows ${JSON.stringify(sorted)}`,
      );
    }
    Realm.dispose(scratch.realm);
  };
  const box = (index: number) => world.boxes[index] as Box<number>;
  steps.forEach((step, index) => {
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
            { id: step.key, value: step.value },
            { at: step.end ? "end" : "start" },
          ),
        );
        break;
      case "baseRemove":
        Realm.update(world.realm, (_read, write) => write.remove(world.rows, step.key));
        break;
      case "baseReplace":
        Realm.update(world.realm, (_read, write) =>
          write.replaceAll(
            world.rows,
            step.keys.map((key) => ({ id: key, value: step.value })),
          ),
        );
        break;
      case "open":
        stages.push(Stage.make(world.realm, { visible, conflicts: step.fail ? "fail" : "replay" }));
        journals.push([]);
        break;
      case "stage": {
        const stage = stages[step.stage] as Stage;
        if (Stage.status(stage) !== "open") break;
        settleQuietly(() => {
          Stage.update(stage, recipeOf(world, step.recipe));
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
    }
    check(index);
  });
  for (const stage of stages) Stage.drop(stage);
  const finalBase = snapshotOf(world);
  View.dispose(view);
  Realm.dispose(world.realm);
  return { finalBase, failures };
};

const seeds = Number(process.env["PINNA_STAGE_FUZZ_SEEDS"] ?? 300);

describe("visible stages: the differential fuzz", () => {
  test("a script ends with the same base with its stages visible and hidden", () => {
    const differing: Array<string> = [];
    for (let seed = 1; seed <= seeds; seed++) {
      const steps = generate(seed);
      const shown = run(steps, true, false);
      const hidden = run(steps, false, false);
      if (JSON.stringify(shown.finalBase) !== JSON.stringify(hidden.finalBase)) {
        differing.push(
          `seed ${seed}: visible ${JSON.stringify(shown.finalBase)}, hidden ${JSON.stringify(hidden.finalBase)}`,
        );
      }
    }
    expect(differing).toEqual([]);
  });

  test("at every rest point the realm shows what applying every showing stage would land", () => {
    const failing: Array<string> = [];
    for (let seed = 1; seed <= seeds; seed++) {
      const { failures } = run(generate(seed), true, true);
      if (failures.length > 0) failing.push(`seed ${seed}: ${failures[0]}`);
    }
    expect(failing).toEqual([]);
  });

  test("the scripts reach stops, stacks, and settles", () => {
    let settles = 0;
    let stopped = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const steps = generate(seed);
      settles += steps.filter((step) => step.kind === "settle").length;
      stopped += steps.filter(
        (step) => step.kind === "stage" && step.recipe.kind === "throwAbove",
      ).length;
    }
    expect(settles).toBeGreaterThan(10);
    expect(stopped).toBeGreaterThan(10);
  });
});
