/**
 * The Node worker: `node --expose-gc <bundle> <request JSON>` prints one
 * response as JSON. V8 counts the bytes it allocates in steps of about
 * 256 KB unless the process runs with --no-inline-new, so the command line
 * takes bytes only from a launch with that flag (`runtimes.ts`).
 *
 * With two more arguments, a file and a byte interval, it samples its heap
 * while it measures and writes the heap profile to that file. Node's own
 * --heap-prof keeps only what is still alive when the process exits, and
 * each sample's garbage is collected long before then; the inspector's
 * sampler can keep what was collected as well.
 */
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { getHeapStatistics } from "node:v8";
import { type Host, measure, type Request } from "../measure.ts";

const collect = (globalThis as { gc?: () => void }).gc;
if (collect === undefined) {
  throw new Error("pinna-bench: run Node with --expose-gc");
}

/**
 * `getHeapStatistics().total_allocated_bytes` is reported by Node 26 and
 * declared by `@types/node` 26, but not by Node 22 or `@types/node` 24, which
 * a workspace can resolve beside 26. Read through this type, the worker
 * compiles against either; asked at run time, a Node without it reports no
 * bytes instead of a difference of two `undefined`s.
 */
type AllocatedCount = { readonly total_allocated_bytes?: number };

const allocatedBytes = (): number | undefined =>
  (getHeapStatistics() as unknown as AllocatedCount).total_allocated_bytes;

const node: Host = {
  now: () => performance.now(),
  ...(allocatedBytes() === undefined ? {} : { allocated: () => allocatedBytes() ?? 0 }),
  collect,
};

const [request = "", heapProfile, heapInterval] = process.argv.slice(2);

const session = heapProfile === undefined ? undefined : new Session();
if (session !== undefined) {
  session.connect();
  await session.post("HeapProfiler.enable");
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: Number(heapInterval),
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}

const response = measure(node, JSON.parse(request) as Request);

if (session !== undefined && heapProfile !== undefined) {
  const { profile } = await session.post("HeapProfiler.stopSampling");
  writeFileSync(heapProfile, JSON.stringify(profile));
  session.disconnect();
}

console.log(JSON.stringify(response));
