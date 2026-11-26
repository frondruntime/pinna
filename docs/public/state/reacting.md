---
title: Reacting
description: Read when code outside React runs because a value changed. Watch a selection, run an autorun with a cleanup, and write from an autorun without a loop.
---

## Example

The samples on this page use the realm and the box `$tags` of
[Updates](./updates.md).

<!-- region state.ts#setup -->

`Realm.watch` runs its effect when the select's result changes, not on the first
run. The effect gets the value and the one before it.

<!-- region state.ts#watch -->

`Realm.autorun` runs at once, and again when what its last run read changes.

<!-- region state.ts#autorun -->

A function an autorun returns is its cleanup.

<!-- region state.ts#cleanup -->

An autorun's body may call `Realm.update`. The recipe runs untracked, so its reads
of what it writes do not subscribe the autorun.

<!-- region state.ts#autorunWrite -->

A `scheduler` option runs a watch or an autorun when the scheduler calls the
`run` it is handed, rather than before `Realm.update` returns. Every write before
that joins one run, which reads the values current when it starts. Pinna
ships no scheduler and reads no time: the application picks what its host
has.

<!-- region state.ts#scheduler -->

## Rules

- Prefer a computed value to an autorun that writes a box: derived state is
  computed, not copied.
- A watch's select only reads: an update there throws. Its effect runs
  untracked and writes through `Realm.update`.
- An autorun that writes what it read runs again, until what it read stops
  changing. One that never settles stops after 100 rounds, and
  `pinna: watchers did not settle after 100 rounds` goes to `onError`.
- A watch's effect returns `undefined`, so an async function does not
  type-check. The refusal is in the types only: at run time the returned
  promise is dropped, and its rejection is unhandled, reaching neither the
  caller nor `onError`. Start async work from the effect and handle its
  errors there.
- An error from the first run of either is thrown to the caller, and nothing
  is watched. A later one goes to the realm's `onError`.
- Both return a stop function. Stopping twice does nothing, and once stopped,
  the effect never runs again.
- A scheduled watch or autorun runs its first run at once, as the others do,
  so its error is thrown to the caller. Every later run waits for the
  scheduler, and its error goes to `onError`, since the writer has returned.
  A scheduler that calls `run` at once makes a plain watch.
- A scheduled run reads only settled values, so `run` throws
  `pinna/scheduled-run-not-at-rest` inside an update, a computed value, a
  watch's select, an autorun, or a stage recipe. Call it from a frame, a
  timer, an event handler, or a watch's effect.
- A scheduled run that finds nothing it read changed does nothing: a
  computed value it reads recomputes once per run, not once per write, and
  a write a failed update rolled back runs nothing.
- A scheduled autorun that writes what it read runs again at the next call
  of its scheduler, past the reach of the settle's round limit. At 100 such
  runs in a row, `pinna/watchers-unsettled` goes to `onError` and the
  autorun waits for a change from outside its own runs.
- A `run` called after the stop, after the realm's disposal, or a second
  time for one schedule does nothing. Disposal stops a scheduled watch, as
  it stops an autorun.
- In React, read with the hooks instead: [Hooks](../react/hooks.md). React
  decides when a component renders, so the hooks take no scheduler.

## Answers

| Call | Answers |
| --- | --- |
| `Realm.watch(realm, (read) => ..., (value, previous) => ..., { name?, equals?, scheduler? })` | The stop function. `equals` decides what counts as a change; `Object.is` by default. |
| `Realm.autorun(realm, (read) => ..., { scheduler? })` | The stop function. |
| `Scheduler` | The type `(run: () => void) => void`. |

## See also

- [Updates](./updates.md): writing from an effect.
- [Lifecycles](./lifecycles.md): what a watch or an autorun holds observed.
- [Programs](../effect/programs.md): `Program.watchScoped` and `Program.changes` as Effect programs.
- [Live data](../guides/live-data.md): a watch that refetches when its input changes.
