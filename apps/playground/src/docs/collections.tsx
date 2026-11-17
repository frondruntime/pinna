// The site's docs print the regions of this file (docs/public/state/collections.md), so
// `bun run typecheck` compiles what the page shows. The `CollectionField` is `models.ts`.
import {
  box,
  collection,
  computed,
  computedFunction,
  createRealm,
  onRowChange,
  update,
  watch,
} from "@frondruntime/pinna";
import { useValue } from "@frondruntime/pinna-react";
import { memo } from "react";

// #region collection
const realm = createRealm();

interface Order {
  readonly id: string;
  readonly total: number;
}

const $orders = collection(realm, {
  keyOf: (order: Order) => order.id,
  // A refetch builds new objects; an order with the same total is kept.
  equals: (previous, next) => previous.total === next.total,
});
// #endregion

// #region write
const addOrder = (order: Order) => {
  update(realm, (_read, write) => {
    // Replaces the order under its id, or adds it last.
    write.upsert($orders, order, { at: "end" });
  });
};

const removeOrder = (id: string) => {
  update(realm, (_read, write) => {
    write.remove($orders, id); // a missing id changes nothing
  });
};
// #endregion

// #region row
// Reruns only when the order under "7" changes, is added, or is removed.
const stopRow = watch(
  realm,
  (read) => read($orders.row("7"))?.total,
  (total) => {
    console.log(total);
  },
);
// #endregion

// #region lookup
// Takes 10% off each order under `ids`. A recipe tracks nothing, so
// `read.row` makes no box for the orders it looks up.
const discountOrders = (ids: ReadonlyArray<string>) => {
  update(realm, (read, write) => {
    for (const id of ids) {
      const order = read.row($orders, id);
      if (order !== undefined) {
        write.upsert($orders, { ...order, total: order.total * 0.9 });
      }
    }
  });
};
// #endregion

// #region read
// Recomputes when an order is added, removed, or moved.
const $count = computed(realm, (read) => read($orders.keys).length);

// Recomputes when any order or the order of the keys changes.
const $sum = computed(realm, (read) =>
  read($orders.rows).reduce((sum, order) => sum + order.total, 0),
);
// #endregion

// #region component
// Rerenders when an order is added, removed, or moved; never for an order's own change.
function OrderList() {
  const ids = useValue($orders.keys);
  return (
    <ul>
      {ids.map((id) => (
        <OrderRow key={id} id={id} />
      ))}
    </ul>
  );
}

// Rerenders when the order under its id changes.
const OrderRow = memo(function OrderRow({ id }: { readonly id: string }) {
  const order = useValue($orders.row(id));
  return order === undefined ? null : (
    <li>
      {order.id}: {order.total}
    </li>
  );
});
// #endregion

// #region replaceAll
const receiveOrders = (orders: ReadonlyArray<Order>) => {
  update(realm, (_read, write) => {
    // The rows become `orders`, in their order. An order that `equals` finds
    // unchanged is kept: what read its row does not rerun.
    write.replaceAll($orders, orders);
  });
};

// #endregion

// #region selection
const $selected = box<string | undefined>(realm, undefined);

// A flag per id. A row reads its own flag, so a new selection rerenders the
// row that lost it and the row that gained it. The flag of an id is dropped
// once no mounted row reads it.
const isSelected = computedFunction(realm, (read, id: string) => read($selected) === id);

const select = (id: string) => {
  update(realm, (_read, write) => {
    write($selected, id);
  });
};

const SelectableRow = memo(function SelectableRow({ id }: { readonly id: string }) {
  const order = useValue($orders.row(id));
  const selected = useValue(isSelected(id));
  return order === undefined ? null : (
    <li>
      <button type="button" aria-pressed={selected} onClick={() => select(id)}>
        {order.id}: {order.total}
      </button>
    </li>
  );
});
// #endregion

// #region onRowChange
// The sum of every total, kept a row at a time: each write adds what it
// changed, instead of a reduce over every order. It takes effect and rolls back
// with the write that changed the row. The listener first hears each order
// already held, as added, so the sum starts from them.
const $runningSum = box(realm, 0);

const stopRunningSum = onRowChange($orders, (change, read, write) => {
  const added = (change.after?.total ?? 0) - (change.before?.total ?? 0);
  write($runningSum, read($runningSum) + added);
});

// #endregion

export {
  $count,
  $orders,
  $runningSum,
  $selected,
  $sum,
  addOrder,
  discountOrders,
  isSelected,
  OrderList,
  receiveOrders,
  removeOrder,
  SelectableRow,
  select,
  stopRow,
  stopRunningSum,
};
