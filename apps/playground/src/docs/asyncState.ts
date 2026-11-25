// The site's docs print the regions of this file (docs/public/guides/async-state.md),
// so `bun run typecheck` compiles what the pages show.
import { Box, Computed, Realm, Source } from "@frondruntime/pinna";

const realm = Realm.make();

// #region status
// The application's own status type: Pinna ships none.
type Load<Value> =
  | { readonly state: "loading" }
  | { readonly state: "loaded"; readonly value: Value }
  | { readonly state: "failed"; readonly error: unknown };
// #endregion

interface Profile {
  readonly id: string;
  readonly name: string;
}

const toProfile = (body: unknown): Profile => {
  if (typeof body === "object" && body !== null) {
    const { id, name } = body as Record<string, unknown>;
    if (typeof id === "string" && typeof name === "string") {
      return { id, name };
    }
  }
  throw new TypeError("profile: the body is not a profile");
};

// #region promise
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
// #endregion

// #region hold
// A store that loads once, as a MobX fromPromise in a constructor does: the
// release holds $profile observed, so it keeps its answer until released.
const releaseProfile = Source.observe($profile);
// #endregion

// #region external
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

// #endregion

export { $greeting, fromExternal, type Load, releaseProfile };
