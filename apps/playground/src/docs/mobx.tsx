// The site's docs print the regions of this file (docs/public/start/mobx.md), so
// `bun run typecheck` compiles both sides. The two regions build the same cart.
import { Box, Computed, Model, Realm } from "@frondruntime/pinna";
import { useValue } from "@frondruntime/pinna-react";
import { makeAutoObservable, reaction } from "mobx";
import { observer } from "mobx-react-lite";

// #region mobx
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
// #endregion

// #region pinna
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

// #endregion

export { CartTotal, StoreTotal };
