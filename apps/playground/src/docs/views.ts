// The site's docs print the regions of this file (docs/public/state/views.md),
// so `bun run typecheck` compiles what the page shows.
import { Box, Collection, Computed, Realm, View } from "@frondruntime/pinna";

// #region rows
const realm = Realm.make();

interface Order {
  readonly id: string;
  readonly customer: string;
  /** Whole cents, so a total kept by adding and subtracting stays exact. */
  readonly cents: number;
}

const $orders = Collection.make(realm, {
  keyOf: (order: Order) => order.id,
  equals: (previous, next) => previous.customer === next.customer && previous.cents === next.cents,
});
// #endregion

// #region ordered
const $largestFirst = Box.make(realm, true);
const $customer = Box.make<string | undefined>(realm, undefined);

// Sorted by amount, filtered to one customer. Both factories read boxes,
// so writing either box sorts or filters again; a row write moves one key.
const $byAmount = View.ordered($orders, {
  compare: (read) => {
    const sign = read($largestFirst) ? -1 : 1;
    return (left, right) => sign * (left.cents - right.cents);
  },
  filter: (read) => {
    const customer = read($customer);
    return customer === undefined ? undefined : (order) => order.customer === customer;
  },
  name: "byAmount",
});
// #endregion

// #region window
// The keys a scrolled list shows: rows 40 to 60 of the filtered order. A
// write that leaves those keys in place reruns nothing that reads them.
const $visible = $byAmount.range(40, 60);

// "20 of 1,000 orders"
const $shown = Computed.make(
  realm,
  (read) => `${read($byAmount.size)} of ${read($byAmount.totalSize)} orders`,
);
// #endregion

// #region grouped
// The ids of each customer's orders. A write to one customer's orders reruns
// the readers of that customer alone.
const $ordersOf = View.grouped($orders, { groupOf: (order) => order.customer, name: "ordersOf" });

const $aliceOrders = $ordersOf.group("alice");
// #endregion

// #region totals
// The count and sum of each customer's orders, in cents.
const $totalOf = View.totals($orders, {
  project: (order) => ({ group: order.customer, value: order.cents }),
  arithmetic: {
    zero: 0,
    add: (total, cents) => total + cents,
    subtract: (total, cents) => total - cents,
  },
  name: "totalOf",
});

// { count: 2, total: 4_500 }
const $aliceTotal = $totalOf.group("alice");
// #endregion

// #region dispose
// A view lives as long as its owner: dispose it where the owner ends.
const stopViews = () => {
  View.dispose($byAmount);
  View.dispose($ordersOf);
  View.dispose($totalOf);
};

// #endregion

export {
  $aliceOrders,
  $aliceTotal,
  $byAmount,
  $customer,
  $largestFirst,
  $orders,
  $shown,
  $visible,
  realm,
  stopViews,
};
