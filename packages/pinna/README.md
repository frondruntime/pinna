# @frondruntime/pinna

Reactive state with explicit reads: boxes, computed values, keyed
collections, atomic updates, and watchers. A box checks nothing, and the
package imports nothing from Effect. For boxes that check an Effect Schema,
use `@frondruntime/pinna-effect`; for React, `@frondruntime/pinna-react`.

0.2.0 is a pre-1.0 release: any version may change the API.

## Install

```bash
bun add @frondruntime/pinna
```

## Example

```ts
import { Box, Computed, Realm } from "@frondruntime/pinna";

const realm = Realm.make();
const $count = Box.make(realm, 0, { name: "count" });
const $double = Computed.make(realm, (read) => read($count) * 2, { name: "double" });

Realm.update(realm, (read, write) => {
  write($count, read($count) + 1);
});

const double = Realm.untracked(realm, (read) => read($double)); // 2
```

## Exports

| Entry | Exports |
| --- | --- |
| `@frondruntime/pinna` | `Realm.make`, `Box.make`, `Computed.make`, `Computed.fn`, `Atom.make`, `Collection.make`, `Realm.update`, `Realm.untracked`, `Realm.watch`, `Realm.autorun`, `Source.observe`, `Source.onObserved`, `Collection.onRowChange`, `Realm.isTracking`, `Source.inspect`, `Collection.reconcile`, `Model`; the types `Atom`, `Box`, `Collection`, `CollectionOptions`, `Computed`, `Draft`, `Equals`, `Inspection`, `ValueOptions`, `Read`, `Realm`, `RealmOptions`, `ReconcileOptions`, `RowChange`, `RowListener`, `UpsertOptions`, `Write` |
| `@frondruntime/pinna/testing` | `testRealm`, `record`, `held`, `retainedKeys` |
| `@frondruntime/pinna/internal` | What `pinna-effect` and `pinna-react` build on; not for applications |

`AGENTS.md`, shipped in this package, holds the rules for agents that write
applications on Pinna.

## Documentation

<https://pinna.frondruntime.dev/docs/start>
