import { describe, expect, test } from "bun:test";
import { checked as libraries } from "../../src/libraries/index.ts";
import { type Observation, play, type Script, script } from "./random.ts";

/** Fixed seeds, so the gate never depends on luck; a failure names its seed. */
const seeds = Array.from({ length: 200 }, (_, index) => index);

const observe = (name: string, seed: number): Observation => {
  const library = libraries.find((candidate) => candidate.name === name);
  if (library === undefined) {
    throw new Error(`differential: no library ${name}`);
  }
  return play(library.make(), script(seed));
};

/**
 * Per write operation, whether it writes a box away from its value and back
 * within the update. Pinna puts such a box back at its old version, so its
 * readers recompute nothing there; MobX recomputes them.
 */
const writesBack = ({ sources, operations }: Script): ReadonlyArray<boolean> => {
  const values: Array<number> = Array.from({ length: sources }, () => 0);
  const steps: Array<boolean> = [];
  for (const operation of operations) {
    if (operation.kind !== "write" && operation.kind !== "nested") {
      continue;
    }
    const writes =
      operation.kind === "write" ? operation.writes : [operation.outer, operation.inner];
    const before = [...values];
    const moved = new Set<number>();
    for (const [box, value] of writes) {
      if (value !== before[box]) {
        moved.add(box);
      }
      values[box] = value;
    }
    steps.push([...moved].some((box) => values[box] === before[box]));
  }
  return steps;
};

describe("differential", () => {
  // Pinna and MobX agree on values and notifications, and compute alike on
  // every write but one that writes a value back: there Pinna computes less.
  test.each(seeds)("seed %i: Pinna and MobX compute and notify alike", (seed) => {
    const mobx = observe("mobx", seed);
    const pinna = observe("pinna", seed);
    expect(pinna.seen).toEqual(mobx.seen);
    expect(pinna.values).toEqual(mobx.values);
    const back = writesBack(script(seed));
    expect(pinna.computations.length).toBe(back.length);
    pinna.computations.forEach((counts, step) => {
      const theirs = mobx.computations[step] ?? [];
      if (back[step] === true) {
        counts.forEach((count, node) => {
          expect(count).toBeLessThanOrEqual(theirs[node] ?? 0);
        });
      } else {
        expect(counts).toEqual(theirs);
      }
    });
  });

  // alien-signals also leaves a value written back unchanged, so it computes
  // exactly as Pinna does.
  test.each(seeds)("seed %i: Pinna and alien-signals compute and notify alike", (seed) => {
    expect(observe("alien-signals", seed)).toEqual(observe("pinna", seed));
  });
});
