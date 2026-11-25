// The site's docs print the regions of this file (docs/public/state/updates.md, "Stages"),
// so `bun run typecheck` compiles what the page shows.
import {
  Box,
  Collection,
  Computed,
  Model,
  Realm,
  Stage,
  StageConflictError,
  type UpdateRecipe,
} from "@frondruntime/pinna";

// #region setup
const realm = Realm.make();
const $balance = Box.make(realm, 100);
const $status = Box.make<"idle" | "sent">(realm, "idle");
// #endregion

// #region stage
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
// #endregion

// #region compare
const pendingDebit = (stage: Stage): number =>
  Stage.realmRead(stage, (read) => read($balance)) - Stage.read(stage, (read) => read($balance));
// #endregion

// #region reads
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
// #endregion

// #region recipe
class Cart extends Model.Class {
  readonly $count = Box.make(this.realm, 0);

  // A change handed back as a Recipe runs in an update or in a stage alike.
  add(amount: number): UpdateRecipe {
    return (read, write) => write(this.$count, read(this.$count) + amount);
  }
}

const cart = new Cart(realm);
Realm.update(realm, cart.add(1));
// #endregion

// #region pure
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
// #endregion

// #region savepoint
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
// #endregion

// #region conflicts
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
// #endregion

// #region join
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

// #endregion

// #region visible
const $title = Box.make(realm, "Untitled");

const rename = async (title: string, save: (title: string) => Promise<void>) => {
  // Shown at once over the realm's confirmed values; the guess is the answer.
  const stage = Stage.make(realm, { name: "rename", visible: true });
  try {
    Stage.update(stage, (_read, write) => {
      write($title, title);
    });
    await save(title);
    Stage.apply(stage);
  } finally {
    // A failed save takes the guess off the screen: $title shows the confirmed title.
    Stage.drop(stage);
  }
};
// #endregion

// #region settle
interface Item {
  readonly id: string;
  readonly done: boolean;
}

const $items = Collection.make<string, Item>(realm, { keyOf: (item) => item.id, name: "items" });
const $saving = Box.make(realm, false);

const toggle = async (id: string, done: boolean, send: () => Promise<Item>) => {
  const guess = Stage.make(realm, { name: "toggle (guess)", visible: true });
  const answer = Stage.make(realm, { name: "toggle" });
  try {
    Stage.update(guess, (_read, write) => {
      write.upsert($items, { id, done });
      // A pending marker the guess writes: it shows while the guess shows.
      write($saving, true);
    });
    const saved = await send();
    Stage.update(answer, (_read, write) => {
      write.upsert($items, saved);
    });
    // The server's answer wins: one update lands it and takes the guess off,
    // so a watcher runs once, with the settled row.
    Realm.update(realm, () => {
      Stage.apply(answer);
      Stage.drop(guess);
    });
  } finally {
    Stage.drop(answer);
    Stage.drop(guess);
  }
};
// #endregion

// #region stopped
const showFailure = (stage: Stage): string | undefined => {
  const { showing, failure, status } = Stage.inspect(stage);
  // A guess that can no longer apply stops showing and keeps the reason.
  return status === "open" && !showing && failure instanceof Error ? failure.message : undefined;
};

// #endregion

export {
  $items,
  $price,
  $saving,
  $title,
  cart,
  land,
  landWithLog,
  pendingDebit,
  placeOrder,
  priced,
  realm,
  refetch,
  rename,
  showFailure,
  toggle,
  transfer,
  transferWithNote,
};
