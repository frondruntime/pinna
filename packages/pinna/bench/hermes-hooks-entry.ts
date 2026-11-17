/**
 * The hooks benchmark inside Hermes. `hermes-hooks.ts` bundles this file and
 * puts `benchSubject` in front of it; it prints one subject's results as
 * JSON.
 */
import type { Host } from "./graph-model.ts";
import { measure, type SubjectName } from "./hooks-model.ts";

declare const benchSubject: SubjectName;
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
