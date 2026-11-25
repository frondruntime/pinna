import { describe, expect, test } from "bun:test";
import {
  _isComputingDerivation,
  createAtom,
  type IAtom,
  autorun as mobxAutorun,
  computed as mobxComputed,
  runInAction,
} from "mobx";
import { Atom, Computed, type Read, Realm, Source } from "../../../src/index.ts";

/**
 * An application's `createAtom`, `IAtom`, and `_isComputingDerivation` uses,
 * beside `Atom.make`, `Source.onObserved`, and `Realm.isTracking`:
 *
 * - live demand: an atom whose first observer starts a stream and whose last
 *   observer stops it, and which outside a derivation tells its caller so;
 * - resource lifecycle: an atom observed only when the read is tracked, and
 *   changed when the resource's lifecycle moves.
 */

// The stream starts with the first reader and stops with the last; a change
// reruns the reader; an untracked read starts nothing.
//
// The order differs: MobX starts the hook inside `reportObserved`, during the
// reader's first run, and Pinna once that run's reads are linked, after it. The
// application's live demand only sets a flag and queues a refresh in the hook,
// so the order does not reach it.
const demandTrace = { hooks: ["observed", "unobserved"], runs: 2, outside: false };

describe("createAtom for live demand", () => {
  test("MobX: onBecomeObserved and onBecomeUnobserved callbacks, and reportObserved's answer", () => {
    const hooks: Array<string> = [];
    const atom: IAtom = createAtom(
      "live demand",
      () => hooks.push("observed"),
      () => hooks.push("unobserved"),
    );
    const outside = atom.reportObserved();
    let runs = 0;
    const stop = mobxAutorun(() => {
      atom.reportObserved();
      runs++;
    });
    runInAction(() => {
      atom.reportChanged();
    });
    stop();
    expect({ hooks, runs, outside }).toEqual(demandTrace);
  });

  test("Pinna: atom with an onObserved hook, and isTracking for the answer", () => {
    const realm = Realm.make();
    const hooks: Array<string> = [];
    const $atom = Atom.make(realm);
    Source.onObserved($atom, () => {
      hooks.push("observed");
      return () => hooks.push("unobserved");
    });
    Realm.untracked(realm, (read) => read($atom));
    const outside = Realm.isTracking(realm);
    let runs = 0;
    const stop = Realm.autorun(realm, (read) => {
      read($atom);
      runs++;
    });
    Realm.update(realm, (_read, write) => {
      write.changed($atom);
    });
    stop();
    expect({ hooks, runs, outside }).toEqual(demandTrace);
  });
});

// Only tracked reads observe the lifecycle, and its change reruns the reader
// once.
//
// The compute count differs. Pinna computes the derived value once more when
// it gains its first observer: nothing observed the atom during the first
// run, so its version may have moved unseen (`packages/pinna-core/src/graph.ts`, the
// `refresh` note on sources). MobX computes it once.
const lifecycleTrace = { untracked: [false], runs: 2 };

/** Splits the tracking answers into the first, untracked read and the rest. */
const split = (tracking: ReadonlyArray<boolean>) => ({
  untracked: tracking.slice(0, 1),
  tracked: tracking.slice(1).every((value) => value),
});

describe("_isComputingDerivation and a lifecycle atom", () => {
  test("MobX: observes the lifecycle only inside a derivation", () => {
    const lifecycle = createAtom("resource lifecycle");
    const tracking: Array<boolean> = [];
    const read = () => {
      tracking.push(_isComputingDerivation());
      if (_isComputingDerivation()) {
        lifecycle.reportObserved();
      }
    };
    read();
    let computes = 0;
    const derivation = mobxComputed(() => {
      read();
      computes++;
      return computes;
    });
    let runs = 0;
    const stop = mobxAutorun(() => {
      derivation.get();
      runs++;
    });
    runInAction(() => {
      lifecycle.reportChanged();
    });
    stop();
    const { untracked, tracked } = split(tracking);
    expect({ untracked, runs }).toEqual(lifecycleTrace);
    expect(tracked).toBe(true);
    expect(computes).toBe(2);
  });

  test("Pinna: isTracking", () => {
    const realm = Realm.make();
    const lifecycle = Atom.make(realm);
    const tracking: Array<boolean> = [];
    const touch = (read?: Read) => {
      tracking.push(Realm.isTracking(realm));
      if (read !== undefined && Realm.isTracking(realm)) {
        read(lifecycle);
      }
    };
    touch();
    let computes = 0;
    const derivation = Computed.make(realm, (read) => {
      touch(read);
      computes++;
      return computes;
    });
    let runs = 0;
    const stop = Realm.autorun(realm, (read) => {
      read(derivation);
      runs++;
    });
    Realm.update(realm, (_read, write) => {
      write.changed(lifecycle);
    });
    stop();
    const { untracked, tracked } = split(tracking);
    expect({ untracked, runs }).toEqual(lifecycleTrace);
    expect(tracked).toBe(true);
    // Linking never runs a compute, so the autorun's link adds none.
    expect(computes).toBe(2);
  });
});
