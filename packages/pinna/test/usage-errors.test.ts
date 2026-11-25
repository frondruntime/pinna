import { describe, expect, test } from "bun:test";
import {
  Box,
  Collection,
  Computed,
  isPinnaError,
  type PinnaError,
  PinnaUsageError,
  type Read,
  Realm,
  Source,
  Stage,
  StageClosedError,
  StageConflictError,
  type Write,
} from "../src/index.ts";
import { retainedKeys } from "../src/testing/index.ts";

/**
 * Every error Pinna throws is a `PinnaError`: a condition code handles has
 * its own class and `_tag`, misuse is one `PinnaUsageError` with a `code`.
 * These tests assert on `_tag` and `code`, never on the message.
 */

const thrown = (run: () => unknown): PinnaError => {
  try {
    run();
  } catch (error) {
    expect(isPinnaError(error)).toBe(true);
    return error as PinnaError;
  }
  throw new Error("expected a throw");
};

const usageCode = (run: () => unknown): string => {
  const error = thrown(run);
  expect(error._tag).toBe("PinnaUsageError");
  expect(error).toBeInstanceOf(PinnaUsageError);
  return (error as PinnaUsageError).code;
};

describe("PinnaError", () => {
  test("a usage error is an Error with its name, tag, code, and unchanged message", () => {
    const realm = Realm.make();
    const error = thrown(() => Box.make(realm, 0, { name: "" }));
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PinnaUsageError");
    expect(error._tag).toBe("PinnaUsageError");
    expect((error as PinnaUsageError).code).toBe("pinna/empty-name");
    expect(error.message).toBe("pinna: a name is a non-empty string");
  });

  test("isPinnaError matches by brand, so an error from another copy of Pinna matches", () => {
    const foreign = Object.assign(new Error("pinna: from another copy"), {
      "~pinna/Error": true,
      _tag: "StageConflictError",
    });
    expect(isPinnaError(foreign)).toBe(true);
    expect(isPinnaError(new Error("pinna: lookalike"))).toBe(false);
    expect(isPinnaError({ "~pinna/Error": "yes" })).toBe(false);
    expect(isPinnaError(null)).toBe(false);
    expect(isPinnaError("pinna: a string")).toBe(false);
  });

  test("the stage conditions carry their own literal tags", () => {
    const realm = Realm.make();
    const $price = Box.make(realm, 1, { name: "price" });
    const stage = Stage.make(realm, { conflicts: "fail" });
    Stage.update(stage, (read, write) => {
      write($price, read($price) + 1);
    });
    Realm.update(realm, (_read, write) => {
      write($price, 5);
    });
    const conflict = thrown(() => Stage.apply(stage));
    expect(conflict).toBeInstanceOf(StageConflictError);
    expect(conflict._tag).toBe("StageConflictError");
    expect(conflict.name).toBe("StageConflictError");

    // Narrowed by tag to the class, so its fields read without a cast.
    if (!isPinnaError(conflict, "StageConflictError")) throw new Error("expected a conflict");
    expect(conflict.changed).toEqual(["price"]);
    expect(conflict.observables).toEqual([$price]);
    expect(isPinnaError(conflict, "StageClosedError")).toBe(false);
    // Serialized with its fields, leaving out the observables, which hold realms.
    expect(JSON.parse(JSON.stringify(conflict))).toEqual({
      _tag: "StageConflictError",
      name: "StageConflictError",
      message: conflict.message,
      stage: undefined,
      changed: ["price"],
    });

    const closed = thrown(() => Stage.update(stage, () => {}));
    expect(closed).toBeInstanceOf(StageClosedError);
    expect(closed._tag).toBe("StageClosedError");
    expect(JSON.parse(JSON.stringify(closed))).toMatchObject({
      _tag: "StageClosedError",
      status: "dropped",
    });
  });

  test("a usage error serializes with its code", () => {
    const realm = Realm.make();
    const error = thrown(() => Box.make(realm, 0, { name: "" }));
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      _tag: "PinnaUsageError",
      name: "PinnaUsageError",
      message: "pinna: a name is a non-empty string",
      code: "pinna/empty-name",
    });
  });

  test("the internal wait past the depth limit never reaches the caller", () => {
    const realm = Realm.make();
    const $source = Box.make(realm, 0);
    let $tip: Computed<number> = Computed.make(realm, (read) => read($source));
    for (let depth = 0; depth < 5_000; depth++) {
      const $below = $tip;
      $tip = Computed.make(realm, (read) => read($below) + 1);
    }
    expect(Realm.untracked(realm, (read) => read($tip))).toBe(5_000);
  });
});

describe("PinnaUsageError codes", () => {
  test("reading and writing", () => {
    const realm = Realm.make();
    const other = Realm.make();
    const $count = Box.make(realm, 0);
    let keptRead: Read | undefined;
    let keptWrite: Write | undefined;
    Realm.update(realm, (read, write) => {
      keptRead = read;
      keptWrite = write;
    });
    expect(usageCode(() => keptRead?.($count))).toBe("pinna/read-outside-place");
    expect(usageCode(() => keptWrite?.($count, 1))).toBe("pinna/write-outside-update");
    expect(usageCode(() => Realm.update(other, (read) => void read($count)))).toBe(
      "pinna/foreign-realm",
    );
    expect(usageCode(() => Source.observe({} as never))).toBe("pinna/not-made-by-pinna");
  });

  test("updates and derivations", () => {
    const realm = Realm.make();
    const $writer = Computed.make(realm, () => {
      Realm.update(realm, () => {});
      return 1;
    });
    expect(usageCode(() => Realm.untracked(realm, (read) => read($writer)))).toBe(
      "pinna/update-in-derivation",
    );
    expect(usageCode(() => Realm.update(realm, (async () => {}) as never))).toBe(
      "pinna/async-recipe",
    );
    expect(usageCode(() => Realm.update(realm, (() => 1) as never))).toBe(
      "pinna/recipe-returns-value",
    );
    const $self: Computed<number> = Computed.make(realm, (read) => read($self) + 1);
    expect(usageCode(() => Realm.untracked(realm, (read) => read($self)))).toBe("pinna/cycle");
  });

  test("drafts", () => {
    const realm = Realm.make();
    const $point = Box.make(realm, { x: 0 });
    let kept: { x: number } | undefined;
    Realm.update(realm, (_read, write) => {
      write.modify($point, (draft) => {
        kept = draft;
      });
    });
    expect(
      usageCode(() => {
        if (kept !== undefined) kept.x = 1;
      }),
    ).toBe("pinna/draft-kept");
    const $date = Box.make(realm, new Date(0));
    expect(
      usageCode(() =>
        Realm.update(realm, (_read, write) => {
          write.modify($date as never, () => {});
        }),
      ),
    ).toBe("pinna/modify-not-draftable");
  });

  test("collections and reconcile", () => {
    const realm = Realm.make();
    const keyOf = (row: { readonly id: number }) => row.id;
    const $rows = Collection.make(realm, { keyOf });
    expect(
      usageCode(() =>
        Realm.update(realm, (_read, write) => {
          write.replaceAll($rows, [{ id: 1 }, { id: 1 }]);
        }),
      ),
    ).toBe("pinna/repeated-key");
    expect(
      usageCode(() =>
        Realm.update(realm, (_read, write) => {
          write.upsert($rows, undefined as never);
        }),
      ),
    ).toBe("pinna/undefined-row");
    expect(
      usageCode(() =>
        Collection.reconcile([], [{ id: 1 }, { id: 1 }], { keyOf, equals: () => true }),
      ),
    ).toBe("pinna/repeated-key");
    expect(usageCode(() => Collection.onRowChange({} as never, () => {}))).toBe(
      "pinna/not-made-by-pinna",
    );
    expect(usageCode(() => retainedKeys({} as never))).toBe("pinna/not-made-by-pinna");
  });

  test("stages", () => {
    const realm = Realm.make();
    const parent = Stage.make(realm);
    const child = Stage.make(parent);
    expect(usageCode(() => Stage.apply(parent))).toBe("pinna/stage-child-open");
    expect(usageCode(() => Stage.update(child, () => void Box.make(realm, 0)))).toBe(
      "pinna/made-in-recipe",
    );
    expect(usageCode(() => Stage.read(child, () => void Box.make(realm, 0)))).toBe(
      "pinna/made-in-recipe",
    );
    expect(usageCode(() => Stage.make(realm, { conflicts: "never" as never }))).toBe(
      "pinna/stage-conflicts-option",
    );
    Stage.drop(child);
    Stage.drop(parent);
  });
});
