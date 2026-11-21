/**
 * `withStage`: a stage for the length of an Effect program. The program's
 * section stages its writes; when it succeeds the stage is applied, and when
 * it fails, dies, or is interrupted the stage is dropped, so nothing it
 * staged reaches the realm or the parent stage. Over a stage, it is a
 * savepoint: a section that fails and is caught leaves the parent as it was,
 * and each attempt of an `Effect.retry` opens a fresh one.
 */
import {
  applyStage,
  dropStage,
  openStage,
  type Realm,
  type Stage,
  StageConflictError,
  type StageOptions,
} from "@frondruntime/pinna";
import { Data, Effect } from "effect";

/**
 * A stage opened with `{ conflicts: "fail" }` found that what it read changed
 * in the realm before it was applied, so nothing landed. Recoverable: catch
 * it with `Effect.catchTag("StageConflict", ...)`, or rerun the section with
 * `Effect.retry`, which reads the new values.
 */
export class StageConflict extends Data.TaggedError("StageConflict")<{
  /** The stage's name, when it has one. */
  readonly stage: string | undefined;
  /** The name of each box that changed, or `"<anonymous>"`; a collection is `"a collection"`. */
  readonly changed: ReadonlyArray<string>;
  /** The boxes and collections that changed. */
  readonly observables: ReadonlyArray<object>;
}> {}

/**
 * Runs `section` with a new stage over `over`, a realm or a stage, made with
 * `options`. On success the stage is applied and the section's value
 * returned; on failure, a defect, or interruption, the stage is dropped and
 * the section's outcome stands. A conflict on applying fails with
 * `StageConflict`; any other throw from the apply, such as a recipe that
 * throws on replay, is a defect. The release drops whether or not the stage
 * applied, which does nothing to a closed stage.
 */
export const withStage = <A, E, R>(
  over: Realm | Stage,
  section: (stage: Stage) => Effect.Effect<A, E, R>,
  options?: StageOptions,
): Effect.Effect<A, E | StageConflict, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => openStage(over, options)),
    (stage) =>
      Effect.flatMap(section(stage), (value) =>
        Effect.suspend((): Effect.Effect<A, StageConflict> => {
          try {
            applyStage(stage);
          } catch (error) {
            if (error instanceof StageConflictError) {
              return Effect.fail(
                new StageConflict({
                  stage: error.stage,
                  changed: error.changed,
                  observables: error.observables,
                }),
              );
            }
            return Effect.die(error);
          }
          return Effect.succeed(value);
        }),
      ),
    (stage) => Effect.sync(() => dropStage(stage)),
  );
