// The site's docs print the regions of this file (docs/public/state/updates.md, "Stages"),
// so `bun run typecheck` compiles what the page shows.
import {
  applyStage,
  box,
  collection,
  computed,
  createRealm,
  dropStage,
  Model,
  openStage,
  type Recipe,
  realmRead,
  type Stage,
  StageConflictError,
  stageRead,
  stageUpdate,
  update,
} from "@frondruntime/pinna";

// #region setup
const realm = createRealm();
const $balance = box(realm, 100);
const $status = box<"idle" | "sent">(realm, "idle");
// #endregion

// #region stage
const transfer = async (amount: number, send: (amount: number) => Promise<void>) => {
  const stage = openStage(realm, { name: "transfer" });
  try {
    stageUpdate(stage, (read, write) => {
      write($balance, read($balance) - amount);
      write($status, "sent");
    });
    // Until applyStage, $balance and $status keep their values and nothing reruns.
    await send(amount);
    applyStage(stage);
  } finally {
    // Does nothing once applied: a failure anywhere above leaves nothing behind.
    dropStage(stage);
  }
};
// #endregion

// #region compare
const pendingDebit = (stage: Stage): number =>
  realmRead(stage, (read) => read($balance)) - stageRead(stage, (read) => read($balance));
// #endregion

// #region reads
interface Line {
  readonly sku: string;
  readonly price: number;
}

const $lines = collection<string, Line>(realm, { keyOf: (line) => line.sku });
const $total = computed(realm, (read) =>
  read($lines.rows).reduce((total, line) => total + line.price, 0),
);

const refetch = async (load: () => Promise<ReadonlyArray<Line>>) => {
  const stage = openStage(realm);
  try {
    const lines = await load();
    stageUpdate(stage, (read, write) => {
      write.replaceAll($lines, lines);
      // The stage reads its own rows: $total here is the refetched total.
      if (read($total) > 1000) {
        write($status, "idle");
      }
    });
    applyStage(stage);
  } finally {
    dropStage(stage);
  }
};
// #endregion

// #region recipe
class Cart extends Model {
  readonly $count = box(this.realm, 0);

  // A change handed back as a Recipe runs in an update or in a stage alike.
  add(amount: number): Recipe {
    return (read, write) => write(this.$count, read(this.$count) + amount);
  }
}

const cart = new Cart(realm);
update(realm, cart.add(1));
// #endregion

// #region pure
const $orders = collection<string, { readonly id: string; readonly at: number }>(realm, {
  keyOf: (order) => order.id,
});

const placeOrder = (stage: Stage) => {
  // Made outside the recipe: the recipe runs again when the stage is applied,
  // and a new id or time there would land a different order than the one staged.
  const order = { id: crypto.randomUUID(), at: Date.now() };
  stageUpdate(stage, (_read, write) => {
    write.upsert($orders, order);
  });
  return order.id;
};
// #endregion

// #region savepoint
const $note = box<string | undefined>(realm, undefined);

const transferWithNote = async (amount: number, describe: () => Promise<string>) => {
  const stage = openStage(realm);
  try {
    stageUpdate(stage, (read, write) => {
      write($balance, read($balance) - amount);
    });
    // A child stage is a savepoint: dropped, it leaves the outer stage as it was.
    const section = openStage(stage);
    try {
      // A note that fails to load leaves the transfer to land without one.
      const note = await describe();
      stageUpdate(section, (_read, write) => {
        write($note, note);
      });
      applyStage(section);
    } catch {
      dropStage(section);
    }
    applyStage(stage);
  } finally {
    dropStage(stage);
  }
};
// #endregion

// #region conflicts
const $price = box(realm, 10);

const checkout = (stage: Stage) => {
  stageUpdate(stage, (read, write) => {
    write($balance, read($balance) - read($price));
  });
};

const land = (stage: Stage): boolean => {
  try {
    applyStage(stage);
    return true;
  } catch (error) {
    // Opened with { conflicts: "fail" }: $price changed since the stage read it.
    if (error instanceof StageConflictError) {
      return false;
    }
    throw error;
  }
};

const priced = openStage(realm, { conflicts: "fail" });
checkout(priced);
// #endregion

// #region join
const $log = box<ReadonlyArray<string>>(realm, []);

const landWithLog = (stage: Stage, entry: string) => {
  update(realm, (_read, write) => {
    write.modify($log, (log) => {
      log.push(entry);
    });
    // Nested in this update: watchers see the log entry and the staged writes
    // once, together. A replay that throws undoes only the stage's writes.
    try {
      applyStage(stage);
    } catch {
      write.modify($log, (log) => {
        log.push(`${entry} failed`);
      });
    }
  });
};

// #endregion

export {
  $price,
  cart,
  land,
  landWithLog,
  pendingDebit,
  placeOrder,
  priced,
  refetch,
  transfer,
  transferWithNote,
};
