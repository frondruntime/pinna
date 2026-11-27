/**
 * The API names a skill may print, read from the published packages through
 * the TypeScript checker, and the check that every name a skill prints is
 * one of them. A code span `Box.make` must name a member of a Pinna module,
 * `read.row` and `write.restore` a property of `Read` and `Write`, a
 * `use...` call a hook of `@frondruntime/pinna-react` or of React, and a
 * `pinna/...` code a member of `PinnaUsageCode`. The names come from the
 * source through the `source` export condition, so a rename in `src` fails
 * the build of every skill that still prints the old name.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { fail } from "./slices.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface Names {
  /** Each Pinna module (`Box`, `Stage`, `Program`, ...) with its members, from every package. */
  readonly modules: ReadonlyMap<string, ReadonlySet<string>>;
  /** Every value the packages export by name (`testRealm`, `isPinnaError`, `useValue`). */
  readonly exports: ReadonlySet<string>;
  readonly read: ReadonlySet<string>;
  readonly write: ReadonlySet<string>;
  readonly codes: ReadonlySet<string>;
  /** The hooks React exports, so `useDeferredValue` passes beside `useValue`. */
  readonly reactHooks: ReadonlySet<string>;
}

const packages = [
  "@frondruntime/pinna",
  "@frondruntime/pinna-effect",
  "@frondruntime/pinna-react",
  "@frondruntime/pinna/testing",
] as const;

export function loadNames(): Names {
  // The file sits in pinna-react so `react` resolves from its dependencies.
  const file = join(root, "packages/pinna-react/src/skill-names.ts");
  const text = [
    ...packages.map((name, index) => `import * as p${index} from "${name}";`),
    `import * as react from "react";`,
    `import type { PinnaUsageCode, Read, Write } from "@frondruntime/pinna";`,
    `export type Names = [typeof p0, typeof p1, typeof p2, typeof p3, typeof react, PinnaUsageCode, Read, Write];`,
  ].join("\n");
  const config = ts.readConfigFile(join(root, "tsconfig.base.json"), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
  const host = ts.createCompilerHost({ ...options, types: [] });
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, language, ...rest) =>
    name === file
      ? ts.createSourceFile(name, text, language, true)
      : getSourceFile.call(host, name, language, ...rest);
  const fileExists = host.fileExists;
  host.fileExists = (name) => name === file || fileExists.call(host, name);
  const program = ts.createProgram([file], { ...options, types: [] }, host);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  if (source === undefined) fail("the names file did not load");

  const moduleOf = (specifier: string): ts.Symbol => {
    const statement = source.statements.find(
      (node): node is ts.ImportDeclaration =>
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === specifier,
    );
    const symbol =
      statement === undefined ? undefined : checker.getSymbolAtLocation(statement.moduleSpecifier);
    if (symbol === undefined) fail(`${specifier} does not resolve from ${root}`);
    return symbol;
  };
  const resolved = (symbol: ts.Symbol): ts.Symbol =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

  const modules = new Map<string, Set<string>>();
  const exports = new Set<string>();
  for (const specifier of packages) {
    for (const exported of checker.getExportsOfModule(moduleOf(specifier))) {
      const symbol = resolved(exported);
      if (!(symbol.flags & ts.SymbolFlags.Value)) continue;
      exports.add(exported.name);
      if (!/^[A-Z]/.test(exported.name)) continue;
      const members = checker
        .getPropertiesOfType(checker.getTypeOfSymbol(symbol))
        .map((property) => property.name)
        .filter((name) => name !== "prototype");
      if (members.length === 0) continue;
      const known = modules.get(exported.name) ?? new Set<string>();
      for (const member of members) known.add(member);
      modules.set(exported.name, known);
    }
  }

  const typeExport = (name: string): ts.Type => {
    const symbol = checker
      .getExportsOfModule(moduleOf("@frondruntime/pinna"))
      .find((candidate) => candidate.name === name);
    if (symbol === undefined) fail(`@frondruntime/pinna exports no ${name}`);
    return checker.getDeclaredTypeOfSymbol(resolved(symbol));
  };
  const properties = (name: string): ReadonlySet<string> =>
    new Set(checker.getPropertiesOfType(typeExport(name)).map((property) => property.name));
  const codeType = typeExport("PinnaUsageCode");
  const codes = new Set(
    (codeType.isUnion() ? codeType.types : [codeType]).flatMap((type) =>
      type.isStringLiteral() ? [type.value] : [],
    ),
  );
  if (codes.size === 0) fail("PinnaUsageCode resolved to no string literal");
  const reactHooks = new Set(
    checker
      .getExportsOfModule(moduleOf("react"))
      .map((symbol) => symbol.name)
      .filter((name) => /^use[A-Z]/.test(name)),
  );
  return {
    modules,
    exports,
    read: properties("Read"),
    write: properties("Write"),
    codes,
    reactHooks,
  };
}

/**
 * Names the docs print for another library, which resolve in none of
 * Pinna's packages: MobX's hook in the translation table of
 * `start/mobx.md`, and Effect's `Atom.batch` in `start/principles.md`.
 */
const foreign: ReadonlySet<string> = new Set([
  "useLocalObservable",
  "Atom.batch",
  // Effect's error, which a ValueRejectedError and a DecodeError carry as `cause`.
  "SchemaError",
  "SuppressedError",
]);

/** The packages that are not published, which no skill names. */
const unpublished = /pinna-form|pinna-devtools|\bForm\.[a-z]|\bDevtools|\bReduxExtension\b/;

/**
 * Every name in `text` that resolves nowhere, as `where: name`. `text` is
 * Markdown: inline code spans are checked, and prose too when `prose` is set
 * (a description, which has no code spans). Fenced code is skipped: a
 * reference's samples are regions `bun run typecheck` compiles, and the
 * hub's one hand-written sample, in "In a component", is read in review.
 */
export function unresolved(
  names: Names,
  where: string,
  text: string,
  prose = false,
): ReadonlyArray<string> {
  const problems: string[] = [];
  const outside = text.replace(/```[\s\S]*?```/g, "");
  const spans = prose ? [outside] : [...outside.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? "");
  if (unpublished.test(text)) problems.push(`${where}: names an unpublished package`);
  for (const span of spans) {
    for (const match of span.matchAll(/(?<![\w.$])([A-Z]\w*)\.([a-zA-Z]\w*)/g)) {
      const [, module = "", member = ""] = match;
      const members = names.modules.get(module);
      if (members !== undefined && !members.has(member) && !foreign.has(`${module}.${member}`)) {
        problems.push(`${where}: ${module}.${member} is no member of ${module}`);
      }
    }
    for (const match of span.matchAll(/(?<![\w.$])(read|write)\.([a-zA-Z]\w*)/g)) {
      const [, verb = "", member = ""] = match;
      if (!(verb === "read" ? names.read : names.write).has(member)) {
        problems.push(
          `${where}: ${verb}.${member} is no property of ${verb === "read" ? "Read" : "Write"}`,
        );
      }
    }
    for (const match of span.matchAll(/(?<![\w.$])(use[A-Z]\w*)/g)) {
      const hook = match[1] ?? "";
      if (!names.exports.has(hook) && !names.reactHooks.has(hook) && !foreign.has(hook)) {
        problems.push(`${where}: ${hook} is no hook of pinna-react or React`);
      }
    }
    // A span that is an error class names an export of a package.
    if (/^[A-Z]\w*Error$/.test(span) && !names.exports.has(span) && !foreign.has(span)) {
      problems.push(`${where}: ${span} is no error a package exports`);
    }
    for (const match of span.matchAll(/(?<![\w/])pinna\/([a-z][a-z-]*[a-z])/g)) {
      const code = `pinna/${match[1] ?? ""}`;
      if (!names.codes.has(code)) problems.push(`${where}: ${code} is no PinnaUsageCode`);
    }
  }
  return problems;
}
