---
title: Programs
description: Read when an app is written as Effect programs. Provide the realm as a service, run an effect per change, stream changes, hold a value observed for a scope, feed a value from a stream, and run a feed while its data is read.
---

The Effect pages are for applications that already use Effect: see
[Schema-checked boxes](./boxes.md). The functions on this page are for apps
written as Effect programs, and `@frondruntime/pinna-effect` exports them next
to the rest. Models and components need none of them. `watchScoped` and
`observeScoped` end in `Scoped`, Effect's suffix for a call that lives for the
caller's scope, because the plain `watch` and `observe` keep their names and
return a stop function instead.

## Example

The realm is a service. `watchScoped`, `changes`, and `fromStream` read it from
`RealmService`; a layer provides it once.

<!-- region programs.ts#layer -->

`watchScoped` runs an effect for each change of what the select reads, in the
caller's scope. A new value interrupts the running effect: the latest value
wins. `search` stands for the application's own effect.

<!-- region programs.ts#watch -->

`changes` is a stream of the current value, then each change.

<!-- region programs.ts#changes -->

`fromStream` is a read-only value fed by a stream. The stream runs only while
the value is observed. When the last observer leaves, the value resets to
`initial` synchronously. Each run starts from `initial` until its first
element arrives. `fetchRate` stands for the application's own effect.

<!-- region programs.ts#fromStream -->

`whileObserved` runs a program while an observable is observed: from the
start when the first observer arrives, interrupted when the last one leaves.
It is how a feed writes the rows of a collection only while something reads
them. `fromStream` is the same lifetime around a single value. A row checked
against a schema lands in a `schemaCollection`
([Collection fields](./collections.md)). `fetchTrades` and `tradeUpdates`
stand for the application's own snapshot and updates.

<!-- region programs.ts#trade -->

<!-- region programs.ts#whileObserved -->

`observeScoped` holds a value observed until the scope closes, so the stream behind
it keeps running with nothing rendered.

<!-- region programs.ts#observe -->

Each of them stops when its scope closes.

<!-- region programs.ts#run -->

## Rules

- Provide `RealmService` once, at the edge of the program. A test provides a
  realm of its own.
- A watch's effect has no error channel. A defect is a bug: it is logged at
  the error level, and the watch keeps running. A stream behind `fromStream`
  logs a defect too.
- While observed, a `fromStream` value is the last element of the current
  run, or `initial` before the first; while unobserved, it is `initial`. A
  stream that completes or dies leaves the value as it is until the last
  observer leaves. A failure the screen must show is an element the stream
  gives, such as a status beside the rate: see
  [Failures as values](#failures-as-values).
- A watch's select is tracked and must not write. Its effect writes through
  `update`.
- `watchScoped` runs for changes, not for the current value. `changes` starts with
  the current value.
- `observeScoped` and `whileObserved` take the realm from the observable,
  so they need no `RealmService`.
- A `whileObserved` program runs in a scope of its own, closed when the run
  ends, so a fiber it forks into that scope stops with it. A program that
  returns ends its run while the value is still observed, and the next run
  starts only after the last observer leaves and another arrives: a feed
  ends on the stream it runs.
- `whileObserved` and `fromStream` keep the services of the program that
  called them, not of the code that observes later. Provide a service before
  the call.
- A program that writes more than one value per element runs on
  `whileObserved` and writes them in one update. `fromStream` publishes each
  element in an update of its own, so a box written from inside its stream
  lands one update earlier, and a reader of both sees them disagree.
- Whether a feed has loaded is the application's own box. Pinna cannot tell
  when a snapshot is complete. The program writes the flag in the same
  update as the rows, so no reader sees it loaded with the rows missing.
- `watchScoped`, `changes`, and `fromStream` compare with `Object.is` unless
  given `{ equals }`, as the core's `watch` and `box` do: a value from a
  stream or a select has no schema to compare by, unlike a `schemaBox`.
- Stop a program by closing its scope, not by keeping stop functions.

## Answers

| Call | Answers |
| --- | --- |
| `RealmService` | The service the functions below read the realm from. |
| `watchScoped((read) => ..., (value, previous) => effect, { equals?, name? })` | An effect that starts the watch in the caller's scope; needs `RealmService`. A result equal under `equals`, `Object.is` by default, is no change, so it neither runs nor interrupts the effect. `name` names the watch in its errors. |
| `changes($x)` | A stream of `$x`'s current value, then each change; a slow consumer skips to the newest. Takes a box or a computed value, not an atom; needs `RealmService`. |
| `observeScoped($x)` | An effect that holds `$x`, a box, a computed value, or an atom, observed until the scope closes. Needs no `RealmService`. |
| `whileObserved($x, program)` | An effect that runs `program` while `$x`, a box, a computed value, or an atom, is observed, each run in a scope of its own. A defect is logged at the error level, and the next observation starts the program again. Closing the caller's scope interrupts a run and waits for it; later observation does not start it again. Needs no `RealmService`. |
| `fromStream(stream, initial, { equals?, name? })` | A read-only value: `initial`, then the stream's latest element; needs `RealmService` and the stream's services. The stream runs with the services of the program that made the value, and restarts each time the value is observed again. The value resets to `initial` when the last observer leaves or the scope closes; closing the scope stops the stream for good. An element equal under `equals`, `Object.is` by default, notifies nobody; `name` names the value for `inspect`. |

## Lifetimes

Two owners run an effect, and the owner decides what stops it.

- Observation owns the stream of a `fromStream` value and a `whileObserved`
  program: each runs from the first observer to the last, and starts again with the next. This fits
  data that matters only while something shows it, such as a rate or a
  search result: the last observer leaving stops the work.
- A scope owns a command, such as an order sent or a file saved. It runs
  to its end whatever the screen does, and only closing the scope
  interrupts it. This fits work a person started and expects finished.

A `fromStream` value keeps the context of the program that made it, and its
stream runs with that context on every observation. A service the stream
needs is provided where the value is made, not where it is observed. The
stream's type lists the services it needs but not the clock, so a stream
that polls or sleeps keeps the clock of the program that made the value: a
test on `TestClock` provides it before the value is made
([Testing](../guides/testing.md#time)).

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

`fromStream` takes a stream whose error type is `never`, because a value
has no channel for a failure. A typed failure the screen shows is mapped
into the value's own type: the good elements and the failure become members
of one union, and `Stream.catch` turns the failure into the last element.

<!-- region programs.ts#failures -->

The stream ends on the failure, and the value shows it until the last
observer leaves. The next observer starts the stream again, from `initial`.

## See also

- [Reacting](../state/reacting.md): `watch` and `autorun` without Effect.
- [Classes](./classes.md): `decode`, JSON in and a checked model out.
- [Live data](../guides/live-data.md): a WebSocket feed and a refetch as Effect programs.
