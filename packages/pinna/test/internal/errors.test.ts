import { afterEach, describe, expect, test } from "bun:test";
import { Graph, readCell, writeCell } from "@frondruntime/pinna-core";

/** Internals: a graph made with its own reporter. The public twin is `onError` in `test/errors.test.ts`. */

const original = globalThis.reportError;

afterEach(() => {
  globalThis.reportError = original;
});

const failGlobal = (): void => {
  globalThis.reportError = (error) => {
    throw new Error(`the global reporter was called with ${String(error)}`);
  };
};

describe("createRealm({ onError })", () => {
  test("a graph made with a reporter uses it", () => {
    failGlobal();
    const reported: Array<unknown> = [];
    const graph = new Graph((error) => reported.push(error));
    const cell = graph.cell(0);
    graph.watch(() => {
      if (readCell(cell) === 1) {
        throw new Error("boom");
      }
    });
    writeCell(cell, 1);
    expect(reported.map((error) => (error as Error).message)).toEqual(["boom"]);
  });
});
