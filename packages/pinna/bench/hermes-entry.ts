/**
 * The data benchmark inside Hermes. `hermes.ts` bundles this file and puts
 * `benchSubject` in front of it; it prints one subject's results as JSON.
 */
import { type Host, measure, subjects } from "./data-model.ts";

declare const benchSubject: keyof typeof subjects;
declare const print: (text: string) => void;
declare const gc: () => void;
declare const now: () => number;
declare const HermesInternal: {
  readonly getInstrumentedStats: () => { readonly js_allocatedBytes: number };
};

/** Keeps measured values alive until the run ends. */
const kept: Array<unknown> = [];

const allocated = (): number => {
  gc();
  gc();
  return HermesInternal.getInstrumentedStats().js_allocatedBytes;
};

/** Hermes has no `performance`: the host's `now` reads a steady clock. */
const hermes: Host = {
  now,
  retained: (make) => {
    const before = allocated();
    kept.push(make());
    return `${((allocated() - before) / 1_048_576).toFixed(1)} MB`;
  },
};

print(JSON.stringify(measure(subjects[benchSubject], hermes)));
