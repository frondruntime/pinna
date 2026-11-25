/** pinna's `Stage` module, with `Stage.scoped`, a stage for the length of an Effect program's section. */
import { Stage as PlainStage, type StageModule as PlainStageModule } from "@frondruntime/pinna";
import { withStage } from "../stage.ts";

/** A stage: writes held apart from the realm until it is applied. */
export type Stage = PlainStage;

export interface StageModule extends PlainStageModule {
  /** Applies the stage when the section succeeds and drops it otherwise. */
  readonly scoped: typeof withStage;
}

export const Stage: StageModule = { ...PlainStage, scoped: withStage };
