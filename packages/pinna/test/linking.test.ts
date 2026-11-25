import { describe, expect, test } from "bun:test";
import { Box, Computed, type Read, Realm, Source } from "../src/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * How a reader links to and unlinks from what it reads, through the public
 * API: observed hooks that throw or stop a reader while it links, a reader
 * that reads a source twice or drops some, repeat writes in one update, and
 * a computed value that tries to write. The public twin of the "reentry,
 * with errors", "observer links", "repeat marks", "a compute cannot write",
 * and "a stopped watch" groups of `packages/pinna-core/test/core.test.ts`.
 * The cases that need a `Reaction` activated apart from its track (a cleanup
 * that reactivates it, a reaction told and not tracked again) have no public
 * form and stay there; `adopt` has its twin in `pinna-react`.
 */

const observers = (...sources: ReadonlyArray<Box<unknown> | Computed<unknown>>): Array<number> =>
  sources.map((source) => Source.inspect(source).observers);

const set = <Value>(realm: Realm, box: Box<Value>, value: Value): void => {
  Realm.update(realm, (_read, write) => {
    write(box, value);
  });
};

const get = <Value>(realm: Realm, value: Computed<Value> | Box<Value>): Value =>
  Realm.untracked(realm, (read) => read(value));

const autorun = (realm: Realm, run: (read: Read) => unknown): (() => void) =>
  Realm.autorun(realm, (read) => {
    run(read);
    return undefined;
  });

const watchInto = <Value>(
  realm: Realm,
  select: (read: Read) => Value,
  seen: Array<Value>,
): (() => void) =>
  Realm.watch(realm, select, (value) => {
    seen.push(value);
    return undefined;
  });

/** A realm whose onError collects each error's message. */
const reporting = (): { readonly realm: Realm; readonly reports: Array<string> } => {
  const reports: Array<string> = [];
  const realm = Realm.make({ onError: (error) => reports.push((error as Error).message) });
  return { realm, reports };
};

describe("reentry, with errors", () => {
  test("an autorun whose first run throws starts no hook and does not run again", () => {
    const { realm } = reporting();
    const source = Box.make(realm, 0);
    const log: Array<string> = [];
    Source.onObserved(source, () => {
      log.push("start");
      return () => {
        log.push("stop");
      };
    });
    let runs = 0;
    expect(() =>
      Realm.autorun(realm, (read) => {
        runs++;
        read(source);
        throw new Error("the first run fails");
      }),
    ).toThrow("the first run fails");
    expect(runs).toBe(1);
    expect(log).toEqual([]);
    expect(observers(source)).toEqual([0]);
    expectRealmAtRest(realm);
  });

  test("an autorun whose source hooks throw on its first run still links the rest", () => {
    const { realm, reports } = reporting();
    const boxes = [Box.make(realm, 0), Box.make(realm, 0), Box.make(realm, 0)] as const;
    for (const [index, name] of ["first", "second"].entries()) {
      Source.onObserved(boxes[index] as Box<number>, () => {
        throw new Error(`the ${name} hook fails`);
      });
    }
    let runs = 0;
    const stop = autorun(realm, (read) => {
      runs++;
      return read(boxes[0]) + read(boxes[1]) + read(boxes[2]);
    });

    expect(reports).toEqual(["the first hook fails", "the second hook fails"]);
    expect(observers(...boxes)).toEqual([1, 1, 1]);
    set(realm, boxes[2], 1);
    expect(runs).toBe(2);
    stop();
    expectRealmAtRest(realm);
  });

  for (const throws of [false, true]) {
    test(`a source hook that stops the linking autorun leaves nothing linked${throws ? ", when it throws" : ""}`, () => {
      const { realm, reports } = reporting();
      const flag = Box.make(realm, false);
      const boxes = [Box.make(realm, 0), Box.make(realm, 0), Box.make(realm, 0)] as const;
      let stop = (): void => {};
      Source.onObserved(boxes[1], () => {
        stop();
        if (throws) {
          throw new Error("the middle hook fails");
        }
        return undefined;
      });
      let running = 0;
      Source.onObserved(boxes[2], () => {
        running++;
        return () => {
          running--;
        };
      });
      stop = autorun(realm, (read) =>
        read(flag) ? read(boxes[0]) + read(boxes[1]) + read(boxes[2]) : 0,
      );

      set(realm, flag, true);

      expect(reports).toEqual(throws ? ["the middle hook fails"] : []);
      expect(observers(flag, ...boxes)).toEqual([0, 0, 0, 0]);
      expect(running).toBe(0);
      expectRealmAtRest(realm);
    });

    test(`a source hook that stops a computed value's only reader leaves nothing linked${throws ? ", when it throws" : ""}`, () => {
      const { realm, reports } = reporting();
      const flag = Box.make(realm, false);
      const boxes = [Box.make(realm, 0), Box.make(realm, 0), Box.make(realm, 0)] as const;
      const sum = Computed.make(realm, (read) => read(boxes[0]) + read(boxes[1]) + read(boxes[2]));
      let stop = (): void => {};
      Source.onObserved(boxes[1], () => {
        stop();
        if (throws) {
          throw new Error("the middle hook fails");
        }
        return undefined;
      });
      let running = 0;
      for (const source of [boxes[2], sum]) {
        Source.onObserved(source, () => {
          running++;
          return () => {
            running--;
          };
        });
      }
      stop = autorun(realm, (read) => (read(flag) ? read(sum) : 0));

      set(realm, flag, true);

      expect(reports).toEqual(throws ? ["the middle hook fails"] : []);
      expect(observers(sum, ...boxes)).toEqual([0, 0, 0, 0]);
      expect(running).toBe(0);
      expectRealmAtRest(realm);
    });
  }

  // Ruling 28: hooks settle by comparing once every link is done, so a hook
  // that stops the reader leaves the later sources' hooks never started.
  test("a hook that stops the linking autorun leaves the later hooks never started", () => {
    const { realm } = reporting();
    const flag = Box.make(realm, false);
    const boxes = [Box.make(realm, 0), Box.make(realm, 0), Box.make(realm, 0)] as const;
    let stop = (): void => {};
    Source.onObserved(boxes[0], () => {
      stop();
      return undefined;
    });
    const started: Array<string> = [];
    Source.onObserved(boxes[2], () => {
      started.push("last");
      return () => {
        started.push("last stopped");
      };
    });
    let runs = 0;
    stop = autorun(realm, (read) => {
      runs++;
      return read(flag) ? read(boxes[0]) + read(boxes[1]) + read(boxes[2]) : 0;
    });

    set(realm, flag, true);
    set(realm, boxes[2], 1);

    expect(started).toEqual([]);
    expect(runs).toBe(2);
    expectRealmAtRest(realm);
  });

  test("a computed value whose source hook throws on its first link still links the rest", () => {
    const { realm, reports } = reporting();
    const boxes = [Box.make(realm, 0), Box.make(realm, 0), Box.make(realm, 0)] as const;
    const sum = Computed.make(realm, (read) => read(boxes[0]) + read(boxes[1]) + read(boxes[2]));
    Source.onObserved(boxes[1], () => {
      throw new Error("the middle hook fails");
    });
    let sumHooks = 0;
    Source.onObserved(sum, () => {
      sumHooks++;
      return undefined;
    });
    let runs = 0;
    const stop = autorun(realm, (read) => {
      runs++;
      return read(sum);
    });

    expect(reports).toEqual(["the middle hook fails"]);
    expect(observers(...boxes)).toEqual([1, 1, 1]);
    expect(sumHooks).toBe(1);
    set(realm, boxes[2], 1);
    expect(runs).toBe(2);
    stop();
    expectRealmAtRest(realm);
  });
});

describe("errors a computed value keeps", () => {
  test("a thrown error is kept until what the run read changes", () => {
    const realm = Realm.make();
    const divisor = Box.make(realm, 0);
    let runs = 0;
    const ratio = Computed.make(realm, (read) => {
      runs++;
      const value = read(divisor);
      if (value === 0) {
        throw new Error("divide by zero");
      }
      return 10 / value;
    });
    expect(() => get(realm, ratio)).toThrow("divide by zero");
    expect(() => get(realm, ratio)).toThrow("divide by zero");
    expect(runs).toBe(1);
    set(realm, divisor, 2);
    expect(get(realm, ratio)).toBe(5);
    expectRealmAtRest(realm);
  });

  test("an observed computed value follows the sources its throwing run read", () => {
    const realm = Realm.make();
    const mode = Box.make(realm, "constant");
    const divisor = Box.make(realm, 0);
    const ratio = Computed.make(realm, (read) => {
      if (read(mode) === "constant") {
        return 1;
      }
      const value = read(divisor);
      if (value === 0) {
        throw new Error("divide by zero");
      }
      return 10 / value;
    });
    const shown = Computed.make(realm, (read) => {
      try {
        return String(read(ratio));
      } catch {
        return "error";
      }
    });
    const seen: Array<string> = [];
    const stop = watchInto(realm, (read) => read(shown), seen);
    set(realm, mode, "divide");
    set(realm, divisor, 5);
    expect(seen).toEqual(["error", "2"]);
    stop();
    expectRealmAtRest(realm);
  });
});

describe("watch order", () => {
  test("watchers run in the order they were marked, and their writes run in the next round", () => {
    const realm = Realm.make();
    const first = Box.make(realm, 0);
    const second = Box.make(realm, 0);
    const order: Array<string> = [];
    const stops = [
      Realm.watch(
        realm,
        (read) => read(second),
        () => {
          order.push("second");
          return undefined;
        },
      ),
      Realm.watch(
        realm,
        (read) => read(first),
        (value) => {
          order.push("first");
          set(realm, second, value);
          return undefined;
        },
      ),
      Realm.watch(
        realm,
        (read) => read(first),
        () => {
          order.push("first again");
          return undefined;
        },
      ),
    ];
    set(realm, first, 1);
    expect(order).toEqual(["first", "first again", "second"]);
    for (const stop of stops) stop();
    expectRealmAtRest(realm);
  });

  test("a watcher behind a computed value runs again in the next round after an earlier watcher writes", () => {
    const realm = Realm.make();
    const count = Box.make(realm, 0);
    const doubled = Computed.make(realm, (read) => read(count) * 2);
    const order: Array<string> = [];
    const stops = [
      Realm.watch(
        realm,
        (read) => read(count),
        (value) => {
          order.push(`first sees ${value}`);
          if (value < 3) {
            set(realm, count, value + 1);
          }
          return undefined;
        },
      ),
      Realm.watch(
        realm,
        (read) => read(doubled),
        (value) => {
          order.push(`second sees ${value}`);
          return undefined;
        },
      ),
    ];
    set(realm, count, 1);
    expect(order).toEqual([
      "first sees 1",
      "second sees 4",
      "first sees 2",
      "second sees 6",
      "first sees 3",
    ]);
    for (const stop of stops) stop();
    expectRealmAtRest(realm);
  });

  test("watchers run in link order after the first one stops", () => {
    const realm = Realm.make();
    const box = Box.make(realm, 0);
    const ran: Array<string> = [];
    const watch = (name: string) =>
      Realm.watch(
        realm,
        (read) => read(box),
        () => {
          ran.push(name);
          return undefined;
        },
      );
    const stops = ["first", "second", "third"].map(watch);
    stops[0]?.();
    stops.push(watch("fourth"));

    set(realm, box, 1);

    expect(ran).toEqual(["second", "third", "fourth"]);
    expect(observers(box)).toEqual([3]);
    for (const stop of stops) stop();
    expect(observers(box)).toEqual([0]);
    expectRealmAtRest(realm);
  });
});

describe("observer links", () => {
  test("a nested read after reordering keeps one link per reader", () => {
    const realm = Realm.make();
    const left = Box.make(realm, 1);
    const right = Box.make(realm, 2);
    const reversed = Box.make(realm, false);
    const derived = Computed.make(realm, (read) => read(right));
    const aggregate = Computed.make(realm, (read) => {
      if (read(reversed)) {
        read(right);
        read(left);
      } else {
        read(left);
        read(right);
      }
      return read(derived) + read(right);
    });
    const stop = autorun(realm, (read) => read(aggregate));
    Realm.update(realm, (_read, write) => {
      write(right, 3);
      write(reversed, true);
    });
    expect(get(realm, aggregate)).toBe(6);
    expect(observers(right)).toEqual([2]);
    stop();
    expect(observers(right)).toEqual([0]);
    expectRealmAtRest(realm);
  });

  test("a wide aggregate of 8,000 rows releases the rows it drops", () => {
    const realm = Realm.make();
    const width = 8000;
    const rows = Array.from({ length: width }, (_, index) => {
      const source = Box.make(realm, index);
      return { source, derived: Computed.make(realm, (read) => 2 * read(source)) };
    });
    const count = Box.make(realm, width);
    const aggregate = Computed.make(realm, (read) => {
      let total = 0;
      for (let index = 0; index < read(count); index++) {
        const row = rows[index] as (typeof rows)[number];
        total += read(row.derived) + read(row.source);
      }
      return total;
    });
    expect(get(realm, aggregate)).toBe((3 * width * (width - 1)) / 2);
    const stop = autorun(realm, (read) => read(aggregate));
    const first = rows[0] as (typeof rows)[number];
    const last = rows[width - 1] as (typeof rows)[number];
    expect(observers(first.source, last.source)).toEqual([2, 2]);
    set(realm, first.source, 10);
    expect(get(realm, aggregate)).toBe((3 * width * (width - 1)) / 2 + 30);
    set(realm, count, 1);
    expect(get(realm, aggregate)).toBe(30);
    expect(observers(last.source)).toEqual([0]);
    stop();
    expect(observers(first.source)).toEqual([0]);
    expectRealmAtRest(realm);
  });

  test("a source read twice around a computed value that reads it too is linked once per reader and unlinked fully", () => {
    const realm = Realm.make();
    const box = Box.make(realm, 1);
    const flag = Box.make(realm, true);
    const inner = Computed.make(realm, (read) => read(box) * 10);
    const outer = Computed.make(realm, (read) => {
      const before = read(box);
      const middle = read(flag) ? read(inner) : 0;
      return before + middle + read(box);
    });
    const seen: Array<number> = [];
    const stop = watchInto(realm, (read) => read(outer), seen);
    expect(observers(box)).toEqual([2]);

    set(realm, box, 2);
    set(realm, flag, false);
    expect(observers(box, inner)).toEqual([1, 0]);
    set(realm, flag, true);
    expect(observers(box)).toEqual([2]);
    set(realm, box, 3);

    expect(seen).toEqual([24, 4, 24, 36]);
    stop();
    expect(observers(box, flag, inner)).toEqual([0, 0, 0]);
    expectRealmAtRest(realm);
  });

  test("a computed value a run reads twice is linked once after a recompute", () => {
    const realm = Realm.make();
    const box = Box.make(realm, 1);
    const doubled = Computed.make(realm, (read) => read(box) * 2);
    const sum = Computed.make(realm, (read) => read(doubled) + read(doubled));
    const seen: Array<number> = [];
    const stop = watchInto(realm, (read) => read(sum), seen);
    expect(observers(doubled)).toEqual([1]);

    set(realm, box, 2);
    set(realm, box, 3);

    expect(seen).toEqual([8, 12]);
    expect(observers(doubled)).toEqual([1]);
    stop();
    expect(observers(doubled)).toEqual([0]);
    expectRealmAtRest(realm);
  });

  test("a rerun that drops one source keeps the links to the rest", () => {
    const realm = Realm.make();
    const flag = Box.make(realm, true);
    const left = Box.make(realm, "left");
    const right = Box.make(realm, "right");
    const kept = Box.make(realm, "kept");
    let runs = 0;
    const stop = autorun(realm, (read) => {
      runs++;
      return `${read(kept)} ${read(flag) ? read(left) : read(right)}`;
    });

    set(realm, flag, false);
    expect(observers(left, right, kept)).toEqual([0, 1, 1]);
    runs = 0;
    set(realm, left, "ignored");
    expect(runs).toBe(0);
    set(realm, kept, "still kept");
    set(realm, right, "right again");
    expect(runs).toBe(2);
    stop();
    expect(observers(flag, left, right, kept)).toEqual([0, 0, 0, 0]);
    expectRealmAtRest(realm);
  });

  test("a recompute that reads fewer sources in another order unlinks every one it dropped", () => {
    const realm = Realm.make();
    const flip = Box.make(realm, false);
    const boxes = [0, 1, 2, 3, 4].map((value) => Box.make(realm, value));
    const at = (index: number): Box<number> => boxes[index] as Box<number>;
    const sum = Computed.make(realm, (read) =>
      read(flip) ? read(at(4)) + read(at(2)) : boxes.reduce((total, box) => total + read(box), 0),
    );
    const seen: Array<number> = [];
    const stop = watchInto(realm, (read) => read(sum), seen);

    // The source read again, the third, sits between dropped ones in the old
    // list: the one after it must be unlinked too.
    set(realm, flip, true);
    expect(observers(...boxes)).toEqual([0, 0, 1, 0, 1]);
    set(realm, flip, false);
    expect(observers(...boxes)).toEqual([1, 1, 1, 1, 1]);
    stop();

    expect(seen).toEqual([6, 10]);
    expect(observers(...boxes)).toEqual([0, 0, 0, 0, 0]);
    expectRealmAtRest(realm);
  });

  test("a computed value that loses its last reader during its own run leaves the sources it just read to their other readers", () => {
    const realm = Realm.make();
    const flag = Box.make(realm, false);
    const shared = Box.make(realm, 0);
    const late: { value?: Computed<number> } = {};
    // On the flag, `inner` reads `shared` for the first time and then
    // `outer`, which stops reading `inner`: `inner` loses its last reader
    // while its run has read `shared` and not linked it yet.
    const inner = Computed.make(realm, (read) => {
      if (!read(flag)) {
        return 0;
      }
      read(shared);
      return (late.value === undefined ? 0 : read(late.value)) + 1;
    });
    const outer = Computed.make(realm, (read) => (read(flag) ? 10 : read(inner)));
    late.value = outer;
    const stopOuter = autorun(realm, (read) => read(outer));
    const seen: Array<number> = [];
    const stopShared = watchInto(realm, (read) => read(shared), seen);

    Realm.update(realm, (_read, write) => {
      write(flag, true);
      get(realm, inner);
    });
    set(realm, shared, 1);

    expect(seen).toEqual([1]);
    expect(observers(shared, inner)).toEqual([1, 0]);
    stopOuter();
    stopShared();
    expect(observers(flag, shared)).toEqual([0, 0]);
    expectRealmAtRest(realm);
  });

  test("an autorun whose rerun throws after reading a source out of order keeps every source linked once", () => {
    const { realm, reports } = reporting();
    const failing = Box.make(realm, false);
    const boxes = [Box.make(realm, 0), Box.make(realm, 1), Box.make(realm, 2)] as const;
    const stop = autorun(realm, (read) => {
      if (read(failing)) {
        // The failed run reads the last source first: its old link goes, and
        // the sources it never reached stay linked.
        read(boxes[2]);
        throw new Error("the run fails");
      }
      return read(boxes[0]) + read(boxes[1]) + read(boxes[2]);
    });

    set(realm, failing, true);

    expect(reports).toEqual(["the run fails"]);
    expect(observers(...boxes)).toEqual([1, 1, 1]);
    stop();
    expect(observers(failing, ...boxes)).toEqual([0, 0, 0, 0]);
    expectRealmAtRest(realm);
  });
});

describe("repeat writes in one update", () => {
  test("a computed value written a hundred times in one update reruns its reader once", () => {
    const realm = Realm.make();
    const base = Box.make(realm, 0);
    const doubled = Computed.make(realm, (read) => read(base) * 2);
    const seen: Array<number> = [];
    const stop = autorun(realm, (read) => seen.push(read(doubled)));

    Realm.update(realm, (_read, write) => {
      for (let index = 1; index <= 100; index++) {
        write(base, index);
      }
    });
    expect(seen).toEqual([0, 200]);

    set(realm, base, 0);
    expect(seen).toEqual([0, 200, 0]);
    stop();
    expectRealmAtRest(realm);
  });

  test("a box written again in an update reaches a watch made between the writes", () => {
    const realm = Realm.make();
    const base = Box.make(realm, 0);
    const doubled = Computed.make(realm, (read) => read(base) * 2);
    const seen: Array<string> = [];
    const stopFirst = Realm.watch(
      realm,
      (read) => read(doubled),
      (value) => {
        seen.push(`first ${value}`);
        return undefined;
      },
    );
    let stopSecond = (): void => {};

    Realm.update(realm, (_read, write) => {
      write(base, 1);
      stopSecond = Realm.watch(
        realm,
        (read) => read(base),
        (value) => {
          seen.push(`second ${value}`);
          return undefined;
        },
      );
      write(base, 2);
    });

    expect(seen).toEqual(["first 4", "second 2"]);
    stopFirst();
    stopSecond();
    expectRealmAtRest(realm);
  });

  test("a watch whose select throws before reading a computed value reruns on its next change", () => {
    const { realm, reports } = reporting();
    const failing = Box.make(realm, false);
    const base = Box.make(realm, 0);
    const doubled = Computed.make(realm, (read) => read(base) * 2);
    const seen: Array<number> = [];
    const stop = watchInto(
      realm,
      (read) => {
        if (read(failing)) {
          throw new Error("the select fails");
        }
        return read(doubled);
      },
      seen,
    );

    Realm.update(realm, (_read, write) => {
      write(failing, true);
      write(base, 1);
    });
    expect(reports).toEqual(["the select fails"]);

    set(realm, base, 2);
    expect(reports).toEqual(["the select fails", "the select fails"]);

    set(realm, failing, false);
    expect(seen).toEqual([4]);
    stop();
    expectRealmAtRest(realm);
  });

  test("a watch left unrun at the round limit reruns on the next change of a computed value", () => {
    const { realm, reports } = reporting();
    const loop = Box.make(realm, 0);
    const base = Box.make(realm, 0);
    const doubled = Computed.make(realm, (read) => read(base) * 2);
    const seen: Array<number> = [];
    const stopSeen = watchInto(realm, (read) => read(doubled), seen);
    let looping = true;
    let count = 0;
    const stopLoop = Realm.watch(
      realm,
      (read) => read(loop),
      () => {
        if (looping) {
          count++;
          Realm.update(realm, (_read, write) => {
            write(base, count);
            write(loop, count);
          });
        }
        return undefined;
      },
    );

    set(realm, loop, -1);
    expect(reports).toEqual([expect.stringMatching(/did not settle/)]);
    expect(seen.at(-1)).toBeLessThan(count * 2);

    looping = false;
    set(realm, base, 1000);
    expect(seen.at(-1)).toBe(2000);
    stopSeen();
    stopLoop();
    expectRealmAtRest(realm);
  });

  test("an autorun made inside an update on stale reads hears a later write in it", () => {
    const realm = Realm.make();
    const other = Box.make(realm, 0);
    const base = Box.make(realm, 0);
    const doubled = Computed.make(realm, (read) => read(base) * 2);
    const stopWatch = autorun(realm, (read) => read(doubled));
    const seen: Array<number> = [];
    let stop = (): void => {};

    Realm.update(realm, (_read, write) => {
      write(other, 1);
      write(base, 1);
      stop = autorun(realm, (read) => seen.push(read(other) + read(doubled)));
      write(base, 2);
    });

    expect(seen.at(-1)).toBe(5);
    stop();
    stopWatch();
    expectRealmAtRest(realm);
  });
});

describe("a computed value cannot write, however deep", () => {
  const refused = expect.objectContaining({ code: "pinna/update-in-derivation" }) as never;

  test("through nested untracked calls", () => {
    const realm = Realm.make();
    const box = Box.make(realm, 1);
    const value = Computed.make(realm, () =>
      Realm.untracked(realm, () => Realm.untracked(realm, () => set(realm, box, 2))),
    );
    expect(() => get(realm, value)).toThrow(refused);
    expect(get(realm, box)).toBe(1);
    expectRealmAtRest(realm);
  });

  test("through untracked inside a custom equals", () => {
    const realm = Realm.make();
    const box = Box.make(realm, 1);
    const source = Box.make(realm, 0);
    const value = Computed.make(realm, (read) => read(source), {
      equals: () => {
        Realm.untracked(realm, () => set(realm, box, 5));
        return false;
      },
    });
    get(realm, value);
    set(realm, source, 1);
    expect(() => get(realm, value)).toThrow(refused);
    expect(get(realm, box)).toBe(1);
    expectRealmAtRest(realm);
  });

  test("a hook begun by a computed value's read still writes, after the read settles", () => {
    const realm = Realm.make();
    const observed = Box.make(realm, 0);
    const written = Box.make(realm, 0);
    Source.onObserved(observed, () => {
      set(realm, written, 1);
      return undefined;
    });
    const value = Computed.make(realm, (read) => read(observed));
    const stop = autorun(realm, (read) => read(value));
    expect(get(realm, written)).toBe(1);
    stop();
    expectRealmAtRest(realm);
  });
});

describe("a stopped watch", () => {
  test("that stops itself in its own select does not run its effect", () => {
    const realm = Realm.make();
    const box = Box.make(realm, 0);
    const effects: Array<number> = [];
    let stop: () => void = () => {};
    stop = Realm.watch(
      realm,
      (read) => {
        const value = read(box);
        if (value > 0) {
          stop();
        }
        return value;
      },
      (value) => {
        effects.push(value);
        return undefined;
      },
    );
    set(realm, box, 1);
    set(realm, box, 2);
    expect(effects).toEqual([]);
    expect(observers(box)).toEqual([0]);
    expectRealmAtRest(realm);
  });
});
