# Indexes and sets

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/guides/row-indexes.md.

Sections: Example, Rules, See also.

## Example

A sorted, filtered order, the keys of each group, and a total per group are
[views](views.md): `View.ordered`, `View.grouped`, and
`View.totals`. Each structure on this page takes a few lines over the calls
on [Collections](collections.md), and no view covers it.
`Collection.onRowChange` keeps a structure in step with a collection a row
at a time. The samples share one collection of orders, with amounts in
whole cents.

```ts
import { Collection, Realm } from "@frondruntime/pinna";

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
```

A set of keys is a collection keyed by the key itself. `read.row` tracks
one key, so a row that asks whether it is selected reruns only when its own
key joins or leaves the set. An array in a box reruns every such reader on
each change, and each one scans the array.

```ts
import { Collection, Computed, Realm } from "@frondruntime/pinna";

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
```

A value per key that no view keeps, such as the latest time each customer
ordered, is one box per key, made on the first ask. A map of values in one
box copies every value on each change and reruns every reader of every key.

```ts
import { Box, Realm } from "@frondruntime/pinna";

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
```

A listener fills those boxes a row at a time.

```ts
import { Collection } from "@frondruntime/pinna";

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
```

A graph is a collection of edges with two indexes, `View.grouped` by source
and by target. A walk over it, such as every key reachable from one key, is
a function that reads them, run in a `Computed.make` or an update, and reruns in
full on each change it reads. Rows kept in sorted order are a
[`View.ordered`](views.md).

## Rules

- Keep what a listener builds in boxes and collections, so a failed write
  puts it back with the row ([Collections](collections.md)).
- Skip a report that leaves a value as it was. A write of an equal value
  still costs the listener its work.
- A `Computed.make` over `rows` derives the same values with no listener, and
  reruns over every row on each change. It fits a collection that is small
  or rarely written.

## See also

- [Views](views.md): a sorted, filtered order, the keys of each group, and a total per group.
- [Collections](collections.md): `Collection.onRowChange`, `read.row`, and what each write reports.
- [Updates](https://pinna.frondruntime.dev/docs/state/updates.md): the update a listener runs in, and what a failed one puts back.
- [Collection fields](https://pinna.frondruntime.dev/docs/effect/collections.md): a collection as a field of a `Model.Schema`.
