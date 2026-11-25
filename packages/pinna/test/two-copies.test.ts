import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as First from "../src/index.ts";

/**
 * Two loaded copies of pinna, as an application gets when two packages each
 * bundle their own: the second copy is `src` bundled again by `Bun.build`
 * into a temporary folder, so its module objects and classes are its own.
 * Today a read or write across copies throws `pinna/foreign-realm` and
 * `isPinnaError` recognizes the other copy's errors; `Box.make` and
 * `Realm.autorun` accept the other copy's realm, which is an open question in
 * the test catalog, so these tests do not pin it.
 */

let Second: typeof First;

beforeAll(async () => {
  const outdir = mkdtempSync(join(tmpdir(), "pinna-copy-"));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/index.ts")],
    outdir,
    target: "bun",
    conditions: ["source"],
  });
  expect(built.success).toBe(true);
  Second = (await import(built.outputs[0]?.path as string)) as typeof First;
  rmSync(outdir, { recursive: true, force: true });
});

const foreign = expect.objectContaining({ code: "pinna/foreign-realm" }) as never;

describe("two loaded copies", () => {
  test("the second copy is a separate module", () => {
    expect(Second.Realm).not.toBe(First.Realm);
    expect(Second.PinnaError).not.toBe(First.PinnaError);
  });

  test("a read of the other copy's box throws pinna/foreign-realm", () => {
    const realm = First.Realm.make();
    const box = Second.Box.make(Second.Realm.make(), 1);
    expect(() => First.Realm.untracked(realm, (read) => read(box as never))).toThrow(foreign);
  });

  test("a write to the other copy's box throws pinna/foreign-realm and changes nothing", () => {
    const realm = First.Realm.make();
    const secondRealm = Second.Realm.make();
    const box = Second.Box.make(secondRealm, 1);
    expect(() =>
      First.Realm.update(realm, (_read, write) => {
        write(box as never, 2 as never);
      }),
    ).toThrow(foreign);
    expect(Second.Realm.untracked(secondRealm, (read) => read(box))).toBe(1);
  });

  test("a computed value that reads the other copy's box throws pinna/foreign-realm", () => {
    const realm = First.Realm.make();
    const box = Second.Box.make(Second.Realm.make(), 1);
    const derived = First.Computed.make(realm, (read) => read(box as never) as number);
    expect(() => First.Realm.untracked(realm, (read) => read(derived))).toThrow(foreign);
  });

  test("Source.inspect refuses the other copy's box with pinna/not-made-by-pinna", () => {
    const box = Second.Box.make(Second.Realm.make(), 1);
    expect(() => First.Source.inspect(box as never)).toThrow(
      expect.objectContaining({ code: "pinna/not-made-by-pinna" }) as never,
    );
  });

  test("isPinnaError recognizes the other copy's error, where instanceof does not", () => {
    let caught: unknown;
    try {
      Second.Realm.update(Second.Realm.make(), () => {
        Second.Source.peek(undefined as never);
      });
    } catch (error) {
      caught = error;
    }
    expect(First.isPinnaError(caught)).toBe(true);
    expect(caught instanceof First.PinnaError).toBe(false);
  });
});
