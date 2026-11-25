/**
 * The API rename (`docs/api-redesign.md`): moves every reference to a flat
 * export onto its module member, following `names.ts` and nothing else.
 *
 *   bun scripts/codemod/rename-api.ts           rewrites the workspace
 *   bun scripts/codemod/rename-api.ts --check   writes nothing; exits 1 when
 *                                               a run would change a file
 *
 * A reference is found through the TypeScript checker, not by its text: an
 * identifier is rewritten only when its symbol is the binding of an import
 * from `@frondruntime/pinna` or `@frondruntime/pinna-effect` (or a relative
 * path to either package's `src/index.ts`). Three passes run in order, each
 * on a fresh program:
 *
 * 1. Types: `Options` and `Recipe` are renamed at their declaration and at
 *    every reference, through the language service's rename.
 * 2. Members: a value reference to `box` becomes `Box.make`, a namespace
 *    access `Pinna.box` becomes `Pinna.Box.make`, and the import list drops
 *    `box` and gains `Box`. A type reference keeps its name.
 * 3. Exports: the flat names leave both packages' `src/index.ts`.
 *
 * What a pass cannot place (a type reference to a name with no type, an
 * export of an imported flat name, a module name already bound to something
 * else) is reported, and that file is left as it is. A second run changes
 * nothing. `<script>` blocks and the frontmatter of `.astro` files, and
 * Markdown fences marked `ts` or `tsx`, are rewritten as TypeScript; the
 * records of past decisions (`historical` below) keep their names. Biome formats every changed file afterwards.
 */

import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { type MemberRename, type Package, renames, type TypeRename } from "./names.ts";

const root = resolve(import.meta.dir, "../..");
const check = process.argv.includes("--check");

const indexes: Record<Package, string> = {
  "@frondruntime/pinna": resolve(root, "packages/pinna/src/index.ts"),
  "@frondruntime/pinna-effect": resolve(root, "packages/pinna-effect/src/index.ts"),
};
const packageOfIndex = new Map<string, Package>(
  Object.entries(indexes).map(([name, path]) => [path, name as Package]),
);

const memberRenames = renames.filter((rename): rename is MemberRename => rename.kind === "member");
/** What pass 1 renames in place: the types, and each renamed module with its module type. */
const typeRenames: ReadonlyArray<TypeRename> = renames.flatMap((rename) =>
  rename.kind === "type"
    ? [rename]
    : rename.kind === "module"
      ? [
          { ...rename, kind: "type" as const },
          {
            kind: "type" as const,
            from: `${rename.from}Module`,
            to: `${rename.to}Module`,
            packages: rename.packages,
          },
        ]
      : [],
);
const moduleNames = new Set(memberRenames.map((rename) => rename.module));

const findMember = (name: string, from: Package): MemberRename | undefined =>
  memberRenames.find((rename) => rename.from === name && rename.packages.includes(from));

// ---------------------------------------------------------------- files

/** The files git tracks, so a build output or a dependency is never touched. */
const tracked = (): ReadonlyArray<string> => {
  const listed = Bun.spawnSync(["git", "ls-files", "*.ts", "*.tsx", "*.astro", "*.md"], {
    cwd: root,
  });
  return new TextDecoder()
    .decode(listed.stdout)
    .split("\n")
    .filter((line) => line.length > 0 && !historical.has(line))
    .map((line) => resolve(root, line));
};

/** The records of past decisions keep the names they were written with. */
const historical = new Set([
  "docs/api-redesign.md",
  "docs/feature-gaps.md",
  "docs/reaction-schedulers.md",
  "docs/realm-dispose.md",
]);

const configs = (): ReadonlyArray<string> => {
  const listed = Bun.spawnSync(["git", "ls-files", "tsconfig.json", "*/tsconfig.json"], {
    cwd: root,
  });
  return new TextDecoder()
    .decode(listed.stdout)
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => resolve(root, line));
};

/**
 * A TypeScript block inside another file: an `.astro` file's frontmatter or
 * `<script>`, or a Markdown fence marked `ts` or `tsx`.
 */
interface Block {
  readonly host: string;
  readonly start: number;
  readonly end: number;
}

/** Each block is served to the compiler as `<file>.<index>.ts` (or `.tsx`), beside its file. */
const blocks = new Map<string, Block>();
const texts = new Map<string, string>();

const readText = (path: string): string => {
  const known = texts.get(path);
  if (known !== undefined) {
    return known;
  }
  const text = ts.sys.readFile(path) ?? "";
  texts.set(path, text);
  return text;
};

const loadAstro = (astro: string): ReadonlyArray<string> => {
  const text = readText(astro);
  const found: Array<{ start: number; end: number }> = [];
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (frontmatter !== null) {
    const start = text.indexOf("\n") + 1;
    found.push({ start, end: start + (frontmatter[1] ?? "").length });
  }
  for (const script of text.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    const start = (script.index ?? 0) + script[0].indexOf(">") + 1;
    found.push({ start, end: start + (script[1] ?? "").length });
  }
  return found.map((block, index) => {
    const path = `${astro}.${index}.ts`;
    blocks.set(path, { host: astro, ...block });
    texts.set(path, text.slice(block.start, block.end));
    return path;
  });
};

const loadMarkdown = (markdown: string): ReadonlyArray<string> => {
  const text = readText(markdown);
  const paths: Array<string> = [];
  for (const fence of text.matchAll(/^```(tsx|typescript|ts)[^\n]*\n([\s\S]*?)^```/gm)) {
    const start = (fence.index ?? 0) + fence[0].indexOf("\n") + 1;
    const path = `${markdown}.${paths.length}.${fence[1] === "tsx" ? "tsx" : "ts"}`;
    blocks.set(path, { host: markdown, start, end: start + (fence[2] ?? "").length });
    texts.set(path, fence[2] ?? "");
    paths.push(path);
  }
  return paths;
};

// ---------------------------------------------------------------- programs

interface Project {
  readonly service: ts.LanguageService;
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  /** The tracked files this project rewrites: each file belongs to the first project that holds it. */
  readonly files: ReadonlyArray<ts.SourceFile>;
  readonly options: ts.CompilerOptions;
}

const projects = (): ReadonlyArray<Project> => {
  texts.clear();
  blocks.clear();
  const all = tracked();
  const owned = new Set<string>();
  const virtual = [
    ...all.filter((path) => path.endsWith(".astro")).flatMap(loadAstro),
    ...all.filter((path) => path.endsWith(".md")).flatMap(loadMarkdown),
  ];
  const result: Array<Project> = [];
  for (const config of configs()) {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      config,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
        },
      },
    );
    if (parsed === undefined) {
      continue;
    }
    const directory = dirname(config);
    const inside = (path: string): boolean => !relative(directory, path).startsWith("..");
    const names = [...parsed.fileNames.map((path) => resolve(path)), ...virtual.filter(inside)];
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => parsed.options,
      getScriptFileNames: () => names,
      getScriptVersion: () => "0",
      getScriptSnapshot: (path) => {
        const text = blocks.has(path) ? texts.get(path) : ts.sys.readFile(path);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => directory,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: (path) => blocks.has(path) || ts.sys.fileExists(path),
      readFile: (path) => (blocks.has(path) ? texts.get(path) : ts.sys.readFile(path)),
      readDirectory: ts.sys.readDirectory,
      // Workspace packages are symlinks under `node_modules`; their files are read at the real path.
      realpath: (path) => (blocks.has(path) ? path : (ts.sys.realpath?.(path) ?? path)),
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    };
    const service = ts.createLanguageService(host, ts.createDocumentRegistry());
    const program = service.getProgram();
    if (program === undefined) {
      continue;
    }
    const trackedSet = new Set(all);
    const files = program
      .getSourceFiles()
      .filter(
        (file) =>
          (trackedSet.has(file.fileName) || blocks.has(file.fileName)) &&
          inside(file.fileName) &&
          !owned.has(file.fileName),
      );
    for (const file of files) {
      owned.add(file.fileName);
    }
    result.push({
      service,
      program,
      checker: program.getTypeChecker(),
      files,
      options: parsed.options,
    });
  }
  return result;
};

// ---------------------------------------------------------------- edits

interface Edit {
  readonly file: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const problems: Array<string> = [];

const where = (file: ts.SourceFile, node: ts.Node): string => {
  const block = blocks.get(file.fileName);
  const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
  if (block !== undefined) {
    const before = readText(block.host).slice(0, block.start).split("\n").length;
    return `${relative(root, block.host)}:${before + line}`;
  }
  return `${relative(root, file.fileName)}:${line + 1}`;
};

/** Applies the edits; returns the real files it changed (the host file for its blocks). */
const apply = (edits: ReadonlyArray<Edit>): ReadonlyArray<string> => {
  const byFile = new Map<string, Array<Edit>>();
  for (const edit of edits) {
    const list = byFile.get(edit.file) ?? [];
    if (!list.some((known) => known.start === edit.start && known.end === edit.end)) {
      list.push(edit);
    }
    byFile.set(edit.file, list);
  }
  const changed = new Map<string, string>();
  const hostEdits = new Map<string, Array<Edit>>();
  for (const [file, list] of byFile) {
    const sorted = [...list].sort((left, right) => right.start - left.start);
    let text = readText(file);
    for (const edit of sorted) {
      text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    }
    const block = blocks.get(file);
    if (block === undefined) {
      changed.set(file, text);
    } else {
      const hostList = hostEdits.get(block.host) ?? [];
      hostList.push({ file: block.host, start: block.start, end: block.end, text });
      hostEdits.set(block.host, hostList);
    }
  }
  for (const [host, list] of hostEdits) {
    let text = readText(host);
    for (const edit of [...list].sort((left, right) => right.start - left.start)) {
      text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    }
    changed.set(host, text);
  }
  if (!check) {
    for (const [file, text] of changed) {
      ts.sys.writeFile(file, text);
    }
  }
  return [...changed.keys()];
};

// ---------------------------------------------------------------- pass 1: types

const renameTypes = (): Array<Edit> => {
  const edits: Array<Edit> = [];
  for (const project of projects()) {
    for (const [name, index] of Object.entries(indexes) as Array<[Package, string]>) {
      const indexFile = project.program.getSourceFile(index);
      const moduleSymbol =
        indexFile === undefined ? undefined : project.checker.getSymbolAtLocation(indexFile);
      if (moduleSymbol === undefined) {
        continue;
      }
      const exports = project.checker.getExportsOfModule(moduleSymbol);
      for (const rename of typeRenames.filter((rename) => rename.packages.includes(name))) {
        const exported = exports.find((symbol) => symbol.name === rename.from);
        if (exported === undefined) {
          continue;
        }
        const target =
          exported.flags & ts.SymbolFlags.Alias
            ? project.checker.getAliasedSymbol(exported)
            : exported;
        const declaration = target.declarations?.[0];
        const nameNode =
          declaration !== undefined && "name" in declaration
            ? (declaration.name as ts.Node | undefined)
            : undefined;
        if (declaration === undefined || nameNode === undefined) {
          continue;
        }
        const locations =
          project.service.findRenameLocations(
            declaration.getSourceFile().fileName,
            nameNode.getStart(),
            false,
            false,
            { providePrefixAndSuffixTextForRename: false },
          ) ?? [];
        for (const location of locations) {
          edits.push({
            file: location.fileName,
            start: location.textSpan.start,
            end: location.textSpan.start + location.textSpan.length,
            text: rename.to,
          });
        }
      }
    }
  }
  return edits;
};

// ---------------------------------------------------------------- pass 2: members

const indexOf = (
  project: Project,
  file: ts.SourceFile,
  declaration: ts.ImportDeclaration | ts.ExportDeclaration,
): Package | undefined => {
  const specifier = declaration.moduleSpecifier;
  if (specifier === undefined || !ts.isStringLiteral(specifier)) {
    return undefined;
  }
  const resolved = ts.resolveModuleName(specifier.text, file.fileName, project.options, ts.sys)
    .resolvedModule?.resolvedFileName;
  if (resolved === undefined) {
    // A Markdown sample at the root resolves no workspace package; its specifier names one.
    return specifier.text in indexes ? (specifier.text as Package) : undefined;
  }
  return packageOfIndex.get(resolve(resolved));
};

/** Whether an identifier names a type, not a value: `typeof box` and `extends Model` are values. */
const inTypePosition = (node: ts.Node): boolean => {
  let child: ts.Node = node;
  let parent = node.parent;
  while (ts.isQualifiedName(parent)) {
    if (parent.right === child) {
      return false;
    }
    child = parent;
    parent = parent.parent;
  }
  if (ts.isTypeReferenceNode(parent)) {
    return true;
  }
  if (ts.isExpressionWithTypeArguments(parent)) {
    const clause = parent.parent;
    return !(
      ts.isHeritageClause(clause) &&
      clause.token === ts.SyntaxKind.ExtendsKeyword &&
      (ts.isClassDeclaration(clause.parent) || ts.isClassExpression(clause.parent))
    );
  }
  return false;
};

/** Whether a symbol is still a flat export: its declaration is outside a package's `src/modules`. */
const isFlat = (checker: ts.TypeChecker, symbol: ts.Symbol | undefined): boolean => {
  if (symbol === undefined) {
    return false;
  }
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const declarations = target.declarations ?? [];
  return (
    declarations.length > 0 &&
    declarations.every((declaration) => !isModuleFile(declaration.getSourceFile().fileName))
  );
};

/**
 * Whether an import names a package the compiler cannot load from where it
 * stands (a Markdown sample at the root): its name alone says whether it is
 * flat, and `Model`, both a flat name and a module, is taken as the module.
 */
const unresolved = (checker: ts.TypeChecker, symbol: ts.Symbol | undefined): boolean =>
  symbol !== undefined &&
  (symbol.flags & ts.SymbolFlags.Alias) !== 0 &&
  (checker.getAliasedSymbol(symbol).declarations ?? []).length === 0;

const isModuleFile = (path: string): boolean => /\/packages\/[^/]+\/src\/modules\//.test(path);

/** Each named import from either index. */
interface Binding {
  readonly declaration: ts.ImportDeclaration;
  readonly specifier: ts.ImportSpecifier;
  readonly from: Package;
  /** The rename, when the import is a flat export the mapping names. */
  readonly rename: MemberRename | undefined;
  readonly symbol: ts.Symbol | undefined;
}

/** A value reference to a flat name, written once the module's local name is known. */
interface Reference {
  readonly node: ts.Identifier;
  readonly rename: MemberRename;
  readonly shorthand: boolean;
}

/** The names a file binds at its top level, but its own unaliased imports from either index. */
const topLevelNames = (file: ts.SourceFile, bindings: ReadonlyArray<Binding>): Set<string> => {
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
          const ours = bindings.some(
            (binding) => binding.specifier === specifier && specifier.propertyName === undefined,
          );
          if (!ours) {
            names.add(specifier.name.text);
          }
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

const renameMembersIn = (project: Project, file: ts.SourceFile): Array<Edit> => {
  const { checker } = project;
  const fileName = file.fileName;
  if (packageOfIndex.has(fileName) || isModuleFile(fileName)) {
    return [];
  }
  const bindings: Array<Binding> = [];
  const namespaces = new Map<ts.Symbol, Package>();
  const indexSymbols = new Map<Package, ts.Symbol>();
  for (const [name, index] of Object.entries(indexes) as Array<[Package, string]>) {
    const indexFile = project.program.getSourceFile(index);
    const symbol = indexFile === undefined ? undefined : checker.getSymbolAtLocation(indexFile);
    if (symbol !== undefined) {
      indexSymbols.set(name, symbol);
    }
  }
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const from = indexOf(project, file, statement);
    const bound = statement.importClause?.namedBindings;
    if (from === undefined || bound === undefined) {
      continue;
    }
    if (ts.isNamespaceImport(bound)) {
      const symbol = checker.getSymbolAtLocation(bound.name);
      if (symbol !== undefined) {
        namespaces.set(symbol, from);
      }
      continue;
    }
    for (const specifier of bound.elements) {
      const imported = (specifier.propertyName ?? specifier.name).text;
      const symbol = checker.getSymbolAtLocation(specifier.name);
      bindings.push({
        declaration: statement,
        specifier,
        from,
        rename: (unresolved(checker, symbol) ? !moduleNames.has(imported) : isFlat(checker, symbol))
          ? findMember(imported, from)
          : undefined,
        symbol,
      });
    }
  }
  const renamed = bindings.filter((binding) => binding.rename !== undefined);
  // Every file is visited: one that imports nothing from an index can still
  // destructure an index's namespace, as `typeof import("…/index.ts")`.

  const edits: Array<Edit> = [];
  const local: Array<string> = [];
  const references: Array<Reference> = [];
  /** The packages each module is read from in this file. */
  const needed = new Map<string, Set<Package>>();
  /** Renamed bindings a type reference still reads, so their specifier stays. */
  const keptForTypes = new Set<Binding>();

  /** `Pinna.box` and `typeof Pinna.box` through a namespace import: the module goes in between. */
  const throughNamespace = (left: ts.Node, right: ts.Identifier): void => {
    const symbol = checker.getSymbolAtLocation(left);
    const from = symbol === undefined ? undefined : namespaces.get(symbol);
    if (from === undefined || !isFlat(checker, checker.getSymbolAtLocation(right))) {
      return;
    }
    const rename = findMember(right.text, from);
    if (rename !== undefined) {
      edits.push({
        file: fileName,
        start: right.getStart(file),
        end: right.getEnd(),
        text: `${rename.module}.${rename.member}`,
      });
    }
  };

  /**
   * `const { box, update } = api`, where `api` is a package's module
   * namespace, becomes `const { Box: { make: box }, Realm: { update } } = api`:
   * the locals keep their names.
   */
  const destructured = (pattern: ts.ObjectBindingPattern, initializer: ts.Expression): void => {
    const symbol = checker.getTypeAtLocation(initializer).getSymbol();
    const from = [...indexSymbols].find(([, indexSymbol]) => indexSymbol === symbol)?.[0];
    if (from === undefined || symbol === undefined) {
      return;
    }
    const exports = checker.getExportsOfModule(symbol);
    const kept: Array<string> = [];
    const grouped = new Map<string, Array<string>>();
    for (const element of pattern.elements) {
      const key = element.propertyName ?? element.name;
      const rename =
        element.dotDotDotToken === undefined && ts.isIdentifier(key)
          ? findMember(key.text, from)
          : undefined;
      const exported =
        rename === undefined
          ? undefined
          : exports.find((candidate) => candidate.name === rename.from);
      if (rename === undefined || !isFlat(checker, exported)) {
        kept.push(element.getText(file));
        continue;
      }
      const name = element.name.getText(file);
      const initializer =
        element.initializer === undefined ? "" : ` = ${element.initializer.getText(file)}`;
      const entry =
        name === rename.member
          ? `${name}${initializer}`
          : `${rename.member}: ${name}${initializer}`;
      const list = grouped.get(rename.module) ?? [];
      list.push(entry);
      grouped.set(rename.module, list);
    }
    if (grouped.size === 0) {
      return;
    }
    const entries = [
      ...kept,
      ...[...grouped].map(([module, list]) => `${module}: { ${list.join(", ")} }`),
    ];
    edits.push({
      file: fileName,
      start: pattern.getStart(file),
      end: pattern.getEnd(),
      text: `{ ${entries.join(", ")} }`,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      return;
    }
    if (
      ts.isExportDeclaration(node) &&
      node.exportClause !== undefined &&
      ts.isNamedExports(node.exportClause)
    ) {
      const from = indexOf(project, file, node);
      for (const element of node.exportClause.elements) {
        const name = (element.propertyName ?? element.name).text;
        if (
          from !== undefined &&
          findMember(name, from) !== undefined &&
          isFlat(checker, checker.getSymbolAtLocation(element.propertyName ?? element.name))
        ) {
          local.push(`${where(file, element)}: re-exports the flat name \`${name}\``);
        }
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ts.isIdentifier(node.name)
    ) {
      throughNamespace(node.expression, node.name);
    }
    if (ts.isQualifiedName(node) && ts.isIdentifier(node.left) && ts.isTypeQueryNode(node.parent)) {
      throughNamespace(node.left, node.right);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined
    ) {
      destructured(node.name, node.initializer);
    }
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const shorthand = ts.isShorthandPropertyAssignment(parent) && parent.name === node;
      const symbol = shorthand
        ? checker.getShorthandAssignmentValueSymbol(parent)
        : checker.getSymbolAtLocation(node);
      const binding =
        symbol === undefined ? undefined : renamed.find((candidate) => candidate.symbol === symbol);
      const rename = binding?.rename;
      if (binding !== undefined && rename !== undefined) {
        if (ts.isExportSpecifier(parent)) {
          local.push(`${where(file, node)}: exports the flat name \`${node.text}\``);
        } else if (inTypePosition(node)) {
          if (rename.from === rename.module) {
            keptForTypes.add(binding);
          } else {
            local.push(
              `${where(file, node)}: \`${node.text}\` names a type, and \`${rename.module}.${rename.member}\` has none`,
            );
          }
        } else {
          const set = needed.get(rename.module) ?? new Set<Package>();
          set.add(binding.from);
          needed.set(rename.module, set);
          references.push({ node, rename, shorthand });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  // A module read from both packages comes from pinna-effect, whose module
  // holds every member of pinna's as the same function, but `reconcile`,
  // which keeps pinna's behavior for every call pinna's accepts (`names.ts`).
  const chosen = new Map<string, Package>();
  for (const [module, froms] of needed) {
    chosen.set(
      module,
      froms.has("@frondruntime/pinna-effect")
        ? "@frondruntime/pinna-effect"
        : "@frondruntime/pinna",
    );
  }

  // Each module's local name: its own name, or `Pinna<Module>` (then
  // `Pinna<Module>Module`) where the file already binds the name to something else.
  const taken = topLevelNames(file, bindings);
  const localName = new Map<string, string>();
  for (const module of chosen.keys()) {
    const candidates = [module, `Pinna${module}`, `Pinna${module}Module`];
    const free = candidates.find((candidate) => {
      if (taken.has(candidate)) {
        return false;
      }
      return references.every((reference) => {
        const bound = checker.resolveName(candidate, reference.node, ts.SymbolFlags.Value, false);
        return (
          bound === undefined ||
          bindings.some(
            (binding) =>
              binding.symbol === bound &&
              binding.specifier.propertyName === undefined &&
              binding.specifier.name.text === candidate,
          )
        );
      });
    });
    if (free === undefined) {
      local.push(
        `${where(file, file)}: \`${module}\`, \`Pinna${module}\`, and \`Pinna${module}Module\` are all bound here`,
      );
    } else {
      localName.set(module, free);
    }
  }

  if (local.length > 0) {
    problems.push(...local);
    return [];
  }

  for (const { node, rename, shorthand } of references) {
    const replacement = `${localName.get(rename.module)}.${rename.member}`;
    edits.push({
      file: fileName,
      start: node.getStart(file),
      end: node.getEnd(),
      text: shorthand ? `${node.text}: ${replacement}` : replacement,
    });
  }

  // The import lists: drop each renamed specifier a type no longer reads, then add each module.
  interface Entry {
    readonly name: string;
    readonly alias: string | undefined;
    readonly type: boolean;
  }
  const lists = new Map<ts.ImportDeclaration, Array<Entry>>();
  const fromOf = new Map<ts.ImportDeclaration, Package>();
  for (const binding of bindings) {
    fromOf.set(binding.declaration, binding.from);
  }
  for (const declaration of fromOf.keys()) {
    const bound = declaration.importClause?.namedBindings;
    if (bound === undefined || !ts.isNamedImports(bound)) {
      continue;
    }
    lists.set(
      declaration,
      bound.elements
        .filter((specifier) => {
          const binding = bindings.find((candidate) => candidate.specifier === specifier);
          return binding?.rename === undefined || keptForTypes.has(binding);
        })
        .map((specifier) => ({
          name: (specifier.propertyName ?? specifier.name).text,
          alias: specifier.propertyName === undefined ? undefined : specifier.name.text,
          type: specifier.isTypeOnly,
        })),
    );
  }
  const additions: Array<string> = [];
  for (const [module, from] of chosen) {
    const name = localName.get(module) ?? module;
    const alias = name === module ? undefined : name;
    let placed = false;
    for (const [declaration, list] of lists) {
      const index = list.findIndex((entry) => entry.name === module && entry.alias === alias);
      if (index === -1) {
        continue;
      }
      if (fromOf.get(declaration) === from && declaration.importClause?.isTypeOnly !== true) {
        list[index] = { name: module, alias, type: false };
        placed = true;
      } else {
        list.splice(index, 1);
      }
    }
    if (placed) {
      continue;
    }
    const target = [...lists.keys()].find(
      (declaration) =>
        declaration.importClause?.isTypeOnly !== true && fromOf.get(declaration) === from,
    );
    const entry = { name: module, alias, type: false };
    if (target === undefined) {
      const specifier = [...fromOf.keys()].find(
        (declaration) => fromOf.get(declaration) === from,
      )?.moduleSpecifier;
      const text = alias === undefined ? module : `${module} as ${alias}`;
      additions.push(
        `import { ${text} } from ${specifier === undefined ? JSON.stringify(from) : specifier.getText(file)};`,
      );
    } else {
      lists.get(target)?.push(entry);
    }
  }
  for (const [declaration, list] of lists) {
    const original = declaration.importClause?.namedBindings as ts.NamedImports;
    const before = original.elements.map((element) => element.getText(file));
    const after = list.map(
      (entry) =>
        `${entry.type ? "type " : ""}${entry.name}${entry.alias === undefined ? "" : ` as ${entry.alias}`}`,
    );
    if (before.join(",") === after.join(",")) {
      continue;
    }
    // A changed list is sorted by name, as Biome sorts it; a Markdown sample is not formatted after.
    after.sort((left, right) =>
      left.replace(/^type /, "").localeCompare(right.replace(/^type /, ""), "en", {
        sensitivity: "base",
      }),
    );
    if (after.length === 0 && declaration.importClause?.name === undefined) {
      let end = declaration.getEnd();
      if (file.text[end] === "\n") {
        end += 1;
      }
      edits.push({ file: fileName, start: declaration.getStart(file), end, text: "" });
    } else {
      edits.push({
        file: fileName,
        start: original.getStart(file),
        end: original.getEnd(),
        text: `{ ${after.join(", ")} }`,
      });
    }
  }
  if (additions.length > 0) {
    const last = file.statements.filter(ts.isImportDeclaration).at(-1);
    const at = last === undefined ? 0 : last.getEnd();
    edits.push({
      file: fileName,
      start: at,
      end: at,
      text: last === undefined ? `${additions.join("\n")}\n` : `\n${additions.join("\n")}`,
    });
  }
  return edits;
};

const renameMembers = (): Array<Edit> =>
  projects().flatMap((project) => project.files.flatMap((file) => renameMembersIn(project, file)));

// ---------------------------------------------------------------- pass 3: exports

/** The modules a package defines in `src/modules`: the exported const and the file. */
const localModules = (index: string): Map<string, { path: string; hasInterface: boolean }> => {
  const directory = resolve(dirname(index), "modules");
  const found = new Map<string, { path: string; hasInterface: boolean }>();
  for (const name of ts.sys.readDirectory(directory, [".ts"], undefined, undefined, 1)) {
    const text = readText(name);
    const constant = /export const (\w+)\b/.exec(text)?.[1];
    if (constant !== undefined) {
      found.set(constant, {
        path: `./modules/${relative(directory, name)}`,
        hasInterface: new RegExp(`export interface ${constant}Module\\b`).test(text),
      });
    }
  }
  return found;
};

/**
 * Each index drops its flat names and exports each of its `src/modules`, so
 * a module name always means the package's own module.
 */
const pruneExports = (): Array<Edit> => {
  const edits: Array<Edit> = [];
  for (const [name, index] of Object.entries(indexes) as Array<[Package, string]>) {
    const file = ts.createSourceFile(index, readText(index), ts.ScriptTarget.Latest, true);
    const modules = localModules(index);
    const exported = new Set<string>();
    let lastExport: ts.Statement | undefined;
    for (const statement of file.statements) {
      if (
        !ts.isExportDeclaration(statement) ||
        statement.exportClause === undefined ||
        !ts.isNamedExports(statement.exportClause)
      ) {
        continue;
      }
      lastExport = statement;
      const source =
        statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : "";
      const fromModules = source.startsWith("./modules/");
      const elements = statement.exportClause.elements;
      const kept = elements.filter((element) => {
        if (element.isTypeOnly || statement.isTypeOnly) {
          return true;
        }
        const exportedName = element.name.text;
        if (modules.has(exportedName)) {
          if (fromModules) {
            exported.add(exportedName);
          }
          return fromModules;
        }
        if (moduleNames.has(exportedName)) {
          return true;
        }
        return findMember(exportedName, name) === undefined;
      });
      if (kept.length === elements.length) {
        continue;
      }
      if (kept.length === 0) {
        let end = statement.getEnd();
        if (file.text[end] === "\n") {
          end += 1;
        }
        edits.push({ file: index, start: statement.getStart(file), end, text: "" });
      } else {
        edits.push({
          file: index,
          start: statement.exportClause.getStart(file),
          end: statement.exportClause.getEnd(),
          text: `{ ${kept.map((element) => element.getText(file)).join(", ")} }`,
        });
      }
    }
    const missing = [...modules].filter(([module]) => !exported.has(module));
    if (missing.length > 0) {
      const at = lastExport?.getEnd() ?? file.getEnd();
      edits.push({
        file: index,
        start: at,
        end: at,
        text: missing
          .map(
            ([module, { path, hasInterface }]) =>
              `\nexport { ${module}${hasInterface ? `, type ${module}Module` : ""} } from "${path}";`,
          )
          .join(""),
      });
    }
  }
  return edits;
};

// ---------------------------------------------------------------- run

const changed = new Set<string>();
const passes: ReadonlyArray<readonly [string, () => ReadonlyArray<Edit>]> = [
  ["types", renameTypes],
  ["members", renameMembers],
  ["exports", pruneExports],
];
for (const [name, pass] of passes) {
  texts.clear();
  const edits = pass();
  const files = apply(edits);
  for (const file of files) {
    changed.add(file);
  }
  console.log(`${name}: ${edits.length} edits in ${files.length} files`);
  if (check && files.length > 0) {
    break;
  }
}

if (problems.length > 0) {
  console.log(`\n${problems.length} references left as they were:`);
  for (const problem of [...new Set(problems)].sort()) {
    console.log(`  ${problem}`);
  }
}

if (check) {
  process.exit(changed.size > 0 || problems.length > 0 ? 1 : 0);
}
if (changed.size > 0) {
  const formatted = Bun.spawnSync(
    [
      "bunx",
      "biome",
      "check",
      "--write",
      ...[...changed].filter((file) => !file.endsWith(".md")).map((file) => relative(root, file)),
    ],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if (formatted.exitCode !== 0) {
    console.log("biome left findings in the changed files; see above");
  }
}
process.exit(problems.length > 0 ? 1 : 0);
