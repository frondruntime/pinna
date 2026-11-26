import { describe, expect, test } from "bun:test";
import { Atom, Box, Computed, Realm, Source } from "../src/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * Deep chains through the public API: reads, writes, observers and errors
 * along a chain far deeper than the JavaScript stack, with equality cutoff
 * kept. The public twin of `packages/pinna-core/test/depth.test.ts`; the
 * graph's own depth limit and how many computes a wait restarts are
 * checked there, and here only as an upper bound.
 */

/** Deeper than Bun's stack allows a recursive walk, and far deeper than Hermes's. */
const depth = 100_000;

const get = <Value>(realm: Realm, value: Computed<Value>): Value =>
  Realm.untracked(realm, (read) => read(value));

const set = <Value>(realm: Realm, box: Box<Value>, value: Value): void => {
  Realm.update(realm, (_read, write) => {
    write(box, value);
  });
};

/** A box and a chain of computed values over it, each read once as it is made. */
const chain = (realm: Realm) => {
  const base = Box.make(realm, 0);
  let top: Computed<number> = Computed.make(realm, (read) => read(base) + 1);
  get(realm, top);
  for (let index = 1; index < depth; index++) {
    const below = top;
    top = Computed.make(realm, (read) => read(below) + 1);
    get(realm, top);
  }
  return { base, top };
};

/** A chain no value has read, so the first read from the top computes every value. */
const unread = (realm: Realm, length: number, counted?: { computes: number }) => {
  const base = Box.make(realm, 0);
  let top: Computed<number> = Computed.make(realm, (read) => read(base) + 1);
  for (let index = 1; index < length; index++) {
    const below = top;
    top = Computed.make(realm, (read) => {
      if (counted !== undefined) {
        counted.computes++;
      }
      return read(below) + 1;
    });
  }
  return { base, top };
};

describe("a deep chain built from the bottom", () => {
  test("a value nothing observes reads a write to the bottom", () => {
    const realm = Realm.make();
    const { base, top } = chain(realm);
    expect(get(realm, top)).toBe(depth);
    set(realm, base, 1);
    expect(get(realm, top)).toBe(depth + 1);
  });

  test("an autorun on the top observes the whole chain, and lets go of it", () => {
    const realm = Realm.make();
    const { base, top } = chain(realm);
    const stop = Realm.autorun(realm, (read) => {
      read(top);
      return undefined;
    });
    expect(Source.inspect(base).observers).toBe(1);
    stop();
    expect(Source.inspect(base).observers).toBe(0);
    expect(Source.inspect(top).observers).toBe(0);
  });

  test("a watch on the top sees a write to the bottom", () => {
    const realm = Realm.make();
    const { base, top } = chain(realm);
    const seen: Array<number> = [];
    const stop = Realm.watch(
      realm,
      (read) => read(top),
      (value) => {
        seen.push(value);
        return undefined;
      },
    );
    set(realm, base, 1);
    set(realm, base, 2);
    expect(seen).toEqual([depth + 1, depth + 2]);
    stop();
  });
});

describe("a deep chain read first from the top", () => {
  for (const length of [200, 600, 2000]) {
    test(`keeps equality cutoff while refreshing ${length} cached levels`, () => {
      const realm = Realm.make();
      const shared = Box.make(realm, 0);
      const base = Box.make(realm, 1);
      const levels: Array<Computed<{ value: number }>> = [];
      let computes = 0;
      let comparisons = 0;
      for (let index = 0; index < length; index++) {
        const below = levels[index - 1];
        levels.push(
          Computed.make(
            realm,
            (read) => {
              computes++;
              read(shared);
              return { value: below === undefined ? read(base) : read(below).value };
            },
            {
              equals: (left, right) => {
                comparisons++;
                return left.value === right.value;
              },
            },
          ),
        );
      }
      const top = levels[length - 1] as Computed<{ value: number }>;
      let effects = 0;
      let selections = 0;
      const stops = [
        Realm.watch(
          realm,
          (read) => read(top),
          () => {
            effects++;
            return undefined;
          },
        ),
      ];
      for (let index = 20; index < length - 1; index += 40) {
        const level = levels[index] as Computed<{ value: number }>;
        stops.push(
          Realm.watch(
            realm,
            (read) => {
              selections++;
              return read(level);
            },
            () => {
              effects++;
              return undefined;
            },
          ),
        );
      }
      const previous = get(realm, top);
      computes = comparisons = selections = 0;

      set(realm, shared, 1);

      expect(effects).toBe(0);
      expect(selections).toBe(0);
      expect(get(realm, top)).toBe(previous);
      // Every level recomputes at least once; a restart after a wait may add more, never double.
      expect(computes).toBeGreaterThanOrEqual(length);
      expect(computes).toBeLessThan(2 * length);
      // Equality runs once per level, on finished results only.
      expect(comparisons).toBe(length);
      for (const stop of stops) stop();
      expectRealmAtRest(realm);
    });
  }

  test("a cached compute deep in the chain finishes when its lower value stays equal", () => {
    const realm = Realm.make();
    const shared = Box.make(realm, 0);
    const levels: Array<Computed<number>> = [];
    let top = Computed.make(realm, () => 0);
    for (let index = 0; index < 600; index++) {
      const below = top;
      top = Computed.make(realm, (read) => {
        const current = read(shared);
        read(below);
        return index % 2 === 0 ? 0 : current;
      });
      levels.push(top);
    }
    const seen: Array<number> = [];
    const stop = Realm.watch(
      realm,
      (read) => read(top),
      (value) => {
        seen.push(value);
        return undefined;
      },
    );
    set(realm, shared, 1);
    expect(get(realm, top)).toBe(1);
    expect(seen).toEqual([1]);
    expect(levels.map((level) => get(realm, level))).toEqual(levels.map((_, index) => index % 2));
    stop();
    expectRealmAtRest(realm);
  });

  test("a cached value over two deep branches compares its finished result once", () => {
    const realm = Realm.make();
    const shared = Box.make(realm, 0);
    const branch = () => {
      let top = Computed.make(realm, () => 1);
      for (let index = 0; index < 600; index++) {
        const below = top;
        top = Computed.make(realm, (read) => {
          read(shared);
          return read(below);
        });
      }
      return top;
    };
    const left = branch();
    const right = branch();
    let computes = 0;
    let comparisons = 0;
    const middle = Computed.make(
      realm,
      (read) => {
        computes++;
        read(shared);
        return { value: read(left) + read(right) };
      },
      {
        equals: (previous, current) => {
          comparisons++;
          return previous.value === current.value;
        },
      },
    );
    const top = Computed.make(realm, (read) => {
      read(shared);
      return read(middle);
    });
    let effects = 0;
    const stop = Realm.watch(
      realm,
      (read) => read(top),
      () => {
        effects++;
        return undefined;
      },
    );
    const previous = get(realm, middle);
    computes = comparisons = 0;

    set(realm, shared, 1);

    expect(computes).toBeGreaterThanOrEqual(1);
    expect(computes).toBeLessThanOrEqual(3);
    expect(comparisons).toBe(1);
    expect(effects).toBe(0);
    expect(get(realm, middle)).toBe(previous);
    stop();
    expectRealmAtRest(realm);
  });

  test("cached errors deep in the chain recover without passing an error to equals", () => {
    const realm = Realm.make();
    const shared = Box.make(realm, 0);
    const failure = new Error("bottom failed");
    let comparisons = 0;
    let top = Computed.make(realm, (read) => {
      if (read(shared) % 2 === 0) throw failure;
      return { value: 1 };
    });
    for (let index = 0; index < 600; index++) {
      const below = top;
      top = Computed.make(
        realm,
        (read) => {
          read(shared);
          return { value: read(below).value };
        },
        {
          equals: (previous, current) => {
            comparisons++;
            expect(previous).not.toBeInstanceOf(Error);
            return previous.value === current.value;
          },
        },
      );
    }
    expect(() => get(realm, top)).toThrow(failure);
    for (const value of [1, 2, 3]) {
      set(realm, shared, value);
      if (value % 2 === 0) {
        expect(() => get(realm, top)).toThrow(failure);
      } else {
        expect(get(realm, top)).toEqual({ value: 1 });
      }
      expectRealmAtRest(realm);
    }
    expect(comparisons).toBe(0);
  });

  test("a deep chain over an atom reads untracked state afresh on each unobserved read", () => {
    const realm = Realm.make();
    const atom = Atom.make(realm);
    let outside = 1;
    let top = Computed.make(realm, () => 0);
    for (let index = 0; index < 600; index++) {
      const below = top;
      top = Computed.make(realm, (read) => {
        read(atom);
        return read(below) + outside;
      });
    }
    expect(get(realm, top)).toBe(600);
    outside = 2;
    expect(get(realm, top)).toBe(1200);
    expectRealmAtRest(realm);
  });

  test("a cycle of 1,000 values throws and recovers", () => {
    const realm = Realm.make();
    const closes = Box.make(realm, false);
    const length = 1000;
    const values: Array<Computed<number>> = [];
    for (let index = 0; index < length; index++) {
      values.push(
        Computed.make(realm, (read) => {
          const closing = read(closes);
          if (index === length - 1 && !closing) return 0;
          return read(values[(index + 1) % length] as Computed<number>);
        }),
      );
    }
    const top = values[0] as Computed<number>;
    expect(get(realm, top)).toBe(0);
    set(realm, closes, true);
    expect(() => get(realm, top)).toThrow("cycle");
    expectRealmAtRest(realm);
    set(realm, closes, false);
    expect(get(realm, top)).toBe(0);
    expectRealmAtRest(realm);
  });

  for (const length of [15_000, 30_000]) {
    test(`refreshes ${length} cached levels that read a changed shared source first`, () => {
      const realm = Realm.make();
      const shared = Box.make(realm, 0);
      let top = Computed.make(realm, () => 0);
      for (let index = 0; index < length; index++) {
        const previous = top;
        top = Computed.make(realm, (read) => read(shared) + read(previous));
      }
      expect(get(realm, top)).toBe(0);
      set(realm, shared, 1);
      expect(get(realm, top)).toBe(length);
      set(realm, shared, 2);
      expect(get(realm, top)).toBe(2 * length);
      expectRealmAtRest(realm);
    });
  }

  test("a refresh leaves a stale branch unread when the new compute drops it", () => {
    const realm = Realm.make();
    const shared = Box.make(realm, 0);
    let bottomRuns = 0;
    let top = Computed.make(realm, (read) => {
      bottomRuns++;
      return read(shared);
    });
    for (let index = 0; index < 1000; index++) {
      const previous = top;
      top = Computed.make(realm, (read) => {
        const current = read(shared);
        return current === 0 ? read(previous) : current;
      });
    }
    expect(get(realm, top)).toBe(0);
    expect(bottomRuns).toBe(1);
    set(realm, shared, 1);
    expect(get(realm, top)).toBe(1);
    expect(bottomRuns).toBe(1);
  });

  test("computes, and reads a write to the bottom", () => {
    const realm = Realm.make();
    const { base, top } = unread(realm, depth);
    expect(get(realm, top)).toBe(depth);
    set(realm, base, 1);
    expect(get(realm, top)).toBe(depth + 1);
  });

  test("a watch on the top observes the whole chain, sees a write, and lets go", () => {
    const realm = Realm.make();
    const { base, top } = unread(realm, depth);
    const seen: Array<number> = [];
    const stop = Realm.watch(
      realm,
      (read) => read(top),
      (value) => {
        seen.push(value);
        return undefined;
      },
    );
    expect(Source.inspect(base).observers).toBe(1);
    set(realm, base, 1);
    expect(seen).toEqual([depth + 1]);
    stop();
    expect(Source.inspect(base).observers).toBe(0);
    expect(Source.inspect(top).observers).toBe(0);
  });

  test("a chain of 200 computes each value once", () => {
    const realm = Realm.make();
    const counted = { computes: 0 };
    const { top } = unread(realm, 200, counted);
    expect(get(realm, top)).toBe(200);
    expect(counted.computes).toBe(199);
  });

  test("a chain of 1,000 computes each value fewer than twice", () => {
    const realm = Realm.make();
    const counted = { computes: 0 };
    const { top } = unread(realm, 1000, counted);
    expect(get(realm, top)).toBe(1000);
    expect(counted.computes).toBeGreaterThanOrEqual(999);
    expect(counted.computes).toBeLessThan(2 * 999);
  });

  test("an error at the bottom reaches the top", () => {
    const realm = Realm.make();
    const failing = Box.make(realm, false);
    const bottom = Computed.make(realm, (read) => {
      if (read(failing)) {
        throw new Error("bottom");
      }
      return 0;
    });
    let top: Computed<number> = bottom;
    for (let index = 1; index < 2000; index++) {
      const below = top;
      top = Computed.make(realm, (read) => read(below) + 1);
    }
    set(realm, failing, true);
    expect(() => get(realm, top)).toThrow("bottom");
    set(realm, failing, false);
    expect(get(realm, top)).toBe(1999);
  });
});

describe("teardown of a deep chain", () => {
  test("an autorun over 10,000 values stops and lets go of every one", () => {
    const realm = Realm.make();
    const { base, top } = unread(realm, 10_000);
    const stop = Realm.autorun(realm, (read) => {
      read(top);
      return undefined;
    });
    expect(Source.inspect(base).observers).toBe(1);
    stop();
    expect(Source.inspect(base).observers).toBe(0);
    expect(Source.inspect(top).observers).toBe(0);
    expectRealmAtRest(realm);
  });

  test("a realm observing 10,000 values disposes", () => {
    const realm = Realm.make();
    const { base, top } = unread(realm, 10_000);
    Realm.autorun(realm, (read) => {
      read(top);
      return undefined;
    });
    Realm.dispose(realm);
    expect(Realm.status(realm)).toBe("disposed");
    expect(() => set(realm, base, 1)).toThrow();
  });

  test("an update that observes 10,000 new values and throws rolls back", () => {
    const realm = Realm.make();
    const { base, top } = unread(realm, 10_000);
    let inside = 0;
    expect(() =>
      Realm.update(realm, (read, write) => {
        write(base, 1);
        inside = read(top);
        throw new Error("after the chain");
      }),
    ).toThrow("after the chain");
    expect(inside).toBe(10_001);
    expect(Realm.untracked(realm, (read) => read(base))).toBe(0);
    expect(get(realm, top)).toBe(10_000);
    expectRealmAtRest(realm);
  });
});

describe("a chain made anew on each compute", () => {
  test("a computed value that makes a chain deeper than the limit on each run throws pinna/depth-rebuilt, and the realm reads on", () => {
    const realm = Realm.make();
    const $length = Box.make(realm, 260);
    let runs = 0;
    const $total = Computed.make(
      realm,
      (read) => {
        runs++;
        let step = Computed.make(realm, () => 0);
        const count = read($length);
        for (let index = 0; index < count; index++) {
          const below = step;
          step = Computed.make(realm, (readStep) => readStep(below) + 1);
        }
        return read(step);
      },
      { name: "total" },
    );
    expect(() => get(realm, $total)).toThrow(
      'pinna: the computed value "total" stopped past depth 256 and ran again more than 64 times in one read, as one that makes a new chain of computed values each time it computes does; make the chain outside the computed value and read it there',
    );
    // The first run and 64 restarts.
    expect(runs).toBe(65);
    const $other = Box.make(realm, 1);
    const $double = Computed.make(realm, (read) => read($other) * 2);
    expect(get(realm, $double)).toBe(2);
    // A short chain made anew on each run still reads.
    set(realm, $length, 10);
    expect(get(realm, $total)).toBe(10);
    Realm.dispose(realm);
  });

  test("a chain made once and kept between runs reads past the limit", () => {
    const realm = Realm.make();
    const $base = Box.make(realm, 0);
    let chain: Computed<number> | undefined;
    const $total = Computed.make(realm, (read) => {
      if (chain === undefined) {
        let step = Computed.make(realm, (readBase) => readBase($base));
        for (let index = 0; index < 600; index++) {
          const below = step;
          step = Computed.make(realm, (readStep) => readStep(below) + 1);
        }
        chain = step;
      }
      return read(chain);
    });
    expect(get(realm, $total)).toBe(600);
    set(realm, $base, 1);
    expect(get(realm, $total)).toBe(601);
    Realm.dispose(realm);
  });
});
