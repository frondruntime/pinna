# Lifecycles

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/state/lifecycles.md.

Sections: Example, Rules, Answers, See also.

## Example

An observable is observed while something holds it: a watch, an autorun, a
mounted `useValue`, `Source.observe`, or an observed computed value that read it.
`Source.onObserved` runs on the first observer, and its cleanup after the last.

```ts
import { Box, Realm, Source } from "@frondruntime/pinna";

const realm = Realm.make();

const $online = Box.make(realm, true);

// Listens to the browser only while something observes $online.
Source.onObserved($online, () => {
  const sync = () => {
    Realm.update(realm, (_read, write) => write($online, navigator.onLine));
  };
  sync(); // the value may have changed while no one listened
  window.addEventListener("online", sync);
  window.addEventListener("offline", sync);
  return () => {
    window.removeEventListener("online", sync);
    window.removeEventListener("offline", sync);
  };
});
```

An atom stands for state kept outside Pinna. `read($atom)` subscribes;
`write.changed($atom)`, inside an update, reruns what observed it.

```ts
import { Atom, Computed, Realm, Source } from "@frondruntime/pinna";

// The clock is state kept outside Pinna: the atom stands for it.
const $clock = Atom.make(realm);

Source.onObserved($clock, () => {
  const timer = setInterval(() => {
    Realm.update(realm, (_read, write) => write.changed($clock));
  }, 1000);
  return () => clearInterval(timer);
});

const $time = Computed.make(realm, (read) => {
  read($clock);
  return new Date().toLocaleTimeString();
});
```

`Source.observe` holds a value observed with nothing rendered.

```ts
import { Source } from "@frondruntime/pinna";

// The clock ticks, and $time stays cached, until release runs.
const release = Source.observe($time);
```

`Computed.fromPromise` is the same lifetime around one promise: `load` runs
on the first observer with a signal the last observer's leaving aborts, and
the value is `initial` until the promise resolves
([Async state](async-state.md)).

```ts
import { Computed } from "@frondruntime/pinna";

// The request runs while something observes $profile, and its signal aborts
// when the last observer leaves. The failure is mapped into the value, so
// the screen shows it; a rejection left unmapped goes to the realm's onError.
const $profile = Computed.fromPromise<Load<Profile>>(
  realm,
  (signal) =>
    fetch("https://example.com/profile", { signal })
      .then((response) => response.json())
      .then((body): Load<Profile> => ({ state: "loaded", value: toProfile(body) }))
      // After the parse, so a body that is not a profile fails too.
      .catch((error: unknown): Load<Profile> => ({ state: "failed", error })),
  { state: "loading" },
  { name: "profile" },
);

const $greeting = Computed.make(realm, (read) => {
  const profile = read($profile);
  return profile.state === "loaded" ? `Hello, ${profile.value.name}` : "";
});
```

`Realm.dispose` ends what a realm runs, for a screen or a program that closes:
each begun hook's cleanup runs once, so a socket a hook opened closes even
while something still observes its value.

```ts
import { Box, Realm, Source } from "@frondruntime/pinna";

// A screen's realm, made when the screen opens and disposed when it closes.
const screen = Realm.make({ name: "screen" });
const $quote = Box.make(screen, 0);

Source.onObserved($quote, () => {
  const socket = new WebSocket("wss://quotes.example/feed");
  socket.onmessage = (message) => {
    Realm.update(screen, (_read, write) => write($quote, Number(message.data)));
  };
  return () => socket.close();
});

const stopQuote = Source.observe($quote);

// Closes the socket: every begun hook's cleanup runs once. Afterward a read
// returns the last quote, and an update throws pinna/realm-disposed.
const closeScreen = () => {
  Realm.dispose(screen);
  Realm.status(screen); // "disposed"
};
```

## Rules

- A hook may write, in an update. It runs once every link of the call that
  observed is in place, before that call returns. Inside an update, hooks
  start and stop once the recipe returns, never in the middle of it.
- An observer holds what it read until it stops: a watch or an autorun until
  its stop function runs or its next run stops reading the value, `Source.observe` until its release runs, `useValue` and
  `useValues` until the component unmounts, `Program.watchScoped`, `Source.observeScoped`,
  and `Program.changes` until the scope closes or the stream stops, and an observed
  computed value until it is no longer observed or a recompute stops reading
  the value. `Realm.untracked` and an update read without observing.
- A source lost and gained within one call or one update fires nothing, so a
  watcher that swaps its sources does not restart a subscription.
- A hook's error, or its cleanup's, goes to the realm's `onError`, never to
  the caller. The caller always gets its release.
- Nothing reports what outside state did while no one observed it, so a hook
  syncs the state when it starts, as `sync()` does above.
- Dispose a realm whose screen, program, or request ends, once it is at
  rest: from an event handler or a teardown, never inside an update, a
  derivation, a watch's effect, an autorun, or a hook, where it throws
  `pinna/dispose-not-at-rest`. A realm nothing references is collected
  without it, but a hook's socket or timer keeps its realm alive, and
  running, until its cleanup runs.
- A disposed realm keeps its last values for reads. A watch, a `Source.observe`,
  or a mounted hook stays linked and never runs again, since nothing can
  write; its stop or release does nothing more. A mounted hook that reads
  a source for the first time after disposal starts none of its
  `Source.onObserved` hooks, which no later disposal would end. `Realm.update`, and every call
  that starts an observer, a hook, a listener, or a stage, throws
  `pinna/realm-disposed`.
- In React, make and dispose a realm in one effect. Made in `useState` and
  disposed in an effect cleanup, the realm is disposed by StrictMode's
  second run while the state still holds it, and the next hook to mount
  throws.
- A `Computed.fromPromise` value runs `load` from the start for each
  observation and drops a result that arrives after it ended, so a slow
  answer from an earlier observation never overwrites a newer one, and none
  writes a disposed realm. Its rejection goes to `onError`; the value keeps
  what it held.
- An atom nothing observes counts as changed on every check. A computed value
  that reads such an atom recomputes on every read; observed, it recomputes
  only after `write.changed`.

## Answers

| Call | Answers |
| --- | --- |
| `Source.onObserved($x, () => cleanup)` | The function that removes the hook. The function passed in returns the cleanup. |
| `Atom.make(realm)` | An atom. `read($atom)` returns `undefined`. |
| `write.changed($atom)` | Reruns what observed the atom. |
| `Computed.fromPromise(realm, (signal) => promise, initial, { equals?, name? })` | A read-only value: `initial`, then what the promise resolved to, while observed; `initial` while unobserved. `load` runs on each first observer, and `signal` aborts when the last leaves or the realm is disposed, which also resets the value. A resolved value equal under `equals`, `Object.is` by default, notifies nobody; `name` names it for `Source.inspect`. A rejection or a throw from `load` goes to `onError`. |
| `Source.observe($x)` | A release. Until it runs, `$x`'s hooks stay started and a computed value stays cached. |
| `Realm.dispose(realm)` | `void`. Ends every autorun, row listener, open stage, and begun hook of the realm, then refuses writes and new observers. A second call does nothing. Also `realm[Symbol.dispose]()`, so `using realm = Realm.make()` disposes it. |
| `Realm.status(realm)` | `"open"`, `"disposing"` while `Realm.dispose` runs, or `"disposed"`. |

## See also

- [Reacting](https://pinna.frondruntime.dev/docs/state/reacting.md): watches and autoruns.
- [Programs](https://pinna.frondruntime.dev/docs/effect/programs.md): `Program.fromStream`, a value fed by a stream while observed.
- [Live data](https://pinna.frondruntime.dev/docs/guides/live-data.md): a WebSocket opened while something observes the feed.
