/**
 * The graph benchmark inside Hermes. `hermes-graph.ts` bundles this file and
 * puts `benchSubject`, `<library>@<first scenario>`, in front of it; it
 * prints that library's measurement as JSON.
 */
import { type Host, type LibraryName, libraries, measure } from "./graph-model.ts";

declare const benchSubject: string;
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

const [library, from] = benchSubject.split("@");
print(JSON.stringify(measure(libraries[library as LibraryName], hermes, Number(from))));
