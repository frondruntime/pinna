/**
 * `Stage`: a stage's module. `Stage.make(realm or stage, options)` opens one;
 * its writes land whole in `Stage.apply`, or never after `Stage.drop`.
 */
import {
  applyStage,
  dropStage,
  inspectStage,
  openStage,
  realmRead,
  type stageBrand,
  stageRead,
  stageStatus,
  stageUpdate,
} from "../stage.ts";

/**
 * Writes held back from the realm until `Stage.apply` lands them, or
 * `Stage.drop` discards them. Made by `Stage.make`, over a realm or over
 * another stage; closes once.
 */
export interface Stage {
  readonly [stageBrand]: true;
}

export interface StageModule {
  /** Opens a stage over a realm, or a child stage over a stage. */
  readonly make: typeof openStage;
  /** Runs `recipe` against the stage, keeping it for the replay. */
  readonly update: typeof stageUpdate;
  /** Reads through the stage: its own writes, and the realm's values elsewhere. */
  readonly read: typeof stageRead;
  /** Reads the realm's values, ignoring the stage. */
  readonly realmRead: typeof realmRead;
  /** Replays the stage's recipes and lands them in one update. */
  readonly apply: typeof applyStage;
  /** Closes the stage and its children, discarding them. */
  readonly drop: typeof dropStage;
  /** `"open"`, `"applied"`, or `"dropped"`. */
  readonly status: typeof stageStatus;
  /** What the stage wrote and read, by name. */
  readonly inspect: typeof inspectStage;
}

export const Stage: StageModule = {
  make: openStage,
  update: stageUpdate,
  read: stageRead,
  realmRead,
  apply: applyStage,
  drop: dropStage,
  status: stageStatus,
  inspect: inspectStage,
};
