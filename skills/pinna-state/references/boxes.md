# Boxes and computed

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/state/boxes.md.

Sections: Example, Rules, Answers, Constructor inputs, See also.

## Example

A box is observable state. Its name starts with `$`.

```ts
import { Box, Realm } from "@frondruntime/pinna";

const realm = Realm.make();

const $price = Box.make(realm, 10, { name: "price" });
const $tags = Box.make(realm, ["sale"], { name: "tags" });
```

A write equal to the current value notifies nobody. A box compares with
`Object.is`, so a new array or object counts as a change. `{ equals }`
replaces the comparison. To check every write against a schema, use
[Schema-checked boxes](https://pinna.frondruntime.dev/docs/effect/boxes.md).

```ts
import { Box } from "@frondruntime/pinna";

// A write within a cent of the current value notifies nobody.
const $total = Box.make(realm, 0, {
  equals: (previous, next) => Math.abs(previous - next) < 0.01,
});
```

A computed value is derived from what its function reads. It recomputes only
when one of those changes.

```ts
import { Computed } from "@frondruntime/pinna";

const $count = Computed.make(realm, (read) => read($tags).length, { name: "count" });

// A computed value reads other computed values the same way.
const $label = Computed.make(realm, (read) => `${read($count)} tags at ${read($price)}`);
```

`Computed.fn` makes a computed value per argument, for a value that
depends on an argument.

```ts
import { Computed } from "@frondruntime/pinna";

const hasTag = Computed.fn(realm, (read, tag: string) => read($tags).includes(tag));

// While something observes hasTag("sale"), a call with "sale" returns that same
// computed value; nothing observes this one, so a later call makes a new one.
const $onSale = hasTag("sale");
```

A model groups boxes, computed values, and the methods that write them. A
class that extends `Model` checks nothing, takes its realm in the constructor,
and gives field initializers `this.realm`. A write goes through a method that
calls `Realm.update`.

```ts
import { Box, Computed, Model, Realm } from "@frondruntime/pinna";

// A model groups boxes and the methods that write them. `Model` checks
// nothing and gives field initializers `this.realm`.
class Basket extends Model.Class {
  readonly $quantity = Box.make(this.realm, 1, { name: "quantity" });
  readonly $unitPrice = Box.make(this.realm, 10, { name: "unitPrice" });
  readonly $total = Computed.make(
    this.realm,
    (read) => read(this.$quantity) * read(this.$unitPrice),
  );

  add(count: number): void {
    Realm.update(this.realm, (read, write) => write(this.$quantity, read(this.$quantity) + count));
  }
}

const basket = new Basket(realm);
basket.add(2);
```

## Rules

- A box holds plain data: numbers, strings, arrays, and plain objects. Its
  type is the value's own, not made `readonly`, so a change in place
  type-checks and reaches no watcher. A box is written whole, so a
  finer-grained update is more boxes, or a [collection](collections.md) of
  rows by key.
- A computed value only reads. A write, a `Realm.watch`, a `Realm.autorun`, a
  `Source.observe`, or a release throws while it computes. Its `equals` is part of
  the compute and never does any of them either.
- A computed value that throws keeps the error and throws it to each read,
  until a source it read changes.
- While observed, a computed value stays linked to what it read. Unobserved,
  it holds no links, and a read checks its sources first.
- A `Computed.fn` compares arguments by identity, one per position.
  While nothing observes an entry, it is dropped, and the next call makes a
  new one. Two entries made for the same arguments before either was
  observed are both kept while observed: a call returns the first, and once
  it is released, the second, so a call never returns a new entry while one
  for its arguments is observed.
- A model with no schema extends `Model`, from `@frondruntime/pinna`. With
  Effect, a model is a `Model.Schema`: see [Classes](https://pinna.frondruntime.dev/docs/effect/classes.md).
  There is no third form, such as a function that returns boxes: a draft
  leaves an instance of either class read-only, and a plain object of boxes
  it would draft.
- `{ name }` is for tools: `Source.inspect` reports it, and a named computed value's
  errors name it. An empty name throws.

## Answers

| Call | Answers |
| --- | --- |
| `Box.make(realm, initial, { name?, equals? })` | A box. `equals` defaults to `Object.is`. |
| `Computed.make(realm, (read) => ..., { name?, equals? })` | A computed value. `equals` defaults to `Object.is`. |
| `Computed.fn(realm, (read, ...args) => ..., options?)` | A function from arguments to a computed value, shared while observed. |
| `class X extends Model` | A model that checks nothing. `new X(realm)` makes one; field initializers read `this.realm`. |
| `read($x)` | The value, inside a computed value, a computed function, a watch's select, an autorun, `useSelect`, an update, or `Realm.untracked`. An atom reads as `undefined`. |
| `read.row($collection, key)` | The row under `key`, or `undefined`: see [Collections](collections.md). |
| `Read` | The type of `read`, for a function that takes it: `(read: Read) => ...`. |
| `Realm.isTracking(realm)` | `true` while reads are tracked: in a computed value, a watch's select, or an autorun. `false` in an update, `Realm.untracked`, a watch's effect, and a hook. |

## Constructor inputs

A model's field initializers run when `Model`'s constructor returns, before
the subclass's own constructor sets its parameter properties. An initializer
reads `this.realm`, which `Model` has set. A computed value's function runs on
its first read, which comes after the constructor unless the constructor
itself reads the value, so it reads a parameter property such as
`this.title` too.

What matters is where `this.title` is read. Inside a function, such as the
computed value's own or an `equals` written in place, it is read when the
function runs, after the constructor. As a value passed when the field is
made, such as a computed value's `name`, a box's initial value, or an
`equals` that is itself a parameter property, it is read at once. A field
initializer that reads it there does not compile, with
`TS2729: Property 'title' is used before its initialization`, and at run time
it reads `undefined`. That field is declared with its type and made in the
constructor body, after `super`, where the parameter is set.

```ts
import { Box, Computed, Model, Realm } from "@frondruntime/pinna";

class Shelf extends Model.Class {
  readonly $count = Box.make(this.realm, 0);
  // An option is read as the computed value is made. A field initializer runs
  // before `title` is set, so this field is made in the constructor body.
  readonly $label: Computed<string>;

  constructor(
    realm: Realm,
    readonly title: string,
  ) {
    super(realm);
    // The function runs on the first read, after the constructor, so a field
    // initializer's function may read `this.title` too.
    this.$label = Computed.make(realm, (read) => `${this.title}: ${read(this.$count)}`, {
      name: `${title}.label`,
    });
  }
}

const shelf = new Shelf(realm, "Books");
```

## See also

- [Updates](https://pinna.frondruntime.dev/docs/state/updates.md): writing boxes.
- [Collections](collections.md): rows by key, tracked row by row.
- [Lifecycles](https://pinna.frondruntime.dev/docs/state/lifecycles.md): what observing a value starts and keeps.
- [Schema-checked boxes](https://pinna.frondruntime.dev/docs/effect/boxes.md): a box that checks every write against a schema.
- [Equality and hashing](https://pinna.frondruntime.dev/docs/effect/equality.md): what a box of each kind counts as the same value.
- [Classes](https://pinna.frondruntime.dev/docs/effect/classes.md): boxes and computed values as fields of a model.
