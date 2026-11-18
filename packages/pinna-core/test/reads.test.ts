import { describe, expect, test } from "bun:test";
import { Graph, type Node, observerCount, readCell, readDerived, writeCell } from "../src/graph.ts";
import { captureReports } from "./reports.ts";
import { expectAtRest } from "./rest.ts";

/** Counts list traversal without a production counter or a timing threshold. */
const countTraversals = (node: Node) => {
  const counted = { traversals: 0 };
  for (let edge = node.dependenciesHead; edge !== undefined; ) {
    let next = edge.nextDependency;
    Object.defineProperty(edge, "nextDependency", {
      configurable: true,
      get: () => {
        counted.traversals++;
        return next;
      },
      set: (value: typeof next) => {
        next = value;
      },
    });
    edge = next;
  }
  return counted;
};

describe("wide nested reads", () => {
  for (const kind of ["derived", "watch"] as const) {
    for (const ending of ["stable", "drop", "throw"] as const) {
      test(`${kind} scans linearly and clears its index after a ${ending} run`, () => {
        const graph = new Graph();
        const width = 512;
        const rows = Array.from({ length: width }, (_, index) => {
          const source = graph.cell(index);
          return { source, derived: graph.derived(() => 2 * readCell(source)) };
        });
        const count = graph.cell(width);
        const failing = graph.cell(false);
        let observer: Node | undefined;
        let indexed = false;
        const compute = () => {
          observer = graph.active;
          const length = readCell(count);
          const failure = readCell(failing);
          let total = 0;
          for (let index = 0; index < length; index++) {
            const row = rows[index] as (typeof rows)[number];
            total += readCell(row.source) + readDerived(row.derived) + readCell(row.source);
          }
          indexed = observer?.readIndex !== undefined;
          if (failure) throw new Error("wide run failed");
          return total;
        };
        const aggregate = graph.derived(compute);
        const stop = graph.watch(kind === "derived" ? () => readDerived(aggregate) : compute);
        const node = observer as unknown as Node;
        const counted = countTraversals(node);
        const length = ending === "drop" ? width / 2 : width;
        const reports = captureReports(() =>
          graph.batch(() => {
            writeCell(count, length);
            writeCell(failing, ending === "throw");
            for (const row of rows) writeCell(row.source, readCell(row.source) + 1);
          }),
        );

        // A head scan per repeated read takes over width squared steps.
        expect(counted.traversals).toBeLessThan(width * 16);
        expect(indexed).toBe(true);
        expect(node.readIndex).toBeUndefined();
        expect(reports.map((error) => (error as Error).message)).toEqual(
          ending === "throw" ? ["wide run failed"] : [],
        );
        writeCell(failing, false);
        if (kind === "derived") {
          expect(readDerived(aggregate)).toBe(2 * length * (length + 1));
        }
        for (let index = 0; index < width; index++) {
          const row = rows[index] as (typeof rows)[number];
          expect(observerCount(row.source)).toBe(index < length ? 2 : 0);
        }
        stop();
        expect(node.readIndex).toBeUndefined();
        expectAtRest(graph);
      });
    }
  }
});
