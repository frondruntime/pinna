/**
 * The black-box harness: a scenario builds state through the public API and
 * returns one step, which the harness runs many times. It reports what an
 * app would feel and what a long session would hold:
 *
 * - each step's time, as the median, the 99th percentile, and the worst;
 * - bytes allocated per step, garbage included, where the engine counts them;
 * - bytes live after a full collection at five checkpoints, and the growth
 *   per 1,000 steps after the first quarter, which is a leak when it does not
 *   stay near zero;
 * - collections and their total pause, where the engine reports them.
 *
 * A scenario checks its own result at the end, so a fast wrong answer fails.
 *
 * Between steps the harness lets queued microtasks run, outside the clock,
 * as an app's event loop does between two messages. Without that, work an
 * engine or a library parks on the microtask queue during a step stays live
 * for the whole run and reads as a leak.
 */

/** What the harness needs of the engine it runs on. */
export interface Host {
  /** Milliseconds, as precise as the engine allows. */
  readonly now: () => number;
  /** Bytes live after a full collection. */
  readonly live: () => number;
  /** Bytes allocated since the engine started, garbage included, where the engine counts them. */
  readonly allocated?: () => number;
  /**
   * Collections so far and their total pause in ms, where the engine reports
   * them, without the ones `live` forced.
   */
  readonly collections?: () => Collections;
}

interface Collections {
  readonly count: number;
  readonly totalMs: number;
}

/** A built scenario: the step the harness repeats, and the check after the last one. */
export interface Built {
  readonly step: (index: number) => void;
  /** Throws when the state is not what the steps should have made. */
  readonly check: () => void;
  /** Releases what the scenario holds, so a following measure starts clean. */
  readonly dispose?: () => void;
}

export interface Scenario {
  readonly name: string;
  /** What the scenario stands for in an app, one line. */
  readonly story: string;
  readonly steps: number;
  readonly build: () => Built;
}

export interface Result {
  readonly name: string;
  readonly steps: number;
  readonly buildMs: number;
  readonly totalMs: number;
  readonly medianMs: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  /** The median step of each quarter of the run: a rise means steps slow down as the run goes on. */
  readonly quarterMedianMs: ReadonlyArray<number>;
  readonly bytesPerStep?: number;
  /** KB live after the build, then after 25, 50, 75 and 100% of the steps. */
  readonly liveKB: ReadonlyArray<number>;
  /** KB of live growth per 1,000 steps, from 25% to 100% of the steps. */
  readonly growthPer1kKB: number;
  /** KB still live once the scenario is disposed and unreachable, against before the build. */
  readonly afterDisposeKB: number;
  readonly collections?: Collections;
}

const quantile = (sorted: ReadonlyArray<number>, at: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))] as number;

const kilobytes = (bytes: number): number => Math.round(bytes / 1024);

/** Resolves once every microtask queued before it has run. */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    queueMicrotask(resolve);
  });

interface Measured {
  readonly buildMs: number;
  readonly times: Float64Array;
  readonly total: number;
  readonly allocated: number;
  readonly live: ReadonlyArray<number>;
  readonly collections?: Collections;
}

/**
 * Builds and steps in its own frame, so nothing it made is reachable once it
 * returns: the live bytes measured after it are what the scenario left
 * behind.
 */
const measure = async (scenario: Scenario, host: Host): Promise<Measured> => {
  const buildStart = host.now();
  const built = scenario.build();
  const buildMs = host.now() - buildStart;
  await settle();
  const live: Array<number> = [host.live()];
  const checkpoints = [0.25, 0.5, 0.75, 1].map((share) => Math.round(scenario.steps * share));
  // Doubles in a typed array: a plain array may box each one.
  const times = new Float64Array(scenario.steps);
  const collectionsBefore = host.collections?.();
  let allocated = 0;
  let total = 0;
  let next = 0;
  for (let index = 0; index < scenario.steps; index++) {
    const allocatedBefore = host.allocated?.() ?? 0;
    const start = host.now();
    built.step(index);
    const elapsed = host.now() - start;
    allocated += (host.allocated?.() ?? 0) - allocatedBefore;
    times[index] = elapsed;
    total += elapsed;
    await settle();
    if (index + 1 === checkpoints[next]) {
      live.push(host.live());
      next++;
    }
  }
  const collectionsAfter = host.collections?.();
  built.check();
  built.dispose?.();
  await settle();
  return {
    buildMs,
    times,
    total,
    allocated,
    live,
    ...(collectionsBefore === undefined || collectionsAfter === undefined
      ? {}
      : {
          collections: {
            count: collectionsAfter.count - collectionsBefore.count,
            totalMs: Math.round((collectionsAfter.totalMs - collectionsBefore.totalMs) * 10) / 10,
          },
        }),
  };
};

export const run = async (scenario: Scenario, host: Host): Promise<Result> => {
  const baseline = host.live();
  const measured = await measure(scenario, host);
  const afterDispose = host.live();
  const sorted = Array.from(measured.times).sort((left, right) => left - right);
  const quarterStep = Math.round(scenario.steps * 0.25);
  const quarter = measured.live[1] as number;
  const end = measured.live[4] as number;
  return {
    name: scenario.name,
    steps: scenario.steps,
    buildMs: measured.buildMs,
    totalMs: measured.total,
    medianMs: quantile(sorted, 0.5),
    p99Ms: quantile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1] as number,
    quarterMedianMs: [0, 1, 2, 3].map((quarter) => {
      const length = Math.floor(scenario.steps / 4);
      const part = Array.from(measured.times.subarray(quarter * length, (quarter + 1) * length));
      return quantile(
        part.sort((left, right) => left - right),
        0.5,
      );
    }),
    ...(host.allocated === undefined
      ? {}
      : { bytesPerStep: Math.round(measured.allocated / scenario.steps) }),
    liveKB: measured.live.map((bytes) => kilobytes(bytes - baseline)),
    growthPer1kKB:
      Math.round(((end - quarter) / 1024 / (scenario.steps - quarterStep)) * 1000 * 10) / 10,
    afterDisposeKB: kilobytes(afterDispose - baseline),
    ...(measured.collections === undefined ? {} : { collections: measured.collections }),
  };
};

/** A seeded generator, so every engine and every run sees the same data. */
export const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};

/** Throws when `actual` is not `expected`. */
export const expectEqual = (actual: unknown, expected: unknown, what: string): void => {
  if (!Object.is(actual, expected)) {
    throw new Error(`blackbox: ${what} is ${String(actual)}, expected ${String(expected)}`);
  }
};
