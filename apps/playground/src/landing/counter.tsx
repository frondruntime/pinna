// The site's landing page prints the `api` region of this file (apps/site/src/pages/index.astro),
// so `bun run typecheck` compiles what the page shows. It uses the package without Effect, as it
// needs no schema library; the Effect section prints the checked boxes (`effect.ts`).
import { Box, Computed, Realm, Source } from "@frondruntime/pinna";
import { useValue } from "@frondruntime/pinna-react";

// #region api
// Realm: where state lives. A test or a request creates its own.
const realm = Realm.make();

// Create: a box holds state, a computed value derives from it.
const $count = Box.make(realm, 0);
const $double = Computed.make(realm, (read) => read($count) * 2);

// Read: a component reads through a hook. No hook, no read.
function Counter() {
  const double = useValue($double);
  return (
    <button type="button" onClick={increment}>
      {double}
    </button>
  );
}

// Write: write exists only inside update.
function increment() {
  Realm.update(realm, (read, write) => write($count, read($count) + 1));
}

// Observe: watch runs when the value it selects changes,
// autorun when anything it read changes. Each returns its stop.
const stop = Realm.watch(
  realm,
  (read) => read($double),
  (double) => {
    document.title = String(double);
  },
);
const stopLog = Realm.autorun(realm, (read) => void console.log(read($double)));

// Start work: when the first observer arrives,
// and return what stops it when the last one leaves.
// This one counts up each second while something reads $count.
Source.onObserved($count, () => {
  const timer = setInterval(increment, 1000);
  return () => clearInterval(timer);
});

// #endregion

export { Counter, stop, stopLog };
