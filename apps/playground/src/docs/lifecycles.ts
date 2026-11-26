// The site's docs print the regions of this file (docs/public/state/lifecycles.md), so
// `bun run typecheck` compiles what the pages show.
import { Atom, Box, Computed, Realm, Source } from "@frondruntime/pinna";

// #region onObserved
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
// #endregion

// #region atom
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
// #endregion

// #region observe
// The clock ticks, and $time stays cached, until release runs.
const release = Source.observe($time);

// #endregion

// #region dispose
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

// #endregion

export { closeScreen, release, stopQuote };
