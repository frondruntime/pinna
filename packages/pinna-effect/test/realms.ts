import { PinnaUsageError, Realm, type Source } from "../src/index.ts";

type Observable = Parameters<typeof Source.inspect>[0];

/**
 * Whether `realm` made `observable`, asked through the public API: a realm's
 * read throws `pinna/foreign-realm` for an observable another realm made.
 */
export const madeBy = (observable: Observable, realm: Realm): boolean => {
  try {
    Realm.untracked(realm, (read) => read(observable as never));
    return true;
  } catch (error) {
    if (error instanceof PinnaUsageError && error.code === "pinna/foreign-realm") {
      return false;
    }
    throw error;
  }
};
