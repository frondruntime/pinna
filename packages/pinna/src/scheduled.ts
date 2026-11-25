/**
 * A watch or an autorun with a scheduler: a reaction the settle tells of each
 * write that reaches it, and that runs when the application's scheduler calls
 * `run`. Every write before that joins one run, which reads the values
 * current when it starts.
 */

import {
  PinnaUsageError,
  placeDeriving,
  placeShadowed,
  placeTracked,
  placeUpdating,
  Reaction,
} from "@frondruntime/pinna-core";
import type { ObservableRealm } from "./realm.ts";

/**
 * Runs `run` later, or at once: the application's choice of timing, such as
 * `(run) => requestAnimationFrame(() => run())`. Pinna ships none and reads
 * no time. A scheduler that calls `run` at once makes a plain watch.
 */
export type Scheduler = (run: () => void) => void;

/**
 * How many runs in a row a scheduled reaction may schedule for its own
 * writes before the run is reported and not scheduled: the round limit of a
 * settle, which a deferred run never reaches.
 */
const maximumOwnRuns = 100;

/**
 * Throws where a scheduled run would read an update's partial state or run
 * inside a tracked read: in an update recipe, a computed value, a watch's
 * select, an autorun's body, or a stage recipe.
 */
const assertAtRest = (owner: ObservableRealm, label: string): void => {
  if ((owner.core.place & (placeUpdating | placeDeriving | placeTracked | placeShadowed)) !== 0) {
    throw new PinnaUsageError(
      "pinna/scheduled-run-not-at-rest",
      `pinna: ${label}'s scheduler called run inside an update, a computed value, a watch's select, an autorun, or a stage recipe, where values are not settled; call run from a frame, a timer, an event handler, or a watch's effect`,
    );
  }
};

/**
 * The machinery of one scheduled watch or autorun. `pass` runs the select or
 * the body through `track` and calls the effect; it runs once in `start`,
 * synchronously, and then once for each call of `run` that finds what it
 * read changed.
 */
export class ScheduledReaction {
  readonly reaction: Reaction;
  /**
   * The schedule whose `run` the scheduler holds and has not called, or
   * `undefined`. Each schedule hands out its own `run`, so a `run` of an
   * earlier schedule never takes a later one's turn.
   */
  private schedule: object | undefined = undefined;
  stopped = false;
  /** Inside `pass`: a notice now came from the run's own write. */
  private running = false;
  private ownRuns = 0;

  constructor(
    private readonly owner: ObservableRealm,
    private readonly scheduler: Scheduler,
    readonly label: string,
    private readonly pass: (reaction: Reaction) => void,
  ) {
    this.reaction = new Reaction(owner.core, this.notify, label, "marked");
  }

  /**
   * Links, then runs the first pass, so its reads are observed as it makes
   * them, as a watch's first run's are. An error is thrown and nothing stays
   * linked.
   */
  start(): void {
    const reaction = this.reaction;
    try {
      // One batch, so a first pass that throws unlinks before the settle and
      // starts no hook, as a watch whose first run throws starts none.
      this.owner.core.batch(() => {
        // Nothing read yet: activating links nothing and finds nothing changed.
        reaction.activate();
        try {
          this.pass(reaction);
        } catch (error) {
          reaction.deactivate();
          throw error;
        }
      });
    } catch (error) {
      // The batch's settle threw, as a hook's write whose scheduler throws
      // does: the caller gets no stop, so nothing stays linked or scheduled.
      this.schedule = undefined;
      this.stopped = true;
      reaction.deactivate();
      throw error;
    }
  }

  /** Unlinks; a pending run then does nothing. Stopping twice does nothing. */
  stop(): void {
    if (this.stopped) {
      return;
    }
    // Unlinked before the flag is set: a stop that throws, as one inside a
    // computed value does, leaves it running and still stoppable.
    this.reaction.deactivate();
    this.stopped = true;
    this.schedule = undefined;
  }

  /** Called by the settle for each write that reaches the reaction. */
  private readonly notify = (): void => {
    if (this.stopped) {
      return;
    }
    // Any notice from outside the run breaks the streak, scheduled or not.
    if (!this.running) {
      this.ownRuns = 0;
    }
    if (this.schedule !== undefined) {
      return;
    }
    if (this.running && ++this.ownRuns >= maximumOwnRuns) {
      // Not scheduled: the next change from outside the run schedules it.
      this.ownRuns = 0;
      this.owner.core.reportAside(
        new PinnaUsageError(
          "pinna/watchers-unsettled",
          `pinna: ${this.label} ran ${maximumOwnRuns} times in a row for its own writes; it runs again at the next change from outside`,
        ),
      );
      return;
    }
    const schedule = {};
    this.schedule = schedule;
    try {
      this.scheduler(() => this.run(schedule));
    } catch (error) {
      if (this.schedule === schedule) {
        this.schedule = undefined;
      }
      throw error;
    }
  };

  /**
   * Runs the reaction for `schedule` if what it read changed. Does nothing
   * once stopped, once its realm is no longer open, or for a schedule
   * already run. A call refused as not at rest leaves the schedule pending,
   * so a later call of the same `run` still runs it. An error goes to the
   * realm's `onError`, except in a settle, where a scheduler that calls
   * `run` at once has it reported as a watch's.
   */
  private run(schedule: object): void {
    if (this.schedule !== schedule) {
      return;
    }
    const owner = this.owner;
    if (this.stopped || owner.status !== "open") {
      this.schedule = undefined;
      return;
    }
    assertAtRest(owner, this.label);
    this.schedule = undefined;
    const core = owner.core;
    const settling = core.depth !== 0;
    this.running = true;
    try {
      if (this.reaction.changed()) {
        this.pass(this.reaction);
      }
    } catch (error) {
      if (settling) {
        throw error;
      }
      core.reportAside(error);
    } finally {
      this.running = false;
    }
  }
}
