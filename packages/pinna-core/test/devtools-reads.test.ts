import { describe, expect, test } from "bun:test";
import {
  dependenciesOf,
  Graph,
  heldValue,
  kindOf,
  observersOf,
  Reaction,
  readAtom,
  readCell,
  readDerived,
  sourcesOf,
  writeCell,
} from "../src/graph.ts";
import { expectAtRest } from "./rest.ts";

/**
 * The reads devtools makes of the graph: `observersOf`, `sourcesOf`,
 * `kindOf`, and `heldValue`. Each is a read of links and fields the graph
 * keeps; none runs a node.
 */
describe("devtools reads of the graph", () => {
  test("observersOf lists each observed derived value, watch, and active reaction, in link order", () => {
    const graph = new Graph(() => {});
    const cell = graph.cell(1);
    const double = graph.derived(() => readCell(cell) * 2);
    expect(observersOf(cell)).toEqual([]);
    const stopWatch = graph.watch(
      () => readDerived(double),
      () => undefined,
      { label: "show" },
    );
    const stopDirect = graph.watch(
      () => readCell(cell),
      () => undefined,
    );
    const reaction = new Reaction(graph, () => {}, "useValue");
    reaction.track(() => readCell(cell));
    reaction.activate();
    const observers = observersOf(cell);
    expect(observers.map(kindOf)).toEqual(["derived", "watch", "reaction"]);
    expect(observers[0]).toBe(double);
    expect(observersOf(double).map((node) => node.label)).toEqual(["show"]);
    reaction.deactivate();
    stopDirect();
    expect(observersOf(cell)).toEqual([double]);
    stopWatch();
    expect(observersOf(cell)).toEqual([]);
    expectAtRest(graph);
  });

  test("an unobserved derived value is in no observer list, though it keeps what it read", () => {
    const graph = new Graph(() => {});
    const cell = graph.cell(1);
    const double = graph.derived(() => readCell(cell) * 2);
    expect(readDerived(double)).toBe(2);
    expect(observersOf(cell)).toEqual([]);
    expect(sourcesOf(double)).toEqual([cell]);
    expect(sourcesOf(double)).toEqual(dependenciesOf(double));
  });

  test("sourcesOf lists what a watch read, and nothing for a cell or an atom", () => {
    const graph = new Graph(() => {});
    const left = graph.cell(1);
    const right = graph.cell(2);
    const atom = graph.atom();
    const stop = graph.watch(
      () => {
        readAtom(atom);
        return readCell(left) + readCell(right);
      },
      () => undefined,
    );
    const watch = observersOf(left)[0];
    expect(watch === undefined ? undefined : sourcesOf(watch)).toEqual([atom, left, right]);
    expect(sourcesOf(left)).toEqual([]);
    expect(sourcesOf(atom)).toEqual([]);
    expect(kindOf(atom)).toBe("atom");
    expect(kindOf(left)).toBe("cell");
    stop();
  });

  test("heldValue reads a cell and a kept value, and runs nothing", () => {
    const graph = new Graph(() => {});
    const cell = graph.cell(1);
    let runs = 0;
    const double = graph.derived(() => {
      runs++;
      return readCell(cell) * 2;
    });
    expect(heldValue(cell)).toEqual({ has: true, value: 1 });
    expect(heldValue(double)).toEqual({ has: false, value: undefined });
    expect(runs).toBe(0);
    readDerived(double);
    expect(heldValue(double)).toEqual({ has: true, value: 2 });
    graph.batch(() => writeCell(cell, 5));
    // Stale: what it holds is its last run's value.
    expect(heldValue(double)).toEqual({ has: true, value: 2 });
    expect(runs).toBe(1);
    const failing = graph.derived(() => {
      throw new Error("no");
    });
    expect(() => readDerived(failing)).toThrow("no");
    expect(heldValue(failing).has).toBe(false);
    expect(heldValue(graph.atom()).has).toBe(false);
  });
});
