import { expect, test } from "bun:test";

const graph = await Bun.file(new URL("../src/graph.ts", import.meta.url)).text();
const errors = await Bun.file(
  new URL("../../../docs/public/reference/errors.md", import.meta.url),
).text();

const declared = (name: string): number => {
  const match = new RegExp(`const ${name} = (\\d+);`).exec(graph);
  if (match === null) throw new Error(`graph.ts declares no ${name}`);
  return Number(match[1]);
};

test("the pinna/depth-rebuilt row of errors.md states the budget graph.ts declares", () => {
  const row = errors.split("\n").find((line) => line.includes("`pinna/depth-rebuilt`"));
  if (row === undefined) throw new Error("errors.md has no pinna/depth-rebuilt row");
  const depth = declared("maximumComputeDepth");
  const restarts = declared("maximumRestarts");
  expect(row).toContain(`stopped past depth ${depth} and ran again more than ${restarts} times`);
  expect(row).toContain(`A read past depth ${depth} waits`);
  expect(row).toContain(`up to ${restarts - 1} kept chains read`);
});
