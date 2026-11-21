---
title: Testing
description: Read when writing tests. Make a test realm per test, read and write as application code does, record what a select changed to, check what a collection still holds, and test models and programs with Effect.
---

## Example

The state under test is a model: a class that extends `Model`, so each test
can make one in a realm of its own.

<!-- region testing.test.ts#model -->

A test makes its own realm with `testRealm` from
`@frondruntime/pinna/testing` and builds its state in it. It reads through
`untracked` and writes through the methods that call `update`, as an event
handler does. Held with `using`, the realm is disposed when the test ends,
and its dispose throws if a watch, an autorun, an `observe`, an
`onRowChange` listener, or a stage is still running.

<!-- region testing.test.ts#realm -->

`record` keeps each value a select changes to, in `values`, and stops when
its `using` scope ends. Each update reruns it once, after the update ends,
and only when the value changed, so `values.length` counts the changes.

<!-- region testing.test.ts#watch -->

An update that throws leaves the realm as it was.

<!-- region testing.test.ts#rollback -->

`retainedKeys` names the keys a collection still keeps something for: a row,
or the box and computed value a reader made for a key. A test of a feed that
removes rows checks that this set is exactly the keys that remain, so a
removed row that stays in memory fails the test, which a count of the rows
would not show.

<!-- region testing.test.ts#retained -->

## Rules

- One realm per test, made with `using realm = testRealm()`. A realm made at
  module level carries state from one test into the next.
- Read with `untracked(realm, (read) => ...)`, write with `update` or a model
  method that calls it. The testing entry adds no reader or writer, so a test
  goes through the same calls as application code.
- A watch's effect runs after the outermost update ends, so a test that
  records values asserts after the update returns.
- Declare the realm before the recordings: `using` disposes in reverse
  order, so each recording stops before the realm checks.
- Stop every watch, autorun, `observe`, and `onRowChange` listener a test
  starts, and apply or drop every stage. One left running keeps its values
  cached and its `onObserved` hooks started, and a stage left open holds
  its overlay, so the test realm's dispose throws, naming each by its
  `name`, or `watch`, `autorun`, `onRowChange`, or `stage`, and stops it so
  the next test starts clean; a stage is dropped. A React component's
  subscription is not counted.
- Hold each one in `using`: a watch through `record`, the rest through
  `held`, as in `using _ = held(autorun(realm, ...))`. A stop function called
  at the end of the test is skipped when an assertion fails, the dispose
  then throws too, and Bun 1.4.4 prints the resulting `SuppressedError`
  without either error, so the assertion's diff is lost.
- Check what a collection holds with `retainedKeys`, never through its
  private fields: they are not part of the API and change without notice.

## Answers

| Call | Answers |
| --- | --- |
| `testRealm(options?)` | A realm of the test's own; its dispose throws if a watch, an autorun, an `observe`, an `onRowChange` listener, or a stage is still running. |
| `record(realm, select, options?)` | `values`, each value `select` changed to, oldest first; `stop`, which `using` also runs. |
| `held(stop)` | A `Disposable` that runs `stop` when its `using` scope ends. |
| `retainedKeys($items)` | A copy of the set of keys `$items` keeps a row, a box, or a computed value for; every one is a present key. Throws for a value that is not a collection Pinna made. |

## With Effect

A model decoded from `pinna-effect` is tested the same way. The `TodoList` and
its wire data, `items`, are the ones from
[Collection fields](../effect/collections.md).

<!-- region testingEffect.test.ts#model -->

A watch on the model and a write the schema rejects behave as above: one
rerun per update, and a rejected write leaves the realm as it was.

An Effect program takes the test's realm: `watchScoped(realm, ...)` and
`fromStream(realm, ...)` take it first, and `changes`, `observeScoped`, and
`whileObserved` take it from the observable. A `SchemaModel` decoded inside
an Effect program reads it from `RealmService`, which the test provides. A
`Deferred` waits for the watch's effect without a sleep. Close every
program's scope: a program left running keeps its values cached and its
`onObserved` hooks started, and the test realm's dispose throws for its
watch.

<!-- region testingEffect.test.ts#program -->

| Call | Answers |
| --- | --- |
| `decode(realm, Model)(json)` | A model in the test's realm. |
| `Effect.provideService(RealmService, realm)` | A `SchemaModel` decoded inside the program lands in the test's realm. |

A program that polls or sleeps runs on `TestClock`:
[Programs](../effect/programs.md#testing) shows where to provide it and what
a test waits on instead of the clock.

## See also

- [Updates](../state/updates.md): what an update undoes when it throws.
- [Reacting](../state/reacting.md): when a watch reruns.
- [Programs](../effect/programs.md): `watchScoped`, `withStage`, and testing a program on `TestClock`.
- [Errors and debugging](./errors.md): what throws, and where the rest goes.
