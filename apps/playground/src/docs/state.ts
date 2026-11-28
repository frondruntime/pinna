// The site's docs print the regions of this file (docs/public/state/updates.md and
// docs/public/state/reacting.md), so `bun run typecheck` compiles what the pages show.
import { Box, Collection, Realm, type Scheduler } from "@frondruntime/pinna";

// #region setup
const realm = Realm.make();
const $tags = Box.make<ReadonlyArray<string>>(realm, []);
// #endregion

// #region modify
const addTag = (tag: string) => {
  Realm.update(realm, (_read, write) => {
    write.modify($tags, (tags) => {
      tags.push(tag);
    });
  });
};
// #endregion

// #region atomic
const $quantity = Box.make(realm, 1);
const $note = Box.make(realm, "");

const take = (amount: number) => {
  Realm.update(realm, (read, write) => {
    write($note, `took ${amount}`);
    const left = read($quantity) - amount;
    if (left < 0) throw new Error("not enough in stock"); // $note is undone too
    write($quantity, left);
  });
};
// #endregion

// #region watch
const stop = Realm.watch(
  realm,
  (read) => read($tags).length,
  (count, previous) => {
    console.log(`${previous} → ${count} tags`);
  },
);
// #endregion

// #region watchImmediate
const stopCount = Realm.watch(
  realm,
  (read) => read($tags).length,
  (count, previous) => {
    // `previous` is `undefined` on the run at the call.
    console.log(previous === undefined ? `${count} tags` : `${previous} → ${count} tags`);
  },
  { immediate: true },
);
// #endregion

// #region autorun
const stopTitle = Realm.autorun(realm, (read) => {
  document.title = `${read($tags).length} tags`;
});
// #endregion

// #region cleanup
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
// #endregion

// #region autorunWrite
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
// #endregion

// #region scheduler
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
// #endregion

// #region reconcile
interface Rate {
  readonly currency: string;
  readonly rate: number;
}

const $rates = Box.make<ReadonlyArray<Rate>>(realm, []);

const receiveRates = (next: ReadonlyArray<Rate>) => {
  Realm.update(realm, (read, write) => {
    // An unchanged rate keeps its previous object, so what derives one rate
    // from $rates returns the same value and its readers do not rerun.
    write(
      $rates,
      Collection.reconcile(read($rates), next, {
        keyOf: (rate) => rate.currency,
        equals: (previous, latest) => previous.rate === latest.rate,
      }),
    );
  });
};
// #endregion

// Stands for the application's own request to the server.
const requests: Array<ReadonlyArray<string>> = [];
const sendCart = (cart: ReadonlyArray<string>) => {
  requests.push(cart);
};

// #region afterUpdate
// `sendCart` is the application's request to the server.
const $cart = Box.make<ReadonlyArray<string>>(realm, []);

// The request goes out from a watch: it runs after the outermost update ends,
// and only when the cart changed, so an update that is undone sends nothing.
const stopSending = Realm.watch(
  realm,
  (read) => read($cart),
  (cart) => {
    sendCart(cart);
  },
);

const addToCart = (item: string) => {
  Realm.update(realm, (_read, write) => {
    write.modify($cart, (cart) => {
      cart.push(item);
    });
    // A request sent here would go out even when a caller's update throws
    // later and undoes this write.
  });
};

const addPair = (first: string, second: string) => {
  Realm.update(realm, () => {
    addToCart(first);
    if (second === "") throw new Error("a pair needs two items");
    addToCart(second);
  });
};
// #endregion

// #region untracked
const onSave = () => {
  const tags = Realm.untracked(realm, (read) => read($tags));
  console.log("saving", tags);
};

// #endregion

export {
  $cart,
  addPair,
  addTag,
  addToCart,
  onSave,
  realm,
  receiveRates,
  requests,
  stop,
  stopClamp,
  stopCount,
  stopDraw,
  stopEscape,
  stopSending,
  stopTitle,
  take,
};
