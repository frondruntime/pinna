---
title: Async state
description: Read when a value comes from a request or another library. Load a promise into a value while it is observed, give it a status type of the application's own, hold it for a store that loads once, and copy a query from TanStack Query or another library into a box.
---

## Example

Pinna ships no status type for asynchronous work: no loading flag, refetch,
cache, or Suspense hook. A request library, such as TanStack Query, owns
those, and Pinna holds what it answers. The status is a union the
application writes once.

<!-- region asyncState.ts#status -->

`Computed.fromPromise` loads a promise into a read-only value. The request
starts with the first observer and is aborted when the last one leaves,
through the signal `load` receives; the value is `initial` until the promise
resolves, and again once nothing observes it. The failure is mapped into the
union inside `load`, so the screen shows it.

<!-- region asyncState.ts#promise -->

A store that loads once, as a MobX store that calls `fromPromise` in its
constructor, holds the value with `Source.observe`. The request runs once,
and the answer stays until the release runs.

<!-- region asyncState.ts#hold -->

A query from another library is copied into a box. TanStack Query's
`QueryObserver`, and any store with a current result and a listener, fits
the shape below: the box subscribes while something observes it, and syncs
on each start, since nothing reports what the query did while no one
listened ([Lifecycles](../state/lifecycles.md)).

<!-- region asyncState.ts#external -->

## Rules

- Pass a function, not a started promise. A started promise cannot be
  aborted, and the next observation needs a new request; `() => promise`
  reuses one answer for every observation.
- Map a failure the screen shows into the value, inside `load`. A rejection
  left unmapped goes to the realm's `onError`, as a hook's throw does, and
  the value keeps what it held.
- Pass `signal` to the request. Without it, a request whose observer left
  runs to the end; its result is dropped either way, so it never writes a
  realm that was disposed.
- Hold a value that must keep its answer across screens with
  `Source.observe`. Unobserved, it resets to `initial`, and the next
  observer requests again.
- Write a result that must be saved, restored, or written by other code into
  a box. `Computed.fromPromise` is read-only, and `read.snapshot` refuses a
  computed value.
- Keep the status, retry, and refetch policy in the request library or in
  plain code. Pinna holds the answer; the library decides when to ask.

## With Effect

`Program.fromEffect` is the same value over one Effect: the effect runs while
the value is observed and is interrupted when the last observer leaves. Its
error type is `never`, so a failure is mapped into the value first; a
promise inside it enters through `Effect.tryPromise`, whose signal aborts
on the interruption ([Programs](../effect/programs.md)).

<!-- region programs.ts#fromEffect -->

## See also

- [Lifecycles](../state/lifecycles.md): `Computed.fromPromise`, `Source.onObserved`, and `Source.observe`.
- [Live data](./live-data.md): a socket feed, and a refetch that keeps row identity.
- [Programs](../effect/programs.md): `Program.fromEffect` and `Program.fromStream`.
- [Updates](../state/updates.md): a stage that fails on conflicts, which includes a value `Computed.fromPromise` changed.
