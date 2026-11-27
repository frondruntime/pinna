# Collections

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/state/collections.md.

Sections: Example, Rules, Answers, Row selection, See also.

## Example

A collection holds rows by key, a box for each key a reader reads, and one
box for the order of the keys, so a write to one row reruns the readers of
that row, not the readers of the list. A key's box is made on the first
read of `row(key)` and kept while the key is present, so rows nobody reads
alone cost no box. `Collection.make` makes an empty one with no schema;
`undefined` rows are rejected.

```tsx
import { Collection, Realm } from "@frondruntime/pinna";

const realm = Realm.make();

interface Order {
  readonly id: string;
  readonly total: number;
}

const $orders = Collection.make(realm, {
  keyOf: (order: Order) => order.id,
  // A refetch builds new objects; an order with the same total is kept.
  equals: (previous, next) => previous.total === next.total,
});
```

A collection is written inside an update, with `write.upsert` and
`write.remove`.

```tsx
import { Realm } from "@frondruntime/pinna";

const addOrder = (order: Order) => {
  Realm.update(realm, (_read, write) => {
    // Replaces the order under its id, or adds it last.
    write.upsert($orders, order, { at: "end" });
  });
};

const removeOrder = (id: string) => {
  Realm.update(realm, (_read, write) => {
    write.remove($orders, id); // a missing id changes nothing
  });
};
```

`row(key)` tracks that key alone. A write to another row, or a new key,
reruns nothing here.

```tsx
import { Realm } from "@frondruntime/pinna";

// Reruns only when the order under "7" changes, is added, or is removed.
const stopRow = Realm.watch(
  realm,
  (read) => read($orders.row("7"))?.total,
  (total) => {
    console.log(total);
  },
);
```

Where nothing tracks (an update's recipe, `Realm.untracked`, a watch's effect),
`read.row($items, key)` reads the row the collection holds and makes no box,
so a lookup leaves nothing behind. In a tracked place it is
`read($items.row(key))`.

```tsx
import { Realm } from "@frondruntime/pinna";

// Takes 10% off each order under `ids`. A recipe tracks nothing, so
// `read.row` makes no box for the orders it looks up.
const discountOrders = (ids: ReadonlyArray<string>) => {
  Realm.update(realm, (read, write) => {
    for (const id of ids) {
      const order = read.row($orders, id);
      if (order !== undefined) {
        write.upsert($orders, { ...order, total: order.total * 0.9 });
      }
    }
  });
};
```

`keys` changes only when a key is added, removed, or moved. `rows` changes
when any row or the order changes.

```tsx
import { Computed } from "@frondruntime/pinna";

// Recomputes when an order is added, removed, or moved.
const $count = Computed.make(realm, (read) => read($orders.keys).length);

// Recomputes when any order or the order of the keys changes.
const $sum = Computed.make(realm, (read) =>
  read($orders.rows).reduce((sum, order) => sum + order.total, 0),
);
```

A list component reads `keys` and hands each row its key, so a change to one
row rerenders that row alone.

```tsx
import { useValue } from "@frondruntime/pinna-react";
import { memo } from "react";

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
```

A refetch writes every row at once with `write.replaceAll`. A row that
`equals` finds unchanged is kept, and what read it does not rerun.

```tsx
import { Realm } from "@frondruntime/pinna";

const receiveOrders = (orders: ReadonlyArray<Order>) => {
  Realm.update(realm, (_read, write) => {
    // The rows become `orders`, in their order. An order that `equals` finds
    // unchanged is kept: what read its row does not rerun.
    write.replaceAll($orders, orders);
  });
};
```

A value kept a row at a time listens with `Collection.onRowChange`; a
sorted order, an index by another key, and a total per group are
[views](views.md). The listener runs inside the update that wrote
the row, with that update's `read` and `write`, so what it writes takes effect
and rolls back with the row.

```tsx
import { Box, Collection } from "@frondruntime/pinna";

// The sum of every total, kept a row at a time: each write adds what it
// changed, instead of a reduce over every order. It takes effect and rolls back
// with the write that changed the row. The listener first hears each order
// already held, as added, so the sum starts from them.
const $runningSum = Box.make(realm, 0);

const stopRunningSum = Collection.onRowChange($orders, (change, read, write) => {
  const added = (change.after?.total ?? 0) - (change.before?.total ?? 0);
  write($runningSum, read($runningSum) + added);
});
```

## Rules

- A collection is written with `write.upsert`, `write.remove`, and
  `write.replaceAll`, inside an update. An update that throws puts back the
  keys and every row, as it does a box.
- `write.upsert` and `write.replaceAll` reject an `undefined` row with
  `pinna: a collection row cannot be undefined`, before changing any row.
  `row(key)` and `read.row` return `undefined` for a missing key, so a
  present row cannot use that value. The rule also applies to schema
  collections, even when the schema accepts `undefined`.
- `upsert` replaces a held key's row in place and puts a new key first, or
  last with `{ at: "end" }`. `remove` of a missing key changes nothing.
- Keys are equal as a `Map`'s are: `NaN` matches `NaN`, and `0` matches
  `-0`. A key is stored as the `Map` stores it, so a row keyed `-0` is held
  under `0`, and `keys`, a view's keys, a row listener's `key`, and a
  record's row `key` hand out `0` on every path, base or staged. Without
  this, `keys` kept the sign of the first write and a view or a listener
  the sign of the latest row, so one row had two keys `Object.is` told
  apart.
- Adding or removing a key copies the key order, so its cost grows with the
  collection: about 15 µs at 1,000 rows and 120 µs at 10,000 on Hermes.
  Replacing the row of a held key costs the same at any size. The order is
  one immutable array, so a failed update puts back the old one and `keys`
  answers the same array until a key changes. Many new rows go in through
  one `write.replaceAll`, which copies once; an `upsert` per row copies once
  per row, even inside one update.
- A row written under a held key is compared with `equals`, `Object.is`
  without one. A refetch builds new objects, so without `equals` it reruns
  the readers of every row.
- A key that appears twice in `replaceAll` throws
  `pinna: the collection key <key> appears twice`, and nothing is written.
- A list that renders one row per key reads `keys` and `row(key)`. `rows`
  reruns its reader when any row or the order changes.
- `keys` is observed while something reads `keys` or `rows`, or reads
  `row(key)` for a missing key. `row(key)` of a present key tracks that row
  alone, so a hook on `keys` misses a reader of one row. A feed that writes
  the rows only while any of them is read hangs on a private atom that every
  public reader reads ([Live data](https://pinna.frondruntime.dev/docs/guides/live-data.md)); a feed for a
  list alone starts and stops with `keys`, through `Source.onObserved` or, with
  Effect, `Program.whileObserved`.
- `row(key)` returns the same computed value for a present key on every call;
  for a missing key, only while something observes it.
- A lookup where nothing tracks reads through `read.row($items, key)`.
  `read($items.row(key))` there makes the key's computed value and box,
  and the collection keeps both until the key is removed.
- `read.row` outside every place of its realm throws, as `read` does.
- `Collection.onRowChange` reports each row `upsert`, `remove`, or `replaceAll` adds,
  replaces, or removes, `replaceAll` a row at a time, with the row `before`
  and `after` the write; one is `undefined` for an add or a removal. A write
  that keeps a row reports nothing.
- `write.revert` and `write.replay` report a row only to a listener added
  after the record's update, and to every view: the record already holds
  what an older listener wrote, and restores it as written
  ([Change stream](https://pinna.frondruntime.dev/docs/state/changes.md)).
- A listener first hears each row the collection holds, in key order, as
  added, so what it keeps starts in step with the rows. A throw there adds
  no listener and reaches the caller of `Collection.onRowChange`. If settling watchers
  throws after replay commits, the listener is removed and the replay's
  writes stay committed: the caller received no function to remove it.
- A listener writes other boxes and collections. A write to the collection
  it listens to throws, and so does a listener that returns a value: it
  is synchronous. A listener that throws fails the write, which is put back.
- What a listener keeps rolls back when it lives in boxes. A plain `Map`
  of values the listener fills is not put back when the write fails; a
  `Map` of boxes is, since it holds the boxes and the boxes are put back.
- A listener sees rows the collection replaces, never a write to a box
  inside a row: a `Model.Schema` row whose box fields alone change is merged
  in place and reports nothing. A sum over a `Model.boxField` is a `Computed.make`.
- `replaceAll` writes every row, then reports them a row at a time, so a
  listener that reads the collection sees rows ahead of their reports.
- An index by another key deletes an entry only while it still names
  `change.key`: two rows that swap values report one at a time, and the
  second report would otherwise delete the first one's new entry.
- Each `Collection.onRowChange` replays the held rows to its listener, so a host adds a
  listener once, beside the boxes it fills. A listener added again, as a
  React effect in strict mode is after its cleanup, counts each row twice
  unless the host resets its boxes first.
- The function `Collection.onRowChange` returns removes the listener for good: an
  update that fails after calling it does not add it back, as with `Realm.watch`.
- `Collection.onRowChange` in a computed value or a watch's select throws, as `Realm.update`
  does there.
- A list written one row at a time is a collection. A box of an array is
  written whole, and every write reruns every reader of the box. A list
  written whole on each refetch can stay a box written through `Collection.reconcile`:
  see [Updates](https://pinna.frondruntime.dev/docs/state/updates.md).

## Answers

| Call | Answers |
| --- | --- |
| `Collection.make(realm, { keyOf, equals?, name? })` | An empty collection with no schema; `undefined` rows are rejected. `equals` defaults to `Object.is`. `name` names its `keys` (`<name>.keys`) and `rows` (`<name>.rows`) for `Source.inspect` and errors, and the collection in a stage's conflict error and `Stage.inspect`. |
| `$items.row(key)` | A computed value of that row, or `undefined`. |
| `read.row($items, key)` | That row, or `undefined`: tracked as `read($items.row(key))` in a tracked place, and read without making a box where nothing tracks. |
| `$items.keys`, `$items.rows` | Computed values of the keys, and of every row, in order. |
| `write.upsert($items, row, { at? })` | Replaces the row under its key, or adds it first, or last with `{ at: "end" }`. |
| `write.remove($items, key)` | Removes the row under `key`. |
| `write.replaceAll($items, rows)` | Makes `rows` the collection's rows, in their order, keeping each one that is unchanged. |
| `Collection.onRowChange($items, (change, read, write) => ...)` | Calls the listener for each row a write adds, replaces, or removes, inside that write's update, except a `write.revert` or `write.replay` of a record made after the listener was added; `change` holds `key`, `before`, and `after`. Returns the function that removes the listener. |

## Row selection

The selected key is one box beside the collection, and each row reads a
flag of its own from a `Computed.fn`. Moving the selection
from one row to another changes two flags, so it rerenders the row that
lost the selection and the row that gained it, and a first selection changes
one; every other row's flag recomputes to the same `false`, and its
row does not render.

```tsx
import { Box, Computed, Realm } from "@frondruntime/pinna";
import { useValue } from "@frondruntime/pinna-react";
import { memo } from "react";

const $selected = Box.make<string | undefined>(realm, undefined);

// A flag per id. A row reads its own flag, so a new selection rerenders the
// row that lost it and the row that gained it. The flag of an id is dropped
// once no mounted row reads it.
const isSelected = Computed.fn(realm, (read, id: string) => read($selected) === id);

const select = (id: string) => {
  Realm.update(realm, (_read, write) => {
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
```

The flag and the row's own computed value live for different spans.

- A flag from `isSelected(id)` lives while something observes it. Once the
  last row that reads it unmounts, it is dropped, and the next call makes a
  new one, so a list that mounts and unmounts rows keeps no flag for a row
  off screen.
- `$orders.row(id)` returns the same computed value while the key is held,
  whether a row reads it or not, and the collection keeps the key's box
  until the key is removed.

## See also

- [Updates](https://pinna.frondruntime.dev/docs/state/updates.md): the update every write runs in, and `Collection.reconcile`.
- [Views](views.md): a sorted, filtered order, the keys of each group, and a total per group, kept a row at a time.
- [Indexes and sets](row-indexes.md): a set of keys and a value per key, kept with `Collection.onRowChange`.
- [Hooks](https://pinna.frondruntime.dev/docs/react/hooks.md): every way a component reads.
- [Collection fields](https://pinna.frondruntime.dev/docs/effect/collections.md): a collection as a field of a `Model.Schema`, each row checked against a schema.
- [Equality and hashing](https://pinna.frondruntime.dev/docs/effect/equality.md): what `equals` counts as an unchanged row.
