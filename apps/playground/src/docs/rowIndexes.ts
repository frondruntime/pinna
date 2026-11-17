// The site's docs print the regions of this file (docs/public/guides/row-indexes.md), so
// `bun run typecheck` compiles what the page shows.
import {
  type Box,
  box,
  collection,
  computed,
  computedFunction,
  createRealm,
  onRowChange,
  type Realm,
  update,
} from "@frondruntime/pinna";

// #region rows
const realm = createRealm();

interface Order {
  readonly id: string;
  readonly customer: string;
  /** Whole cents, so a sum kept by adding and subtracting stays exact. */
  readonly cents: number;
}

const $orders = collection(realm, {
  keyOf: (order: Order) => order.id,
  equals: (previous, next) => previous.customer === next.customer && previous.cents === next.cents,
});
// #endregion

// #region set
// A set of order ids: a collection keyed by the id itself.
const $selected = collection(realm, { keyOf: (id: string) => id });

const toggleSelected = (id: string) => {
  update(realm, (read, write) => {
    if (read.row($selected, id) === undefined) {
      write.upsert($selected, id);
    } else {
      write.remove($selected, id);
    }
  });
};

// Tracks one id: selecting another order reruns nothing here.
const isSelected = computedFunction(
  realm,
  (read, id: string) => read.row($selected, id) !== undefined,
);
// #endregion

// #region boxPerKey
// One box per key, made on the first ask. The map holds boxes, never values,
// so a write that fails puts back what the boxes hold and leaves at most an
// empty box behind.
const boxPerKey = <Key, Value>(realm: Realm, initial: Value) => {
  const boxes = new Map<Key, Box<Value>>();
  return (key: Key): Box<Value> => {
    let $value = boxes.get(key);
    if ($value === undefined) {
      $value = box(realm, initial);
      boxes.set(key, $value);
    }
    return $value;
  };
};
// #endregion

// #region index
// The ids of each customer's orders. A write to one customer's orders reruns
// the readers of that customer alone.
const ordersOf = boxPerKey<string, ReadonlyArray<string>>(realm, []);

const stopOrdersOf = onRowChange($orders, ({ key, before, after }, read, write) => {
  if (before?.customer === after?.customer) {
    return; // a new amount under the same customer moves no id
  }
  if (before !== undefined) {
    const $ids = ordersOf(before.customer);
    write(
      $ids,
      read($ids).filter((id) => id !== key),
    );
  }
  if (after !== undefined) {
    const $ids = ordersOf(after.customer);
    write($ids, [...read($ids), key]);
  }
});
// #endregion

// #region totals
// The sum of each customer's orders, in cents.
const totalOf = boxPerKey<string, number>(realm, 0);

const stopTotalOf = onRowChange($orders, ({ before, after }, read, write) => {
  if (before !== undefined) {
    const $total = totalOf(before.customer);
    write($total, read($total) - before.cents);
  }
  if (after !== undefined) {
    const $total = totalOf(after.customer);
    write($total, read($total) + after.cents);
  }
});
// #endregion

// #region sorted
// Largest first; the id breaks a tie, so every order has one place.
const compareByAmount = (a: Order, b: Order): number =>
  b.cents - a.cents || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The first index whose order sorts at or after `order`.
const placeOf = (orders: ReadonlyArray<Order>, order: Order): number => {
  let low = 0;
  let high = orders.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const held = orders[middle];
    if (held !== undefined && compareByAmount(held, order) < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
};

// Each change finds its place by binary search, instead of a sort of every
// order. The box holds the rows as they were reported: `before` is found by
// the amount it was sorted under.
const $byAmount = box<ReadonlyArray<Order>>(realm, []);

const stopByAmount = onRowChange($orders, ({ before, after }, read, write) => {
  const orders = [...read($byAmount)];
  if (before !== undefined) {
    orders.splice(placeOf(orders, before), 1);
  }
  if (after !== undefined) {
    orders.splice(placeOf(orders, after), 0, after);
  }
  write($byAmount, orders);
});

// The ten largest orders. A change below the tenth leaves the same ten rows,
// and `equals` keeps what reads them from rerunning.
const $largest = computed(realm, (read) => read($byAmount).slice(0, 10), {
  equals: (previous, next) =>
    previous.length === next.length && previous.every((order, index) => order === next[index]),
});

// #endregion

export {
  $byAmount,
  $largest,
  $orders,
  isSelected,
  ordersOf,
  stopByAmount,
  stopOrdersOf,
  stopTotalOf,
  toggleSelected,
  totalOf,
};
