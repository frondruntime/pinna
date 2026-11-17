import { expect, test } from "bun:test";
import { dirname, relative, resolve, sep as separator } from "node:path";
import { Glob } from "bun";
import typescript from "typescript";

const sourceRoot = resolve(import.meta.dir, "../src");

function violations(file: string, content: string): Array<string> {
  const messages: Array<string> = [];
  const exchange = file.startsWith("exchange/");
  // Only the composition root may join the two sides.
  if (file === "main.tsx") return messages;
  const check = (specifier: string) => {
    if (!specifier.startsWith(".")) {
      if (exchange && specifier !== "effect") messages.push(`${file} imports ${specifier}`);
      return;
    }
    const target = relative(sourceRoot, resolve(sourceRoot, dirname(file), specifier))
      .split(separator)
      .join("/");
    const allowed = exchange
      ? target.startsWith("exchange/")
      : file !== "transport.ts" &&
        !target.startsWith("exchange/") &&
        !target.startsWith("../") &&
        target !== "main.tsx";
    if (!allowed) messages.push(`${file} imports ${specifier}`);
  };
  const syntax = typescript.createSourceFile(
    file,
    content,
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TSX,
  );
  const visit = (node: typescript.Node): void => {
    if (
      (typescript.isImportDeclaration(node) || typescript.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      typescript.isStringLiteral(node.moduleSpecifier)
    ) {
      check(node.moduleSpecifier.text);
    }
    if (
      typescript.isImportTypeNode(node) &&
      typescript.isLiteralTypeNode(node.argument) &&
      typescript.isStringLiteral(node.argument.literal)
    ) {
      check(node.argument.literal.text);
    }
    if (
      typescript.isCallExpression(node) &&
      (node.expression.kind === typescript.SyntaxKind.ImportKeyword ||
        (typescript.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const specifier = node.arguments[0];
      if (specifier && typescript.isStringLiteral(specifier)) check(specifier.text);
      else messages.push(`${file} has a nonliteral module import`);
    }
    typescript.forEachChild(node, visit);
  };
  visit(syntax);
  return messages;
}

test("exchange, client, and neutral transport cannot import across their boundary", async () => {
  const messages: Array<string> = [];
  for await (const file of new Glob("**/*.{ts,tsx}").scan(sourceRoot)) {
    messages.push(...violations(file, await Bun.file(resolve(sourceRoot, file)).text()));
  }
  expect(messages).toEqual([]);
});

test("the boundary guard catches imports, re-exports, dynamic imports, and type imports", () => {
  expect(
    violations("client/leak.ts", 'import { makeExchange } from "../exchange/index.ts";'),
  ).toHaveLength(1);
  expect(violations("client/leak.ts", 'export * from "../exchange/index.ts";')).toHaveLength(1);
  expect(
    violations("client/leak.ts", 'const exchange = import("../exchange/index.ts");'),
  ).toHaveLength(1);
  expect(
    violations("client/leak.ts", 'type Exchange = import("../exchange/index.ts").Exchange;'),
  ).toHaveLength(1);
  expect(violations("exchange/leak.ts", 'import "../client/desk.ts";')).toHaveLength(1);
  expect(violations("client/leak.ts", 'import "../main.tsx";')).toHaveLength(1);
  expect(violations("transport.ts", 'import "./exchange/index.ts";')).toHaveLength(1);
  expect(violations("helper.ts", 'import "./exchange/index.ts";')).toHaveLength(1);
});
