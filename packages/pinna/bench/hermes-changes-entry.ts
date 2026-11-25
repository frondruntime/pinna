/**
 * The change stream benchmark inside Hermes. `hermes-changes.ts` bundles
 * this file and puts `benchSubject`, a scenario's name, in front of it; it
 * prints that scenario's numbers as JSON.
 */
import { measure, type ScenarioName } from "./change-stream-model.ts";
import type { Host } from "./graph-model.ts";

declare const benchSubject: ScenarioName;
declare const print: (text: string) => void;
declare const gc: () => void;
declare const now: () => number;
declare const HermesInternal: {
  readonly getInstrumentedStats: () => { readonly js_totalAllocatedBytes: number };
};

/** Hermes has no `performance`: the host's `now` reads a steady clock. */
const hermes: Host = {
  now,
  allocated: () => HermesInternal.getInstrumentedStats().js_totalAllocatedBytes,
  collect: gc,
};

print(JSON.stringify(measure(benchSubject, hermes)));
