import { describe, expect, test } from "bun:test";
import { Box, Computed, type Read, Realm, Source } from "../src/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * Cycles through the public API: a computed value that reads itself, through
 * others, throws a cycle error, recovers once the cycle is gone, and leaves
 * no cycle of observers behind. The public twin of
 * `packages/pinna-core/test/cycles.test.ts`, which tests the same cases on
 * the graph's own functions.
 */

const quiet = (): Realm => Realm.make({ onError: () => {} });

const get = <Value>(realm: Realm, value: Computed<Value>): Value =>
  Realm.untracked(realm, (read) => read(value));

const set = <Value>(realm: Realm, box: Box<Value>, value: Value): void => {
  Realm.update(realm, (_read, write) => {
    write(box, value);
  });
};

/** What `read(value)` gives, or `"cycle"` for the cycle error. */
const orCycle = (read: Read, value: Computed<number>): number | "cycle" => {
  try {
    return read(value);
  } catch {
    return "cycle";
  }
};

/**
 * `first` reads `second` while `wide` holds true, and `second` always reads
 * `first`, so reading `first` with `wide` on meets a cycle inside `second`
 * before `second` has read anything else.
 */
const cycle = (realm: Realm) => {
  const wide = Box.make(realm, true);
  const values: { second?: Computed<number> } = {};
  const first = Computed.make(
    realm,
    (read) => (read(wide) ? (values.second === undefined ? 0 : read(values.second)) : 0),
    { name: "first" },
  );
  const second = Computed.make(realm, (read) => read(first) + 1, { name: "second" });
  values.second = second;
  return { wide, first, second };
};

describe("a value that meets a cycle before it reads anything else", () => {
  test("recovers once the cycle is gone", () => {
    const realm = quiet();
    const { wide, first, second } = cycle(realm);
    expect(() => get(realm, first)).toThrow(/cycle/);
    set(realm, wide, false);
    expect(get(realm, first)).toBe(0);
    expect(get(realm, second)).toBe(1);
    expectRealmAtRest(realm);
  });

  test("recovers when it is read first after the cycle is gone", () => {
    const realm = quiet();
    const { wide, first, second } = cycle(realm);
    expect(() => get(realm, first)).toThrow(/cycle/);
    set(realm, wide, false);
    expect(get(realm, second)).toBe(1);
    expect(get(realm, first)).toBe(0);
    expectRealmAtRest(realm);
  });

  test("an autorun over it sees the recovery", () => {
    const realm = quiet();
    const { wide, first, second } = cycle(realm);
    expect(() => get(realm, first)).toThrow(/cycle/);
    const seen: Array<number | string> = [];
    const stop = Realm.autorun(realm, (read) => {
      seen.push(orCycle(read, second));
      return undefined;
    });
    set(realm, wide, false);
    expect(seen).toEqual(["cycle", 1]);
    stop();
    expect(Source.inspect(wide).observers).toBe(0);
    expectRealmAtRest(realm);
  });

  test("a value read after the cycle keeps the cycle's error until it is gone", () => {
    const realm = quiet();
    const { wide, first, second } = cycle(realm);
    expect(() => get(realm, first)).toThrow(/cycle/);
    expect(() => get(realm, second)).toThrow(/cycle/);
    expect(Source.inspect(second).dependencies).toEqual(["first"]);
    set(realm, wide, false);
    expect(get(realm, second)).toBe(1);
    expectRealmAtRest(realm);
  });

  test("a cycle with no condition is kept by whichever value it began at", () => {
    const realm = quiet();
    const values: { first?: Computed<number> } = {};
    const second = Computed.make(
      realm,
      (read) => (values.first === undefined ? 0 : read(values.first)) + 1,
      { name: "second" },
    );
    const first = Computed.make(realm, (read) => read(second) + 1, { name: "first" });
    values.first = first;
    expect(() => get(realm, second)).toThrow(/cycle/);
    expect(() => get(realm, first)).toThrow(/cycle/);
    expect(Source.inspect(second).dependencies).toEqual([]);
    expect(Source.inspect(first).dependencies).toEqual(["second"]);
    expect(() => get(realm, second)).toThrow(/cycle/);
    expectRealmAtRest(realm);
  });
});

describe("a cycle whose condition is read by a value it passes through", () => {
  // `inner` reads `wide` before it closes the cycle; `outer`, where the cycle
  // begins, reads nothing before it.
  const build = (realm: Realm) => {
    const wide = Box.make(realm, true);
    const values: { outer?: Computed<number> } = {};
    const inner = Computed.make(realm, (read) =>
      read(wide) ? (values.outer === undefined ? 0 : read(values.outer)) : 1,
    );
    const outer = Computed.make(realm, (read) => read(inner) + 1);
    values.outer = outer;
    return { wide, inner, outer };
  };

  test("the value it began at recovers once the cycle is gone", () => {
    const realm = quiet();
    const { wide, inner, outer } = build(realm);
    expect(() => get(realm, outer)).toThrow(/cycle/);
    set(realm, wide, false);
    expect(get(realm, outer)).toBe(2);
    expect(get(realm, inner)).toBe(1);
    expectRealmAtRest(realm);
  });

  test("an autorun over the value it began at sees the recovery", () => {
    const realm = quiet();
    const { wide, outer } = build(realm);
    const seen: Array<number | string> = [];
    const stop = Realm.autorun(realm, (read) => {
      seen.push(orCycle(read, outer));
      return undefined;
    });
    set(realm, wide, false);
    expect(seen).toEqual(["cycle", 2]);
    stop();
    expect(Source.inspect(wide).observers).toBe(0);
  });

  test("a value that catches the cycle recomputes once the cycle is gone", () => {
    const realm = quiet();
    const wide = Box.make(realm, true);
    const values: { outer?: Computed<number> } = {};
    const closing = Computed.make(realm, (read) =>
      read(wide) ? (values.outer === undefined ? 0 : read(values.outer)) : 5,
    );
    const catching = Computed.make(realm, (read) => {
      try {
        return read(closing);
      } catch {
        return -1;
      }
    });
    const outer = Computed.make(realm, (read) => read(catching) + 1);
    values.outer = outer;
    expect(get(realm, outer)).toBe(0);
    set(realm, wide, false);
    expect(get(realm, catching)).toBe(5);
    expect(get(realm, outer)).toBe(6);
  });
});

describe("a cycle closed in an equals", () => {
  test("is kept by the value it began at, not the value whose equals closed it", () => {
    const realm = quiet();
    const source = Box.make(realm, 0);
    const wide = Box.make(realm, false);
    let closes = false;
    const values: { outer?: Computed<number> } = {};
    const inner = Computed.make(realm, (read) => read(source), {
      equals: (left, right) => {
        if (closes && values.outer !== undefined) {
          Source.peek(values.outer);
        }
        return left === right;
      },
    });
    const outer = Computed.make(realm, (read) => (read(wide) ? read(inner) : 0));
    values.outer = outer;
    expect(get(realm, inner)).toBe(0);
    expect(get(realm, outer)).toBe(0);
    Realm.update(realm, (_read, write) => {
      write(wide, true);
      write(source, 1);
    });
    closes = true;
    expect(() => get(realm, outer)).toThrow(/cycle/);
    closes = false;
    expect(get(realm, inner)).toBe(1);
    set(realm, wide, false);
    expect(get(realm, outer)).toBe(0);
    expectRealmAtRest(realm);
  });
});

describe("a compute that catches a cycle", () => {
  /**
   * `catching` reads `leaf`, then `origin`, and catches the error; `origin`
   * reads `catching`. An autorun on `origin` observes `leaf` through both.
   */
  const caught = (realm: Realm) => {
    const leaf = Box.make(realm, 0);
    const hooks = { started: 0, ended: 0 };
    Source.onObserved(leaf, () => {
      hooks.started++;
      return () => {
        hooks.ended++;
      };
    });
    const values: { origin?: Computed<number> } = {};
    const catching = Computed.make(
      realm,
      (read) => {
        read(leaf);
        try {
          return values.origin === undefined ? 0 : read(values.origin);
        } catch {
          return -1;
        }
      },
      { name: "catching" },
    );
    const origin = Computed.make(realm, (read) => read(catching) + 1, { name: "origin" });
    values.origin = origin;
    return { leaf, hooks, catching, origin };
  };

  const expectReleased = (realm: Realm, { hooks, catching, origin }: ReturnType<typeof caught>) => {
    expect(hooks).toEqual({ started: 1, ended: 1 });
    expect(Source.inspect(origin).observers).toBe(0);
    expect(Source.inspect(catching).observers).toBe(0);
    expectRealmAtRest(realm);
  };

  /** Runs an autorun over `run` once, then stops it. */
  const once = (realm: Realm, run: (read: Read) => void): void => {
    Realm.autorun(realm, (read) => {
      run(read);
      return undefined;
    })();
  };

  test("leaves no cycle of observers once its autorun stops", () => {
    const realm = quiet();
    const values = caught(realm);
    once(realm, (read) => read(values.origin));
    expectReleased(realm, values);
  });

  test("leaves no cycle of observers when each value is read on its own first", () => {
    const realm = quiet();
    const values = caught(realm);
    expect(get(realm, values.origin)).toBe(0);
    expect(get(realm, values.catching)).toBe(-1);
    once(realm, (read) => read(values.origin));
    expectReleased(realm, values);
  });

  test("leaves no cycle of observers when one autorun reads both", () => {
    const realm = quiet();
    const values = caught(realm);
    once(realm, (read) => [read(values.origin), read(values.catching)]);
    expectReleased(realm, values);
  });

  test("leaves no cycle of observers when the catching value is read first", () => {
    const realm = quiet();
    const values = caught(realm);
    expect(get(realm, values.catching)).toBe(-1);
    expect(get(realm, values.origin)).toBe(0);
    once(realm, (read) => [read(values.catching), read(values.origin)]);
    expectReleased(realm, values);
  });

  test("leaves no two values reading each other, in either read order", () => {
    const realm = quiet();
    const { catching, origin } = caught(realm);
    const other = Box.make(realm, 0);
    const read = (value: Computed<number>): number | "cycle" =>
      Realm.untracked(realm, (inner) => orCycle(inner, value));
    const readBoth = () =>
      Source.inspect(origin).dependencies.includes("catching") &&
      Source.inspect(catching).dependencies.includes("origin");
    expect([read(origin), read(catching)]).toEqual([0, -1]);
    expect(readBoth()).toBe(false);
    read(catching);
    read(origin);
    expect(readBoth()).toBe(false);
    set(realm, other, 1);
    expect([read(origin), read(catching)]).toEqual([0, -1]);
    expect(readBoth()).toBe(false);
  });

  test("leaves no cycle of observers through a third value", () => {
    const realm = quiet();
    const leaf = Box.make(realm, 0);
    let ended = 0;
    Source.onObserved(leaf, () => () => {
      ended++;
    });
    const values: { origin?: Computed<number> } = {};
    const catching = Computed.make(realm, (read) => {
      read(leaf);
      try {
        return values.origin === undefined ? 0 : read(values.origin);
      } catch {
        return -1;
      }
    });
    const middle = Computed.make(realm, (read) => read(catching) + 1);
    const origin = Computed.make(realm, (read) => read(middle) + 1);
    values.origin = origin;
    once(realm, (read) => read(origin));
    expect(get(realm, origin)).toBe(1);
    once(realm, (read) => [read(catching), read(middle), read(origin)]);
    expect(ended).toBe(2);
    expect([origin, middle, catching].map((value) => Source.inspect(value).observers)).toEqual([
      0, 0, 0,
    ]);
    expectRealmAtRest(realm);
  });

  test("leaves no cycle of observers when two values catch the same cycle", () => {
    const realm = quiet();
    const leaf = Box.make(realm, 0);
    let ended = 0;
    Source.onObserved(leaf, () => () => {
      ended++;
    });
    const values: { origin?: Computed<number> } = {};
    const catchingOf = () =>
      Computed.make(realm, (read) => {
        read(leaf);
        try {
          return values.origin === undefined ? 0 : read(values.origin);
        } catch {
          return -1;
        }
      });
    const left = catchingOf();
    const right = catchingOf();
    const origin = Computed.make(realm, (read) => read(left) + read(right));
    values.origin = origin;
    once(realm, (read) => [read(origin), read(left), read(right)]);
    expect(ended).toBe(1);
    expect([origin, left, right].map((value) => Source.inspect(value).observers)).toEqual([
      0, 0, 0,
    ]);
    expectRealmAtRest(realm);
  });

  test("leaves no cycle of observers when it catches a second cycle it closes", () => {
    const realm = quiet();
    const leaf = Box.make(realm, 0);
    let ended = 0;
    Source.onObserved(leaf, () => () => {
      ended++;
    });
    const values: { origin?: Computed<number>; back?: Computed<number> } = {};
    const catching = Computed.make(realm, (read) => {
      read(leaf);
      let total = 0;
      try {
        total += values.origin === undefined ? 0 : read(values.origin);
      } catch {
        total -= 1;
      }
      try {
        total += values.back === undefined ? 0 : read(values.back);
      } catch {
        total -= 10;
      }
      return total;
    });
    const back = Computed.make(realm, (read) => read(catching) * 2);
    const origin = Computed.make(realm, (read) => read(catching) + 1);
    values.origin = origin;
    values.back = back;
    once(realm, (read) => [read(origin), read(catching), read(back)]);
    expect(ended).toBe(1);
    expect([origin, catching, back].map((value) => Source.inspect(value).observers)).toEqual([
      0, 0, 0,
    ]);
    expectRealmAtRest(realm);
  });

  test("recovers once the cycle is gone, under a watch", () => {
    const realm = quiet();
    const wide = Box.make(realm, true);
    const values: { origin?: Computed<number> } = {};
    const catching = Computed.make(realm, (read) => {
      if (!read(wide)) {
        return 7;
      }
      try {
        return values.origin === undefined ? 0 : read(values.origin);
      } catch {
        return -1;
      }
    });
    const origin = Computed.make(realm, (read) => read(catching) + 1);
    values.origin = origin;
    const seen: number[] = [];
    const stop = Realm.watch(
      realm,
      (read) => read(origin),
      (value) => {
        seen.push(value);
        return undefined;
      },
    );
    set(realm, wide, false);
    expect(seen).toEqual([8]);
    stop();
    expect([origin, catching].map((value) => Source.inspect(value).observers)).toEqual([0, 0]);
    expectRealmAtRest(realm);
  });
});
