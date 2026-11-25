/// <reference types="bun" />
// The site's docs print the regions of this file (docs/public/guides/testing.md), so
// `bun run typecheck` compiles what the page shows. The Effect samples are `testingEffect.test.ts`.
import { expect, test } from "bun:test";
import { Box, Collection, Computed, Model, Realm, Source } from "@frondruntime/pinna";
import { record, retainedKeys, testRealm } from "@frondruntime/pinna/testing";

// #region model
// The state under test: a count of open todos and the method that closes one.
class Todos extends Model.Class {
  readonly $open = Box.make(this.realm, 2);
  readonly $label = Computed.make(this.realm, (read) => `${read(this.$open)} open`);

  close(): void {
    Realm.update(this.realm, (read, write) => {
      if (read(this.$open) === 0) throw new Error("nothing is open");
      write(this.$open, read(this.$open) - 1);
    });
  }
}
// #endregion

// #region realm
test("closing a todo updates the label", () => {
  // A realm per test: nothing one test made is seen by the next. Its dispose,
  // when the test ends, throws if a watch or an autorun is still running.
  using realm = testRealm();
  const todos = new Todos(realm);

  todos.close();

  expect(Realm.untracked(realm, (read) => read(todos.$label))).toBe("1 open");
});
// #endregion

// #region watch
test("closing two todos in one update records one change", () => {
  using realm = testRealm();
  const todos = new Todos(realm);
  // Declared after the realm, so it stops before the realm checks.
  using labels = record(realm, (read) => read(todos.$label));

  Realm.update(realm, () => {
    todos.close();
    todos.close();
  });

  expect(labels.values).toEqual(["0 open"]);
});
// #endregion

// #region rollback
test("an update that throws leaves the realm as it was", () => {
  using realm = testRealm();
  const todos = new Todos(realm);

  expect(() =>
    Realm.update(realm, () => {
      todos.close();
      todos.close();
      todos.close(); // nothing is open: throws, and the two before it are undone
    }),
  ).toThrow("nothing is open");
  expect(Realm.untracked(realm, (read) => read(todos.$open))).toBe(2);
});
// #endregion

// #region retained
test("a refetch lets go of the rows it drops", () => {
  using realm = testRealm();
  const $trades = Collection.make(realm, { keyOf: (trade: { readonly id: string }) => trade.id });
  Realm.update(realm, (_read, write) => {
    write.replaceAll($trades, [{ id: "a" }, { id: "b" }, { id: "c" }]);
  });
  // A reader of a row makes a box and a computed value for its key.
  const release = Source.observe($trades.row("c"));

  Realm.update(realm, (_read, write) => {
    write.replaceAll($trades, [{ id: "a" }]);
  });

  // "c" is gone with its box and computed value, though still observed.
  expect(retainedKeys($trades)).toEqual(new Set(["a"]));
  release();
});
// #endregion
