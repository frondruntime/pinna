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
and its dispose throws if a watch, an autorun, an `observe`, or an
`onRowChange` listener is still running.

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
  starts. One left running keeps its values cached and its `onObserved`
  hooks started; the test realm's dispose throws, naming each by its
  `name`, or `watch`, `autorun`, or `onRowChange`, and stops it so the next
  test starts clean. A React
  component's subscription is not counted.
- Hold a watch in `using`, through `record`, and an autorun, a watch with
  its own effect, or an `observe` through `held`:
  `using _ = held(autorun(realm, ...))`. A stop function called at the end
  of the test is skipped by a failed assertion, the realm's dispose then
  throws as well, and Bun 1.4.4 prints the resulting `SuppressedError` with
  neither error, so the assertion's diff is lost.
- Check what a collection holds with `retainedKeys`, never through its
  private fields: they are not part of the API and change without notice.

## Answers

| Call | Answers |
| --- | --- |
| `testRealm(options?)` | A realm of the test's own; its dispose throws if a watch, an autorun, an `observe`, or an `onRowChange` listener is still running. |
| `new Todos(realm)` | A model in that realm, for a class that extends `Model`. |
| `untracked(realm, (read) => read($x))` | The value of `$x` now, without subscribing. |
| `record(realm, select, options?)` | `values`, each value `select` changed to, oldest first; `stop`, which `using` also runs. |
| `watch(realm, select, effect)` | A stop function; `effect` sees each change of `select`'s result. |
| `held(stop)` | A `Disposable` that runs `stop` when its `using` scope ends. |
| `retainedKeys($items)` | A copy of the set of keys `$items` keeps a row, a box, or a computed value for; every one is a present key. Throws for a value that is not a collection Pinna made. |

## With Effect

A model decoded from `pinna-effect` is tested the same way. The `TodoList` and
its wire data, `items`, are the ones from
[Collection fields](../effect/collections.md).

<!-- region testingEffect.test.ts#model -->

A watch on the model reruns once per update, as above.

<!-- region testingEffect.test.ts#watch -->

A write the schema of a box rejects throws from `update`, and the realm is left
as it was.

<!-- region testingEffect.test.ts#rollback -->

An Effect program finds the realm through `RealmService`; the test provides
its own. A `Deferred` waits for the watch's effect without a sleep. Close every
program's scope: a program left running keeps its values cached and its
`onObserved` hooks started, and the test realm's dispose throws for its
watch.

<!-- region testingEffect.test.ts#program -->

| Call | Answers |
| --- | --- |
| `decode(realm, Model)(json)` | A model in the test's realm. |
| `Effect.provideService(RealmService, realm)` | A program that runs in the test's realm. |

### Time

A program that polls or sleeps is tested on `TestClock`, from
`effect/testing`, so the test moves time instead of waiting for it.

- Provide `TestClock.layer()` around the program that makes a `fromStream`
  value, not only around the one that observes it. The value keeps the
  clock of the program that made it, and a value made on the live clock
  polls on the live clock whatever the observer provides.
- Hold the value observed with `observeScoped`. Its stream runs only while
  something observes the value, so an unobserved poll never runs and the
  value stays `initial`.

<!-- region testingEffect.test.ts#clock -->

`TestClock.adjust` is not a completion signal. It runs the sleeps that fall
due and waits for the fibers it woke to suspend; work that no sleep holds,
such as a load that yields between rows, can still be running when it
returns, and `TestClock.adjust(0)` wakes nothing at all. A test waits on a
value the program publishes when its work is done: a `Deferred`, or a box
read through `changes`.

<!-- region testingEffect.test.ts#barrier -->

A helper that runs a program and declares its realm with `using` is
`async` and awaits the run before it returns. Returning the promise without
`await` disposes the realm while the program's scope is still open, and the
dispose throws `The test realm is not at rest: watch still running.`, one
entry per watch the program holds. The dispose stops each watch first, so no
watch reruns in the next test, but a fiber the program forked runs on until
its scope closes; the fix is `return await`.

<!-- region testingEffect.test.ts#awaited -->

| Call | Answers |
| --- | --- |
| `Effect.provide(TestClock.layer())` | A program whose sleeps and schedules wait on the test clock. |
| `TestClock.adjust(duration)` | Moves the test clock and runs the sleeps that fall due; not a signal that other work finished. |

## See also

- [Updates](../state/updates.md): what an update undoes when it throws.
- [Reacting](../state/reacting.md): when a watch reruns.
- [Programs](../effect/programs.md): `RealmService` and `watchScoped`.
- [Errors and debugging](./errors.md): what throws, and where the rest goes.
