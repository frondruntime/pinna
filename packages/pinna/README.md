# @frondruntime/pinna

Reactive state with explicit reads: boxes, computed values, keyed
collections, atomic updates, and watchers. A box checks nothing, and the
package imports nothing from Effect. For boxes that check an Effect Schema,
use `@frondruntime/pinna-effect`; for React, `@frondruntime/pinna-react`.

0.0.1 is a pre-1.0 release: any version may change the API.

## Install

```bash
bun add @frondruntime/pinna
```

## Example

```ts
import { box, computed, createRealm, untracked, update } from "@frondruntime/pinna";

const realm = createRealm();
const $count = box(realm, 0, { name: "count" });
const $double = computed(realm, (read) => read($count) * 2, { name: "double" });

update(realm, (read, write) => {
  write($count, read($count) + 1);
});

const double = untracked(realm, (read) => read($double)); // 2
```

## Exports

| Entry | Exports |
| --- | --- |
| `@frondruntime/pinna` | `createRealm`, `box`, `computed`, `computedFunction`, `atom`, `collection`, `update`, `untracked`, `watch`, `autorun`, `observe`, `onObserved`, `onRowChange`, `isTracking`, `inspect`, `reconcile`, `Model`; the types `Atom`, `Box`, `Collection`, `CollectionOptions`, `Computed`, `Draft`, `Equals`, `Inspection`, `Options`, `Read`, `Realm`, `RealmOptions`, `ReconcileOptions`, `RowChange`, `RowListener`, `UpsertOptions`, `Write` |
| `@frondruntime/pinna/testing` | `testRealm`, `record`, `held`, `retainedKeys` |
| `@frondruntime/pinna/internal` | What `pinna-effect` and `pinna-react` build on; not for applications |

`AGENTS.md`, shipped in this package, holds the rules for agents that write
applications on Pinna.

## Documentation

<https://pinna.frondruntime.dev/docs/start>
