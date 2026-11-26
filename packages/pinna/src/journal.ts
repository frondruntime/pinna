/**
 * The journal: what a failed update or a failed stage recipe puts back. One
 * class serves the realm's updates and a stage's recipes; each step names
 * a target and three arguments, and a rollback calls `target.undo` with them,
 * the last step first. A step allocates nothing: the slots live in one array
 * that keeps its storage between uses (Hermes drops it on `length = 0`, and
 * an object per step costs every write).
 */

/** What a step puts back: `undo` gets the three arguments the step kept. */
export interface UndoTarget {
  undo(a: unknown, b: unknown, c: unknown): void;
}

/** A step whose `a` is a function to call: for state no target owns. */
export const runUndo: UndoTarget = {
  undo(a) {
    (a as () => void)();
  },
};

/**
 * The value a map entry holds in a step when the key was missing: restoring
 * it deletes the key. Never a value a caller can hold.
 */
export const missing: unique symbol = Symbol("pinna.missing");

/** A step that puts a map entry back: `a` the map, `b` the key, `c` its value or `missing`. */
export const restoreEntry: UndoTarget = {
  undo(a, b, c) {
    const map = a as Map<unknown, unknown>;
    if (c === missing) {
      map.delete(b);
    } else {
      map.set(b, c);
    }
  },
};

/** A step that takes a value an operation added back out of a set: `a` the set, `b` the value. */
export const deleteMember: UndoTarget = {
  undo(a, b) {
    (a as Set<unknown>).delete(b);
  },
};

/** A step that takes each key of `b` out of the map or set `a`. */
export const deleteMembers: UndoTarget = {
  undo(a, b) {
    const container = a as { delete(key: unknown): unknown };
    for (const key of b as ReadonlyArray<unknown>) container.delete(key);
  },
};

export class Journal {
  /**
   * Four slots a step: the target and its three arguments. Slots past
   * `length` are empty. The realm's `record` and `step` write them
   * directly, as `step` does: a call each write would pay on Hermes.
   */
  readonly slots: Array<unknown> = [];
  /** Four times the number of steps: a savepoint is a length. */
  length = 0;

  step(target: UndoTarget, a: unknown, b: unknown, c: unknown): void {
    const slots = this.slots;
    const end = this.length;
    slots[end] = target;
    slots[end + 1] = a;
    slots[end + 2] = b;
    slots[end + 3] = c;
    this.length = end + 4;
  }

  /**
   * Undoes the steps after `savepoint`, the last first. `before`, when
   * given, runs ahead of each step with the step's `c`: the realm puts back
   * the first records taken after it. A step an undo takes lands where the
   * undone steps began, as if they had been taken out before any ran.
   */
  rollback(savepoint: number, before?: (c: unknown) => void): void {
    const slots = this.slots;
    const end = this.length;
    try {
      for (let index = end - 4; index >= savepoint; index -= 4) {
        if (before !== undefined) before(slots[index + 3]);
        (slots[index] as UndoTarget).undo(slots[index + 1], slots[index + 2], slots[index + 3]);
      }
    } finally {
      const taken = this.length - end;
      for (let index = 0; index < taken; index++) {
        slots[savepoint + index] = slots[end + index];
      }
      const length = savepoint + taken;
      for (let index = length; index < this.length; index++) {
        slots[index] = undefined;
      }
      this.length = length;
    }
  }

  /** Forgets the steps after `savepoint`, so the journal holds no value they replaced. */
  forget(savepoint = 0): void {
    const slots = this.slots;
    if (this.length - savepoint > 256) {
      // A long run of steps, such as a staged `replaceAll`'s one per row:
      // truncating drops them in one step, where clearing writes each slot.
      // A short run keeps the array's storage for the next update.
      slots.length = savepoint;
    } else {
      for (let index = savepoint; index < this.length; index++) {
        slots[index] = undefined;
      }
    }
    this.length = savepoint;
  }
}
