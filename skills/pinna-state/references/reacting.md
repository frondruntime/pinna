# Reacting

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/state/reacting.md.

Sections: Example, Rules, Answers, See also.

## Example

The samples on this page use the realm and the box `$tags` of
[Updates](https://pinna.frondruntime.dev/docs/state/updates.md).

```ts
import { Box, Realm } from "@frondruntime/pinna";

const realm = Realm.make();
const $tags = Box.make<ReadonlyArray<string>>(realm, []);
```

`Realm.watch` runs its effect when the select's result changes, not on the first
run. The effect gets the value and the one before it.

```ts
import { Realm } from "@frondruntime/pinna";

const stop = Realm.watch(
  realm,
  (read) => read($tags).length,
  (count, previous) => {
    console.log(`${previous} → ${count} tags`);
  },
);
```

`{ immediate: true }` also runs the effect once at the call, for the current
value, with `previous` `undefined`, as MobX's `fireImmediately` on `reaction`
does. That run ignores `equals`; an error from it is thrown from
`Realm.watch`, and nothing is watched.

```ts
import { Realm } from "@frondruntime/pinna";

const stopCount = Realm.watch(
  realm,
  (read) => read($tags).length,
  (count, previous) => {
    // `previous` is `undefined` on the run at the call.
    console.log(previous === undefined ? `${count} tags` : `${previous} → ${count} tags`);
  },
  { immediate: true },
);
```

`Realm.autorun` runs at once, and again when what its last run read changes.

```ts
import { Realm } from "@frondruntime/pinna";

const stopTitle = Realm.autorun(realm, (read) => {
  document.title = `${read($tags).length} tags`;
});
```

A function an autorun returns is its cleanup.

```ts
import { Box, Realm } from "@frondruntime/pinna";

const $editing = Box.make(realm, false);

const stopEscape = Realm.autorun(realm, (read) => {
  if (!read($editing)) return undefined;
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      Realm.update(realm, (_read, write) => write($editing, false));
    }
  };
  window.addEventListener("keydown", onKey);
  // Runs before the next run, and when the autorun stops.
  return () => window.removeEventListener("keydown", onKey);
});
```

An autorun's body may call `Realm.update`. The recipe runs untracked, so its reads
of what it writes do not subscribe the autorun.

```ts
import { Box, Realm } from "@frondruntime/pinna";

const $selected = Box.make(realm, 0);

// Keeps the selection inside the list as it shrinks.
const stopClamp = Realm.autorun(realm, (read) => {
  const last = Math.max(read($tags).length - 1, 0);
  Realm.update(realm, (read, write) => {
    if (read($selected) > last) {
      write($selected, last);
    }
  });
});
```

A `scheduler` option runs a watch or an autorun when the scheduler calls the
`run` it is handed, rather than before `Realm.update` returns. Every write before
that joins one run, which reads the values current when it starts. Pinna
ships no scheduler and reads no time: the application picks what its host
has.

```ts
import { Realm, type Scheduler } from "@frondruntime/pinna";

// The host's frame, or a timer where it has none, as on a server or in a test.
const nextFrame: Scheduler = (run) => {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => run());
  } else {
    setTimeout(run, 16);
  }
};

// Draws at most once a frame, with the count current then.
const stopDraw = Realm.watch(
  realm,
  (read) => read($tags).length,
  (count) => {
    console.log("draw", count);
  },
  { scheduler: nextFrame },
);
```

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
- `{ immediate: true }` throws `pinna/watch-immediate-in-update` inside
  `Realm.update`: the run at the call would come before the update lands,
  with a value a rollback can take back. Make the watch outside the update.
  The effect's run at the call has no stop function yet: a watch that must
  stop itself on its first value checks the value and stops on a later run.
- A write the run at the call makes settles once it returns, as one in an
  autorun's first run does: no watcher, the watch itself included, runs
  inside it, so the effect never starts again before that run ends, and the
  update's record reaches `Realm.onUpdate` before `Realm.watch` returns.
- The run at the call delivers the value current when the effect runs. A
  `Source.onObserved` hook the watch starts begins when the outermost
  enclosing run settles: at the top that is inside `Realm.watch`, before the
  run at the call, so the effect gets the hook's value. Inside a watch's
  effect, an autorun's body, a hook, or with a `scheduler`, the hook begins
  after the run at the call, and its write is a later change that `equals`
  judges.
- `Realm.autorun` is the form for code that reads what it needs each run
  and needs no `previous`; a watch with `{ immediate: true }` is the form
  that keeps `previous` and `equals`.
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
- In React, read with the hooks instead: [Hooks](https://pinna.frondruntime.dev/docs/react/hooks.md). React
  decides when a component renders, so the hooks take no scheduler.

## Answers

| Call | Answers |
| --- | --- |
| `Realm.watch(realm, (read) => ..., (value, previous) => ..., { name?, equals?, scheduler?, immediate? })` | The stop function. `equals` decides what counts as a change; `Object.is` by default. With `immediate: true`, the effect also runs at the call, `previous` is typed `Value \| undefined`, and a scheduled watch's later runs stay the scheduler's. |
| `Realm.autorun(realm, (read) => ..., { scheduler? })` | The stop function. |
| `Scheduler` | The type `(run: () => void) => void`. |

## See also

- [Updates](https://pinna.frondruntime.dev/docs/state/updates.md): writing from an effect.
- [Lifecycles](https://pinna.frondruntime.dev/docs/state/lifecycles.md): what a watch or an autorun holds observed.
- [Programs](https://pinna.frondruntime.dev/docs/effect/programs.md): `Program.watchScoped` and `Program.changes` as Effect programs.
- [Live data](https://pinna.frondruntime.dev/docs/guides/live-data.md): a watch that refetches when its input changes.
