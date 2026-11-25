/**
 * The graph checker itself: it passes a sound graph and names each broken
 * invariant it is handed, so a check that passes means something.
 */
import { describe, expect, test } from "bun:test";
import { Graph, Reaction, readCell, readDerived, writeCell } from "../src/graph.ts";
import { checkGraph, madeNodes } from "./checker.ts";
import { expectAtRest } from "./rest.ts";

const build = () => {
  const graph = new Graph();
  const a = graph.cell(1, { label: "a" });
  const b = graph.cell(2, { label: "b" });
  const sum = graph.derived(() => readCell(a) + readCell(b), { label: "sum" });
  const stop = graph.watch(() => readDerived(sum));
  return { graph, a, b, sum, stop };
};

describe("graph checker", () => {
  test("a sound graph passes, observed and after its watch stops", () => {
    const { graph, a, sum, stop } = build();
    expect(checkGraph([sum])).toEqual([]);
    writeCell(a, 5);
    expectAtRest(graph);
    stop();
    expect(checkGraph([sum])).toEqual([]);
    expect(madeNodes(graph).size).toBe(3);
  });

  test("a reaction's edges are checked through its sources", () => {
    const graph = new Graph();
    const a = graph.cell(1, { label: "a" });
    const reaction = new Reaction(graph, () => {});
    reaction.track(() => readCell(a));
    expect(checkGraph([a])).toEqual([]);
    reaction.deactivate();
    expect(checkGraph([a])).toEqual([]);
  });

  test("an observer count that disagrees with the list fails", () => {
    const { a } = build();
    a.observers++;
    expect(checkGraph([a])).toContain("cell a: observers is 2, its list holds 1");
  });

  test("an edge linked and not listed fails", () => {
    const { a, sum } = build();
    a.observersHead = undefined;
    a.observersTail = undefined;
    a.observers = 0;
    const problems = checkGraph([sum]);
    expect(problems).toContain("derived sum: an edge to cell a is linked and not listed");
  });

  test("an unobserved derived value marked dirty fails", () => {
    const { sum, stop } = build();
    stop();
    sum.linked = true;
    expect(checkGraph([sum])).toContain("derived sum: dirty with no observer");
  });

  test("an atom whose volatile mark disagrees with its observers fails", () => {
    const graph = new Graph();
    const atom = graph.atom();
    atom.volatile = false;
    expect(checkGraph([atom])).toContain("atom (no label): volatile is false with 0 observers");
  });
});
