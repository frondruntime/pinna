// The old-field oracle is from the pinned place.test.ts.
import { expect, test } from "bun:test";
import {
  nextPlace,
  placeAllows,
  placeDeriving,
  placeDisposed,
  placeKind,
  placeOpen,
  placeShadowed,
  placeTracked,
  placeUpdating,
} from "../../src/index.ts";

/** A run's node, by the shape the old checks read. */
interface RunNode {
  readonly name: string;
  readonly effect: boolean;
  readonly compute: boolean;
}

/** A new node of each shape: every run has its own node, told apart by identity. */
const nodes = {
  get compute(): RunNode {
    return { name: "compute", effect: false, compute: true };
  },
  get watch(): RunNode {
    return { name: "watch", effect: true, compute: true };
  },
  get autorun(): RunNode {
    return { name: "autorun", effect: false, compute: true };
  },
  get reaction(): RunNode {
    return { name: "reaction", effect: true, compute: false };
  },
};

const marker = { name: "a stage recipe", effect: false, compute: false } as const;

/** The old fields. */
interface Old {
  readonly active: RunNode | undefined;
  readonly deriving: RunNode | undefined;
  readonly untrackedActive: RunNode | undefined;
  readonly autorunRun: RunNode | undefined;
  readonly openDepth: number;
  readonly updateDepth: number;
  readonly disposed: boolean;
  readonly draining: boolean;
}

/** What each question answered under the old fields. */
const oldAnswers = (state: Old) => {
  const untracked = state.untrackedActive;
  const updateRefusedByFields =
    state.deriving !== undefined ||
    state.disposed ||
    (untracked !== undefined &&
      untracked !== state.autorunRun &&
      (untracked.effect || !untracked.compute));
  return {
    read: state.active !== undefined || state.openDepth > 0,
    write: state.deriving === undefined && state.updateDepth > 0,
    update:
      !updateRefusedByFields && (state.active === undefined || state.active === state.autorunRun),
    observe: state.deriving === undefined,
    make: state.deriving !== marker,
    rest:
      state.updateDepth === 0 &&
      state.openDepth === 0 &&
      state.deriving === undefined &&
      state.active === undefined &&
      !state.draining,
    scheduledRest:
      state.updateDepth === 0 &&
      state.deriving === undefined &&
      state.active === undefined &&
      state.untrackedActive === undefined,
    recipe: state.deriving === marker,
    tracking: state.active !== undefined,
  };
};

/** What each question answers under the word, `active` aside, which the graph keeps. */
const newAnswers = (place: number, tracking: boolean) => ({
  read: tracking || placeAllows.read(place),
  write: placeAllows.write(place),
  update: placeAllows.update(place),
  observe: placeAllows.observe(place),
  make: placeAllows.make(place),
  rest: placeAllows.rest(place),
  scheduledRest: (place & (placeUpdating | placeDeriving | placeTracked | placeShadowed)) === 0,
  recipe: !placeAllows.make(place),
  tracking: (place & placeTracked) !== 0,
});

interface Both {
  readonly old: Old;
  readonly place: number;
}

/**
 * One step: whether the code can enter it from `state`, and the state after,
 * old and new. `undefined` where the code refuses to enter.
 */
type Step = (state: Both) => Both | undefined;

const steps: Record<string, Step> = {
  update: ({ old, place }) => {
    if (!oldAnswers(old).update) return undefined;
    // In an autorun's body, `Realm.update` runs untracked first.
    const inAutorun = old.active !== undefined;
    const outer = inAutorun ? nextPlace(place, placeKind.autorunUpdate) : place;
    return {
      old: {
        ...old,
        active: inAutorun ? undefined : old.active,
        openDepth: old.openDepth + 1,
        updateDepth: old.updateDepth + 1,
      },
      place: nextPlace(outer, placeKind.update),
    };
  },
  untracked: ({ old, place }) => {
    if (old.deriving === marker) return undefined;
    return {
      old: {
        ...old,
        untrackedActive: old.active ?? old.untrackedActive,
        active: undefined,
        openDepth: old.openDepth + 1,
      },
      place: nextPlace(place | placeOpen, placeKind.untracked),
    };
  },
  compute: ({ old, place }) => {
    const node = nodes.compute;
    return {
      old: { ...old, active: node, deriving: node },
      place: nextPlace(place, placeKind.compute),
    };
  },
  watchSelect: ({ old, place }) => {
    if (!oldAnswers(old).observe) return undefined;
    return { old: { ...old, active: nodes.watch }, place: nextPlace(place, placeKind.select) };
  },
  autorunBody: ({ old, place }) => {
    if (!oldAnswers(old).observe) return undefined;
    const node = nodes.autorun;
    return {
      old: { ...old, active: node, autorunRun: node },
      place: nextPlace(nextPlace(place, placeKind.select), placeKind.autorun),
    };
  },
  selector: ({ old, place }) => {
    return {
      old: { ...old, active: nodes.reaction },
      place: nextPlace(place, placeKind.selector),
    };
  },
  scheduledAutorunBody: ({ old, place }) => {
    if (!oldAnswers(old).observe) return undefined;
    const node = nodes.reaction;
    return {
      old: { ...old, active: node, autorunRun: node },
      place: nextPlace(nextPlace(place, placeKind.selector), placeKind.autorun),
    };
  },
  recipe: ({ old, place }) => {
    const answers = oldAnswers(old);
    if (answers.recipe || !answers.observe) return undefined;
    return {
      old: { ...old, active: undefined, deriving: marker, openDepth: 0 },
      place: nextPlace(place, placeKind.recipe),
    };
  },
  recipeEquals: ({ old, place }) => {
    if (old.deriving !== undefined) return undefined;
    return {
      old: { ...old, active: undefined, deriving: marker },
      place: nextPlace(place, placeKind.recipeEquals),
    };
  },
  hook: ({ old, place }) => {
    // Computed.fn has an immediate graph hook. It also clears the derivation.
    return {
      old: { ...old, active: undefined, deriving: undefined, untrackedActive: undefined },
      place: nextPlace(place, placeKind.hook),
    };
  },
  peek: ({ old, place }) => {
    if (old.active !== undefined || old.deriving === marker) return undefined;
    return {
      old: { ...old, openDepth: old.openDepth + 1 },
      place: nextPlace(place, placeKind.peek),
    };
  },
  listening: ({ old, place }) => {
    if (!oldAnswers(old).rest) return undefined;
    return { old: { ...old, draining: true }, place: nextPlace(place, placeKind.listening) };
  },
};

const idle: Old = {
  active: undefined,
  deriving: undefined,
  untrackedActive: undefined,
  autorunRun: undefined,
  openDepth: 0,
  updateDepth: 0,
  disposed: false,
  draining: false,
};

// Every step starts a fresh run or retains an existing reference. Future
// answers depend on the kind of each old node and its identity relative to
// autorunRun. No step compares the numeric depths except against zero.
// Restoring an outer frame returns exactly the state before its step.
test("reachable old-field states agree with the place word to a fixed point", () => {
  const key = ({ old, place }: Both): string =>
    JSON.stringify([
      place,
      old.active?.name,
      old.deriving?.name,
      old.untrackedActive?.name,
      old.autorunRun?.name,
      old.active === old.autorunRun,
      old.untrackedActive === old.autorunRun,
      old.openDepth > 0,
      old.updateDepth > 0,
      old.disposed,
      old.draining,
    ]);
  const queue = [
    { state: { old: idle, place: 0 }, path: "idle" },
    { state: { old: { ...idle, disposed: true }, place: placeDisposed }, path: "disposed" },
  ];
  const seen = new Set<string>(queue.map(({ state }) => key(state)));
  for (let index = 0; index < queue.length; index++) {
    const { state, path } = queue[index]!;
    const expected = oldAnswers(state.old);
    const actual = newAnswers(state.place, state.old.active !== undefined);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(JSON.stringify({ path, actual, expected }));
    }
    for (const [name, step] of Object.entries(steps)) {
      const next = step(state);
      if (next === undefined || seen.has(key(next))) continue;
      seen.add(key(next));
      queue.push({ state: next, path: `${path} > ${name}` });
    }
  }
  console.log("reachable states checked", seen.size);
  expect(seen.size).toBeGreaterThan(100);
});
