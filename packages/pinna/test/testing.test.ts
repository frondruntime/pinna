import { describe, expect, test } from "bun:test";
import { Box, Collection, Computed, Realm, Source } from "../src/index.ts";
import { held, record, retainedKeys, testRealm } from "../src/testing/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/** `@frondruntime/pinna/testing`: `record`, `held`, and `testRealm` (ruling 52). */

describe("record", () => {
  test("keeps each value a select changes to, not its first value", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 1);
    using doubled = record(realm, (read) => read($count) * 2);
    expect(doubled.values).toEqual([]);
    Realm.update(realm, (_read, write) => {
      write($count, 2);
      write($count, 3);
    });
    Realm.update(realm, (_read, write) => {
      write($count, 3);
    });
    expect(doubled.values).toEqual([6]);
    Realm.update(realm, (_read, write) => {
      write($count, 4);
    });
    expect(doubled.values).toEqual([6, 8]);
  });

  test("compares with options.equals", () => {
    using realm = testRealm();
    const $items = Box.make(realm, [1, 2]);
    using lengths = record(realm, (read) => [...read($items)], {
      equals: (left, right) => left.length === right.length,
    });
    Realm.update(realm, (_read, write) => {
      write($items, [3, 4]);
    });
    Realm.update(realm, (_read, write) => {
      write($items, [5]);
    });
    expect(lengths.values).toEqual([[5]]);
  });

  test("keeps nothing once stopped, and stopping again or leaving its scope does nothing", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 1);
    {
      using counts = record(realm, (read) => read($count));
      counts.stop();
      counts.stop();
      Realm.update(realm, (_read, write) => {
        write($count, 2);
      });
      expect(counts.values).toEqual([]);
    }
    expectRealmAtRest(realm);
  });

  test("stops when its scope ends", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 1);
    let kept: ReadonlyArray<number> = [];
    {
      using counts = record(realm, (read) => read($count));
      kept = counts.values;
      Realm.update(realm, (_read, write) => {
        write($count, 2);
      });
    }
    Realm.update(realm, (_read, write) => {
      write($count, 3);
    });
    expect(kept).toEqual([2]);
  });

  test("throws the select's first error, and records nothing", () => {
    const realm = testRealm();
    expect(() =>
      record(realm, () => {
        throw new Error("first run");
      }),
    ).toThrow("first run");
    realm[Symbol.dispose]();
  });
});

describe("held", () => {
  test("runs the stop function of an autorun, a watch, and an observe when its scope ends", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 1);
    const seen: Array<number> = [];
    {
      using _autorun = held(
        Realm.autorun(realm, (read) => {
          seen.push(read($count));
        }),
      );
      using _watch = held(
        Realm.watch(
          realm,
          (read) => read($count),
          () => undefined,
        ),
      );
      using _observe = held(Source.observe(Computed.make(realm, (read) => read($count) + 1)));
      Realm.update(realm, (_read, write) => {
        write($count, 2);
      });
    }
    Realm.update(realm, (_read, write) => {
      write($count, 3);
    });
    expect(seen).toEqual([1, 2]);
  });

  test("stops before the realm checks, so a failed test throws only its own error", () => {
    const failure = new Error("the assertion");
    const run = () => {
      using realm = testRealm();
      const $count = Box.make(realm, 1);
      using _autorun = held(
        Realm.autorun(realm, (read) => {
          read($count);
        }),
      );
      throw failure;
    };
    expect(run).toThrow(failure);
  });
});

describe("testRealm", () => {
  test("disposing a leaked autorun runs its complete cleanup once", () => {
    const realm = testRealm();
    const $count = Box.make(realm, 1);
    let cleanups = 0;
    let runs = 0;
    const stop = Realm.autorun(realm, (read) => {
      read($count);
      runs++;
      return () => {
        cleanups++;
      };
    });
    expect(() => realm[Symbol.dispose]()).toThrow(
      "The test realm is not at rest: autorun still running.",
    );
    expect(cleanups).toBe(1);
    stop();
    expect(() => realm[Symbol.dispose]()).not.toThrow();
    expect(() => Realm.update(realm, (_read, write) => write($count, 2))).toThrow(
      "pinna: Realm.update cannot start in the disposed realm",
    );
    expect(runs).toBe(1);
    expect(cleanups).toBe(1);
  });

  test("a leaked autorun cleanup reports errors and leaves the realm stopped", () => {
    const errors: Array<unknown> = [];
    const realm = testRealm({ onError: (error) => errors.push(error) });
    const failure = new Error("cleanup failed");
    Realm.autorun(realm, () => () => {
      throw failure;
    });
    expect(() => realm[Symbol.dispose]()).toThrow(
      "The test realm is not at rest: autorun still running.",
    );
    expect(errors).toEqual([failure]);
    expect(() => realm[Symbol.dispose]()).not.toThrow();
  });

  test("an autorun whose stop throws stays tracked with its cleanup", () => {
    const realm = testRealm();
    let cleanups = 0;
    const stop = Realm.autorun(realm, () => () => {
      cleanups++;
    });
    const $stopping = Computed.make(realm, () => {
      stop();
      return 0;
    });
    expect(() => Realm.untracked(realm, (read) => read($stopping))).toThrow();
    expect(cleanups).toBe(0);
    expect(() => realm[Symbol.dispose]()).toThrow(
      "The test realm is not at rest: autorun still running.",
    );
    expect(cleanups).toBe(1);
    expect(() => realm[Symbol.dispose]()).not.toThrow();
  });

  test("a watch named autorun stays counted separately", () => {
    const realm = testRealm();
    Realm.watch(
      realm,
      () => 1,
      () => undefined,
      { name: "autorun" },
    );
    expect(() => realm[Symbol.dispose]()).toThrow(
      "The test realm is not at rest: autorun still running.",
    );
    expect(() => realm[Symbol.dispose]()).not.toThrow();
  });

  test("disposes quietly when every watch, autorun, and observe was stopped", () => {
    const realm = testRealm();
    const $count = Box.make(realm, 1);
    const $doubled = Computed.make(realm, (read) => read($count) * 2);
    const stops = [
      Realm.watch(
        realm,
        (read) => read($count),
        () => undefined,
      ),
      Realm.autorun(realm, (read) => {
        read($doubled);
        return undefined;
      }),
      Source.observe($doubled),
    ];
    for (const stop of stops) {
      stop();
    }
    expect(() => realm[Symbol.dispose]()).not.toThrow();
  });

  test("throws on dispose, naming each watch, autorun, and observe still running", () => {
    const realm = testRealm();
    const $count = Box.make(realm, 1);
    Realm.watch(
      realm,
      (read) => read($count),
      () => undefined,
      { name: "count" },
    );
    Realm.autorun(realm, (read) => {
      read($count);
      return undefined;
    });
    Source.observe($count);
    expect(() => realm[Symbol.dispose]()).toThrow(
      "The test realm is not at rest: autorun still running; count still running; watch still running.",
    );
  });

  test("stops what it found running, so a second dispose is quiet", () => {
    const realm = testRealm();
    const $count = Box.make(realm, 1);
    let runs = 0;
    Realm.autorun(realm, (read) => {
      read($count);
      runs++;
      return undefined;
    });
    expect(() => realm[Symbol.dispose]()).toThrow("autorun still running");
    expect(Realm.status(realm)).toBe("disposed");
    expect(runs).toBe(1);
    expect(() => realm[Symbol.dispose]()).not.toThrow();
  });

  test("counts a watch whose stop threw as still running, and stops it", () => {
    const realm = testRealm();
    const $count = Box.make(realm, 1);
    const stop = Realm.watch(
      realm,
      (read) => read($count),
      () => undefined,
      { name: "count" },
    );
    const $stopping = Computed.make(realm, () => {
      stop();
      return 0;
    });
    expect(() => Realm.untracked(realm, (read) => read($stopping))).toThrow();
    expect(() => realm[Symbol.dispose]()).toThrow("count still running");
    expect(() => realm[Symbol.dispose]()).not.toThrow();
  });

  test("throws on dispose even when the scope ends with an error, which it suppresses", () => {
    const run = (): void => {
      using realm = testRealm();
      Realm.watch(
        realm,
        (read) => read(Box.make(realm, 1)),
        () => undefined,
      );
      throw new Error("the test failed");
    };
    let thrown: unknown;
    try {
      run();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SuppressedError);
    const suppressed = thrown as SuppressedError;
    expect((suppressed.error as Error).message).toContain("watch still running");
    expect((suppressed.suppressed as Error).message).toBe("the test failed");
  });

  test("counts only its own realm's watches", () => {
    const realm = testRealm();
    const other = testRealm();
    const $count = Box.make(other, 1);
    const stop = Realm.watch(
      other,
      (read) => read($count),
      () => undefined,
    );
    expect(() => realm[Symbol.dispose]()).not.toThrow();
    stop();
    other[Symbol.dispose]();
  });
});

describe("retainedKeys", () => {
  interface Row {
    readonly id: string;
    readonly value: number;
  }
  const rowsOf = (count: number): Array<Row> =>
    Array.from({ length: count }, (_, index) => ({ id: `row-${index}`, value: index }));

  test("names the held rows, and lets go of each removed one with its box and computed value", () => {
    const realm = Realm.make();
    const rows = Collection.make<string, Row>(realm, { keyOf: (row) => row.id });
    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows, rowsOf(100));
    });
    // A reader of each row makes its box and its computed value.
    const release = Source.observe(rows.row("row-1"));
    const reads = rowsOf(100).map((row) => Source.observe(rows.row(row.id)));
    for (const stop of reads) stop();
    expect(retainedKeys(rows)).toEqual(new Set(rowsOf(100).map((row) => row.id)));
    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows, rowsOf(10));
    });
    expect(retainedKeys(rows)).toEqual(new Set(rowsOf(10).map((row) => row.id)));
    Realm.update(realm, (_read, write) => {
      write.remove(rows, "row-1");
    });
    // Still observed, yet removed: its box and computed value are let go.
    expect(retainedKeys(rows).has("row-1")).toBe(false);
    expect(retainedKeys(rows).size).toBe(9);
    release();
  });

  test("is a copy, taken when called", () => {
    const realm = Realm.make();
    const rows = Collection.make<string, Row>(realm, { keyOf: (row) => row.id });
    const before = retainedKeys(rows);
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, { id: "a", value: 1 });
    });
    expect(before.size).toBe(0);
    expect(retainedKeys(rows)).toEqual(new Set(["a"]));
  });

  test("throws for a value that is not a collection Pinna made", () => {
    const realm = Realm.make();
    const rows = Collection.make<string, Row>(realm, { keyOf: (row) => row.id });
    expect(() => retainedKeys({ ...rows })).toThrow(
      "pinna: retainedKeys takes a collection Pinna made",
    );
  });
});
