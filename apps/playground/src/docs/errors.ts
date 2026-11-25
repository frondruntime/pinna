// The site's docs print the regions of this file (docs/public/guides/errors.md), so
// `bun run typecheck` compiles what the page shows.
import { Box, Computed, Realm, Source } from "@frondruntime/pinna";

const reported: Array<unknown> = [];
const report = (error: unknown) => {
  reported.push(error);
};

// #region onError
// Errors with no caller to throw to: a watch effect's, an autorun's after
// its first run, an onObserved hook's. The host's reportError by default.
const realm = Realm.make({ onError: (error) => report(error) });
// #endregion

// #region computed
const $count = Box.make(realm, 1, { name: "count" });

const $inverse = Computed.make(
  realm,
  (read) => {
    const count = read($count);
    if (count === 0) throw new Error("no inverse of zero");
    return 1 / count;
  },
  { name: "inverse" },
);

Realm.update(realm, (_read, write) => write($count, 0));
// Every read of $inverse throws "no inverse of zero" until $count changes.
// #endregion

// #region effect
const stop = Realm.watch(
  realm,
  (read) => read($count),
  (count) => {
    if (count > 10) throw new Error(`too many: ${count}`);
  },
);

// The write lands; the effect's error goes to onError, and the watch keeps running.
Realm.update(realm, (_read, write) => write($count, 11));
// #endregion

// #region inspect
Realm.update(realm, (_read, write) => write($count, 2));
const stopInverse = Realm.watch(
  realm,
  (read) => read($inverse),
  () => undefined,
);
Realm.update(realm, (_read, write) => write($count, 4));

Source.inspect($inverse);
// { name: "inverse", realm: undefined, dependencies: ["count"], observers: 1,
//   lastReason: "count changed" }
// #endregion

const inverse = Realm.untracked(realm, (read) => read($inverse));

export { inverse, reported, stop, stopInverse };
