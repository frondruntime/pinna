---
title: Programs
description: Read when an app is written as Effect programs. Run an effect per change, stream changes, hold a value observed for a scope, feed a value from a stream, run a feed while its data is read, and hold a section's writes in a stage until it succeeds.
---

The Effect pages are for applications that already use Effect: see
[Schema-checked boxes](./boxes.md). The functions on this page are for apps
written as Effect programs, and `@frondruntime/pinna-effect` exports them next
to the rest. Models and components need none of them. `Program.watchScoped` and
`Source.observeScoped` end in `Scoped`, Effect's suffix for a call that lives for the
caller's scope, because the plain `Realm.watch` and `Source.observe` keep their names and
return a stop function instead.

## Example

No program requires a service for the realm. `Program.watchScoped` and `Program.fromStream`
take it first, as `Realm.watch` does, and `Program.changes`, `Source.observeScoped`, and
`Program.whileObserved` take it from the observable, so a program that refuses every
requirement but `Scope` runs each of them.

<!-- region programs.ts#layer -->

`Program.watchScoped` runs an effect for each change of what the select reads, in the
caller's scope. A new value interrupts the running effect: the latest value
wins. `search` stands for the application's own effect.

<!-- region programs.ts#watch -->

`Program.changes` is a stream of the current value, then each change.

<!-- region programs.ts#changes -->

`Program.updates` is a stream of the realm's update records, every one of
them, for persistence or a log.

<!-- region programs.ts#updates -->

`Program.fromStream` is a read-only value fed by a stream. The stream runs only while
the value is observed. When the last observer leaves, the value resets to
`initial` synchronously. Each run starts from `initial` until its first
element arrives. `fetchRate` stands for the application's own effect.

<!-- region programs.ts#fromStream -->

`Program.fromEffect` is `Program.fromStream` over one Effect: one answer,
requested again for each observation. A failure the screen shows is mapped
into the value, as for a stream.

<!-- region programs.ts#fromEffect -->

`Program.whileObserved` runs a program while an observable is observed: from the
start when the first observer arrives, interrupted when the last one leaves.
It is how a feed writes the rows of a collection only while a list shows
them: a list reads `keys`, and a reader of one present row does not. `Program.fromStream` is the same lifetime around a single value. A row checked
against a schema lands in a `Collection.schema`
([Collection fields](./collections.md)). `fetchTrades` and `tradeUpdates`
stand for the application's own snapshot and updates.

<!-- region programs.ts#trade -->

<!-- region programs.ts#whileObserved -->

`Source.observeScoped` holds a value observed until the scope closes, so the stream behind
it keeps running with nothing rendered.

<!-- region programs.ts#observe -->

Each of them stops when its scope closes.

<!-- region programs.ts#run -->

## Rules

- Pass the realm, as `Realm.watch` takes it. A test makes a realm of its own.
  `RealmService` is for a `Model.Schema` decoded inside an Effect program
  ([Classes](./classes.md)).
- A watch's effect has no error channel. A defect is a bug: it is logged at
  the error level, and the watch keeps running. A stream behind `Program.fromStream`
  logs a defect too.
- While observed, a `Program.fromStream` value is the last element of the current
  run, or `initial` before the first; while unobserved, it is `initial`. A
  stream that completes or dies leaves the value as it is until the last
  observer leaves. A failure the screen must show is an element the stream
  gives, such as a status beside the rate: see
  [Failures as values](#failures-as-values).
- A watch's select is tracked and must not write. Its effect writes through
  `Realm.update`.
- `Program.watchScoped` runs for changes, not for the current value. `Program.changes` starts with
  the current value.
- `Program.changes`, `Source.observeScoped`, and `Program.whileObserved` take the realm from the
  observable. A host whose programs require nothing but `Scope` watches a
  box with `Program.changes` while its work awaits.
- A `Program.whileObserved` program runs in a scope of its own, closed when the run
  ends, so a fiber it forks into that scope stops with it. A program that
  returns ends its run while the value is still observed, and the next run
  starts only after the last observer leaves and another arrives: a feed
  ends on the stream it runs.
- `Program.whileObserved` and `Program.fromStream` keep the services of the program that
  called them, not of the code that observes later. Provide a service before
  the call.
- A program that writes more than one value per element runs on
  `Program.whileObserved` and writes them in one update. `Program.fromStream` publishes each
  element in an update of its own, so a box written from inside its stream
  lands one update earlier, and a reader of both sees them disagree.
- Whether a feed has loaded is the application's own box. Pinna cannot tell
  when a snapshot is complete. The program writes the flag in the same
  update as the rows, so no reader sees it loaded with the rows missing.
- `Program.watchScoped` and `Program.fromStream` compare with `Object.is` unless given
  `{ equals }`, as the core's `Realm.watch` and `Box.make` do: a value from a stream or
  a select has no schema to compare by, unlike a `Box.schema`. `Program.changes`
  takes no options and compares with `Object.is`.
- Stop a program by closing its scope, not by keeping stop functions.

## Answers

| Call | Answers |
| --- | --- |
| `Program.watchScoped(realm, (read) => ..., (value, previous) => effect, { equals?, name? })` | An effect that starts the watch in the caller's scope. A result equal under `equals`, `Object.is` by default, is no change, so it neither runs nor interrupts the effect. `name` names the watch in its errors. Disposing the realm interrupts the effect it is running. |
| `Program.changes($x)` | A stream of `$x`'s current value, then each change; a slow consumer skips to the newest. Takes a box or a computed value, not an atom. It ends when its realm is disposed. |
| `Program.updates(realm)` | A stream of each record `Realm.onUpdate` hands out, from the next update on; a slow consumer gets every record, since the buffer is unbounded. It ends when the realm is disposed ([Change stream](../state/changes.md)). |
| `Source.observeScoped($x)` | An effect that holds `$x`, a box, a computed value, or an atom, observed until the scope closes. |
| `Program.whileObserved($x, program)` | An effect that runs `program` while `$x`, a box, a computed value, or an atom, is observed, each run in a scope of its own. A defect is logged at the error level, and the next observation starts the program again. Closing the caller's scope interrupts a run and waits for it; later observation does not start it again. |
| `Program.fromStream(realm, stream, initial, { equals?, name? })` | A read-only value: `initial`, then the stream's latest element; needs the stream's services. The stream runs with the services of the program that made the value, and restarts each time the value is observed again. The value resets to `initial` when the last observer leaves or the scope closes; closing the scope stops the stream for good. An element equal under `equals`, `Object.is` by default, notifies nobody; `name` names the value for `Source.inspect`. |
| `Program.fromEffect(realm, effect, initial, { equals?, name? })` | `Program.fromStream(realm, Stream.fromEffect(effect), initial, options)`: a read-only value, `initial` until the effect succeeds, while observed. The effect runs from the start on each first observer and is interrupted when the last leaves, which resets the value; its error type is `never`, and a defect is logged at the error level. |
| `Realm.scoped(options?)` | An effect that makes a realm and disposes it with `Realm.dispose` when the scope closes. Programs started after it in the same scope close first, each awaiting its own release, so the realm disposes last. A `Layer` is `Layer.effect(RealmService, Realm.scoped())`. |
| `Stage.scoped(realm, (stage) => section, { name?, conflicts? })` | The section's value, with its stage applied; a section failure, defect, or interruption drops the stage and the outcome stands. A conflict fails with pinna's `StageConflictError`; a recipe that throws on replay is a defect. An interruption once landing began leaves the stage applied; the exit still contains `Interrupt`. |
| `Stage.scoped(stage, (child) => section, { name? })` | A savepoint over `stage`, with the same success and failure behavior. The child inherits its root's conflict mode, takes no `conflicts` option, and never fails with `StageConflictError`: its root checks what the child read. |
| `StageConflictError` | The error `Stage.scoped` fails with when a stage opened with `{ conflicts: "fail" }` finds that what it read changed: the one `Stage.apply` throws, moved from a throw to a failure so `Effect.catchTag("StageConflictError", ...)` and `Effect.retry` take it. It is matched by brand and `_tag`, so a conflict from another copy of Pinna fails the same way. |

## Lifetimes

Three owners run an effect, and the owner decides what stops it.

- Observation owns the stream of a `Program.fromStream` value and a `Program.whileObserved`
  program: each runs from the first observer to the last, and starts again with the next. This fits
  data that matters only while something shows it, such as a rate or a
  search result: the last observer leaving stops the work, and the value
  resets to `initial`, so a stale rate never shows as current.
- A fiber owns a feed whose data is kept whether shown or not, such as the
  quotes of a board that several screens and watches read from one
  collection. The feed runs until the fiber is interrupted, with nothing
  observing it ([Live data](../guides/live-data.md#with-effect)).
- A scope owns a command, such as an order sent or a file saved. It runs
  to its end whatever the screen does, and only closing the scope
  interrupts it. This fits work a person started and expects finished.

A `Program.fromStream` value keeps the context of the program that made it, and its
stream runs with that context on every observation. A service the stream
needs is provided where the value is made, not where it is observed. The
stream's type lists the services it needs but not the clock, so a stream
that polls or sleeps keeps the clock of the program that made the value: a
test on `TestClock` provides it before the value is made
([Testing](#testing)).

<!-- region programs.ts#context -->

A command that an event handler starts runs in a scope made once for the
application. `Effect.forkIn` runs it in that scope, and
`Effect.runForkWith(context)` gives it the application's services, the
clock among them, so a test's `TestClock` reaches the command too.

<!-- region programs.ts#command -->

`Effect.forkScoped` schedules its fiber and returns before the fiber runs,
so the next line cannot count on what the fiber writes.
`{ startImmediately: true }` runs the fiber up to its first wait at once.

<!-- region programs.ts#startImmediately -->

## Failures as values

`Program.fromStream` takes a stream whose error type is `never`, because a value
has no channel for a failure. A typed failure the screen shows is mapped
into the value's own type: the good elements and the failure become members
of one union, and `Stream.catch` turns the failure into the last element.

<!-- region programs.ts#failures -->

The stream ends on the failure, and the value shows it until the last
observer leaves. The next observer starts the stream again, from `initial`.

## Testing

A program that polls or sleeps is tested on `TestClock`, from
`effect/testing`, so the test moves time instead of waiting for it. The
test realm is as on [Testing](../guides/testing.md).

- Provide `TestClock.layer()` around the program that makes a `Program.fromStream`
  value, not only around the one that observes it. The value keeps the
  clock of the program that made it, and a value made on the live clock
  polls on the live clock whatever the observer provides.
- Hold the value observed with `Source.observeScoped`. Its stream runs only while
  something observes the value, so an unobserved poll never runs and the
  value stays `initial`.

<!-- region testingEffect.test.ts#clock -->

`TestClock.adjust` is not a completion signal. It runs the sleeps that fall
due and waits for the fibers it woke to suspend; work that no sleep holds,
such as a load that yields between rows, can still be running when it
returns, and `TestClock.adjust(0)` wakes nothing at all. A test waits on a
value the program publishes when its work is done: a `Deferred`, or a box
read through `Program.changes`.

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

## Stages

`Stage.scoped` holds a section's writes in a stage
([Updates](../state/updates.md#stages)) and lands them when the section
succeeds. A section failure, defect, or interruption drops
them, so nothing the section staged reaches the realm. An interruption
once landing began leaves the stage applied; the exit still contains `Interrupt`.

<!-- region stagesEffect.ts#withStage -->

Over a stage, `Stage.scoped` is a savepoint. A section that fails and is caught
leaves the outer stage as it was, and each attempt of an `Effect.retry`
opens a fresh child.

<!-- region stagesEffect.ts#savepoint -->

With `{ conflicts: "fail" }`, a stage whose reads changed before it landed
fails with `StageConflictError`, and `Effect.retry` runs the section again over
the new values.

<!-- region stagesEffect.ts#conflicts -->

- `Stage.scoped` applies the stage after the section succeeds, synchronously,
  so nothing runs between the section's last write and the landing.
- The release drops the stage whether or not it applied: `Stage.drop` does
  nothing to a closed stage. A `Stage.apply` precondition failure leaves
  the stage open and becomes a defect in `Stage.scoped`; the release then
  drops it and its open children. A conflict or replay throw drops it
  before the release.
- Retrying reruns the section, requests included. Retry only a section that
  is safe to repeat; `Stage.scoped` never retries on its own.
- A host that lands a stage inside its own update, or applies only on a
  condition, calls `Stage.make`, `Stage.apply`, and `Stage.drop` itself, with
  `Effect.acquireUseRelease`.

### Showing the section's writes

With `{ visible: true }`, the section's writes show over the realm's
confirmed values while it runs ([Visible stages](../state/updates.md#visible-stages)):
the guess is the answer, applied on success and taken off otherwise.

<!-- region stagesEffect.ts#visible -->

With `{ guess: recipe }`, a visible stage shows `recipe` while the section
writes a hidden stage. On success one `Realm.update` applies the section's
stage and drops the guess, so the server's answer wins and a watcher sees
the settled value once; a failure or an interruption drops both.

<!-- region stagesEffect.ts#guess -->

- `name` and `conflicts` describe the section's stage. The guess is named
  `"<name> (guess)"`, or `"guess"`, and replays over what lands under it.
- `guess` with `visible`, or either over a stage, throws
  `pinna/stage-visible-option`: a stage is the guess or the answer, and a
  child stage shows nothing.
- A `StageConflictError` from any call on the section's stage fails the
  effect, as the one from `Stage.apply` does: a visible `"fail"` stage
  stopped mid-section throws it from the section's next `Stage.update`.

## See also

- [Reacting](../state/reacting.md): `Realm.watch` and `Realm.autorun` without Effect.
- [Classes](./classes.md): `Model.decode`, JSON in and a checked model out.
- [Live data](../guides/live-data.md): a WebSocket feed and a refetch as Effect programs.
- [Testing](../guides/testing.md): a test realm, and a program run in it.
