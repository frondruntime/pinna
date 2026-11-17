/**
 * Builds a worker for each runtime the way an application ships: one bundle,
 * `NODE_ENV` set to production (MobX and Legend pick their production builds
 * from it), and for Hermes, lowered by React Native 0.88.1's Babel preset as
 * a release build lowers an app. `hermesc -O` then compiles that script to
 * bytecode, in `runtimes.ts`. Pinna comes from its source, through the
 * `source` export condition, so a run needs no build of the packages.
 *
 * Command-line side, but plain promises so the tests can call it.
 */
import { createRequire } from "node:module";
import type { RuntimeName } from "./results.ts";

const workers: Readonly<Record<RuntimeName, string>> = {
  node: new URL("./workers/node.ts", import.meta.url).pathname,
  hermes: new URL("./workers/hermes.ts", import.meta.url).pathname,
};

/** The preset's own Babel 7, not whatever Babel the workspace hoists. */
const presetRequire = createRequire(
  createRequire(import.meta.url).resolve("@react-native/babel-preset/package.json"),
);
const babel = presetRequire("@babel/core") as {
  readonly transformSync: (code: string, options: object) => { readonly code: string } | null;
};

/** What React Native installs before any module runs and the Hermes command line lacks. */
const hermesPrelude = `if (typeof queueMicrotask !== "function") {
  globalThis.queueMicrotask = function (task) { Promise.resolve().then(task); };
}
`;

/**
 * The worker as Bun bundles it, before Babel lowers Hermes's copy. Its path
 * comments name every module it holds, which Babel's output drops, so the
 * tests read this to check what went in.
 */
export const buildWorker = async (runtime: RuntimeName): Promise<string> => {
  const bundle = await Bun.build({
    entrypoints: [workers[runtime]],
    target: runtime === "hermes" ? "browser" : "node",
    format: runtime === "hermes" ? "iife" : "esm",
    conditions: ["source"],
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const [output] = bundle.outputs;
  if (!bundle.success || output === undefined) {
    throw new AggregateError(bundle.logs, `pinna-bench: bundling the ${runtime} worker failed`);
  }
  return output.text();
};

const lowerForHermes = (code: string): string => {
  const lowered = babel.transformSync(code, {
    babelrc: false,
    configFile: false,
    compact: false,
    presets: [
      [
        presetRequire.resolve("@react-native/babel-preset"),
        { dev: false, enableBabelRuntime: false, unstable_transformProfile: "hermes-stable" },
      ],
    ],
  });
  if (lowered === null) {
    throw new Error("pinna-bench: Babel returned nothing");
  }
  return lowered.code;
};

/**
 * The worker's script for `runtime`. Hermes's script reads its request from
 * a global, `benchRequest`, that `hermesScript` declares, since the Hermes
 * host passes no arguments to the script.
 */
export const bundleWorker = async (runtime: RuntimeName): Promise<string> => {
  const code = await buildWorker(runtime);
  return runtime === "hermes" ? lowerForHermes(code) : code;
};

/** The Hermes source for one request: the prelude, the request, the worker. */
export const hermesScript = (worker: string, request: unknown): string =>
  `${hermesPrelude}var benchRequest = ${JSON.stringify(request)};\n${worker}`;
