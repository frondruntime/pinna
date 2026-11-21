import { describe, expect, test } from "bun:test";
import { Graph, type Node, observerCount, readCell, readDerived, writeCell } from "../src/graph.ts";
import { captureReports } from "./reports.ts";
import { expectAtRest } from "./rest.ts";

type DependencyEdge = NonNullable<Node["cursor"]>;

/** Counts reads of the next dependency with a test-only accessor. */
const countEdgeTraversals = (edge: DependencyEdge, counted: { traversals: number }) => {
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
  return next;
};

const countTraversals = (node: Node) => {
  const counted = { traversals: 0 };
  for (let edge = node.dependenciesHead; edge !== undefined; ) {
    edge = countEdgeTraversals(edge, counted);
  }
  return counted;
};

describe("wide nested reads", () => {
  test("keeps first computed-then-source reads within the growth budget", () => {
    const countFirstRead = (width: number): number => {
      const graph = new Graph();
      const rows = Array.from({ length: width }, (_, index) => {
        const source = graph.cell(index);
        return { source, derived: graph.derived(() => 2 * readCell(source)) };
      });
      const aggregate = graph.derived(() => {
        let total = 0;
        for (const { source, derived } of rows) total += readDerived(derived) + readCell(source);
        return total;
      });
      const counted = { traversals: 0 };
      const wrapped = new WeakSet<DependencyEdge>();
      let cursor = aggregate.cursor;
      // A fresh read creates its edges as it runs. Wrap each edge as the cursor reaches it.
      Object.defineProperty(aggregate, "cursor", {
        get: () => cursor,
        set: (edge: Node["cursor"]) => {
          cursor = edge;
          if (edge === undefined || wrapped.has(edge)) return;
          countEdgeTraversals(edge, counted);
          wrapped.add(edge);
        },
      });

      expect(readDerived(aggregate)).toBe((3 * width * (width - 1)) / 2);
      const { traversals } = counted;
      let dependencies = 0;
      for (let edge = aggregate.dependenciesHead; edge !== undefined; edge = edge.nextDependency) {
        expect(wrapped.has(edge)).toBe(true);
        dependencies++;
      }
      expect(dependencies).toBe(2 * width);
      expectAtRest(graph);
      return traversals;
    };

    // Doubling the width of a head scan per row takes about four times the work.
    const narrow = countFirstRead(256);
    const wide = countFirstRead(512);
    expect(wide).toBeLessThanOrEqual(3 * narrow);
  });

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
