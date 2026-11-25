import { Box, Computed, Source as PinnaSource, Realm, type Write } from "@frondruntime/pinna";
import type { CheckedAdapter, Derived, Library, Source } from "../adapter.ts";

/** Each source and derived value keeps the Pinna observable it reads. */
interface Kept {
  readonly observable: Box<unknown> | Computed<unknown>;
}

/**
 * Pinna through the verbs a place hands out, `read` and `write`. The
 * interface reads through `get` with no verb in hand, so the adapter keeps
 * the read `untracked` hands out and the write an update hands out: a verb
 * checks, when called, that a place of its realm is open, not which place
 * handed it out.
 *
 * Boxes have no schema and every update keeps its rollback journal: the
 * graph as an application gets it.
 */
export const pinna: Library<CheckedAdapter> = {
  name: "pinna",
  package: "@frondruntime/pinna",
  make: () => {
    const realm = Realm.make();
    const read = Realm.untracked(realm, (read) => read);
    const kept: { write?: Write } = {};
    Realm.update(realm, (_read, write) => {
      kept.write = write;
    });
    const write = kept.write;
    if (write === undefined) {
      throw new Error("pinna-bench: update did not run its recipe");
    }
    return {
      box: <Value>(initial: Value): Source<Value> => {
        const $box = Box.make(realm, initial);
        const source: Source<Value> & Kept = {
          get: () => read($box),
          set: (value) => {
            write($box, value);
          },
          observable: $box as Box<unknown>,
        };
        return source;
      },
      computed: <Value>(compute: () => Value): Derived<Value> => {
        const value = Computed.make(realm, compute);
        const derived: Derived<Value> & Kept = {
          get: () => read(value),
          observable: value as Computed<unknown>,
        };
        return derived;
      },
      // `effect` goes to `watch` with no wrapper closure, as MobX's adapter
      // hands it to `reaction`. Pinna's effect type returns `undefined` and
      // the adapter's returns anything, so a conformance case may pass
      // `values.push`; the graph ignores what an effect returns.
      watch: (select, effect) =>
        Realm.watch(realm, select, effect as (value: unknown) => undefined),
      // `run` goes to `update` as its recipe, with no wrapper closure: it
      // ignores the read and write the recipe receives, and every caller's
      // `run` returns nothing.
      update: (run) => Realm.update(realm, run as () => undefined),
      untracked: (run) => Realm.untracked(realm, run),
      onObserved: (observable, start) =>
        PinnaSource.onObserved((observable as Partial<Kept>).observable ?? fail(), start),
    };
  },
};

const fail = (): never => {
  throw new Error("pinna-bench: not an observable of this adapter");
};
