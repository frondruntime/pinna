// The site's docs print the regions of this file (docs/public/state/updates.md and
// docs/public/state/reacting.md), so `bun run typecheck` compiles what the pages show.
import {
  autorun,
  box,
  createRealm,
  reconcile,
  untracked,
  update,
  watch,
} from "@frondruntime/pinna";

// #region setup
const realm = createRealm();
const $tags = box<ReadonlyArray<string>>(realm, []);
// #endregion

// #region modify
const addTag = (tag: string) => {
  update(realm, (_read, write) => {
    write.modify($tags, (tags) => {
      tags.push(tag);
    });
  });
};
// #endregion

// #region atomic
const $quantity = box(realm, 1);
const $note = box(realm, "");

const take = (amount: number) => {
  update(realm, (read, write) => {
    write($note, `took ${amount}`);
    const left = read($quantity) - amount;
    if (left < 0) throw new Error("not enough in stock"); // $note is undone too
    write($quantity, left);
  });
};
// #endregion

// #region watch
const stop = watch(
  realm,
  (read) => read($tags).length,
  (count, previous) => {
    console.log(`${previous} → ${count} tags`);
  },
);
// #endregion

// #region autorun
const stopTitle = autorun(realm, (read) => {
  document.title = `${read($tags).length} tags`;
});
// #endregion

// #region cleanup
const $editing = box(realm, false);

const stopEscape = autorun(realm, (read) => {
  if (!read($editing)) return undefined;
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      update(realm, (_read, write) => write($editing, false));
    }
  };
  window.addEventListener("keydown", onKey);
  // Runs before the next run, and when the autorun stops.
  return () => window.removeEventListener("keydown", onKey);
});
// #endregion

// #region autorunWrite
const $selected = box(realm, 0);

// Keeps the selection inside the list as it shrinks.
const stopClamp = autorun(realm, (read) => {
  const last = Math.max(read($tags).length - 1, 0);
  update(realm, (read, write) => {
    if (read($selected) > last) {
      write($selected, last);
    }
  });
});
// #endregion

// #region reconcile
interface Rate {
  readonly currency: string;
  readonly rate: number;
}

const $rates = box<ReadonlyArray<Rate>>(realm, []);

const receiveRates = (next: ReadonlyArray<Rate>) => {
  update(realm, (read, write) => {
    // An unchanged rate keeps its previous object, so what derives one rate
    // from $rates returns the same value and its readers do not rerun.
    write(
      $rates,
      reconcile(read($rates), next, {
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
const $cart = box<ReadonlyArray<string>>(realm, []);

// The request goes out from a watch: it runs after the outermost update ends,
// and only when the cart changed, so an update that is undone sends nothing.
const stopSending = watch(
  realm,
  (read) => read($cart),
  (cart) => {
    sendCart(cart);
  },
);

const addToCart = (item: string) => {
  update(realm, (_read, write) => {
    write.modify($cart, (cart) => {
      cart.push(item);
    });
    // A request sent here would go out even when a caller's update throws
    // later and undoes this write.
  });
};

const addPair = (first: string, second: string) => {
  update(realm, () => {
    addToCart(first);
    if (second === "") throw new Error("a pair needs two items");
    addToCart(second);
  });
};
// #endregion

// #region untracked
const onSave = () => {
  const tags = untracked(realm, (read) => read($tags));
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
  stopEscape,
  stopSending,
  stopTitle,
  take,
};
