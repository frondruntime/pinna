// The site's docs print the regions of this file (docs/public/state/lifecycles.md), so
// `bun run typecheck` compiles what the pages show.
import { atom, box, computed, createRealm, observe, onObserved, update } from "@frondruntime/pinna";

// #region onObserved
const realm = createRealm();

const $online = box(realm, true);

// Listens to the browser only while something observes $online.
onObserved($online, () => {
  const sync = () => {
    update(realm, (_read, write) => write($online, navigator.onLine));
  };
  sync(); // the value may have changed while no one listened
  window.addEventListener("online", sync);
  window.addEventListener("offline", sync);
  return () => {
    window.removeEventListener("online", sync);
    window.removeEventListener("offline", sync);
  };
});
// #endregion

// #region atom
// The clock is state kept outside Pinna: the atom stands for it.
const $clock = atom(realm);

onObserved($clock, () => {
  const timer = setInterval(() => {
    update(realm, (_read, write) => write.changed($clock));
  }, 1000);
  return () => clearInterval(timer);
});

const $time = computed(realm, (read) => {
  read($clock);
  return new Date().toLocaleTimeString();
});
// #endregion

// #region observe
// The clock ticks, and $time stays cached, until release runs.
const release = observe($time);

// #endregion

export { release };
