---
name: pinna-stages-and-live-data
description: "Use when Pinna state comes from outside or waits on it: a request, socket, or query library (Computed.fromPromise, Source.onObserved, Realm.dispose), or writes held until async work succeeds or shown optimistically (Stage.make, Stage.apply, visible stages). For Effect streams use pinna-with-effect."
---

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->

# Pinna stages and state from outside

Brings state in from outside while something observes it, ends it with its realm, and holds the writes of asynchronous work until it succeeds or shows them at once.

## Every skill assumes

For an agent writing an application on Pinna. Pinna is not Pinia, Vue's
store; it shares no API with it. Import the modules from
`@frondruntime/pinna`, whose boxes and models take no schema, or from
`@frondruntime/pinna-effect`, whose modules hold the same members and add
`Box.schema` and `Model.Schema` to check a schema (`effect` is its peer
dependency); the hooks come from `@frondruntime/pinna-react`. Every call is
a member of its type's module, and the module's name is also the type:
`const $count: Box<number> = Box.make(realm, 0)`, `Realm.update`,
`Stage.apply`, `Model.Class`. Import from one of the two packages in a
file, never both: each exports its own `Box`. The full documentation is at
<https://pinna.frondruntime.dev/docs/start>; this page is what to keep in
mind while writing code.

1. **`$` means observable.** A name that starts with `$` is a box, a
   computed value, an atom, or a collection. Everything else is plain,
   `readonly` data: read it anywhere, never write it.

2. **Read with the `read` a place hands out.** An observable has no read
   or write methods. `Computed.make`, `Computed.fn`, `Realm.watch`'s select,
   `Realm.autorun`, `Realm.update`, `Realm.untracked`, and `useSelect` each pass their
   function a `read`: `Computed.make(realm, (read) => read($a) + 1)`.
   Never keep a `read` past its place: outside every place of its realm
   it throws, and inside another it reads as that place's `read`. Pass it
   down instead.

3. **Write with the `write` that `Realm.update` hands out.**
   `Realm.update(realm, (read, write) => { ... })`: `write($box, value)` replaces a
   value; `write.modify($box, (draft) => { ... })` drafts arrays and plain
   objects; a collection takes `write.upsert`, `write.remove`, and
   `write.replaceAll`; an atom takes `write.changed`. An update that throws
   is rolled back, but only its writes: a request sent inside the recipe
   has gone out. Run an effect that cannot be taken back after the update,
   from a `Realm.watch`
   (<https://pinna.frondruntime.dev/docs/state/updates#effects-after-the-update>).

## Rules

7. **Writes of asynchronous work that must not show early go through a
   stage.** `const stage = Stage.make(realm, { name })`, then
   `Stage.update(stage, (read, write) => ...)` for each step, then
   `Stage.apply(stage)`, with `Stage.drop(stage)` in a `finally`: no box
   changes and nothing reruns until `Stage.apply` lands every step in one
   update, and `Stage.drop` does nothing once the stage is applied. With
   Effect, `Stage.scoped(realm, (stage) => program)` does the same.
   - A read through the stage sees its own writes: boxes, collections
     (`keys`, `rows`, `row`, `read.row`), and computed values. It writes
     boxes, collections, and atoms, as an update does.
   - A recipe runs once when staged and once per `Stage.apply` through its
     parents to the realm; row listeners run for each change on each run.
     Make ids, times, models, and boxes outside it and close over them;
     inside it, making an observable, `Realm.update`, `Realm.untracked`, a kept `read` or
     `write`, and a watch throw.
   - A method that hands back a change returns a `UpdateRecipe`, so it runs in
     `Realm.update(realm, recipe)` and `Stage.update(stage, recipe)` alike.
   - A section that may fail on its own opens a child stage,
     `Stage.make(stage)` or `Stage.scoped(stage, ...)`: dropped, it leaves the
     parent as it was.
   - `Stage.apply` replays over the realm's values when it runs. Pass
     `{ conflicts: "fail" }` to have it throw `StageConflictError` instead
     when what the stage read or wrote changed; never retry a section that sends a
     request unless the request is safe to repeat.
   - A write meant to show before the work succeeds, an optimistic one,
     goes in `Stage.make(realm, { visible: true })`: it shows at once over
     the realm's confirmed values, and a failure drops it with nothing to
     undo. When the guess is the answer, apply the visible stage on success
     and drop it in a `finally`. When the server's answer wins, show the
     guess in a visible stage, write the answer in a hidden one, and in one
     `Realm.update` apply the answer and drop the guess, so watchers see the
     settled value once. With Effect, `Stage.scoped(realm, section,
     { visible: true })` and `{ guess: recipe }` are the two flows.
   - A `Realm.update` recipe reads the confirmed values, not the screen,
     while a guess shows: change a guessed value through a stage made above
     the guess. Read a value inside the recipe that writes it: one read at
     rest with `Source.peek` and written later writes the shown guess into
     the confirmed values. Pinna checks neither.
   - A pending marker is a box the guess writes (`write($saving, true)`):
     it shows exactly while the guess shows. A guess that can no longer
     apply stops showing; `Stage.inspect(stage).failure` says why.

8. **State from outside starts when it is observed.** `Source.onObserved($x, start)`
   runs `start` on the first observer and its cleanup after the last; an
   `Atom.make(realm)` stands for outside state, and `write.changed($atom)` reruns
   what read it. With Effect, `Program.whileObserved($x, program)` runs a feed while
   `$x` is observed, and `Program.fromStream(realm, stream, initial)` makes a value
   that holds the stream's last element while observed.
   - A request's answer is `Computed.fromPromise(realm, (signal) => request,
     initial)`, or `Program.fromEffect(realm, effect, initial)` with Effect.
     Pass `signal` to the request, so the last observer leaving aborts it.
     Map a failure the screen shows into the value's own union inside
     `load`; an unmapped rejection goes to `onError`. Pinna has no loading
     type: write the union, or take it from the request library.
   - Do not `await` a request and then call `Realm.update` by hand for a
     value a screen reads: the answer of an earlier request can land after
     a newer one, and after `Realm.dispose` the update throws
     `pinna/realm-disposed`. The bridge drops both.
   - Hold a value that must keep its answer with `Source.observe`;
     unobserved, it resets to `initial` and requests again when observed.
   - A query from another library, such as TanStack Query's
     `QueryObserver`, is copied into a `Box.make` by a `Source.onObserved`
     hook that syncs on start and subscribes until the cleanup.

9. **A realm whose screen, program, or request ends is disposed.**
   `Realm.dispose(realm)` runs every begun `Source.onObserved` cleanup, stops each
   autorun, row listener, and open stage, and then refuses `Realm.update` and
   every new observer with `pinna/realm-disposed`; reads keep the last
   values. Call it from an event handler or a teardown, never inside an
   update, a derivation, a watch's effect, an autorun, or a hook
   (`pinna/dispose-not-at-rest`). In React, make and dispose the realm in
   one effect, not in `useState` with an effect cleanup, which StrictMode
   disposes while the state still holds it. With Effect, take the realm
   from `Realm.scoped()` so the scope disposes it.

## References

Open a file under `references/` when its condition holds.

| File | Read when |
| --- | --- |
| [stages.md](references/stages.md) | Read when writes of asynchronous work must not show early: making, updating, applying, and dropping a stage, child stages, conflicts. |
| [visible-stages.md](references/visible-stages.md) | Read when a write must show before the work succeeds: the two optimistic flows, pending markers, a guess that stops showing. |
| [lifecycles.md](references/lifecycles.md) | Read when state comes from outside Pinna. Start a listener when a value gains its first observer and stop it after the last, stand for outside state with an atom, hold a value observed, and dispose a realm to end everything it runs. |
| [live-data.md](references/live-data.md) | Read when a socket, a subscription, or a query library feeds state: starting on the first observer, stopping after the last. |
| [async-state.md](references/async-state.md) | Read when a value comes from a request or another library. Load a promise into a value while it is observed, give it a status type of the application's own, hold it for a store that loads once, and copy a query from TanStack Query or another library into a box. |

## Another skill applies

- `pinna-state`: a synchronous write, one `Realm.update`, or code that runs after a change.
- `pinna-with-effect`: a feed that is an Effect or a `Stream`, and `Stage.scoped`.
- `pinna-saving-and-history`: undo of writes that already landed.
- `pinna-react-components`: making and disposing the realm in a component.

`node_modules/@frondruntime/pinna/AGENTS.md` is the same text at the installed version and wins where it differs.
