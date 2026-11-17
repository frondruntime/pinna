/**
 * What each React hook asks of Pinna, without React: the stores of
 * `pinna-react/src/index.ts`, driven the way React 19's production
 * `useSyncExternalStore` drives them. React DOM does not run on bare Hermes,
 * so this is the part of a row's cost that is Pinna's; `hermes-hooks.ts` runs
 * it on Bun and on Hermes.
 *
 * - A mount renders (one snapshot), runs `useSelect`'s layout effect,
 *   subscribes, and checks the snapshot once more, as React's passive
 *   effect does.
 * - A change calls the listener, which reads the snapshot as React's
 *   `handleStoreChange` does; the render that follows reads it again.
 *
 * Each form runs twice. "Before" is the store of 2877e3a, which every form
 * used: a read run with `trackPending` on each render and linked with `adopt`
 * in a layout effect, given a new read function each render. It is
 * `useSelect`'s store today, unchanged. The other is the store each form
 * has since ba6c982.
 */
import { Reaction } from "@frondruntime/pinna-core";
import {
  type Box,
  box,
  type Computed,
  computed,
  createRealm,
  type Read,
  type Realm,
  update,
} from "../src/index.ts";
import { peek, realmOf } from "../src/internal/index.ts";
import type { Host, Measured } from "./graph-model.ts";

/** A row of the app: two boxes and the computed value of their sum; `$b` stays 0, so every hook shows `$a`. */
interface Row {
  readonly $a: Box<number>;
  readonly $b: Box<number>;
  readonly $sum: Computed<number>;
}

/** A mounted hook: what React calls on a later render, and on unmount. */
interface Mounted {
  readonly render: () => number;
  readonly unmount: () => void;
}

/** Mounts a hook on `row`; `changed` stands for React scheduling a render. */
type Hook = (row: Row, changed: () => void) => Mounted;

/** The store of `useValue` and `useValues` since ba6c982 (`SourceStore`). */
const sourceHook =
  <Result>(
    observables: (row: Row) => ReadonlyArray<Computed<unknown>>,
    snapshot: (observables: ReadonlyArray<Computed<unknown>>) => () => Result,
    tracker: (observables: ReadonlyArray<Computed<unknown>>) => (read: Read) => unknown,
    toNumber: (result: Result) => number,
  ): Hook =>
  (row, changed) => {
    const followed = observables(row);
    const getSnapshot = snapshot(followed);
    const track = tracker(followed);
    let rendered = getSnapshot();
    const listener = (): void => {
      const next = getSnapshot();
      if (!Object.is(next, rendered)) {
        changed();
      }
    };
    const reaction = new Reaction(
      realmOf(followed[0] as Computed<unknown>).core,
      () => {
        reaction.track(track);
        listener();
      },
      "useValue",
    );
    reaction.track(track);
    if (reaction.activate()) {
      listener();
    }
    rendered = getSnapshot();
    return {
      render: () => {
        rendered = getSnapshot();
        return toNumber(rendered);
      },
      unmount: () => reaction.deactivate(),
    };
  };

const sameElements = (previous: ReadonlyArray<unknown>, next: ReadonlyArray<unknown>): boolean =>
  previous.length === next.length &&
  previous.every((element, index) => Object.is(element, next[index]));

/**
 * The store of every form at 2877e3a, and of `useSelect` today
 * (`SelectStore`). `reader` makes the read function a render passes.
 */
const trackedHook =
  <Result>(
    reader: (row: Row) => (read: Read) => Result,
    equals: (previous: Result, next: Result) => boolean,
    toNumber: (result: Result) => number,
  ): Hook =>
  (row, changed) => {
    let select = reader(row);
    let version = 0;
    let result: Result | undefined;
    let hasResult = false;
    let renders = 0;
    let pendingRender = 0;
    let keptRender = 0;
    let renderedVersion = 0;
    const notify = (): void => {
      version++;
      // `handleStoreChange` reads the snapshot.
      if (version !== renderedVersion) {
        changed();
      }
    };
    const run = (read: Read): Result => select(read);
    const reaction = new Reaction(
      realmOf(row.$a).core,
      () => {
        const next = reaction.track(run);
        if (!hasResult || !equals(result as Result, next)) {
          result = next;
          hasResult = true;
          notify();
        }
      },
      "useSelect",
    );
    const render = (): Result => {
      renderedVersion = version;
      const renderRead = reader(row);
      const next = reaction.trackPending(renderRead);
      pendingRender = ++renders;
      const value = hasResult && equals(result as Result, next) ? (result as Result) : next;
      // The layout effect.
      if (renders !== keptRender) {
        keptRender = renders;
        select = renderRead;
        result = value;
        hasResult = true;
        if (renders === pendingRender && reaction.adopt()) {
          notify();
        }
      }
      return value;
    };
    render();
    if (reaction.activate()) {
      notify();
    }
    return {
      render: () => toNumber(render()),
      unmount: () => reaction.deactivate(),
    };
  };

const sameValue = (previous: number, next: number): boolean => Object.is(previous, next);
const asNumber = (value: number): number => value;
const firstOf = (values: ReadonlyArray<unknown>): number => values[0] as number;

export const subjects = {
  "useValue($box) before": trackedHook((row) => (read) => read(row.$a), sameValue, asNumber),
  "useValue($box)": sourceHook(
    (row) => [row.$a],
    ([observable]) =>
      () =>
        peek(observable as Computed<number>),
    ([observable]) =>
      (read) =>
        read(observable as Computed<number>),
    asNumber,
  ),
  "useValue($computed) before": trackedHook((row) => (read) => read(row.$sum), sameValue, asNumber),
  "useValue($computed)": sourceHook(
    (row) => [row.$sum],
    ([observable]) =>
      () =>
        peek(observable as Computed<number>),
    ([observable]) =>
      (read) =>
        read(observable as Computed<number>),
    asNumber,
  ),
  "useValues([$a, $b]) before": trackedHook(
    (row) => {
      const observables = [row.$a, row.$b];
      return (read) => observables.map((observable) => read(observable));
    },
    sameElements,
    firstOf,
  ),
  "useValues([$a, $b])": sourceHook(
    (row) => [row.$a, row.$b],
    (observables) => {
      let values: ReadonlyArray<unknown> = [];
      return () => {
        let next: Array<unknown> | undefined;
        for (let index = 0; index < observables.length; index++) {
          const value = peek(observables[index] as Computed<unknown>);
          if (next === undefined) {
            if (index < values.length && Object.is(values[index], value)) {
              continue;
            }
            next = values.slice(0, index);
          }
          next.push(value);
        }
        if (next !== undefined) {
          values = next;
        }
        return values;
      };
    },
    (observables) => (read) => {
      for (let index = 0; index < observables.length; index++) {
        read(observables[index] as Computed<unknown>);
      }
    },
    firstOf,
  ),
} as const satisfies Record<string, Hook>;

export type SubjectName = keyof typeof subjects;

const runs = 9;

const middle = (values: Array<number>): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] as number;
};

const makeRows = (realm: Realm, count: number): Array<Row> =>
  Array.from({ length: count }, () => {
    const $a = box(realm, 1);
    const $b = box(realm, 0);
    const $sum = computed(realm, (read) => read($a) + read($b));
    return { $a, $b, $sum };
  });

/** Runs `measured` after `setup`, `runs` times, and keeps the numbers. */
const measureOne = (host: Host, setup: () => () => void): Measured => {
  const times: Array<number> = [];
  const bytes: Array<number> = [];
  for (let run = 0; run < runs; run++) {
    const measured = setup();
    host.collect();
    const allocatedBefore = host.allocated?.() ?? 0;
    const start = host.now();
    measured();
    times.push(host.now() - start);
    bytes.push((host.allocated?.() ?? 0) - allocatedBefore);
  }
  return {
    minimum: Math.min(...times),
    median: middle(times),
    ...(host.allocated === undefined ? {} : { bytes: middle(bytes) }),
  };
};

const expect = (actual: number, expected: number, scenario: string): void => {
  if (actual !== expected) {
    throw new Error(`bench: ${scenario} saw ${actual}, expected ${expected}`);
  }
};

/** Mounts `count` rows and unmounts them. */
const mount = (host: Host, hook: Hook, count: number): Measured =>
  measureOne(host, () => {
    const rows = makeRows(createRealm(), count);
    return () => {
      const mounted = rows.map((row) => hook(row, () => {}));
      for (const each of mounted) {
        each.unmount();
      }
    };
  });

/** Writes `$a` of `ticking` of `count` mounted rows, `passes` times, and renders the rows that changed. */
const tick = (
  host: Host,
  hook: Hook,
  count: number,
  ticking: number,
  passes: number,
  scenario: string,
): Measured =>
  measureOne(host, () => {
    const realm = createRealm();
    const rows = makeRows(realm, count);
    const dirty: Array<Mounted> = [];
    const mounted: Array<Mounted> = [];
    for (const row of rows) {
      const index = mounted.length;
      mounted.push(hook(row, () => dirty.push(mounted[index] as Mounted)));
    }
    return () => {
      for (let pass = 0; pass < passes; pass++) {
        update(realm, (read, write) => {
          for (let index = 0; index < ticking; index++) {
            const row = rows[index] as Row;
            write(row.$a, read(row.$a) + 1);
          }
        });
        expect(dirty.length, ticking, scenario);
        let total = 0;
        for (const each of dirty) {
          total += each.render();
        }
        expect(total, ticking * (pass + 2), scenario);
        dirty.length = 0;
      }
    };
  });

export const measure = (name: SubjectName, host: Host): Record<string, Measured> => {
  const hook: Hook = subjects[name];
  const scenarios: Record<string, () => Measured> = {
    "mount and unmount 1000 rows": () => mount(host, hook, 1000),
    "mount and unmount 10000 rows": () => mount(host, hook, 10_000),
    "1000 rows: every row ticks ×100": () =>
      tick(host, hook, 1000, 1000, 100, "1000 rows: every row ticks ×100"),
    "10000 rows: every row ticks ×10": () =>
      tick(host, hook, 10_000, 10_000, 10, "10000 rows: every row ticks ×10"),
    "10000 rows: one row ticks ×1000": () =>
      tick(host, hook, 10_000, 1, 1000, "10000 rows: one row ticks ×1000"),
  };
  return Object.fromEntries(Object.entries(scenarios).map(([scenario, run]) => [scenario, run()]));
};
