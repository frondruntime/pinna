/** `Atom`: an atom's module. `Atom.make(realm)` makes one. */
import { atom, type atomKind } from "../box.ts";

/**
 * State kept outside Pinna. Code that reads that state calls `read($atom)`,
 * and code that changes it calls `write.changed($atom)` inside `Realm.update`; a
 * rolled-back update still reruns what observed it once. An atom has no
 * value of its own.
 */
export interface Atom {
  readonly [atomKind]: true;
}

export interface AtomModule {
  /** Makes an atom in `realm`. */
  readonly make: typeof atom;
}

export const Atom: AtomModule = { make: atom };
