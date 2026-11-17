/**
 * The Hermes worker. The command line puts `benchRequest` in front of this
 * bundle and runs it on the host `pinna/bench/hermes-host.cpp` builds, which
 * provides `print`, `gc`, and `now`. Hermes counts every byte it allocates,
 * garbage included.
 */
import { type Host, measure, type Request } from "../measure.ts";

declare const benchRequest: Request;
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

print(JSON.stringify(measure(hermes, benchRequest)));
