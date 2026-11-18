/**
 * What a worker does: measure one cell, one library on one scenario, in a
 * process of its own, and say what it saw. The command line starts the
 * process, picks the stopping rule, and does the statistics; this file only
 * samples.
 *
 * Plain code, bundled into the workers: no `effect`.
 */
import type { LibraryName } from "./adapter.ts";
import { libraries } from "./libraries/index.ts";
import { scenarios } from "./scenarios.ts";
import { relativeWidth } from "./statistics.ts";

/** What a benchmark needs of the engine it runs on. */
export interface Host {
  /** Milliseconds, as precise as the engine allows. */
  readonly now: () => number;
  /** Bytes allocated since the engine started, garbage included, where the engine counts them. */
  readonly allocated?: () => number;
  /** A full collection, so one sample's garbage is not collected in the next. */
  readonly collect: () => void;
}

/** One cell and when to stop sampling it. */
export interface Request {
  readonly library: LibraryName;
  readonly scenario: string;
  /** Samples taken first and reported apart, while a JIT warms up. */
  readonly warmup: number;
  /** Samples always taken after the warm-up. */
  readonly minimum: number;
  /** Samples never exceeded after the warm-up. */
  readonly maximum: number;
  /** Milliseconds of wall time after which sampling stops, once `minimum` is met. */
  readonly budget: number;
  /**
   * Sampling stops early, once `minimum` is met, when the 95% interval of
   * the median is within this fraction of the median.
   */
  readonly precision: number;
}

export type Response =
  | {
      readonly _tag: "Measured";
      /** Milliseconds per sample, warm-up first. */
      readonly times: ReadonlyArray<number>;
      /** Bytes allocated per sample, where the host counts them. */
      readonly bytes?: ReadonlyArray<number>;
      readonly warmup: number;
    }
  | { readonly _tag: "Failed"; readonly failure: "stack overflow" };

/** True when `error` is the engine running out of stack. */
const overflowed = (error: unknown): boolean =>
  error instanceof RangeError && /call stack|stack size/i.test(error.message);

/**
 * Samples one cell: each sample builds the scenario's graph, collects, and
 * times one run. A run out of stack ends the cell as a failure: a deep chain
 * recomputes recursively in some libraries, and Hermes's stack is short.
 * Any other error stops the worker.
 *
 * The library's instance is made once and serves every sample, warm-up
 * included, as an application keeps one realm for its whole life. Each
 * sample builds a new graph in it; the previous sample's graph is garbage
 * by the collection.
 */
export const measure = (host: Host, request: Request): Response => {
  const library = libraries[request.library];
  const scenario = scenarios.find((each) => each.id === request.scenario);
  if (library === undefined || scenario === undefined) {
    throw new Error(`pinna-bench: no cell ${request.library} × ${request.scenario}`);
  }
  const instance = library.make();
  const times: Array<number> = [];
  const bytes: Array<number> = [];
  const started = host.now();
  for (;;) {
    const measured = times.length - request.warmup;
    if (measured >= request.maximum) {
      break;
    }
    if (measured >= request.minimum) {
      const timed = times.slice(request.warmup);
      if (host.now() - started >= request.budget || relativeWidth(timed) <= request.precision) {
        break;
      }
    }
    try {
      const run = scenario.setup(instance);
      host.collect();
      // Both counter reads sit right around the run, so the bytes counted
      // are the run's and the clock's, not the arrays' that store them.
      const allocatedBefore = host.allocated?.() ?? 0;
      const start = host.now();
      run();
      const end = host.now();
      const allocatedAfter = host.allocated?.() ?? 0;
      times.push(end - start);
      bytes.push(allocatedAfter - allocatedBefore);
    } catch (error) {
      if (overflowed(error)) {
        return { _tag: "Failed", failure: "stack overflow" };
      }
      throw error;
    }
  }
  return {
    _tag: "Measured",
    times,
    ...(host.allocated === undefined ? {} : { bytes }),
    warmup: request.warmup,
  };
};
