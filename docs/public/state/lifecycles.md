---
title: Lifecycles
description: Read when state comes from outside Pinna. Start a listener when a value gains its first observer and stop it after the last, stand for outside state with an atom, and hold a value observed.
---

## Example

An observable is observed while something holds it: a watch, an autorun, a
mounted `useValue`, `observe`, or an observed computed value that read it.
`onObserved` runs on the first observer, and its cleanup after the last.

<!-- region lifecycles.ts#onObserved -->

An atom stands for state kept outside Pinna. `read($atom)` subscribes;
`write.changed($atom)`, inside an update, reruns what observed it.

<!-- region lifecycles.ts#atom -->

`observe` holds a value observed with nothing rendered.

<!-- region lifecycles.ts#observe -->

## Rules

- A hook may write, in an update. It runs once every link of the call that
  observed is in place, before that call returns. Inside an update, hooks
  start and stop once the recipe returns, never in the middle of it.
- An observer holds what it read until it stops: a watch or an autorun until
  its stop function runs, `observe` until its release runs, `useValue` and
  `useValues` until the component unmounts, `watchScoped`, `observeScoped`,
  and `changes` until the scope closes or the stream stops, and an observed
  computed value until it is no longer observed or a recompute stops reading
  the value. `untracked` and an update read without observing.
- A source lost and gained within one call or one update fires nothing, so a
  watcher that swaps its sources does not restart a subscription.
- A hook's error, or its cleanup's, goes to the realm's `onError`, never to
  the caller. The caller always gets its release.
- Nothing reports what outside state did while no one observed it, so a hook
  syncs the state when it starts, as `sync()` does above.
- An atom nothing observes counts as changed on every check. A computed value
  that reads such an atom recomputes on every read; observed, it recomputes
  only after `write.changed`.

## Answers

| Call | Answers |
| --- | --- |
| `onObserved($x, () => cleanup)` | The function that removes the hook. The function passed in returns the cleanup. |
| `atom(realm)` | An atom. `read($atom)` returns `undefined`. |
| `write.changed($atom)` | Reruns what observed the atom. |
| `observe($x)` | A release. Until it runs, `$x`'s hooks stay started and a computed value stays cached. |

## See also

- [Reacting](./reacting.md): watches and autoruns.
- [Programs](../effect/programs.md): `fromStream`, a value fed by a stream while observed.
- [Live data](../guides/live-data.md): a WebSocket opened while something observes the feed.
