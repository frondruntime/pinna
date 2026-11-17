/**
 * Packs each published package and installs the tarballs into a new project
 * outside the workspace, the way a user installs them, then typechecks and
 * runs code against them. Nothing is published here; publishing uploads
 * these same tarballs, so what reaches the registry is what passed.
 *
 * The project imports every entry with `moduleResolution: "NodeNext"`, and
 * without the `source` condition, so it reads what the tarballs ship and not
 * the workspace's sources.
 */
import { Console, Effect, FileSystem, Path, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import {
  type PublishedPackage,
  packageDirectory,
  publishedPackages,
  workspaceRoot,
} from "./packages.ts";
import { output, ReleaseError } from "./process.ts";

type Services = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

/** Each package's tarball, in dependency order. */
export type Tarballs = ReadonlyArray<readonly [PublishedPackage, string]>;

const Ranges = Schema.Record(Schema.String, Schema.String);

const Manifest = Schema.Struct({
  dependencies: Schema.optionalKey(Ranges),
  devDependencies: Schema.optionalKey(Ranges),
  peerDependencies: Schema.optionalKey(Ranges),
});

const platformFailure =
  (step: string) =>
  (error: { readonly message: string }): ReleaseError =>
    new ReleaseError({ step, message: error.message });

/** Reads and decodes a JSON file. */
export const readJson = <S extends Schema.Top>(
  step: string,
  schema: S,
  file: string,
): Effect.Effect<S["Type"], ReleaseError, FileSystem.FileSystem | S["DecodingServices"]> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const text = yield* fileSystem
      .readFileString(file)
      .pipe(Effect.mapError(platformFailure(step)));
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
      Effect.mapError((error) => new ReleaseError({ step, message: `${file}: ${error.message}` })),
    );
  });

const workspaceVersion = (
  root: string,
  manifest: string,
  name: string,
): Effect.Effect<string, ReleaseError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const step = `version of ${name}`;
    const json = yield* readJson(step, Manifest, path.join(root, manifest, "package.json"));
    const version = [json.dependencies, json.devDependencies, json.peerDependencies]
      .map((section) => section?.[name])
      .find((value) => value !== undefined);
    if (version === undefined) {
      return yield* new ReleaseError({ step, message: `${manifest} names no version of ${name}` });
    }
    return version;
  });

/** Packs each package into `tarballs`, which runs its `prepack` build. */
const pack = (root: string, tarballs: string): Effect.Effect<Tarballs, ReleaseError, Services> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const listing = fileSystem
      .readDirectory(tarballs)
      .pipe(Effect.mapError(platformFailure("list tarballs")));
    const packed: Array<readonly [PublishedPackage, string]> = [];
    for (const published of publishedPackages) {
      const step = `pack ${published.name}`;
      const before = new Set(yield* listing);
      yield* output(
        step,
        "bun",
        ["pm", "pack", "--destination", tarballs],
        yield* packageDirectory(root, published),
      );
      const added = (yield* listing).filter((file) => !before.has(file));
      const [tarball] = added;
      if (added.length !== 1 || tarball === undefined) {
        return yield* new ReleaseError({
          step,
          message: `expected one new tarball, found ${added.join(", ") || "none"}`,
        });
      }
      packed.push([published, path.join(tarballs, tarball)]);
    }
    return packed;
  });

/**
 * Every request for a package resolves to its tarball, directly and through
 * the other packages. Without the overrides an installer may nest a registry
 * copy under a dependent, and the typecheck would then compare two copies.
 */
const projectManifest = (
  root: string,
  project: string,
  tarballs: Tarballs,
): Effect.Effect<unknown, ReleaseError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fromTarballs = Object.fromEntries(
      tarballs.map(([published, tarball]) => [
        published.name,
        `file:${path.relative(project, tarball)}`,
      ]),
    );
    return {
      name: "pinna-pack-smoke",
      private: true,
      type: "module",
      dependencies: {
        ...fromTarballs,
        effect: yield* workspaceVersion(root, "packages/pinna-effect", "effect"),
        react: yield* workspaceVersion(root, "packages/pinna-react", "react"),
      },
      devDependencies: {
        "@types/bun": yield* workspaceVersion(root, ".", "@types/bun"),
        "@types/react": yield* workspaceVersion(root, "packages/pinna-react", "@types/react"),
        typescript: yield* workspaceVersion(root, ".", "typescript"),
      },
      overrides: fromTarballs,
    };
  });

/** `skipLibCheck` is off, so the declarations the tarballs ship are checked too. */
const projectTsconfig = {
  compilerOptions: {
    strict: true,
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    noEmit: true,
    skipLibCheck: false,
    types: ["bun"],
  },
  include: ["index.ts"],
};

/**
 * Typechecks, then runs. A `Realm` from the testing entry goes into the main
 * entry's functions and into pinna-effect's, so a type the entries share must
 * be one type; the expected errors fail if a declaration resolved to `any`.
 */
const projectSource = `import { Schema } from "effect";
import {
  type Box,
  box,
  computed,
  createRealm,
  type Realm,
  untracked,
  update,
} from "@frondruntime/pinna";
import { ObservableRealm } from "@frondruntime/pinna/internal";
import { testRealm } from "@frondruntime/pinna/testing";
import { schemaBox } from "@frondruntime/pinna-effect";
import { RealmProvider, useRealm, useValue } from "@frondruntime/pinna-react";

const fail = (message: string): never => {
  throw new Error(message);
};

using realm = testRealm();
const count: Box<number> = box(realm, 1);
const doubled = computed(realm, (read) => read(count) * 2);
const checked: Box<number> = schemaBox(realm, Schema.Number, 2);
update(realm, (_read, write) => {
  write(count, 3);
  write(checked, 4);
});
// @ts-expect-error a box of a number holds no string
const wrong: Box<string> = count;
void wrong;

if (untracked(realm, (read) => read(doubled)) !== 6) fail("the computed value did not follow its box");
if (untracked(realm, (read) => read(checked)) !== 4) fail("the schema box did not take its write");
if (!(createRealm() instanceof ObservableRealm)) {
  fail("the main entry and the internal entry hold two copies of the realm class");
}

const fromHook: () => Realm = useRealm;
void fromHook;
if (typeof RealmProvider !== "function" || typeof useValue !== "function") {
  fail("pinna-react exports no hooks");
}
console.log("runtime ok");
`;

const installed = (
  project: string,
  published: PublishedPackage,
  ...rest: Array<string>
): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(project, "node_modules", published.name, ...rest);
  });

const assertNoWorkspaceRanges = (
  project: string,
): Effect.Effect<void, ReleaseError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    for (const published of publishedPackages) {
      const step = `ranges of ${published.name}`;
      const text = yield* fileSystem
        .readFileString(yield* installed(project, published, "package.json"))
        .pipe(Effect.mapError(platformFailure(step)));
      if (text.includes("workspace:")) {
        return yield* new ReleaseError({
          step,
          message: "the packed package.json keeps a workspace: range",
        });
      }
    }
    yield* Console.log("ranges ok");
  });

const assertPackedFiles = (
  project: string,
): Effect.Effect<void, ReleaseError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const missing: Array<string> = [];
    for (const published of publishedPackages) {
      for (const file of published.expectedFiles) {
        const exists = yield* fileSystem
          .exists(yield* installed(project, published, file))
          .pipe(Effect.mapError(platformFailure("packed files")));
        if (!exists) {
          missing.push(`${published.name}/${file}`);
        }
      }
    }
    if (missing.length > 0) {
      return yield* new ReleaseError({
        step: "packed files",
        message: `the tarballs are missing ${missing.join(", ")}`,
      });
    }
    yield* Console.log("files ok");
  });

const assertSingleCopies = (
  project: string,
): Effect.Effect<void, ReleaseError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    for (const published of publishedPackages) {
      const nested = yield* installed(project, published, "node_modules");
      const entries = yield* fileSystem
        .readDirectory(nested)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      if (entries.includes("@frondruntime")) {
        return yield* new ReleaseError({
          step: "single copies",
          message: `${published.name} has its own copy of a Pinna package under ${nested}`,
        });
      }
    }
    yield* Console.log("single copies ok");
  });

/**
 * Packs into `work/tarballs`, installs into `work/project`, and checks the
 * install. Returns the tarballs, which stay in `work`.
 */
export const packAndSmoke = (work: string): Effect.Effect<Tarballs, ReleaseError, Services> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* workspaceRoot;
    const tarballs = path.join(work, "tarballs");
    const project = path.join(work, "project");
    const write = (file: string, text: string) =>
      fileSystem
        .writeFileString(path.join(project, file), text)
        .pipe(Effect.mapError(platformFailure(`write ${file}`)));
    yield* Effect.all(
      [tarballs, project].map((directory) =>
        fileSystem
          .makeDirectory(directory, { recursive: true })
          .pipe(Effect.mapError(platformFailure("work directory"))),
      ),
      { discard: true },
    );
    const packed = yield* pack(root, tarballs);
    yield* Effect.all(
      [
        write(
          "package.json",
          JSON.stringify(yield* projectManifest(root, project, packed), null, 2),
        ),
        write("tsconfig.json", JSON.stringify(projectTsconfig, null, 2)),
        write("index.ts", projectSource),
      ],
      { concurrency: "unbounded", discard: true },
    );
    yield* output("install", "bun", ["install", "--linker", "hoisted"], project);
    yield* assertNoWorkspaceRanges(project);
    yield* assertPackedFiles(project);
    yield* assertSingleCopies(project);
    yield* output("typecheck", "bunx", ["tsc", "-p", "tsconfig.json"], project);
    yield* Console.log((yield* output("run", "bun", ["index.ts"], project)).trimEnd());
    return packed;
  });
