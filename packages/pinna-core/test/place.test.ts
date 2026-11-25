/**
 * The place word's table, checked against what the fields it replaced
 * answered. The oracle below is the old bookkeeping, written out as a model:
 * the active run (`active`) and its shape, the derivation (`deriving`, or the
 * stage marker), the run an untracked read set aside (`untrackedActive`),
 * the autorun body's run (`autorunRun`), and the realm's update and open
 * depths. Every sequence of up to four places the code can enter, from an
 * idle realm and a disposed one, must give the same answer to every question
 * `placeAllows` asks. This is the specification a port reads.
 */
import { describe, expect, test } from "bun:test";
import {
  nextPlace,
  placeAllows,
  placeDeriving,
  placeDisposed,
  placeKind,
  placeKindOf,
  placeKindShift,
  placeOpen,
  placeSelecting,
  placeShadowed,
  placeTracked,
  placeUnderSelect,
  placeUpdating,
} from "../src/graph.ts";

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
    if (!oldAnswers(old).observe) return undefined;
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
    // Hooks run from a settle, which never runs inside a derivation.
    if (old.deriving !== undefined) return undefined;
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

describe("the place word", () => {
  test("every sequence of up to four places answers as the old fields did", () => {
    const mismatches: Array<string> = [];
    let checked = 0;
    const visit = (state: Both, path: ReadonlyArray<string>): void => {
      checked++;
      const expected = oldAnswers(state.old);
      const actual = newAnswers(state.place, state.old.active !== undefined);
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        mismatches.push(
          `${path.join(" > ") || "(start)"}: old ${JSON.stringify(expected)}, word ${JSON.stringify(actual)}`,
        );
      }
      if (path.length === 5) return;
      for (const [name, step] of Object.entries(steps)) {
        const next = step(state);
        if (next !== undefined) visit(next, [...path, name]);
      }
    };
    visit({ old: idle, place: 0 }, ["idle"]);
    visit({ old: { ...idle, disposed: true }, place: placeDisposed }, ["disposed"]);
    expect(mismatches.slice(0, 10)).toEqual([]);
    expect(checked).toBeGreaterThan(10_000);
  });

  test("each kind names itself", () => {
    for (const [name, kind] of Object.entries(placeKind)) {
      // An autorun's body inside a selector is a scheduled autorun's: the table tells them apart.
      const outer = name === "scheduledAutorun" ? nextPlace(0, placeKind.selector) : 0;
      expect(placeKindOf(nextPlace(outer, kind))).toBe(name as keyof typeof placeKind);
    }
  });

  test("the numbers the hot paths enter by hand are the table's words", () => {
    // `recompute`, `runWatch`, `Reaction.track`, and `trackPending` write these out.
    expect(placeDeriving).toBe(4);
    expect(placeKindShift).toBe(12);
    expect(placeKind.compute).toBe(3);
    for (let outer = 0; outer < 1 << 16; outer += 1) {
      const word = (outer & 4095) | (((outer >>> 12) % 14) << 12);
      expect((word & 1987) | 12340).toBe(nextPlace(word, placeKind.compute));
      expect((word & 4095) | 16432).toBe(nextPlace(word, placeKind.select));
      expect((word & 4095) | 20528).toBe(nextPlace(word, placeKind.selector));
      // `Realm.update` in `pinna`.
      expect((word & 4095) | 4099).toBe(nextPlace(word, placeKind.update));
      // `ObservableRealm.peekDerived` in `pinna`, and the graph's `runHook`.
      expect((word & 4095) | 45057).toBe(nextPlace(word, placeKind.peek));
      expect((word & 771) | 40960).toBe(nextPlace(word, placeKind.hook));
    }
  });

  test("the numbers pinna's update, write, and read check by hand are the table's words", () => {
    // `Realm.assertWritable`: write allowed exactly when updating and not deriving.
    expect(placeUpdating | placeDeriving).toBe(6);
    expect(placeUpdating).toBe(2);
    // `Realm.update`'s refusal, and its disposed branch.
    expect(placeDeriving | placeSelecting | placeUnderSelect | placeDisposed).toBe(420);
    expect(placeDisposed).toBe(256);
    // `read`'s open check.
    expect(placeOpen).toBe(1);
    for (let word = 0; word < 1 << 12; word += 1) {
      expect((word & 6) === 2).toBe(placeAllows.write(word));
      expect((word & 420) === 0).toBe(placeAllows.update(word));
    }
  });

  test("an entered place leaves the outer word to be restored", () => {
    // Nothing is shared: the table is a pure function of the outer word and the kind.
    const outer = nextPlace(0, placeKind.update);
    nextPlace(outer, placeKind.compute);
    expect(placeKindOf(outer)).toBe("update");
  });
});
