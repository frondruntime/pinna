import { describe, expect, test } from "bun:test";
import { Graph, readCell } from "../src/graph.ts";
import { captureReports } from "./reports.ts";

describe("the graph keeps begun hooks", () => {
  test("endBegunHooks ends each begun hook once, the last begun first", () => {
    const graph = new Graph();
    const first = graph.cell(0);
    const second = graph.cell(0);
    const events: Array<string> = [];
    graph.onObserved(first, () => () => events.push("first A"));
    graph.onObserved(second, () => () => events.push("second"));
    const stopFirst = graph.watch(() => readCell(first));
    const stopSecond = graph.watch(() => readCell(second));
    graph.onObserved(first, () => () => events.push("first B"));
    expect(graph.begunHooks.size).toBe(3);
    graph.closed = true;
    graph.endBegunHooks();
    expect(events).toEqual(["first B", "second", "first A"]);
    expect(graph.begunHooks.size).toBe(0);
    // The graph ended them: the watches stopping later end nothing again.
    stopFirst();
    stopSecond();
    expect(events).toHaveLength(3);
  });

  test("a closed graph begins no hook", () => {
    const graph = new Graph();
    const source = graph.cell(0);
    const stop = graph.watch(() => readCell(source));
    graph.closed = true;
    let began = 0;
    graph.onObserved(source, () => {
      began++;
      return undefined;
    });
    expect(began).toBe(0);
    expect(graph.begunHooks.size).toBe(0);
    stop();
  });

  test("a cleanup that throws goes aside, and the rest still end", () => {
    const graph = new Graph();
    const source = graph.cell(0);
    const ended: Array<string> = [];
    graph.onObserved(source, () => () => ended.push("kept"));
    graph.onObserved(source, () => () => {
      throw new Error("cleanup");
    });
    const stop = graph.watch(() => readCell(source));
    graph.closed = true;
    const reported = captureReports(() => graph.endBegunHooks());
    expect(ended).toEqual(["kept"]);
    expect(reported).toHaveLength(1);
    stop();
  });
});
