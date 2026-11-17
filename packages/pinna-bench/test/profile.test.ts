import { describe, expect, test } from "bun:test";
import {
  type CallFrame,
  type CpuProfile,
  type HeapNode,
  locationOf,
  printCpu,
  printHeap,
  profileName,
  summarizeCpu,
  summarizeHeap,
} from "../src/profile.ts";

const bundle = "file:///tmp/profiles/worker-node.mjs";

const frame = (functionName: string, url = "", lineNumber = -1): CallFrame => ({
  functionName,
  url,
  lineNumber,
  columnNumber: 0,
});

/**
 * `propagate` is reached from two callers, so it has two nodes; ticks land
 * in it, in `(garbage collector)`, and in `(program)`, but none in `(idle)`.
 */
const cpu: CpuProfile = {
  nodes: [
    { id: 1, callFrame: frame("(root)"), children: [2, 5, 6] },
    { id: 2, callFrame: frame("run", bundle, 9), children: [3, 4] },
    { id: 3, callFrame: frame("propagate", bundle, 99) },
    { id: 4, callFrame: frame("", bundle, 19), children: [7] },
    { id: 5, callFrame: frame("(garbage collector)") },
    { id: 6, callFrame: frame("(program)") },
    { id: 7, callFrame: frame("propagate", bundle, 99) },
  ],
  startTime: 0,
  endTime: 1000,
  samples: [3, 7, 3, 5, 6, 4, 2],
  timeDeltas: [100, 200, 300, 150, 50, 40, 160],
};

describe("summarizeCpu", () => {
  const summary = summarizeCpu(cpu, 3);

  test("sums self time by function across the nodes that reach it", () => {
    expect(summary.ticks).toBe(7);
    expect(summary.milliseconds).toBe(1);
    expect(summary.top).toEqual([
      { name: "propagate", location: "worker-node.mjs:100", milliseconds: 0.6, share: 0.6 },
      { name: "run", location: "worker-node.mjs:10", milliseconds: 0.16, share: 0.16 },
      { name: "(garbage collector)", location: "", milliseconds: 0.15, share: 0.15 },
    ]);
  });

  test("keeps the engine's own entries, those it has, even below the top", () => {
    expect(summary.engine.map((entry) => entry.name)).toEqual(["(garbage collector)", "(program)"]);
    const printed = printCpu(summary);
    expect(printed).toContain("7 ticks over 1.0 ms");
    expect(printed).toMatch(/below the top:\n\s+0\.05\s+5\.0%\s+\(program\)/);
  });

  test("names an anonymous function so", () => {
    expect(summarizeCpu(cpu, 10).top.map((entry) => entry.name)).toContain("(anonymous)");
  });
});

const node = (
  name: string,
  selfSize: number,
  children: ReadonlyArray<HeapNode> = [],
  lineNumber = 0,
): HeapNode => ({ callFrame: frame(name, bundle, lineNumber), selfSize, children });

describe("summarizeHeap", () => {
  const head: HeapNode = {
    callFrame: frame("(root)"),
    selfSize: 0,
    children: [
      node("measure", 100, [
        node("setup", 0, [node("box", 600, [], 41)]),
        node("run", 0, [node("write", 200, [node("box", 100, [], 41)])]),
      ]),
    ],
  };
  const summary = summarizeHeap({ head, samples: [1, 2, 3] }, 3, 2);

  test("ranks call paths by self bytes, each with its nearest callers", () => {
    expect(summary.bytes).toBe(1000);
    expect(summary.samples).toBe(3);
    expect(summary.top).toEqual([
      {
        name: "box",
        location: "worker-node.mjs:42",
        bytes: 600,
        share: 0.6,
        path: ["setup worker-node.mjs:1", "measure worker-node.mjs:1"],
      },
      {
        name: "write",
        location: "worker-node.mjs:1",
        bytes: 200,
        share: 0.2,
        path: ["run worker-node.mjs:1", "measure worker-node.mjs:1"],
      },
      { name: "measure", location: "worker-node.mjs:1", bytes: 100, share: 0.1, path: [] },
    ]);
  });

  test("prints kilobytes, shares, and the path", () => {
    const printed = printHeap(summary);
    expect(printed).toContain("3 samples, 1.0 KiB sampled");
    expect(printed).toContain("< setup worker-node.mjs:1 < measure worker-node.mjs:1");
  });
});

test("a location names the file's last segment and a one-based line", () => {
  expect(locationOf(frame("f", "node:internal/streams/readable", 4))).toBe("readable:5");
  expect(locationOf(frame("(program)"))).toBe("");
});

test("a profile file is named for its cell", () => {
  expect(profileName("cpu", { scenario: "increment", library: "pinna" })).toBe(
    "increment-pinna.cpuprofile",
  );
  expect(profileName("heap", { scenario: "increment", library: "pinna" })).toBe(
    "increment-pinna.heapprofile",
  );
});
