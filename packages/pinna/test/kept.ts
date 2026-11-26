import type { Read, Write } from "../src/index.ts";
import { Realm } from "../src/index.ts";

/**
 * Verbs kept past their place, as a closure or a variable keeps one by
 * mistake. A kept verb checks, when called, that a place of its realm is
 * open: outside one it throws, and inside one it reads or writes as that
 * place's own verb does.
 */

/** The read `Realm.untracked` hands out, kept. */
export const keptRead = (realm: Realm): Read => Realm.untracked(realm, (read) => read);

/** The write an update hands out, kept. */
export const keptWrite = (realm: Realm): Write => {
  const kept: Array<Write> = [];
  Realm.update(realm, (_read, write) => {
    kept.push(write);
  });
  const [write] = kept;
  if (write === undefined) {
    throw new Error("pinna test: update did not run its recipe");
  }
  return write;
};
