import { expect, test } from "bun:test";
import { Graph, Reaction, readCell, readDerived, writeCell } from "../../src/index.ts";

// Edge (ruling 67), recorded in principles.md. D2-3: an adopt refused inside a derived value does not keep
// the last pending read, so the next valid adopt follows nothing of it and a write to it notifies nobody.
test("a refused adopt does not keep the last pending read for the next adopt", () => {
  const graph = new Graph();
  const first = graph.cell(0);
  const next = graph.cell(0);
  let notices = 0;
  const reaction = new Reaction(graph, () => {
    notices++;
  });
  reaction.track(() => readCell(first));
  reaction.activate();
  reaction.trackPending(() => readCell(next));
  const refused = graph.derived(() => reaction.adopt());
  expect(() => readDerived(refused)).toThrow("cannot observe or release while it computes");
  reaction.adopt();
  writeCell(next, 1);
  reaction.deactivate();
  expect(notices).toBe(0);
});

// Edge (ruling 67), recorded in principles.md. D2-4: `adopt` inside the reaction's own `trackPending` run
// is not refused, and the committed sources are not kept when that run throws.
test("a reentrant adopt inside a pending run is not refused", () => {
  const graph = new Graph();
  const committed = graph.cell(0);
  const pending = graph.cell(0);
  let notices = 0;
  const reaction = new Reaction(graph, () => {
    notices++;
  });
  reaction.track(() => readCell(committed));
  reaction.activate();
  reaction.trackPending(() => readCell(pending));
  let innerError: unknown;
  expect(() =>
    reaction.trackPending(() => {
      try {
        reaction.adopt();
      } catch (error) {
        innerError = error;
      }
      throw new Error("discard this render");
    }),
  ).toThrow("discard this render");
  writeCell(committed, 1);
  reaction.deactivate();
  expect([String(innerError), notices]).toEqual(["undefined", 0]);
});
