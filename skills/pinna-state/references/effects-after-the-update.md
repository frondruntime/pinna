# Updates: Effects after the update

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/state/updates.md, its section "Effects after the update".

## Effects after the update

A watch runs once the outermost update ends, and only for a value that
changed. An update that is undone restores every box it wrote, so a watch
that reads only boxes does not run; a `write.changed` on an atom is not
undone, and a watch that reads the atom runs. An effect that a watch
runs from the state it sees is never ahead of the realm. In the sample,
`addPair` joins two calls of `addToCart` in one update; when it throws,
both writes are undone and nothing is sent, and when it succeeds, one
request carries both items.

```ts
import { Box, Realm } from "@frondruntime/pinna";

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
```

An effect that needs no state from the realm, such as closing a dialog,
runs in the event handler after its `Realm.update` returns, and a throw leaves
the handler before it. This holds only for the outermost update: code after
a `Realm.update` that joined an outer one runs before the outer one ends, and
the outer one can still throw.
