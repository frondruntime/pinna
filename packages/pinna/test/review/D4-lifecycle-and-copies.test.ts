import { expect, test } from "bun:test";
import { Box, Realm, Source } from "../../src/index.ts";

// The D4 WeakRef probe of a disposed promise source was removed: the review graded it
// inconclusive (its settled control also stayed reachable) and it depends on GC.

test("editing a match array preserves its input and offset", () => {
  const realm = Realm.make();
  const match = /a/.exec("cat");
  if (!match) throw new Error("expected a match");
  const result = Box.make(realm, match);
  Realm.update(realm, (_read, write) => {
    write.modify(result, (draft) => {
      draft[0] = "A";
    });
  });
  const edited = Source.peek(result);
  expect([edited[0], edited.index, edited.input]).toEqual(["A", 1, "cat"]);
});

test("editing a null-prototype dictionary does not add inherited entries", () => {
  const realm = Realm.make();
  const original: Record<string, string> = Object.create(null);
  const state = Box.make(realm, original);
  Realm.update(realm, (_read, write) => {
    write.modify(state, (draft) => {
      draft["item"] = "one";
    });
  });
  expect("toString" in Source.peek(state)).toBe(false);
});

// Edge (ruling 67), recorded in principles.md. D4 opaque Map case: a draft stored inside a new Map is
// not finalized, and a read of it after the recipe throws `pinna/draft-kept`.
test("a draft inside a new Map is stored as a draft", () => {
  const realm = Realm.make();
  const row = { count: 1 };
  const state = Box.make(realm, { row, byKey: new Map<string, typeof row>() });
  Realm.update(realm, (_read, write) => {
    write.modify(state, (draft) => {
      draft.byKey = new Map([["a", draft.row]]);
    });
  });
  expect(() => Source.peek(state).byKey.get("a")?.count).toThrow(
    "a draft is used after its recipe returned",
  );
});
