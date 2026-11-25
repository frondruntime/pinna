import { describe, expect, test } from "bun:test";
import { Atom, Box, Computed, Realm, Source } from "../src/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * A value one write reaches, a value written back within one update, and a
 * computed value over an atom, through the public API. The public twin of
 * the "a value one write reaches directly", "restore", "an atom linked
 * outside a walk", and "a value over an atom nothing observes" groups of
 * `packages/pinna-core/test/core.test.ts`. A write back is the public form
 * of the core's `restoreCell`; the first cases of it are in
 * `observable.test.ts`. `beginBatch`, `forgetValue`, and an activate apart
 * from a track have no public form and stay in pinna-core; a collection's
 * use of `forgetValue` is covered by `retainedKeys` in `collection.test.ts`.
 */

const get = <Value>(realm: Realm, value: Computed<Value> | Box<Value>): Value =>
  Realm.untracked(realm, (read) => read(value));

const set = <Value>(realm: Realm, box: Box<Value>, value: Value): void => {
  Realm.update(realm, (_read, write) => {
    write(box, value);
  });
};

/** A computed value over `box` that counts its runs in `counter.runs`. */
const counted = (
  realm: Realm,
  box: Box<number>,
  map: (value: number) => number,
): { readonly value: Computed<number>; readonly counter: { runs: number } } => {
  const counter = { runs: 0 };
  const value = Computed.make(realm, (read) => {
    counter.runs++;
    return map(read(box));
  });
  return { value, counter };
};

describe("a value one write reaches", () => {
  test("computes once for that write, and not again for a write to another source", () => {
    const realm = Realm.make();
    const a = Box.make(realm, 1);
    const b = Box.make(realm, 10);
    const { value: doubled, counter } = counted(realm, a, (value) => value * 2);
    const seen: Array<number> = [];
    const stop = Realm.watch(
      realm,
      (read) => read(doubled) + read(b),
      (value) => {
        seen.push(value);
        return undefined;
      },
    );
    set(realm, a, 2);
    expect(counter.runs).toBe(2);
    set(realm, b, 20);
    expect(counter.runs).toBe(2);
    expect(seen).toEqual([14, 24]);
    stop();
    expectRealmAtRest(realm);
  });

  test("a value with two sources written in one update names the first it read as the reason", () => {
    const realm = Realm.make();
    const a = Box.make(realm, 1, { name: "a" });
    const b = Box.make(realm, 10, { name: "b" });
    const sum = Computed.make(realm, (read) => read(a) + read(b), { name: "sum" });
    const stop = Realm.autorun(realm, (read) => {
      read(sum);
      return undefined;
    });
    Realm.update(realm, (_read, write) => {
      write(b, 20);
      write(a, 2);
    });
    expect(Source.inspect(sum).lastReason).toBe("a changed");
    stop();
    expectRealmAtRest(realm);
  });
});

describe("a value written back within one update", () => {
  test("runs nothing that observes the box, and a later write reaches it", () => {
    const realm = Realm.make();
    const box = Box.make(realm, 1);
    const { value: doubled, counter } = counted(realm, box, (value) => value * 2);
    const seen: Array<number> = [];
    const stop = Realm.watch(
      realm,
      (read) => read(doubled),
      (value) => {
        seen.push(value);
        return undefined;
      },
    );
    expect(counter.runs).toBe(1);
    Realm.update(realm, (_read, write) => {
      write(box, 2);
      write(box, 1);
    });
    expect(counter.runs).toBe(1);
    expect(seen).toEqual([]);
    set(realm, box, 3);
    expect(counter.runs).toBe(2);
    expect(seen).toEqual([6]);
    stop();
    expectRealmAtRest(realm);
  });

  test("an observed value read between the write and the write back computes again once", () => {
    const realm = Realm.make();
    const box = Box.make(realm, 1);
    const { value: doubled, counter } = counted(realm, box, (value) => value * 2);
    const seen: Array<number> = [];
    const stop = Realm.watch(
      realm,
      (read) => read(doubled),
      (value) => {
        seen.push(value);
        return undefined;
      },
    );
    Realm.update(realm, (read, write) => {
      write(box, 2);
      expect(read(doubled)).toBe(4);
      write(box, 1);
      expect(read(doubled)).toBe(2);
    });
    expect(counter.runs).toBe(3);
    expect(seen).toEqual([]);
    stop();
    expectRealmAtRest(realm);
  });

  test("a value that loses its observers between the write and the write back does not compute", () => {
    const realm = Realm.make();
    const box = Box.make(realm, 1);
    const { value: doubled, counter } = counted(realm, box, (value) => value * 2);
    const stop = Realm.autorun(realm, (read) => {
      read(doubled);
      return undefined;
    });
    Realm.update(realm, (_read, write) => {
      write(box, 2);
      stop();
      write(box, 1);
    });
    expect(get(realm, doubled)).toBe(2);
    expect(counter.runs).toBe(1);
    expectRealmAtRest(realm);
  });

  test("a write back after other writes to the box still reaches every reader", () => {
    const realm = Realm.make();
    const box = Box.make(realm, 1);
    const { value: next, counter } = counted(realm, box, (value) => value + 1);
    const stop = Realm.autorun(realm, (read) => {
      read(next);
      return undefined;
    });
    Realm.update(realm, (_read, write) => {
      write(box, 2);
      write(box, 3);
      write(box, 1);
      write(box, 4);
      write(box, 1);
    });
    expect(counter.runs).toBe(1);
    expect(get(realm, next)).toBe(2);
    stop();
    expectRealmAtRest(realm);
  });
});

describe("a computed value over an atom", () => {
  // A computed value over an atom nothing observes is never current: nothing
  // tells the realm when the state the atom stands for changes.
  test("an autorun that starts after an untracked read follows the outside state", () => {
    const realm = Realm.make();
    const atom = Atom.make(realm);
    let outside = 0;
    const derived = Computed.make(realm, (read) => {
      read(atom);
      return outside;
    });
    expect(get(realm, derived)).toBe(0);
    outside = 1;
    const seen: Array<number> = [];
    const stop = Realm.autorun(realm, (read) => {
      seen.push(read(derived));
      return undefined;
    });
    expect(seen).toEqual([1]);
    outside = 2;
    Realm.update(realm, (_read, write) => {
      write.changed(atom);
    });
    expect(seen).toEqual([1, 2]);
    stop();
    expectRealmAtRest(realm);
  });

  for (const through of [false, true]) {
    test(`keeps its unobserved reader never current, ${through ? "two values deep" : "one value deep"}`, () => {
      const realm = Realm.make();
      const atom = Atom.make(realm);
      const box = Box.make(realm, 0);
      let outside = 0;
      const overAtom = Computed.make(realm, (read) => {
        read(atom);
        return outside;
      });
      const passed = Computed.make(realm, (read) => read(box));
      const parity = through
        ? Computed.make(realm, (read) => read(passed) % 2)
        : Computed.make(realm, (read) => read(box) % 2);
      const reader = Computed.make(realm, (read) => `${read(overAtom)}:${read(parity)}`);
      expect(get(realm, reader)).toBe("0:0");
      set(realm, box, 2);
      expect(get(realm, reader)).toBe("0:0");
      outside = 1;
      expect(get(realm, reader)).toBe("1:0");
      expectRealmAtRest(realm);
    });
  }
});
