/**
 * One black-box scenario inside Hermes. `hermes-blackbox.ts` bundles this
 * file and puts `benchSubject`, the scenario's name, in front of it; it
 * prints the result as JSON.
 */
import { type Host, run } from "./harness.ts";
import { scenarioNamed } from "./scenarios.ts";

declare const benchSubject: string;
declare const print: (text: string) => void;
declare const gc: () => void;
declare const now: () => number;

interface Stats {
  readonly js_allocatedBytes: number;
  readonly js_totalAllocatedBytes: number;
  readonly js_numGCs: number;
  readonly js_gcTime: number;
}

declare const HermesInternal: { readonly getInstrumentedStats: () => Stats };

const stats = (): Stats => HermesInternal.getInstrumentedStats();

/** The collections `live` forces, kept apart from the ones the scenario caused. */
let forcedCount = 0;
let forcedSeconds = 0;

const hermes: Host = {
  now,
  live: () => {
    const before = stats();
    gc();
    gc();
    const after = stats();
    forcedCount += after.js_numGCs - before.js_numGCs;
    forcedSeconds += after.js_gcTime - before.js_gcTime;
    return after.js_allocatedBytes;
  },
  allocated: () => stats().js_totalAllocatedBytes,
  collections: () => {
    const current = stats();
    return {
      count: current.js_numGCs - forcedCount,
      totalMs: (current.js_gcTime - forcedSeconds) * 1000,
    };
  },
};

// Hermes drops an unhandled rejection without a word, so a failed scenario
// prints its error instead of nothing.
void run(scenarioNamed(benchSubject), hermes).then(
  (result) => {
    print(JSON.stringify(result));
  },
  (error: unknown) => {
    print(JSON.stringify({ error: String(error) }));
  },
);
