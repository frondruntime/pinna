import { describe, expect, test } from "bun:test";
import { buildWorker, bundleWorker } from "../src/bundle.ts";
import type { RuntimeName } from "../src/results.ts";

/**
 * The workers measure what an application ships: no Effect (only the
 * command line uses it), and MobX and Legend in their production builds.
 */
describe.each<RuntimeName>(["node", "hermes"])("the %s worker", (runtime) => {
  test("holds the libraries and not effect", async () => {
    // Before Babel: its output for Hermes keeps no module paths to check.
    const code = await buildWorker(runtime);
    expect(code).toMatch(/node_modules\/[^\n]*\/alien-signals\//);
    expect(code).not.toMatch(/node_modules\/(?:[^\n]*\/)?@?effect\//);
  });

  test("ships with NODE_ENV production inlined", async () => {
    expect(await bundleWorker(runtime)).not.toContain("process.env.NODE_ENV");
  });
});
