/**
 * Compiles a bench entry the way a React Native release build compiles an
 * app, and runs it on Hermes. Bun bundles the entry, React Native 0.88.1's
 * `@react-native/babel-preset` lowers it for Hermes (with the Babel 7 the
 * preset depends on, not this package's Babel 8), `hermesc -O` compiles it to
 * bytecode, and the runner `hermes-host.cpp` builds runs it.
 *
 * Hermes is a `hermes-ios` release's `destroot` directory: `bin/hermesc` from
 * the release, `bin/hermes` built from `hermes-host.cpp` (its header has the
 * command). Nothing is downloaded and nothing is written to the repository.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const presetRequire = createRequire(require.resolve("@react-native/babel-preset/package.json"));
const babel = presetRequire("@babel/core") as {
  readonly transformSync: (code: string, options: object) => { readonly code: string } | null;
};

/**
 * What a React Native app has before any module runs: React Native installs
 * `queueMicrotask`. Effect builds a `TextDecoder` when it loads, which
 * Hermes lacks; an app supplies one (Expo does), so the bench supplies a
 * UTF-8 one.
 */
const prelude = `if (typeof queueMicrotask !== "function") {
  globalThis.queueMicrotask = function (task) { Promise.resolve().then(task); };
}
if (typeof TextDecoder !== "function") {
  globalThis.TextDecoder = function () {};
  globalThis.TextDecoder.prototype.decode = function (bytes) {
    var text = "";
    for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(text));
  };
}
`;

/** The `destroot` from the command line, checked for both binaries. */
export const hermesFrom = (usage: string): string => {
  const destroot = process.argv[2];
  if (destroot === undefined) {
    throw new Error(`bench: usage: ${usage}`);
  }
  for (const binary of ["hermesc", "hermes"]) {
    if (!existsSync(join(destroot, "bin", binary))) {
      throw new Error(
        `bench: no bin/${binary} in ${destroot}; build bin/hermes from bench/hermes-host.cpp`,
      );
    }
  }
  return destroot;
};

/** The entry bundled and lowered for Hermes, as one script. */
export const lowerForHermes = async (entry: string): Promise<string> => {
  const bundle = await Bun.build({
    entrypoints: [entry],
    format: "iife",
    target: "browser",
    conditions: ["source"],
  });
  const [output] = bundle.outputs;
  if (!bundle.success || output === undefined) {
    throw new AggregateError(bundle.logs, "bench: bundling for Hermes failed");
  }
  const lowered = babel.transformSync(await output.text(), {
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
    throw new Error("bench: Babel returned nothing");
  }
  return lowered.code;
};

const directory = mkdtempSync(join(tmpdir(), "pinna-hermes-"));

const run = (command: ReadonlyArray<string>): string => {
  const child = Bun.spawnSync([...command]);
  if (child.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed:\n${child.stdout}${child.stderr}`);
  }
  return child.stdout.toString();
};

/**
 * Compiles `lowered` with `benchSubject` set to `subject` and runs it in its
 * own Hermes process. Returns what the script printed.
 */
export const runOnHermes = (destroot: string, lowered: string, subject: string): string => {
  const name = subject.replace(/[^a-z0-9-]/gi, "-");
  const source = join(directory, `${name}.js`);
  const bytecode = join(directory, `${name}.hbc`);
  writeFileSync(source, `${prelude}var benchSubject = ${JSON.stringify(subject)};\n${lowered}`);
  run([join(destroot, "bin", "hermesc"), "-O", "-emit-binary", "-out", bytecode, source]);
  return run([join(destroot, "bin", "hermes"), "-Xmicrotask-queue", "-Xes6-promise", bytecode]);
};
