# Coming from MobX

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/start/mobx.md.

Sections: Example, Rules, Answers, With Effect, See also.

## Example

A cart in MobX: an observable class, a getter, an action, a reaction, and an
`observer` component.

```tsx
import { makeAutoObservable, reaction } from "mobx";
import { observer } from "mobx-react-lite";

class CartStore {
  quantity = 1;
  price = 10;

  constructor() {
    makeAutoObservable(this);
  }

  get total() {
    return this.quantity * this.price;
  }

  add() {
    this.quantity += 1;
  }
}

const store = new CartStore();

reaction(
  () => store.total,
  (total) => console.log(`total: ${total}`),
);

const StoreTotal = observer(function StoreTotal() {
  return (
    <button type="button" onClick={() => store.add()}>
      {store.total}
    </button>
  );
});
```

The same cart in Pinna. The fields that change are boxes, named with `$`. The
getter is a computed value, the action a method that calls `Realm.update`, the
reaction a `Realm.watch`. The component reads with `useValue` and needs no wrapper.
The cart is a `Model` made from a realm, so a test or a screen can make one of
its own.

```tsx
import { Box, Computed, Model, Realm } from "@frondruntime/pinna";
import { useValue } from "@frondruntime/pinna-react";

class Cart extends Model.Class {
  readonly $quantity = Box.make(this.realm, 1);
  readonly $price = Box.make(this.realm, 10);
  readonly $total = Computed.make(this.realm, (read) => read(this.$quantity) * read(this.$price));

  add(): void {
    Realm.update(this.realm, (read, write) => {
      write(this.$quantity, read(this.$quantity) + 1);
    });
  }
}

const realm = Realm.make();
const cart = new Cart(realm);

Realm.watch(
  realm,
  (read) => read(cart.$total),
  (total) => {
    console.log(`total: ${total}`);
  },
);

function CartTotal() {
  const total = useValue(cart.$total);
  return (
    <button type="button" onClick={() => cart.add()}>
      {total}
    </button>
  );
}
```

## Rules

- Nothing is read by property access. `store.total` becomes
  `read(cart.$total)` in a place, or `useValue(cart.$total)` in a component.
- Nothing is written by assignment. `store.quantity += 1` becomes
  `write(cart.$quantity, ...)` in a `Realm.update`.
- There are no deep proxies. A box holds plain data, replaced whole or through
  `write.modify`. A keyed list is a collection, tracked row by row: see
  [Collections](https://pinna.frondruntime.dev/docs/state/collections.md).
- An update is synchronous and atomic. An update that throws is undone: every
  write before the throw in the same update is taken back.
- There is no global state. Every observable belongs to the realm that made
  it, as with `configure({ isolateGlobalState: true })` for every store.
- `Realm.watch` runs for changes, not for the current value. Where MobX passes
  `fireImmediately: true` to `reaction`, pass `{ immediate: true }`: the
  effect also runs at the call, with `previous` `undefined`.
- `flow` has no counterpart: `await` outside, then one `Realm.update` per step. For
  cancellation, write the work as an Effect program.
- A `Realm.autorun` writes through `Realm.update`, whose reads do not subscribe it.
- `toJS` is not needed: values are plain data already.

## Answers

| MobX | Pinna |
| --- | --- |
| `observable.box` | `Box.make(realm, initial)` |
| `makeAutoObservable`, `makeObservable`, `@observable` | `class X extends Model` with `$` fields made by `Box.make(this.realm, ...)` and `Computed.make(this.realm, ...)`; with Effect, `Model.boxField(schema)` in a `Model.Schema` |
| `observable` arrays and objects | a `Box.make` of plain data, written whole or through `write.modify` |
| `ObservableMap` | `Collection.make(realm, { keyOf })`, or a box of an array written through `Collection.reconcile`; with Effect, a `Model.collectionField` |
| `computed`, a getter | `Computed.make(realm, (read) => ...)` |
| `computedFn` (mobx-utils) | `Computed.fn` |
| `action`, `runInAction` | `Realm.update(realm, (read, write) => ...)` |
| `reaction(select, effect)` | `Realm.watch(realm, (read) => ..., effect)` |
| `autorun` | `Realm.autorun(realm, (read) => ...)` |
| `when`, a `reaction` with `delay` | a `Realm.watch`; with Effect, `Program.changes($x)` and an Effect `Stream` |
| `untracked` | `Realm.untracked(realm, (read) => ...)` |
| `onBecomeObserved`, `onBecomeUnobserved` | `Source.onObserved($x, start)`: `start` runs when `$x` gains its first observer and returns the cleanup, which runs when the last leaves; `Source.onObserved` returns the function that removes the hook |
| `computed({ keepAlive: true })` | `Source.observe($x)`, released when done |
| `createAtom` | `Atom.make(realm)` |
| `fromPromise` (mobx-utils) | `Computed.fromPromise(realm, () => promise, initial)`, with a status union of the application's own in place of `state` and `case` ([Async state](https://pinna.frondruntime.dev/docs/guides/async-state.md)) |
| `fromStream`, `fromResource` (mobx-utils) | `Program.fromStream` from `pinna-effect` |
| `trace`, `getDependencyTree` | `Source.inspect($x)` |
| `onReactionError` | `Realm.make({ onError })` |
| `observer(Component)` | `useValue($x)` for each value the component shows |
| `useLocalObservable` | `useState(() => Box.make(realm, ...))`, with the realm from `useRealm()` |

## With Effect

An application on Effect Schema writes the store as a `Model.Schema`: its `$`
fields are `Model.boxField(schema)`, every write is checked, and `Model.decode` makes it
from server data. This is the same cart, with the `Realm.watch` and the component as
above.

```ts
import { Computed, Model, Realm } from "@frondruntime/pinna-effect";
import { Schema } from "effect";

class Cart extends Model.Schema<Cart>("Cart")({
  $quantity: Model.boxField(Schema.Int),
  $price: Model.boxField(Schema.Number),
}) {
  readonly $total = Computed.make(this.realm, (read) => read(this.$quantity) * read(this.$price));

  add(): void {
    Realm.update(this.realm, (read, write) => {
      write(this.$quantity, read(this.$quantity) + 1);
    });
  }
}

const cart = Model.decode(realm, Cart)({ quantity: 1, price: 10 });

Realm.watch(
  realm,
  (read) => read(cart.$total),
  (total) => {
    console.log(`total: ${total}`);
  },
);
```

## See also

- [Start](https://pinna.frondruntime.dev/docs/start/index.md): a realm, a box, and a computed value.
- [Updates](https://pinna.frondruntime.dev/docs/state/updates.md): drafts and atomic updates.
- [Classes](https://pinna.frondruntime.dev/docs/effect/classes.md): `Model.Schema`, `Model.boxField`, and `Model.decode`.
- [Live data](https://pinna.frondruntime.dev/docs/guides/live-data.md): a WebSocket feed and a fetch that refetches, with and without Effect, where MobX would use `flow`.
