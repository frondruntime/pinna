// The site's docs print the regions of this file (docs/public/guides/row-indexes.md and
// docs/public/state/collections.md), so `bun run typecheck` compiles what the pages show.
import { Box, Collection, Computed, Realm } from "@frondruntime/pinna";

// #region rows
const realm = Realm.make();

interface Order {
  readonly id: string;
  readonly customer: string;
  /** Whole cents, so a sum kept by adding and subtracting stays exact. */
  readonly cents: number;
  /** When the order was placed, in milliseconds since the epoch. */
  readonly placedAt: number;
}

const $orders = Collection.make(realm, {
  keyOf: (order: Order) => order.id,
  equals: (previous, next) =>
    previous.customer === next.customer &&
    previous.cents === next.cents &&
    previous.placedAt === next.placedAt,
});
// #endregion

// #region set
// A set of order ids: a collection keyed by the id itself.
const $selected = Collection.make(realm, { keyOf: (id: string) => id });

const toggleSelected = (id: string) => {
  Realm.update(realm, (read, write) => {
    if (read.row($selected, id) === undefined) {
      write.upsert($selected, id);
    } else {
      write.remove($selected, id);
    }
  });
};

// Tracks one id: selecting another order reruns nothing here.
const isSelected = Computed.fn(realm, (read, id: string) => read.row($selected, id) !== undefined);
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
      $value = Box.make(realm, initial);
      boxes.set(key, $value);
    }
    return $value;
  };
};
// #endregion

// #region lastOrdered
// The latest time each customer ordered, kept as a maximum: rows are
// reported in key order, not by time. No view keeps a value that is not a
// total, so a listener writes one box per customer.
const lastOrderedOf = boxPerKey<string, number>(realm, 0);

const stopLastOrdered = Collection.onRowChange($orders, ({ after }, read, write) => {
  if (after !== undefined) {
    const $last = lastOrderedOf(after.customer);
    if (after.placedAt > read($last)) write($last, after.placedAt);
  }
});

// #endregion

export { $orders, isSelected, lastOrderedOf, stopLastOrdered, toggleSelected };
