# Async state

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/guides/async-state.md.

Sections: Example, Rules, With Effect, See also.

## Example

Pinna ships no status type for asynchronous work: no loading flag, refetch,
cache, or Suspense hook. A request library, such as TanStack Query, owns
those, and Pinna holds what it answers. The status is a union the
application writes once.

```ts
// The application's own status type: Pinna ships none.
type Load<Value> =
  | { readonly state: "loading" }
  | { readonly state: "loaded"; readonly value: Value }
  | { readonly state: "failed"; readonly error: unknown };
```

`Computed.fromPromise` loads a promise into a read-only value. The request
starts with the first observer and is aborted when the last one leaves,
through the signal `load` receives; the value is `initial` until the promise
resolves, and again once nothing observes it. The failure is mapped into the
union inside `load`, so the screen shows it.

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

A store that loads once, as a MobX store that calls `fromPromise` in its
constructor, holds the value with `Source.observe`. The request runs once,
and the answer stays until the release runs.

```ts
import { Source } from "@frondruntime/pinna";

// A store that loads once, as a MobX fromPromise in a constructor does: the
// release holds $profile observed, so it keeps its answer until released.
const releaseProfile = Source.observe($profile);
```

A query from another library is copied into a box. TanStack Query's
`QueryObserver`, and any store with a current result and a listener, fits
the shape below: the box subscribes while something observes it, and syncs
on each start, since nothing reports what the query did while no one
listened ([Lifecycles](lifecycles.md)).

```ts
import { Box, Realm, Source } from "@frondruntime/pinna";

// A query from another library, such as TanStack Query's QueryObserver: it
// has a current result and calls a listener on each change. Pinna holds a
// copy in a box, subscribed only while something observes the box.
interface ExternalQuery<Result> {
  getCurrentResult(): Result;
  subscribe(listener: (result: Result) => void): () => void;
}

const fromExternal = <Result>(query: ExternalQuery<Result>) => {
  const $result = Box.make(realm, query.getCurrentResult());
  Source.onObserved($result, () => {
    const sync = (result: Result) => {
      Realm.update(realm, (_read, write) => write($result, result));
    };
    // The query may have changed while no one listened.
    sync(query.getCurrentResult());
    return query.subscribe(sync);
  });
  return $result;
};
```

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
on the interruption ([Programs](https://pinna.frondruntime.dev/docs/effect/programs.md)).

```ts
import { Program } from "@frondruntime/pinna-effect";
import { Effect } from "effect";

// One answer, not a stream: the effect runs while $settings is observed, and
// again for the next observation. A failure the screen shows is mapped into
// the value; the defaults stand in until the settings arrive, or when they
// cannot be read.
const defaults = new Settings({ currency: "USD" });

const settings = Program.fromEffect(
  realm,
  loadSettings.pipe(Effect.catchTag("SettingsUnavailable", () => Effect.succeed(defaults))),
  defaults,
  { name: "settings" },
);
```

## See also

- [Lifecycles](lifecycles.md): `Computed.fromPromise`, `Source.onObserved`, and `Source.observe`.
- [Live data](https://pinna.frondruntime.dev/docs/guides/live-data.md): a socket feed, and a refetch that keeps row identity.
- [Programs](https://pinna.frondruntime.dev/docs/effect/programs.md): `Program.fromEffect` and `Program.fromStream`.
- [Updates](https://pinna.frondruntime.dev/docs/state/updates.md): a stage that fails on conflicts, which includes a value `Computed.fromPromise` changed.
