// The site's docs print the regions of this file (docs/public/state/updates.md, "Stages"),
// so `bun run typecheck` compiles what the page shows.
import {
  applyStage,
  box,
  createRealm,
  dropStage,
  openStage,
  realmRead,
  type Stage,
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
  const stage = openStage(realm);
  try {
    stageUpdate(stage, (read, write) => {
      write($balance, read($balance) - amount);
      write($status, "sent");
    });
    // Until applyStage, $balance and $status keep their values and nothing reruns.
    await send(amount);
  } catch (error) {
    dropStage(stage);
    throw error;
  }
  // Outside the try: applyStage closes the stage even when it throws, and a
  // dropStage after it would throw over the first error.
  applyStage(stage);
};
// #endregion

// #region compare
const pendingDebit = (stage: Stage): number =>
  realmRead(stage, (read) => read($balance)) - stageRead(stage, (read) => read($balance));
// #endregion

// #region join
const $log = box<ReadonlyArray<string>>(realm, []);

const land = (stage: Stage, entry: string) => {
  update(realm, (_read, write) => {
    write.modify($log, (log) => {
      log.push(entry);
    });
    // Joins this update: watchers see the log entry and the staged writes once, together.
    applyStage(stage);
  });
};

// #endregion

export { land, pendingDebit, transfer };
