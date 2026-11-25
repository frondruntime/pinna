/**
 * `Stage.scoped`: a stage for the length of an Effect program. The program's
 * section stages its writes; when it succeeds the stage is applied, and when
 * it fails, dies, or is interrupted the stage is dropped, so nothing it
 * staged reaches the realm or the parent stage. An interruption once landing
 * began leaves the stage applied; the exit still contains `Interrupt`.
 * Over a stage, it is a savepoint: a section that fails and is caught leaves
 * the parent as it was,
 * and each attempt of an `Effect.retry` opens a fresh one.
 *
 * With `{ visible: true }` the section's own writes show while it runs, and
 * are applied when it succeeds: the guess is the answer. With
 * `{ guess: recipe }` a visible stage shows `recipe` while the section's
 * writes stay hidden; on success one update applies the section's stage and
 * drops the guess, so the answer wins (ruling 68).
 */
import {
  isPinnaError,
  PinnaUsageError,
  Realm,
  Stage,
  type StageConflictError,
  type StageOptions,
  type UpdateRecipe,
} from "@frondruntime/pinna";
import { Effect } from "effect";

/** How `Stage.scoped` makes its stage over a realm. */
export interface ScopedStageOptions extends StageOptions {
  /**
   * A guess shown while the section runs: a visible stage holds `recipe`,
   * named `"<name> (guess)"`, and the section's own writes stay hidden. On
   * success one update applies the section's stage and drops the guess; on
   * failure or interruption both are dropped. `name` and `conflicts`
   * describe the section's stage; the guess replays. Refused with
   * `visible`, and over a stage.
   */
  readonly guess?: UpdateRecipe;
}

/**
 * The failure a recoverable Pinna error becomes in an Effect program: a
 * thrown `StageConflictError` fails the effect, where `Effect.catchTag` and
 * `Effect.retry` take it. `catchTag` sees failures only, never a throw inside
 * `Effect.sync`. Matched by brand and `_tag`, not `instanceof`, so an error
 * from another copy of Pinna is matched too. Anything else dies.
 */
const failRecoverable = (error: unknown): Effect.Effect<never, StageConflictError> =>
  isPinnaError(error, "StageConflictError") ? Effect.fail(error) : Effect.die(error);

/**
 * A `StageConflictError` the section's own `Stage.update` or `Stage.read`
 * threw, as a stopped visible stage throws it, fails the effect as the one
 * from `Stage.apply` does; `Effect.sync` had made it a defect.
 */
const conflictsFail = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | StageConflictError, R> =>
  Effect.catchDefect(effect, (defect) => failRecoverable(defect));

/** Whether `over` is a realm: `Realm.status` refuses anything else. */
const isRealm = (over: Realm | Stage): over is Realm => {
  try {
    Realm.status(over as Realm);
    return true;
  } catch {
    return false;
  }
};

const guessError = (reason: string): PinnaUsageError =>
  new PinnaUsageError("pinna/stage-visible-option", `pinna: Stage.scoped takes a guess ${reason}`);

/**
 * Runs `section` with a new stage over `over`, a realm or a stage, made with
 * `options`. On success the stage is applied and the section's value
 * returned; on section failure, a defect, or interruption, the stage is
 * dropped and the section's outcome stands. An interruption once landing
 * began leaves the stage applied; the exit still contains `Interrupt`. A
 * conflict on applying a stage over a realm fails with `StageConflictError`,
 * the error pinna throws, and so does one thrown by `Stage.update` or
 * `Stage.read` on the stage inside the section; a child never conflicts,
 * since its root checks what it read. Any other throw from the apply, such
 * as a recipe that throws on replay, is a defect. The release drops whether
 * or not the stage applied, which does nothing to a closed stage.
 *
 * `guess` opens a visible stage beside the section's hidden one (see
 * `ScopedStageOptions`); `guess` with `visible`, or over a stage, dies with
 * `pinna/stage-visible-option`.
 */
export function withStage<A, E, R>(
  over: Realm,
  section: (stage: Stage) => Effect.Effect<A, E, R>,
  options?: ScopedStageOptions,
): Effect.Effect<A, E | StageConflictError, R>;
export function withStage<A, E, R>(
  over: Stage,
  section: (stage: Stage) => Effect.Effect<A, E, R>,
  options?: Omit<StageOptions, "conflicts" | "visible"> & {
    readonly conflicts?: never;
    readonly visible?: never;
    readonly guess?: never;
  },
): Effect.Effect<A, E, R>;
export function withStage<A, E, R>(
  over: Realm | Stage,
  section: (stage: Stage) => Effect.Effect<A, E, R>,
  options?: ScopedStageOptions,
): Effect.Effect<A, E | StageConflictError, R> {
  const guess = options?.guess;
  if (guess !== undefined) {
    return withGuess(over, section, guess, options as ScopedStageOptions);
  }
  return Effect.acquireUseRelease(
    Effect.sync(() => Stage.make(over, options)),
    (stage) =>
      Effect.flatMap(conflictsFail(section(stage)), (value) =>
        Effect.suspend((): Effect.Effect<A, StageConflictError> => {
          try {
            Stage.apply(stage);
          } catch (error) {
            return failRecoverable(error);
          }
          return Effect.succeed(value);
        }),
      ),
    (stage) => Effect.sync(() => Stage.drop(stage)),
  );
}

/** The answer wins: a visible guess beside the section's hidden stage, settled in one update. */
const withGuess = <A, E, R>(
  over: Realm | Stage,
  section: (stage: Stage) => Effect.Effect<A, E, R>,
  guess: UpdateRecipe,
  options: ScopedStageOptions,
): Effect.Effect<A, E | StageConflictError, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      if (options.visible !== undefined) {
        throw guessError("or visible, not both: a stage is the guess or the answer");
      }
      if (!isRealm(over)) {
        throw guessError("over a realm alone: a child stage is a savepoint and shows nothing");
      }
      const realm = over;
      const shown = Stage.make(realm, {
        name: options.name === undefined ? "guess" : `${options.name} (guess)`,
        visible: true,
      });
      try {
        Stage.update(shown, guess);
        const answer = Stage.make(realm, {
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(options.conflicts === undefined ? {} : { conflicts: options.conflicts }),
        });
        return { realm, shown, answer };
      } catch (error) {
        Stage.drop(shown);
        throw error;
      }
    }),
    ({ realm, shown, answer }) =>
      Effect.flatMap(conflictsFail(section(answer)), (value) =>
        Effect.suspend((): Effect.Effect<A, StageConflictError> => {
          let failure: unknown;
          let failed = false;
          Realm.update(realm, () => {
            try {
              Stage.apply(answer);
            } catch (error) {
              failed = true;
              failure = error;
            } finally {
              Stage.drop(shown);
            }
          });
          return failed ? failRecoverable(failure) : Effect.succeed(value);
        }),
      ),
    ({ shown, answer }) =>
      Effect.sync(() => {
        Stage.drop(answer);
        Stage.drop(shown);
      }),
  );
