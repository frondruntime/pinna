import { describe, expect, test } from "bun:test";
import { moveMembers } from "./move-members.ts";

const run = (text: string, fileName = "/virtual/app.ts") => moveMembers(fileName, text);

describe("move-members: Realm.watchScoped becomes Program.watchScoped", () => {
  test("rewrites the call and adds Program to the import", () => {
    const result = run(
      [
        `import { Realm } from "@frondruntime/pinna-effect";`,
        `const realm = Realm.make();`,
        `export const save = Realm.watchScoped(realm, (read) => 1, () => undefined as never);`,
      ].join("\n"),
    );
    expect(result.problems).toEqual([]);
    expect(result.text).toBe(
      [
        `import { Realm, Program } from "@frondruntime/pinna-effect";`,
        `const realm = Realm.make();`,
        `export const save = Program.watchScoped(realm, (read) => 1, () => undefined as never);`,
      ].join("\n"),
    );
  });

  test("uses an existing Program import, aliased or not", () => {
    const result = run(
      [
        `import { Program as Programs, Realm as R } from "@frondruntime/pinna-effect";`,
        `R.watchScoped(r, s, e);`,
        `Programs.changes(x);`,
      ].join("\n"),
    );
    expect(result.text).toBe(
      [
        `import { Program as Programs, Realm as R } from "@frondruntime/pinna-effect";`,
        `Programs.watchScoped(r, s, e);`,
        `Programs.changes(x);`,
      ].join("\n"),
    );
  });

  test("imports Program as PinnaProgram when the file binds Program", () => {
    const result = run(
      [
        `import { Realm } from "@frondruntime/pinna-effect";`,
        `const Program = 1;`,
        `Realm.watchScoped(r, s, e);`,
      ].join("\n"),
    );
    expect(result.text).toBe(
      [
        `import { Realm, Program as PinnaProgram } from "@frondruntime/pinna-effect";`,
        `const Program = 1;`,
        `PinnaProgram.watchScoped(r, s, e);`,
      ].join("\n"),
    );
  });

  test("rewrites a namespace import's access", () => {
    const result = run(
      [
        `import * as Pinna from "@frondruntime/pinna-effect";`,
        `Pinna.Realm.watchScoped(r, s, e);`,
      ].join("\n"),
    );
    expect(result.text).toBe(
      [
        `import * as Pinna from "@frondruntime/pinna-effect";`,
        `Pinna.Program.watchScoped(r, s, e);`,
      ].join("\n"),
    );
  });

  test("leaves pinna's Realm, a shadowing Realm, and other members alone", () => {
    const text = [
      `import { Realm } from "@frondruntime/pinna";`,
      `import { Realm as EffectRealm } from "@frondruntime/pinna-effect";`,
      `Realm.watch(r, s, e);`,
      `EffectRealm.scoped();`,
      `function local(EffectRealm: { watchScoped(): void }) {`,
      `  EffectRealm.watchScoped();`,
      `}`,
    ].join("\n");
    expect(run(text)).toEqual({ text, problems: [] });
  });

  test("reports a destructuring and an element access, and changes nothing", () => {
    const text = [
      `import { Realm } from "@frondruntime/pinna-effect";`,
      `const { watchScoped } = Realm;`,
      `Realm["watchScoped"](r, s, e);`,
      `Realm.watchScoped(r, s, e);`,
    ].join("\n");
    const result = run(text);
    expect(result.text).toBe(text);
    expect(result.problems).toEqual([
      "/virtual/app.ts:2: `{ watchScoped } = Realm` destructures a moved member; write it by hand",
      '/virtual/app.ts:3: `Realm["watchScoped"]` is an element access; write the moved member by hand',
    ]);
  });

  test("works in a .tsx file", () => {
    const result = run(
      [
        `import { Realm } from "@frondruntime/pinna-effect";`,
        `const view = <div />;`,
        `Realm.watchScoped(r, s, e);`,
      ].join("\n"),
      "/virtual/app.tsx",
    );
    expect(result.text).toContain(`import { Realm, Program } from "@frondruntime/pinna-effect";`);
    expect(result.text).toContain(`Program.watchScoped(r, s, e);`);
  });

  test("a second run changes nothing", () => {
    const first = run(
      [`import { Realm } from "@frondruntime/pinna-effect";`, `Realm.watchScoped(r, s, e);`].join(
        "\n",
      ),
    );
    expect(run(first.text)).toEqual({ text: first.text, problems: [] });
  });
});
