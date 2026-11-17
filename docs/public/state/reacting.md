---
title: Reacting
description: Read when code outside React runs because a value changed. Watch a selection, run an autorun with a cleanup, and write from an autorun without a loop.
---

## Example

The samples on this page use the realm and the box `$tags` of
[Updates](./updates.md).

<!-- region state.ts#setup -->

`watch` runs its effect when the select's result changes, not on the first
run. The effect gets the value and the one before it.

<!-- region state.ts#watch -->

`autorun` runs at once, and again when what its last run read changes.

<!-- region state.ts#autorun -->

A function an autorun returns is its cleanup.

<!-- region state.ts#cleanup -->

An autorun's body may call `update`. The recipe runs untracked, so its reads
of what it writes do not subscribe the autorun.

<!-- region state.ts#autorunWrite -->

## Rules

- Prefer a computed value to an autorun that writes a box: derived state is
  computed, not copied.
- A watch's select only reads: an update there throws. Its effect runs
  untracked and writes through `update`.
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
- In React, read with the hooks instead: [Hooks](../react/hooks.md).

## Answers

| Call | Answers |
| --- | --- |
| `watch(realm, (read) => ..., (value, previous) => ..., { name?, equals? })` | The stop function. `equals` decides what counts as a change; `Object.is` by default. |
| `autorun(realm, (read) => ...)` | The stop function. |

## See also

- [Updates](./updates.md): writing from an effect.
- [Lifecycles](./lifecycles.md): what a watch or an autorun holds observed.
- [Programs](../effect/programs.md): `watchScoped` and `changes` as Effect programs.
- [Live data](../guides/live-data.md): a watch that refetches when its input changes.
