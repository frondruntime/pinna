import { type Api, type Check, execute } from "./interpret.ts";
import { generate, type Operation, type Program } from "./program.ts";

export interface Difference {
  readonly index: number;
  readonly ours: string | undefined;
  readonly reference: string | undefined;
}

/** The first entry where two traces part, if they do. */
export const firstDifference = (
  ours: ReadonlyArray<string>,
  reference: ReadonlyArray<string>,
): Difference | undefined => {
  const length = Math.max(ours.length, reference.length);
  for (let index = 0; index < length; index++) {
    if (ours[index] !== reference[index]) {
      return { index, ours: ours[index], reference: reference[index] };
    }
  }
  return undefined;
};

/**
 * `PINNA_FUZZ_IGNORE_RUNS=1` drops what only says that a compute ran, for a
 * rewrite that may recompute differently as long as every observable result
 * is the same: the "run nN" entries, the "nN recovered from" entries a
 * compute logs as it runs, and the reason of an inspect, which names the
 * last run.
 */
const ignoreRuns = (): boolean => process.env["PINNA_FUZZ_IGNORE_RUNS"] === "1";

const withoutRuns = (trace: ReadonlyArray<string>): Array<string> =>
  trace
    .filter((entry) => !entry.startsWith("run ") && !entry.includes(" recovered from "))
    .map((entry) => (entry.startsWith("inspect ") ? entry.replace(/ reason=.*$/, "") : entry));

/**
 * `PINNA_FUZZ_IGNORE_ORDER=1` sorts the entries between two "-- " markers,
 * so each top-level operation and each snapshot compares as a multiset: for
 * a rewrite that may mark the readers of one write in another order, which
 * changes the order watchers run in but not how often or with what value.
 * A watch effect that writes makes the order matter: the watchers after it
 * see its write in the same round, so another watcher may run once where it
 * ran twice, and two such effects writing one box leave the last write. So
 * in this mode every watch effect that writes logs only.
 */
const ignoreOrder = (): boolean => process.env["PINNA_FUZZ_IGNORE_ORDER"] === "1";

const withoutOrder = (trace: ReadonlyArray<string>): Array<string> => {
  const sorted: Array<string> = [];
  let segment: Array<string> = [];
  for (const entry of trace) {
    if (entry.startsWith("-- ")) {
      sorted.push(...segment.sort(), entry);
      segment = [];
    } else {
      segment.push(entry);
    }
  }
  sorted.push(...segment.sort());
  return sorted;
};

/** The operations with every watch effect that writes made to log only. */
const loggingOnly = (operations: ReadonlyArray<Operation>): ReadonlyArray<Operation> =>
  operations.map((operation) =>
    operation.kind === "watch" && operation.effect.kind === "write"
      ? { ...operation, effect: { kind: "log" } }
      : operation.kind === "update"
        ? { ...operation, items: loggingOnly(operation.items) }
        : operation,
  );

const traceOf = (program: Program, api: Api, check?: Check): Array<string> => {
  const trace = execute(program, api, check);
  const counted = ignoreRuns() ? withoutRuns(trace) : trace;
  return ignoreOrder() ? withoutOrder(counted) : counted;
};

export const differs = (program: Program, ours: Api, reference: Api, check?: Check): boolean =>
  firstDifference(traceOf(program, ours, check), traceOf(program, reference)) !== undefined;

/** Every program one operation smaller: one removed, at the top or inside an update. */
const smaller = function* (
  operations: ReadonlyArray<Operation>,
): Generator<ReadonlyArray<Operation>> {
  for (let index = 0; index < operations.length; index++) {
    yield [...operations.slice(0, index), ...operations.slice(index + 1)];
  }
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index];
    if (operation?.kind === "update") {
      for (const items of smaller(operation.items)) {
        yield [
          ...operations.slice(0, index),
          { ...operation, items },
          ...operations.slice(index + 1),
        ];
      }
    }
  }
};

/** Removes operations one at a time while the two implementations still differ. */
export const shrink = (program: Program, ours: Api, reference: Api, check?: Check): Program => {
  let current = program;
  let progress = true;
  while (progress) {
    progress = false;
    for (const operations of smaller(current.operations)) {
      const candidate = { ...current, operations };
      if (differs(candidate, ours, reference, check)) {
        current = candidate;
        progress = true;
        break;
      }
    }
  }
  return current;
};

export interface Mismatch {
  readonly seed: number;
  readonly difference: Difference;
  readonly shrunk: Program;
  readonly shrunkDifference: Difference;
}

/** Runs one seed against both implementations; on a mismatch, shrinks it. */
/**
 * Compares one seed's program; `check` runs on this checkout's graph after
 * each operation (`test/internal/graph-check.ts`), so a broken invariant is
 * a mismatch too.
 */
export const checkSeed = (
  seed: number,
  ours: Api,
  reference: Api,
  check?: Check,
): Mismatch | undefined => {
  const generated = generate(seed);
  const program = ignoreOrder()
    ? { ...generated, operations: loggingOnly(generated.operations) }
    : generated;
  const difference = firstDifference(traceOf(program, ours, check), traceOf(program, reference));
  if (difference === undefined) {
    return undefined;
  }
  const shrunk = shrink(program, ours, reference, check);
  const shrunkDifference = firstDifference(
    traceOf(shrunk, ours, check),
    traceOf(shrunk, reference),
  );
  return { seed, difference, shrunk, shrunkDifference: shrunkDifference ?? difference };
};

export const report = (mismatch: Mismatch): string =>
  [
    `MISMATCH at seed ${mismatch.seed}`,
    `first differing trace entry (index ${mismatch.difference.index}, full program):`,
    `  ours:      ${mismatch.difference.ours}`,
    `  reference: ${mismatch.difference.reference}`,
    `shrunk to ${mismatch.shrunk.operations.length} operations; first difference (index ${mismatch.shrunkDifference.index}):`,
    `  ours:      ${mismatch.shrunkDifference.ours}`,
    `  reference: ${mismatch.shrunkDifference.reference}`,
    "shrunk program:",
    JSON.stringify(mismatch.shrunk, undefined, 1),
  ].join("\n");
