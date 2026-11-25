/** pinna's `Realm` module, with its scoped form: `Realm.scoped`. */
import { Realm as PlainRealm, type RealmModule as PlainRealmModule } from "@frondruntime/pinna";
import { createRealmScoped } from "../programs.ts";

/** A realm: the boxes, computed values, and watches that update together. */
export type Realm = PlainRealm;

export interface RealmModule extends PlainRealmModule {
  /** A realm for the length of the caller's scope, disposed when the scope closes. */
  readonly scoped: typeof createRealmScoped;
}

export const Realm: RealmModule = { ...PlainRealm, scoped: createRealmScoped };
