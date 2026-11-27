# Testing

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/guides/testing.md.

Sections: Example, Rules, Answers, With Effect, See also.

## Example

The state under test is a model: a class that extends `Model`, so each test
can make one in a realm of its own.

```ts
import { Box, Computed, Model, Realm } from "@frondruntime/pinna";

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
```

A test makes its own realm with `testRealm` from
`@frondruntime/pinna/testing` and builds its state in it. It reads through
`Realm.untracked` and writes through the methods that call `Realm.update`, as an event
handler does. Held with `using`, the realm is disposed when the test ends,
and its dispose throws if a watch, an autorun, a `Source.observe`, a
`Collection.onRowChange` listener, or a stage is still running.

```ts
import { expect, test } from "bun:test";
import { Realm } from "@frondruntime/pinna";
import { testRealm } from "@frondruntime/pinna/testing";

test("closing a todo updates the label", () => {
  // A realm per test: nothing one test made is seen by the next. Its dispose,
  // when the test ends, throws if a watch or an autorun is still running.
  using realm = testRealm();
  const todos = new Todos(realm);

  todos.close();

  expect(Realm.untracked(realm, (read) => read(todos.$label))).toBe("1 open");
});
```

`record` keeps each value a select changes to, in `values`, and stops when
its `using` scope ends. Each update reruns it once, after the update ends,
and only when the value changed, so `values.length` counts the changes.

```ts
import { expect, test } from "bun:test";
import { Realm } from "@frondruntime/pinna";
import { record, testRealm } from "@frondruntime/pinna/testing";

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
```

An update that throws leaves the realm as it was.

```ts
import { expect, test } from "bun:test";
import { Realm } from "@frondruntime/pinna";
import { testRealm } from "@frondruntime/pinna/testing";

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
```

`retainedKeys` names the keys a collection still keeps something for: a row,
or the box and computed value a reader made for a key. A test of a feed that
removes rows checks that this set is exactly the keys that remain, so a
removed row that stays in memory fails the test, which a count of the rows
would not show.

```ts
import { expect, test } from "bun:test";
import { Collection, Realm, Source } from "@frondruntime/pinna";
import { retainedKeys, testRealm } from "@frondruntime/pinna/testing";

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
```

## Rules

- One realm per test, made with `using realm = testRealm()`. A realm made at
  module level carries state from one test into the next.
- Read with `Realm.untracked(realm, (read) => ...)`, write with `Realm.update` or a model
  method that calls it. The testing entry adds no reader or writer, so a test
  goes through the same calls as application code.
- A watch's effect runs after the outermost update ends, so a test that
  records values asserts after the update returns.
- Declare the realm before the recordings: `using` disposes in reverse
  order, so each recording stops before the realm checks.
- Stop every watch, autorun, `Source.observe`, and `Collection.onRowChange` listener a test
  starts, and apply or drop every stage. One left running keeps its values
  cached and its `Source.onObserved` hooks started, and a stage left open holds
  its overlay, so the test realm's dispose throws, naming each by its
  `name`, or `Realm.watch`, `Realm.autorun`, `Collection.onRowChange`, or `stage`, and stops it so
  the next test starts clean; a stage is dropped. A React component's
  subscription is not counted.
- Hold each one in `using`: a watch through `record`, the rest through
  `held`, as in `using _ = held(Realm.autorun(realm, ...))`. A stop function called
  at the end of the test is skipped when an assertion fails, the dispose
  then throws too, and Bun 1.4.4 prints the resulting `SuppressedError`
  without either error, so the assertion's diff is lost.
- Check what a collection holds with `retainedKeys`, never through its
  private fields: they are not part of the API and change without notice.

## Answers

| Call | Answers |
| --- | --- |
| `testRealm(options?)` | A realm of the test's own; its dispose runs `Realm.dispose`, and throws if a watch, an autorun, a `Source.observe`, a `Collection.onRowChange` listener, or a stage was still running. A test that uses the realm after its dispose throws `pinna/realm-disposed`. |
| `record(realm, select, options?)` | `values`, each value `select` changed to, oldest first; `stop`, which `using` also runs. |
| `held(stop)` | A `Disposable` that runs `stop` when its `using` scope ends. |
| `retainedKeys($items)` | A copy of the set of keys `$items` keeps a row, a box, or a computed value for; every one is a present key. Throws for a value that is not a collection Pinna made. |

## With Effect

A model decoded from `pinna-effect` is tested the same way. The `TodoList` and
its wire data, `items`, are the ones from
[Collection fields](https://pinna.frondruntime.dev/docs/effect/collections.md).

```ts
import { expect, test } from "bun:test";
import { testRealm } from "@frondruntime/pinna/testing";
import { Model, Realm } from "@frondruntime/pinna-effect";
import { TodoList } from "./models.ts";

test("toggling a todo closes it", () => {
  // A realm per test: nothing one test made is seen by the next.
  using realm = testRealm();
  const list = Model.decode(realm, TodoList)({ items });

  const first = Realm.untracked(realm, (read) => read(list.$items.row("1")));
  first?.toggle();

  expect(Realm.untracked(realm, (read) => read(list.$open))).toBe(0);
});
```

A watch on the model and a write the schema rejects behave as above: one
rerun per update, and a rejected write leaves the realm as it was.

An Effect program takes the test's realm: `Program.watchScoped(realm, ...)` and
`Program.fromStream(realm, ...)` take it first, and `Program.changes`, `Source.observeScoped`, and
`Program.whileObserved` take it from the observable. A `Model.Schema` decoded inside
an Effect program reads it from `RealmService`, which the test provides. A
`Deferred` waits for the watch's effect without a sleep. Close every
program's scope: a program left running keeps its values cached and its
`Source.onObserved` hooks started, and the test realm's dispose throws for its
watch.

```ts
import { expect, test } from "bun:test";
import { testRealm } from "@frondruntime/pinna/testing";
import { Box, Program, Realm, RealmService } from "@frondruntime/pinna-effect";
import { Deferred, Effect, Schema } from "effect";

test("a program reads the test's realm", async () => {
  using realm = testRealm();
  const $query = Box.schema(realm, Schema.String, "");

  const program = Effect.gen(function* () {
    const searched = yield* Deferred.make<string>();
    yield* Program.watchScoped(
      realm,
      (read) => read($query),
      (query) => Deferred.succeed(searched, query),
    );
    Realm.update(realm, (_read, write) => write($query, "pinna"));
    return yield* Deferred.await(searched);
  });

  const query = await Effect.runPromise(
    program.pipe(Effect.scoped, Effect.provideService(RealmService, realm)),
  );
  expect(query).toBe("pinna");
});
```

| Call | Answers |
| --- | --- |
| `Model.decode(realm, Model)(json)` | A model in the test's realm. |
| `Effect.provideService(RealmService, realm)` | A `Model.Schema` decoded inside the program lands in the test's realm. |

A program that polls or sleeps runs on `TestClock`:
[Programs](testing-programs.md#testing) shows where to provide it and what
a test waits on instead of the clock.

## See also

- [Updates](https://pinna.frondruntime.dev/docs/state/updates.md): what an update undoes when it throws.
- [Reacting](https://pinna.frondruntime.dev/docs/state/reacting.md): when a watch reruns.
- [Programs](https://pinna.frondruntime.dev/docs/effect/programs.md): `Program.watchScoped`, `Stage.scoped`, and testing a program on `TestClock`.
- [Errors and debugging](errors.md): what throws, and where the rest goes.
