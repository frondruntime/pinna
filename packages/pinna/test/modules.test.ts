import { describe, expect, test } from "bun:test";
import {
  Atom,
  Box,
  Collection,
  Computed,
  isPinnaError,
  Realm,
  Source,
  Stage,
} from "../src/index.ts";

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    if (isPinnaError(error, "PinnaUsageError")) {
      return error.code;
    }
    throw error;
  }
  return undefined;
};

describe("modules", () => {
  test("a module and its type share a name", () => {
    const realm: Realm = Realm.make();
    const $count: Box<number> = Box.make(realm, 1);
    const $double: Computed<number> = Computed.make(realm, (read) => read($count) * 2);
    const $rows: Collection<number, { readonly id: number }> = Collection.make(realm, {
      keyOf: (row: { readonly id: number }) => row.id,
    });
    const atom: Atom = Atom.make(realm);
    const stage: Stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write($count, 2);
    });
    Stage.apply(stage);
    expect(Realm.untracked(realm, (read) => [read($count), read($double)])).toEqual([2, 4]);
    expect(Realm.untracked(realm, (read) => read($rows.rows))).toEqual([]);
    expect(atom).toBeDefined();
    Realm.dispose(realm);
    expect(Realm.status(realm)).toBe("disposed");
  });
});

describe("Source.peek", () => {
  test("reads one box or computed value outside every place", () => {
    const realm = Realm.make();
    const $count = Box.make(realm, 3);
    const $double = Computed.make(realm, (read) => read($count) * 2);
    expect(Source.peek($count)).toBe(3);
    expect(Source.peek($double)).toBe(6);
    expect(Source.inspect($double).observers).toBe(0);
  });

  test("throws where reads are tracked, so it never goes stale silently", () => {
    const realm = Realm.make();
    const $count = Box.make(realm, 3);
    const $peeking = Computed.make(realm, () => Source.peek($count));
    expect(codeOf(() => Realm.untracked(realm, (read) => read($peeking)))).toBe(
      "pinna/peek-while-tracking",
    );
    let fromSelect: string | undefined;
    const stop = Realm.watch(
      realm,
      () => {
        fromSelect = codeOf(() => Source.peek($count));
        return 0;
      },
      () => {},
    );
    stop();
    expect(fromSelect).toBe("pinna/peek-while-tracking");
  });

  test("throws inside a stage recipe, where it would read the value from before the stage", () => {
    const realm = Realm.make();
    const $count = Box.make(realm, 3);
    const stage = Stage.make(realm);
    let inRecipe: string | undefined;
    Stage.update(stage, (_read, write) => {
      write($count, 4);
      inRecipe = codeOf(() => Source.peek($count));
    });
    Stage.drop(stage);
    expect(inRecipe).toBe("pinna/peek-in-recipe");
  });
});
