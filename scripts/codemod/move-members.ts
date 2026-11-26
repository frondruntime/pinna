/**
 * Moves a member from one module to another in code built on Pinna, for a
 * member that changed module after the module API (`names.ts` covers the
 * flat names before it). Each move is in `moves` below:
 *
 *   bun scripts/codemod/move-members.ts [directory]           rewrites
 *   bun scripts/codemod/move-members.ts [directory] --check   writes nothing;
 *                                                             exits 1 when a
 *                                                             run would change
 *                                                             a file
 *
 * The directory defaults to the current one; the files are the `.ts` and
 * `.tsx` files git tracks under it. `Realm.watchScoped(...)` becomes
 * `Program.watchScoped(...)` where `Realm` is the binding of a named import
 * from `@frondruntime/pinna-effect`, found through the TypeScript checker,
 * so a local `Realm` that shadows the import is left alone. A namespace
 * import's `Pinna.Realm.watchScoped` becomes `Pinna.Program.watchScoped`.
 * `Program` joins that import, as `PinnaProgram` when the file already binds
 * `Program` to something else. A use the script cannot rewrite (a
 * destructuring, an element access) is reported and its file left as it is.
 * A second run changes nothing.
 */

import { relative, resolve } from "node:path";
import ts from "typescript";

/** One member that moved: `from.member` in `package` is now `to.member`. */
export interface MemberMove {
  readonly package: string;
  readonly from: string;
  readonly to: string;
  readonly member: string;
}

export const moves: ReadonlyArray<MemberMove> = [
  // Decision B2 of ruling 71 of `docs/api.md`: on `Realm` it added 21 KB to every bundle.
  { package: "@frondruntime/pinna-effect", from: "Realm", to: "Program", member: "watchScoped" },
];

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface MoveResult {
  readonly text: string;
  /** What could not be rewritten, each with its line; the text is then unchanged. */
  readonly problems: ReadonlyArray<string>;
}

const apply = (text: string, edits: ReadonlyArray<Edit>): string =>
  [...edits]
    .sort((left, right) => right.start - left.start)
    .reduce(
      (result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end),
      text,
    );

/** The names a file binds at its top level. */
const topLevelNames = (file: ts.SourceFile): Set<string> => {
  const names = new Set<string>();
  const addBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      names.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) {
        addBinding(element.name);
      }
    }
  };
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name !== undefined) {
        names.add(clause.name.text);
      }
      const bound = clause?.namedBindings;
      if (bound !== undefined && ts.isNamespaceImport(bound)) {
        names.add(bound.name.text);
      } else if (bound !== undefined) {
        for (const specifier of bound.elements) {
          names.add(specifier.name.text);
        }
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        addBinding(declaration.name);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.name !== undefined &&
      ts.isIdentifier(statement.name)
    ) {
      names.add(statement.name.text);
    }
  }
  return names;
};

/** A program over one file in memory; imports stay unresolved, which the checker's own bindings do not need. */
const programOf = (fileName: string, text: string): ts.Program => {
  const options: ts.CompilerOptions = {
    noResolve: true,
    noLib: true,
    allowJs: false,
    jsx: ts.JsxEmit.Preserve,
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile;
  host.getSourceFile = (name, version, onError, create) =>
    name === fileName
      ? ts.createSourceFile(name, text, version, true, kindOf(name))
      : original(name, version, onError, create);
  return ts.createProgram([fileName], options, host);
};

const kindOf = (fileName: string): ts.ScriptKind =>
  fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

const lineOf = (file: ts.SourceFile, node: ts.Node): number =>
  file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

/** Rewrites every move in one file's text. */
export const moveMembers = (
  fileName: string,
  text: string,
  table: ReadonlyArray<MemberMove> = moves,
): MoveResult => {
  const program = programOf(fileName, text);
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(fileName);
  if (file === undefined) {
    return { text, problems: [] };
  }
  const edits: Array<Edit> = [];
  const problems: Array<string> = [];
  const bound = topLevelNames(file);

  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.importClause?.isTypeOnly === true
    ) {
      continue;
    }
    const specifierText = statement.moduleSpecifier.text;
    const named = statement.importClause?.namedBindings;
    if (named === undefined) {
      continue;
    }
    const forPackage = table.filter((move) => move.package === specifierText);
    if (forPackage.length === 0) {
      continue;
    }

    if (ts.isNamespaceImport(named)) {
      const namespace = checker.getSymbolAtLocation(named.name);
      const visit = (node: ts.Node): void => {
        // `Pinna.Realm.watchScoped`: the middle name changes.
        if (
          ts.isPropertyAccessExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          checker.getSymbolAtLocation(node.expression.expression) === namespace
        ) {
          const middle = node.expression.name;
          const move = forPackage.find(
            (candidate) => candidate.from === middle.text && candidate.member === node.name.text,
          );
          if (move !== undefined) {
            edits.push({ start: middle.getStart(file), end: middle.getEnd(), text: move.to });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
      continue;
    }

    for (const specifier of named.elements) {
      if (specifier.isTypeOnly) {
        continue;
      }
      const imported = (specifier.propertyName ?? specifier.name).text;
      const movesHere = forPackage.filter((move) => move.from === imported);
      if (movesHere.length === 0) {
        continue;
      }
      const symbol = checker.getSymbolAtLocation(specifier.name);
      const uses: Array<{ readonly node: ts.Identifier; readonly move: MemberMove }> = [];
      const visit = (node: ts.Node): void => {
        if (
          ts.isPropertyAccessExpression(node) &&
          ts.isIdentifier(node.expression) &&
          checker.getSymbolAtLocation(node.expression) === symbol
        ) {
          const move = movesHere.find((candidate) => candidate.member === node.name.text);
          if (move !== undefined) {
            uses.push({ node: node.expression, move });
          }
        } else if (
          ts.isElementAccessExpression(node) &&
          ts.isIdentifier(node.expression) &&
          checker.getSymbolAtLocation(node.expression) === symbol &&
          ts.isStringLiteral(node.argumentExpression) &&
          movesHere.some(
            (move) => move.member === (node.argumentExpression as ts.StringLiteral).text,
          )
        ) {
          problems.push(
            `${fileName}:${lineOf(file, node)}: \`${node.getText(file)}\` is an element access; write the moved member by hand`,
          );
        } else if (
          ts.isVariableDeclaration(node) &&
          node.initializer !== undefined &&
          ts.isIdentifier(node.initializer) &&
          checker.getSymbolAtLocation(node.initializer) === symbol &&
          ts.isObjectBindingPattern(node.name) &&
          node.name.elements.some((element) => {
            const name = element.propertyName ?? element.name;
            return ts.isIdentifier(name) && movesHere.some((move) => move.member === name.text);
          })
        ) {
          problems.push(
            `${fileName}:${lineOf(file, node)}: \`${node.getText(file)}\` destructures a moved member; write it by hand`,
          );
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
      if (uses.length === 0) {
        continue;
      }
      // Each target module's local name: an existing import of it, or a new one.
      const targets = new Map<string, string>();
      const added: Array<string> = [];
      for (const to of new Set(uses.map((use) => use.move.to))) {
        const existing = named.elements.find(
          (element) => !element.isTypeOnly && (element.propertyName ?? element.name).text === to,
        );
        if (existing !== undefined) {
          targets.set(to, existing.name.text);
          continue;
        }
        const local = [to, `Pinna${to}`].find((candidate) => !bound.has(candidate));
        if (local === undefined) {
          problems.push(
            `${fileName}:${lineOf(file, statement)}: \`${to}\` and \`Pinna${to}\` are both bound here`,
          );
          continue;
        }
        bound.add(local);
        targets.set(to, local);
        added.push(local === to ? to : `${to} as ${local}`);
      }
      for (const use of uses) {
        const local = targets.get(use.move.to);
        if (local !== undefined) {
          edits.push({ start: use.node.getStart(file), end: use.node.getEnd(), text: local });
        }
      }
      if (added.length > 0) {
        const last = named.elements[named.elements.length - 1] as ts.ImportSpecifier;
        edits.push({ start: last.getEnd(), end: last.getEnd(), text: `, ${added.join(", ")}` });
      }
    }
  }
  if (problems.length > 0) {
    return { text, problems };
  }
  return { text: apply(text, edits), problems };
};

// ---------------------------------------------------------------- command line

const main = (): void => {
  const check = process.argv.includes("--check");
  const directory = resolve(
    process.argv.slice(2).find((argument) => !argument.startsWith("--")) ?? ".",
  );
  const listed = Bun.spawnSync(["git", "ls-files", "--", "*.ts", "*.tsx"], { cwd: directory });
  if (listed.exitCode !== 0) {
    console.error(`move-members: ${directory} is not in a git repository`);
    process.exit(2);
  }
  const files = new TextDecoder()
    .decode(listed.stdout)
    .split("\n")
    .filter((line) => line.length > 0 && !line.includes("node_modules/"))
    .map((line) => resolve(directory, line));
  const changed: Array<string> = [];
  const problems: Array<string> = [];
  for (const path of files) {
    const text = ts.sys.readFile(path);
    if (text === undefined || !moves.some((move) => text.includes(move.member))) {
      continue;
    }
    const result = moveMembers(path, text);
    problems.push(
      ...result.problems.map((problem) => problem.replace(path, relative(directory, path))),
    );
    if (result.text !== text) {
      changed.push(relative(directory, path));
      if (!check) {
        ts.sys.writeFile(path, result.text);
      }
    }
  }
  for (const problem of problems) {
    console.error(problem);
  }
  console.log(
    changed.length === 0
      ? "move-members: nothing to change"
      : `move-members: ${check ? "would change" : "changed"} ${changed.join(", ")}`,
  );
  if (problems.length > 0 || (check && changed.length > 0)) {
    process.exit(1);
  }
};

if (import.meta.main) {
  main();
}
