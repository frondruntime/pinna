/**
 * Reading the profiles `--profile` makes, so the command line can print what
 * a profiled cell spent its time or its bytes on without another tool.
 *
 * Command-line side, but plain functions on plain JSON so the tests can call
 * them on small profiles written by hand.
 */

export type ProfileMode = "cpu" | "heap";

/** The file a profiled cell writes, named so the command line can find it. */
export const profileName = (
  mode: ProfileMode,
  cell: { readonly scenario: string; readonly library: string },
): string => `${cell.scenario}-${cell.library}.${mode === "cpu" ? "cpuprofile" : "heapprofile"}`;

/** Where a function is, as V8 reports it: lines and columns count from zero. */
export interface CallFrame {
  readonly functionName: string;
  readonly url: string;
  readonly lineNumber: number;
  readonly columnNumber: number;
}

/** A `.cpuprofile`: a call tree, and which of its nodes each tick landed in. */
export interface CpuProfile {
  readonly nodes: ReadonlyArray<{
    readonly id: number;
    readonly callFrame: CallFrame;
    readonly children?: ReadonlyArray<number>;
  }>;
  readonly startTime: number;
  readonly endTime: number;
  /** The node id of each tick. */
  readonly samples: ReadonlyArray<number>;
  /** Microseconds before each tick, since the previous one or the start. */
  readonly timeDeltas: ReadonlyArray<number>;
}

/** A `.heapprofile`: a call tree whose nodes carry the bytes sampled in them. */
export interface HeapNode {
  readonly callFrame: CallFrame;
  readonly selfSize: number;
  readonly children: ReadonlyArray<HeapNode>;
}

export interface HeapProfile {
  readonly head: HeapNode;
  readonly samples?: ReadonlyArray<unknown>;
}

/** The lines V8 names in parentheses, which a reader looks for first. */
const engineEntries = ["(program)", "(idle)", "(garbage collector)"];

const nameOf = (frame: CallFrame): string =>
  frame.functionName === "" ? "(anonymous)" : frame.functionName;

/** `file:line`, one-based, with the file's last path segment only; empty for native code. */
export const locationOf = (frame: CallFrame): string =>
  frame.url === "" ? "" : `${frame.url.split("/").at(-1)}:${frame.lineNumber + 1}`;

const keyOf = (frame: CallFrame): string =>
  `${frame.functionName}\u0000${frame.url}\u0000${frame.lineNumber}\u0000${frame.columnNumber}`;

const percent = (part: number, whole: number): string =>
  `${whole === 0 ? "0.0" : ((part / whole) * 100).toFixed(1)}%`;

export interface CpuEntry {
  readonly name: string;
  readonly location: string;
  readonly milliseconds: number;
  readonly share: number;
}

export interface CpuSummary {
  readonly ticks: number;
  readonly milliseconds: number;
  /** The `count` functions with the most self time, heaviest first. */
  readonly top: ReadonlyArray<CpuEntry>;
  /** `(program)`, `(idle)`, and `(garbage collector)`, those the profile has. */
  readonly engine: ReadonlyArray<CpuEntry>;
}

/**
 * Self time by function, summed over every node of the tree that calls it
 * from somewhere: each tick gets the time since the tick before it.
 */
export const summarizeCpu = (profile: CpuProfile, count: number): CpuSummary => {
  const frames = new Map(profile.nodes.map((node) => [node.id, node.callFrame]));
  const byFunction = new Map<string, { frame: CallFrame; microseconds: number }>();
  let total = 0;
  profile.samples.forEach((id, index) => {
    const frame = frames.get(id);
    const delta = profile.timeDeltas[index] ?? 0;
    if (frame === undefined) {
      return;
    }
    total += delta;
    const key = keyOf(frame);
    const seen = byFunction.get(key);
    if (seen === undefined) {
      byFunction.set(key, { frame, microseconds: delta });
    } else {
      seen.microseconds += delta;
    }
  });
  const entries = [...byFunction.values()]
    .map(
      ({ frame, microseconds }): CpuEntry => ({
        name: nameOf(frame),
        location: locationOf(frame),
        milliseconds: microseconds / 1000,
        share: total === 0 ? 0 : microseconds / total,
      }),
    )
    .sort((left, right) => right.milliseconds - left.milliseconds);
  return {
    ticks: profile.samples.length,
    milliseconds: total / 1000,
    top: entries.slice(0, count),
    engine: entries.filter((entry) => engineEntries.includes(entry.name)),
  };
};

export const printCpu = (summary: CpuSummary): string => {
  const line = (entry: CpuEntry) =>
    `${entry.milliseconds.toFixed(2).padStart(10)} ${percent(entry.share, 1).padStart(6)}  ` +
    `${entry.name.padEnd(36)} ${entry.location}`;
  const missing = summary.engine.filter((entry) => !summary.top.includes(entry));
  return [
    `${summary.ticks} ticks over ${summary.milliseconds.toFixed(1)} ms`,
    `${"self ms".padStart(10)} ${"share".padStart(6)}  ${"function".padEnd(36)} location`,
    ...summary.top.map(line),
    ...(missing.length === 0 ? [] : ["below the top:", ...missing.map(line)]),
  ].join("\n");
};

export interface HeapEntry {
  readonly name: string;
  readonly location: string;
  readonly bytes: number;
  readonly share: number;
  /** The callers, nearest first: `name location` each. */
  readonly path: ReadonlyArray<string>;
}

export interface HeapSummary {
  readonly samples: number | undefined;
  readonly bytes: number;
  /** The `count` call paths with the most bytes sampled in their last frame, heaviest first. */
  readonly top: ReadonlyArray<HeapEntry>;
}

/**
 * Self bytes by node of the tree, so one function reached two ways shows
 * twice, each with the `depth` callers that lead to it.
 */
export const summarizeHeap = (profile: HeapProfile, count: number, depth: number): HeapSummary => {
  const found: Array<{ node: HeapNode; callers: ReadonlyArray<HeapNode> }> = [];
  let total = 0;
  const visit = (node: HeapNode, callers: ReadonlyArray<HeapNode>) => {
    total += node.selfSize;
    if (node.selfSize > 0) {
      found.push({ node, callers });
    }
    const below = [node, ...callers];
    for (const child of node.children) {
      visit(child, below);
    }
  };
  visit(profile.head, []);
  const top = found
    .sort((left, right) => right.node.selfSize - left.node.selfSize)
    .slice(0, count)
    .map(
      ({ node, callers }): HeapEntry => ({
        name: nameOf(node.callFrame),
        location: locationOf(node.callFrame),
        bytes: node.selfSize,
        share: total === 0 ? 0 : node.selfSize / total,
        path: callers
          .filter((caller) => caller.callFrame.functionName !== "(root)")
          .slice(0, depth)
          .map((caller) => `${nameOf(caller.callFrame)} ${locationOf(caller.callFrame)}`.trim()),
      }),
    );
  return { samples: profile.samples?.length, bytes: total, top };
};

export const printHeap = (summary: HeapSummary): string => {
  const line = (entry: HeapEntry) =>
    `${(entry.bytes / 1024).toFixed(1).padStart(10)} ${percent(entry.share, 1).padStart(6)}  ` +
    `${`${entry.name} ${entry.location}`.trim()}\n${" ".repeat(20)}< ${entry.path.join(" < ")}`;
  return [
    `${summary.samples === undefined ? "" : `${summary.samples} samples, `}` +
      `${(summary.bytes / 1024).toFixed(1)} KiB sampled`,
    `${"self KiB".padStart(10)} ${"share".padStart(6)}  function location, then its callers`,
    ...summary.top.map(line),
  ].join("\n");
};
