# Updates: Stages

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/state/updates.md, its section "Stages".

## Stages

A stage holds back the writes of asynchronous work until it succeeds:
`Stage.apply` lands them in one update, and `Stage.drop` discards them. Until
then no box changes, so nothing renders a half-done result and a failure
leaves nothing to undo. A write meant to show before the work succeeds
goes in a visible stage ([Visible stages](visible-stages.md#visible-stages)).

```ts
import { Box, Realm } from "@frondruntime/pinna";

const realm = Realm.make();
const $balance = Box.make(realm, 100);
const $status = Box.make<"idle" | "sent">(realm, "idle");
```

```ts
import { Stage } from "@frondruntime/pinna";

const transfer = async (amount: number, send: (amount: number) => Promise<void>) => {
  const stage = Stage.make(realm, { name: "transfer" });
  try {
    Stage.update(stage, (read, write) => {
      write($balance, read($balance) - amount);
      write($status, "sent");
    });
    // Until applyStage, $balance and $status keep their values and nothing reruns.
    await send(amount);
    Stage.apply(stage);
  } finally {
    // Does nothing once applied: a failure anywhere above leaves nothing behind.
    Stage.drop(stage);
  }
};
```

A read through the stage sees the stage's own writes everywhere: a box, a
collection's `keys`, `rows`, `row`, and `read.row`, and a computed value,
which the stage evaluates over its own values. A refetch stages
`write.replaceAll` and decides on the result before anything shows.

```ts
import { Collection, Computed, Stage } from "@frondruntime/pinna";

interface Line {
  readonly sku: string;
  readonly price: number;
}

const $lines = Collection.make<string, Line>(realm, { keyOf: (line) => line.sku });
const $total = Computed.make(realm, (read) =>
  read($lines.rows).reduce((total, line) => total + line.price, 0),
);

const refetch = async (load: () => Promise<ReadonlyArray<Line>>) => {
  const stage = Stage.make(realm);
  try {
    const lines = await load();
    Stage.update(stage, (read, write) => {
      write.replaceAll($lines, lines);
      // The stage reads its own rows: $total here is the refetched total.
      if (read($total) > 1000) {
        write($status, "idle");
      }
    });
    Stage.apply(stage);
  } finally {
    Stage.drop(stage);
  }
};
```

`Stage.realmRead` reads what the realm holds, to compare it with the stage.

```ts
import { Stage } from "@frondruntime/pinna";

const pendingDebit = (stage: Stage): number =>
  Stage.realmRead(stage, (read) => read($balance)) - Stage.read(stage, (read) => read($balance));
```

A function that hands back a change returns a `UpdateRecipe`, which `Realm.update` and
`Stage.update` both run.

```ts
import { Box, Model, Realm, type UpdateRecipe } from "@frondruntime/pinna";

class Cart extends Model.Class {
  readonly $count = Box.make(this.realm, 0);

  // A change handed back as a Recipe runs in an update or in a stage alike.
  add(amount: number): UpdateRecipe {
    return (read, write) => write(this.$count, read(this.$count) + amount);
  }
}

const cart = new Cart(realm);
Realm.update(realm, cart.add(1));
```

A recipe runs once when staged and once per `Stage.apply` along its path
through parent stages to the realm. Row listeners run for each change on
each run. Root replay runs in a fresh overlay over the realm's current values under the same
recipe guard, then one update lands the final state without user code in
its recipe. Anything it creates, an id, a time, a model, is made outside it
and closed over, so all
runs land the same thing.

```ts
import { Collection, Stage } from "@frondruntime/pinna";

const $orders = Collection.make<string, { readonly id: string; readonly at: number }>(realm, {
  keyOf: (order) => order.id,
});

const placeOrder = (stage: Stage) => {
  // Made outside the recipe: the recipe runs again when the stage is applied,
  // and a new id or time there would land a different order than the one staged.
  const order = { id: crypto.randomUUID(), at: Date.now() };
  Stage.update(stage, (_read, write) => {
    write.upsert($orders, order);
  });
  return order.id;
};
```

A child stage, opened over a stage, is a savepoint: applied, it replays into
its parent; dropped, it leaves the parent as it was.

```ts
import { Box, Stage } from "@frondruntime/pinna";

const $note = Box.make<string | undefined>(realm, undefined);

const transferWithNote = async (amount: number, describe: () => Promise<string>) => {
  const stage = Stage.make(realm);
  try {
    Stage.update(stage, (read, write) => {
      write($balance, read($balance) - amount);
    });
    // A child stage is a savepoint: dropped, it leaves the outer stage as it was.
    const section = Stage.make(stage);
    try {
      // A note that fails to load leaves the transfer to land without one.
      const note = await describe();
      Stage.update(section, (_read, write) => {
        write($note, note);
      });
      Stage.apply(section);
    } catch {
      Stage.drop(section);
    }
    Stage.apply(stage);
  } finally {
    Stage.drop(stage);
  }
};
```

A stage opened with `{ conflicts: "fail" }` refuses to land when something it
read changed in the realm since: a box, a collection, or an atom, read
directly or beneath a computed value. An atom read beneath a computed value
is reported by that value's name.

```ts
import { Box, Stage, StageConflictError } from "@frondruntime/pinna";

const $price = Box.make(realm, 10);

const checkout = (stage: Stage) => {
  Stage.update(stage, (read, write) => {
    write($balance, read($balance) - read($price));
  });
};

const land = (stage: Stage): boolean => {
  try {
    Stage.apply(stage);
    return true;
  } catch (error) {
    // Opened with { conflicts: "fail" }: $price changed since the stage read it.
    if (error instanceof StageConflictError) {
      return false;
    }
    throw error;
  }
};

const priced = Stage.make(realm, { conflicts: "fail" });
checkout(priced);
```

A host that has its own update open lands the stage inside it, and records a
failed replay in the same update.

```ts
import { Box, Realm, Stage } from "@frondruntime/pinna";

const $log = Box.make<ReadonlyArray<string>>(realm, []);

const landWithLog = (stage: Stage, entry: string) => {
  Realm.update(realm, (_read, write) => {
    write.modify($log, (log) => {
      log.push(entry);
    });
    // Nested in this update: watchers see the log entry and the staged writes
    // once, together. A replay that throws undoes only the stage's writes.
    try {
      Stage.apply(stage);
    } catch {
      write.modify($log, (log) => {
        log.push(`${entry} failed`);
      });
    }
  });
};
```

### Rules

- Every call takes the stage first, as `Realm.update` takes the realm. The realm
  keeps no current stage, so `Realm.update` and `read` cost the same with stages
  in use.
- A recipe is a function of its `read`. It runs once when staged and once
  per `Stage.apply` through its parents to the realm, over the destination's
  values at that moment, so an id, a time, or an observable it made would
  differ between runs. Inside a recipe, inside a `Stage.read` function, and
  inside a computed value the stage evaluates, making a box, a computed
  value, a computed function, an atom, a collection, or a model throws, and
  so do `Realm.update` writing the realm, a `read` or a `write` kept from another place,
  `Realm.untracked`, `Realm.watch`, `Realm.autorun`, `Source.observe`, `Source.onObserved`, `Collection.onRowChange`,
  and every stage call. The guard covers the stage's own realm;
  `Realm.update(otherRealm, ...)` runs on every recipe run, and its writes survive
  `Stage.drop`. Pinna has no
  development mode, so these checks run in every build.
- A read through a stage sees the stage's writes; what it did not write
  reads the realm's current value. It is not a snapshot: a box the stage
  did not write can change between two reads with an `await` between them.
  Once a stage writes a collection it holds that collection's rows and
  order, so the two agree.
- A computed value read through a stage runs its own function against the
  stage's `read`, outside the graph: it starts no `Source.onObserved` source, and
  a value nothing observes reads what its boxes hold. The result is cached
  on the stage until the stage, a parent stage, or the realm changes.
- A stage writes boxes (`write`, `write.modify`), collections
  (`write.upsert`, `write.remove`, `write.replaceAll`), and atoms
  (`write.changed`, which reruns observers when the stage is applied). A
  collection write keeps a row equal to the one held, merges a refetched
  `Model.Schema` into the held instance, and runs `Collection.onRowChange` listeners
  with the stage's `read` and `write`, as in an update.
- A schema box or a schema collection checks a staged write at
  `Stage.update`, so the work learns of a refused value where it wrote it,
  and during each `Stage.apply`'s guarded replay. Landing skips the check
  already performed by that same box or collection.
- `Stage.apply` replays over the realm's values when it runs. By default it
  does not detect a conflict: a stage that added 2 to a box at 1 lands 7
  when another update moved the box to 5. With `{ conflicts: "fail" }` it
  throws a `StageConflictError` instead and lands nothing, when a box or
  collection the stage read, directly or through a computed value, changed
  since. A `write.modify` counts as a read of its box when its base comes
  from the realm, as `read` does. A box or collection the stage wrote
  without reading counts too: under `"fail"` the first writer wins, so a
  change underneath a blind write is a conflict, not a silent overwrite.
  Under `"replay"` that box is the last writer's. Reading two different versions of one box or collection
  conflicts even if a rollback restores the first version.
- `Stage.apply` replays into a fresh overlay, then lands its final box
  values, collection rows and order, and atom marks in one update, nested
  in an update already open. Row listeners run during replay, once per
  change; landing does not call them again. A replay throw, including a
  refused write, discards the overlay without changing the realm and
  reaches the caller; the caller's update keeps its own writes if it
  catches it. Several stages in one update land in apply order. Final
  values equal to the realm's values change no version and notify nobody.
  If an enclosing update rolls back the landing, the stage reads
  `"dropped"`; stage the work again in a new stage. An empty journal stays
  `"applied"`, since it had no landing to undo.
- A stage closes once, `"applied"` or `"dropped"`, and `Stage.status` says
  which. A conflict or a replay throw drops it. A `Stage.apply` precondition
  failure, such as an open child or a call inside a recipe or computed
  value, leaves it open. After closing, `Stage.status` and `Stage.inspect`
  remain callable outside a recipe; `Stage.drop` does nothing, so a `finally`
  drops whether or not the work applied. Every other stage call throws
  `StageClosedError`. A `read` or a `write` kept past its recipe throws.
- Watch effects and autoruns settle after landing. Their errors go to
  `onError` and the stage stays `"applied"`.
- A child stage reads through its parent. `Stage.apply` replays it into the
  parent as one `Stage.update`, and a throw leaves the parent as it was. A
  parent with an open child does not apply; dropping the parent drops its
  children.
- A hidden stage's values are not observable. Nothing subscribes to them, and
  `Stage.read` and `Stage.realmRead` throw in a computed value, a watch's select,
  or a selector, which would go stale on them. `Stage.update` and
  `Stage.apply` throw there as `Realm.update` does.
- A stage left open holds its overlay until it is collected. A test realm's
  dispose reports it as `stage "name" still running`, and drops it
  ([Testing](https://pinna.frondruntime.dev/docs/guides/testing.md)). `Stage.inspect` reports its name,
  parent, status, and what it holds.
