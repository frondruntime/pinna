/**
 * `Source`: the functions on any observable, a box, a computed value, or an
 * atom, which take the observable first and no realm.
 */
import { inspect } from "../box.ts";
import { observe, onObserved } from "../realm.ts";
import { peekOutside } from "../verbs.ts";

export interface SourceModule {
  /** Reads one box or computed value without tracking; throws where reads are tracked or staged. */
  readonly peek: typeof peekOutside;
  /** Keeps the observable observed until the returned function is called. */
  readonly observe: typeof observe;
  /** Runs `start` while the observable is observed, and its cleanup when it stops. */
  readonly onObserved: typeof onObserved;
  /** What the observable read, how many observe it, and why it last recomputed. */
  readonly inspect: typeof inspect;
}

export const Source: SourceModule = { peek: peekOutside, observe, onObserved, inspect };
