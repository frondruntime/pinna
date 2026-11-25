import { describe, expect, test } from "bun:test";
import { Atom, Box, Computed, type Read, Realm, Source } from "../src/index.ts";
import { captureReports } from "./reports.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * An observing call links or unlinks everything first, then starts or stops
 * the hooks: a hook or cleanup sees every observer count in place, and at
 * rest a source's hooks are started exactly when it is observed. A read
 * outside an update settles once it is over, and a computed value's equals
 * is part of its compute. The public twin of
 * `test/internal/links-first.test.ts`; the cases there that need a core
 * `Reaction` activated apart from its track, or a hook that begins inside a
 * compute (`onObservedNow`), have no public form and stay there.
 */

const quiet = (): Realm => Realm.make({ onError: () => {} });

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

describe("a hook sees every count in place", () => {
  test("an autorun's first run starts a hook once its later sources are linked", () => {
    const realm = quiet();
    const boxes = [Box.make(realm, 0), Box.make(realm, 0), Box.make(realm, 0)] as const;
    const seen: Array<ReadonlyArray<number>> = [];
    Source.onObserved(boxes[0], () => {
      seen.push(observers(boxes[1], boxes[2]));
      return () => {
        seen.push(observers(boxes[1], boxes[2]));
      };
    });

    const stop = autorun(realm, (read) => read(boxes[0]) + read(boxes[1]) + read(boxes[2]));
    stop();
    expect(seen).toEqual([
      [1, 1],
      [0, 0],
    ]);
    expectRealmAtRest(realm);
  });

  test("a computed value's first source starts its hook once the computed value's later sources are linked", () => {
    const realm = quiet();
    const boxes = [Box.make(realm, 0), Box.make(realm, 0), Box.make(realm, 0)] as const;
    const sum = Computed.make(realm, (read) => read(boxes[0]) + read(boxes[1]) + read(boxes[2]));
    const seen: Array<ReadonlyArray<number>> = [];
    Source.onObserved(boxes[0], () => {
      seen.push(observers(sum, boxes[1], boxes[2]));
      return () => {
        seen.push(observers(sum, boxes[1], boxes[2]));
      };
    });

    const stop = autorun(realm, (read) => read(sum));
    stop();
    expect(seen).toEqual([
      [1, 1, 1],
      [0, 0, 0],
    ]);
    expectRealmAtRest(realm);
  });

  test("a relink starts the new source's hook once the dropped one is unlinked", () => {
    const realm = quiet();
    const flag = Box.make(realm, false);
    const left = Box.make(realm, 1);
    const right = Box.make(realm, 2);
    const pick = Computed.make(realm, (read) => (read(flag) ? read(right) : read(left)));
    const seen: Array<number> = [];
    Source.onObserved(right, () => {
      seen.push(Source.inspect(left).observers);
      return undefined;
    });
    const stop = autorun(realm, (read) => read(pick));

    set(realm, flag, true);
    expect(seen).toEqual([0]);
    stop();
    expectRealmAtRest(realm);
  });
});

describe("a hook's write while a computed value links", () => {
  test("leaves the computed value linked only to what it reads", () => {
    const realm = quiet();
    const gate = Box.make(realm, 0);
    const middle = Box.make(realm, 0);
    const near = Box.make(realm, 10);
    const far = Box.make(realm, 20);
    const pick = Computed.make(realm, (read) => {
      if (read(gate) > 0) {
        return read(near);
      }
      read(middle);
      return read(far);
    });
    let middleRunning = false;
    Source.onObserved(middle, () => {
      middleRunning = true;
      set(realm, gate, 1);
      return () => {
        middleRunning = false;
      };
    });
    let runs = 0;
    const stop = autorun(realm, (read) => {
      runs++;
      return read(pick);
    });

    expect(get(realm, pick)).toBe(10);
    expect(observers(gate, near, middle, far)).toEqual([1, 1, 0, 0]);
    expect(middleRunning).toBe(false);
    expect(runs).toBe(2);
    stop();
    expectRealmAtRest(realm);
  });

  test("a read that relinks a stale computed value sees the hook's write next", () => {
    const realm = quiet();
    const trigger = Box.make(realm, 0);
    const flag = Box.make(realm, false);
    const base = Box.make(realm, 1);
    const extra = Box.make(realm, 0);
    const added = Computed.make(realm, (read) =>
      read(flag) ? read(base) + read(extra) : read(base),
    );
    Source.onObserved(extra, () => {
      set(realm, extra, 5);
      return undefined;
    });
    const seen: Array<number> = [];
    // The trigger comes first, so a change to it reruns the autorun, which
    // relinks the computed value.
    const stop = autorun(realm, (read) => seen.push(read(trigger) + read(added)));

    Realm.update(realm, (_read, write) => {
      write(trigger, 1);
      write(flag, true);
    });
    expect(get(realm, added)).toBe(6);
    expect(seen.at(-1)).toBe(7);
    stop();
    expectRealmAtRest(realm);
  });
});

describe("at rest, hooks are started exactly when observed", () => {
  test("a hook added inside an update to an observed source starts when the update ends", () => {
    const realm = quiet();
    const box = Box.make(realm, 0);
    const stop = autorun(realm, (read) => read(box));
    const log: Array<string> = [];
    Realm.update(realm, () => {
      Source.onObserved(box, () => {
        log.push("start");
        return undefined;
      });
      log.push("added");
    });
    expect(log).toEqual(["added", "start"]);
    stop();
    expectRealmAtRest(realm);
  });

  test("a hook added to an observed source while a computed value computes starts once the read is over", () => {
    const realm = quiet();
    const box = Box.make(realm, 0);
    const stop = autorun(realm, (read) => read(box));
    const log: Array<string> = [];
    const adds = Computed.make(realm, () => {
      Source.onObserved(box, () => {
        log.push("start");
        return undefined;
      });
      log.push("computed");
      return 0;
    });
    get(realm, adds);
    expect(log).toEqual(["computed", "start"]);
    stop();
    expectRealmAtRest(realm);
  });

  test("a watch that stops itself in its own select leaves nothing linked", () => {
    const realm = quiet();
    const box = Box.make(realm, 0);
    const log: Array<string> = [];
    Source.onObserved(box, () => {
      log.push("start");
      return () => {
        log.push("stop");
      };
    });
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
      () => undefined,
    );

    set(realm, box, 1);
    expect(observers(box)).toEqual([0]);
    expect(log).toEqual(["start", "stop"]);
    expectRealmAtRest(realm);
  });
});

describe("an onError that throws while an observing call settles", () => {
  const failing = (): Realm =>
    Realm.make({
      onError: () => {
        throw new Error("onError fails");
      },
    });

  test("a hook's error goes to the host and the autorun is made", () => {
    const realm = failing();
    const box = Box.make(realm, 0);
    Source.onObserved(box, () => {
      throw new Error("the hook fails");
    });
    let stop: (() => void) | undefined;
    const reports = captureReports(() => {
      stop = autorun(realm, (read) => read(box));
    });
    expect(reports.map((error) => (error as Error).message)).toEqual(["onError fails"]);
    expect(observers(box)).toEqual([1]);
    stop?.();
    expectRealmAtRest(realm);
  });
});

describe("a computed value cannot observe or release while it computes", () => {
  const refused = expect.objectContaining({ code: "pinna/observe-while-computing" }) as never;

  for (const call of ["Realm.autorun", "Realm.watch", "a stop"] as const) {
    test(`${call} in a computed value throws and links nothing`, () => {
      const realm = quiet();
      const box = Box.make(realm, 0);
      const kept = autorun(realm, (read) => read(box));
      const bad = Computed.make(realm, () => {
        if (call === "Realm.autorun") autorun(realm, (read) => read(box));
        else if (call === "Realm.watch")
          Realm.watch(
            realm,
            (read) => read(box),
            () => undefined,
          );
        else kept();
        return 0;
      });
      expect(() => get(realm, bad)).toThrow(refused);
      expect(observers(box)).toEqual([1]);
      kept();
      expect(observers(box)).toEqual([0]);
      expectRealmAtRest(realm);
    });
  }
});

describe("a hook removed while a computed value computes", () => {
  test("runs its cleanup once the read is over, not inside the compute", () => {
    const realm = quiet();
    const box = Box.make(realm, 0);
    const stop = autorun(realm, (read) => read(box));
    const remove = Source.onObserved(box, () => () => {
      stop();
    });
    let during = -1;
    const removes = Computed.make(realm, () => {
      remove();
      during = Source.inspect(box).observers;
      return 0;
    });

    get(realm, removes);
    expect(during).toBe(1);
    expect(observers(box)).toEqual([0]);
    expectRealmAtRest(realm);
  });

  test("ends at the settle, so a cleanup's write leaves the computed value linked only to what it reads", () => {
    const realm = quiet();
    const gate = Box.make(realm, 0);
    const near = Box.make(realm, 10);
    const far = Box.make(realm, 20);
    const anchor = Box.make(realm, 0);
    const tick = Box.make(realm, 0);
    const stopAnchor = autorun(realm, (read) => read(anchor));
    const order: Array<string> = [];
    const remove = Source.onObserved(anchor, () => () => {
      order.push("cleanup");
      set(realm, gate, 1);
    });
    let removing = false;
    const trigger = Computed.make(realm, (read) => {
      read(tick);
      if (removing) {
        removing = false;
        remove();
        order.push("compute ends");
      }
      return 0;
    });
    const pick = Computed.make(realm, (read) => {
      if (read(gate) > 0) {
        return read(near);
      }
      read(trigger);
      return read(far);
    });
    const stop = autorun(realm, (read) => read(pick));
    removing = true;
    set(realm, tick, 1);

    expect(order).toEqual(["compute ends", "cleanup"]);
    expect(get(realm, pick)).toBe(10);
    expect(observers(gate, near, trigger, far)).toEqual([1, 1, 0, 0]);
    stop();
    stopAnchor();
    expect(observers(gate, near, trigger, far)).toEqual([0, 0, 0, 0]);
    expectRealmAtRest(realm);
  });
});

describe("a computed value's equals is part of its compute, through the realm", () => {
  test("equals cannot observe, outermost or nested", () => {
    const realm = quiet();
    const source = Box.make(realm, 0);
    const other = Box.make(realm, 0);
    const observeOnChange = (_left: number, right: number): boolean => {
      if (right === 1) {
        autorun(realm, (read) => read(other));
      }
      return false;
    };
    const outermost = Computed.make(realm, (read) => read(source), { equals: observeOnChange });
    const inner = Computed.make(realm, (read) => read(source), { equals: observeOnChange });
    const outer = Computed.make(realm, (read) => read(inner));
    get(realm, outermost);
    get(realm, outer);
    set(realm, source, 1);

    const refused = expect.objectContaining({ code: "pinna/observe-while-computing" }) as never;
    expect(() => get(realm, outermost)).toThrow(refused);
    expect(() => get(realm, outer)).toThrow(refused);
    expect(observers(other)).toEqual([0]);
    expectRealmAtRest(realm);
  });

  test("a hook removed in equals ends at the settle, seeing every count in place", () => {
    const realm = quiet();
    const source = Box.make(realm, 0);
    const later = Box.make(realm, 0);
    const watched = Box.make(realm, 0);
    const stopWatched = autorun(realm, (read) => read(watched));
    const seen: Array<number> = [];
    const remove = Source.onObserved(watched, () => () => {
      seen.push(Source.inspect(later).observers);
    });
    const value = Computed.make(realm, (read) => read(source), {
      equals: (left, right) => {
        if (right === 1) {
          remove();
        }
        return left === right;
      },
    });
    get(realm, value);
    set(realm, source, 1);
    const stop = autorun(realm, (read) => read(value) + read(later));

    expect(seen).toEqual([1]);
    stop();
    stopWatched();
    expectRealmAtRest(realm);
  });
});

describe("an equals that throws is kept as the value's error", () => {
  const throwingOn =
    (thrownFor: number) =>
    (left: number, right: number): boolean => {
      if (right === thrownFor) {
        throw new Error("equals");
      }
      return left === right;
    };

  test("a read throws it until a source changes, and never serves the old value", () => {
    const realm = quiet();
    const source = Box.make(realm, 0);
    const value = Computed.make(realm, (read) => read(source), { equals: throwingOn(1) });
    expect(get(realm, value)).toBe(0);
    set(realm, source, 1);

    expect(() => get(realm, value)).toThrow("equals");
    expect(() => get(realm, value)).toThrow("equals");
    set(realm, source, 2);
    expect(get(realm, value)).toBe(2);
    expectRealmAtRest(realm);
  });

  test("an autorun sees it as a change and reports it", () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const source = Box.make(realm, 0);
    const value = Computed.make(realm, (read) => read(source), { equals: throwingOn(1) });
    const seen: Array<number> = [];
    const stop = autorun(realm, (read) => seen.push(read(value)));
    set(realm, source, 1);

    expect(errors.map(String)).toEqual(["Error: equals"]);
    expect(() => get(realm, value)).toThrow("equals");
    set(realm, source, 2);
    expect(get(realm, value)).toBe(2);
    expect(seen.at(-1)).toBe(2);
    stop();
    expectRealmAtRest(realm);
  });

  test("an autorun that starts over it links everything and reports the error", () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const first = Box.make(realm, 0);
    const source = Box.make(realm, 0);
    const log: Array<string> = [];
    Source.onObserved(first, () => {
      log.push("start");
      return () => log.push("stop");
    });
    const value = Computed.make(realm, (read) => read(source), { equals: throwingOn(1) });
    get(realm, value);
    set(realm, source, 1);
    const flag = Box.make(realm, false);
    const stop = autorun(realm, (read) => (read(flag) ? read(first) + read(value) : 0));

    set(realm, flag, true);
    expect(errors.map(String)).toEqual(["Error: equals"]);
    expect(observers(first, value)).toEqual([1, 1]);
    stop();
    expect(observers(first, value)).toEqual([0, 0]);
    expect(log).toEqual(["start", "stop"]);
    expectRealmAtRest(realm);
  });
});

describe("a computed value that starts reading an atom in a run with an equal value, through the realm", () => {
  test("its readers learn it, and check it on every read", () => {
    const realm = quiet();
    const mode = Box.make(realm, false);
    const atom = Atom.make(realm);
    let outside = 1;
    const value = Computed.make(realm, (read) => {
      if (read(mode)) {
        read(atom);
      }
      return outside;
    });
    const reader = Computed.make(realm, (read) => read(value));
    expect(get(realm, reader)).toBe(1);
    set(realm, mode, true);
    expect(get(realm, reader)).toBe(1);
    outside = 2;

    expect(get(realm, value)).toBe(2);
    expect(get(realm, reader)).toBe(2);
    expectRealmAtRest(realm);
  });

  test("with an equal value it keeps its previous instance", () => {
    const realm = quiet();
    const mode = Box.make(realm, false);
    const atom = Atom.make(realm);
    const value = Computed.make(
      realm,
      (read) => {
        if (read(mode)) {
          read(atom);
        }
        return [1, 2];
      },
      {
        equals: (left, right) =>
          left.length === right.length && left.every((item, index) => item === right[index]),
      },
    );
    const before = get(realm, value);
    set(realm, mode, true);
    expect(get(realm, value)).toBe(before);
    expectRealmAtRest(realm);
  });
});

describe("a read of a computed value from inside its own equals", () => {
  test("is a cycle, kept as the value's error, and both recover", () => {
    const realm = quiet();
    const source = Box.make(realm, 0);
    let reader: Computed<number> | undefined;
    const value = Computed.make(realm, (read) => read(source), {
      equals: (left, right) => {
        if (reader !== undefined) {
          get(realm, reader);
        }
        return left === right;
      },
    });
    const tenfold = Computed.make(realm, (read) => read(value) * 10);
    reader = tenfold;
    expect(get(realm, tenfold)).toBe(0);
    set(realm, source, 1);

    expect(() => get(realm, value)).toThrow(
      expect.objectContaining({ code: "pinna/cycle" }) as never,
    );
    expect(() => get(realm, tenfold)).toThrow(
      expect.objectContaining({ code: "pinna/cycle" }) as never,
    );
    reader = undefined;
    set(realm, source, 2);
    expect(get(realm, value)).toBe(2);
    expect(get(realm, tenfold)).toBe(20);
    expectRealmAtRest(realm);
  });
});

describe("memo making an entry inside a compute that a read outside an update runs", () => {
  test("does not end a hook removed earlier in the compute before the read is over", () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const $x = Box.make(realm, 0);
    Realm.watch(
      realm,
      (read) => read($x),
      () => {},
    );
    let computing = false;
    const seen: Array<boolean> = [];
    const remove = Source.onObserved($x, () => () => {
      seen.push(computing);
    });
    const square = Computed.fn(realm, (_read, n: number) => n * n);
    const $d = Computed.make(realm, (read) => {
      computing = true;
      remove();
      const value = read(square(5));
      computing = false;
      return value;
    });

    expect(Realm.untracked(realm, (read) => read($d))).toBe(25);
    expect(errors).toEqual([]);
    expect(seen).toEqual([false]);
  });

  test("does not rerun, mid-compute, a watcher that reads the computing value", () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const $x = Box.make(realm, 0);
    const $y = Box.make(realm, 0);
    Realm.watch(
      realm,
      (read) => read($x),
      () => {},
    );
    const remove = Source.onObserved($x, () => () => {
      Realm.update(realm, (_read, write) => {
        write($y, 1);
      });
    });
    const square = Computed.fn(realm, (_read, n: number) => n * n);
    const $d = Computed.make(realm, (read) => {
      remove();
      return read(square(3));
    });
    const seen: Array<number> = [];
    Realm.watch(
      realm,
      (read) => read($y),
      () => {
        seen.push(Realm.untracked(realm, (read) => read($d)));
      },
    );

    expect(Realm.untracked(realm, (read) => read($d))).toBe(9);
    expect(errors.map(String)).toEqual([]);
    expect(seen).toEqual([9]);
  });

  test("does not evict an entry made earlier in the same compute", () => {
    const realm = Realm.make();
    let computes = 0;
    const square = Computed.fn(realm, (_read, n: number) => {
      computes++;
      return n * n;
    });
    const $d = Computed.make(realm, (read) => read(square(2)) + read(square(3)) + read(square(2)));
    expect(Realm.untracked(realm, (read) => read($d))).toBe(17);
    expect(computes).toBe(2);
  });
});

describe("a read outside an update settles once it is over", () => {
  test("a refused update inside the compute does not evict a memo entry made earlier in it", () => {
    const realm = Realm.make();
    let computes = 0;
    const square = Computed.fn(realm, (_read, n: number) => {
      computes++;
      return n * n;
    });
    const $d = Computed.make(realm, (read) => {
      const first = read(square(2));
      expect(() => Realm.untracked(realm, () => Realm.update(realm, () => undefined))).toThrow(
        "update cannot run in a computed value",
      );
      return first + read(square(2));
    });
    expect(Realm.untracked(realm, (read) => read($d))).toBe(8);
    expect(computes).toBe(1);
  });

  test("a refused update inside the compute does not run a cleanup removed earlier in it", () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const $x = Box.make(realm, 0);
    Realm.watch(
      realm,
      (read) => read($x),
      () => {},
    );
    let computing = false;
    const seen: Array<boolean> = [];
    const remove = Source.onObserved($x, () => () => {
      seen.push(computing);
    });
    const $d = Computed.make(realm, () => {
      computing = true;
      remove();
      expect(() => Realm.untracked(realm, () => Realm.update(realm, () => undefined))).toThrow(
        "update cannot run in a computed value",
      );
      computing = false;
      return 1;
    });
    expect(Realm.untracked(realm, (read) => read($d))).toBe(1);
    expect(errors).toEqual([]);
    expect(seen).toEqual([false]);
  });

  test("a failing update inside the compute settles nothing before the read is over", () => {
    const realm = Realm.make();
    const $y = Box.make(realm, 0);
    let computes = 0;
    const square = Computed.fn(realm, (_read, n: number) => {
      computes++;
      return n * n;
    });
    const $d = Computed.make(realm, (read) => {
      const first = read(square(2));
      try {
        Realm.untracked(realm, () =>
          Realm.update(realm, (_read, write) => {
            write($y, 1);
          }),
        );
      } catch {}
      return first + read(square(2));
    });
    expect(Realm.untracked(realm, (read) => read($d))).toBe(8);
    expect(computes).toBe(1);
  });

  test("a refused update inside the compute does not rerun, mid-compute, a watcher that reads the computing value", () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const $x = Box.make(realm, 0);
    const $y = Box.make(realm, 0);
    Realm.watch(
      realm,
      (read) => read($x),
      () => {},
    );
    const remove = Source.onObserved($x, () => () => {
      Realm.update(realm, (_read, write) => {
        write($y, 1);
      });
    });
    const $d = Computed.make(realm, () => {
      remove();
      expect(() => Realm.untracked(realm, () => Realm.update(realm, () => undefined))).toThrow(
        "update cannot run in a computed value",
      );
      return 9;
    });
    const seen: Array<number> = [];
    Realm.watch(
      realm,
      (read) => read($y),
      () => {
        seen.push(Realm.untracked(realm, (read) => read($d)));
      },
    );
    expect(Realm.untracked(realm, (read) => read($d))).toBe(9);
    expect(errors.map(String)).toEqual([]);
    expect(seen).toEqual([9]);
  });

  test("a read that throws out of equals still runs a cleanup removed in the compute", () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const $x = Box.make(realm, 0);
    Realm.watch(
      realm,
      (read) => read($x),
      () => {},
    );
    const seen: Array<string> = [];
    const remove = Source.onObserved($x, () => () => {
      seen.push("cleanup");
    });
    const $src = Box.make(realm, 0);
    const $d = Computed.make(
      realm,
      (read) => {
        const value = read($src);
        if (value === 1) {
          remove();
        }
        return value;
      },
      {
        equals: (left, right) => {
          if (right === 1) {
            throw new Error("equals");
          }
          return left === right;
        },
      },
    );
    expect(Realm.untracked(realm, (read) => read($d))).toBe(0);
    Realm.update(realm, (_read, write) => {
      write($src, 1);
    });
    expect(() => Realm.untracked(realm, (read) => read($d))).toThrow("equals");
    // Ruling 31: the cleanup runs once the outermost read is over.
    expect(seen).toEqual(["cleanup"]);
  });

  test("a read that throws out of equals leaves nothing due, so a later hook begins at once", () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const $x = Box.make(realm, 0);
    Realm.watch(
      realm,
      (read) => read($x),
      () => {},
    );
    const remove = Source.onObserved($x, () => undefined);
    const $src = Box.make(realm, 0);
    const $d = Computed.make(
      realm,
      (read) => {
        if (read($src) === 1) {
          remove();
        }
        return read($src);
      },
      {
        equals: (_left, right) => {
          if (right === 1) {
            throw new Error("equals");
          }
          return false;
        },
      },
    );
    expect(Realm.untracked(realm, (read) => read($d))).toBe(0);
    Realm.update(realm, (_read, write) => {
      write($src, 1);
    });
    expect(() => Realm.untracked(realm, (read) => read($d))).toThrow("equals");
    const log: Array<string> = [];
    Source.onObserved($x, () => {
      log.push("start");
      return undefined;
    });
    // Ruling 31: outside an update, compute, or observing call, a hook on an observed observable begins at once.
    expect(log).toEqual(["start"]);
  });

  test("a read that throws out of equals after memo runs a cleanup removed in the compute once it is over", () => {
    const realm = Realm.make();
    const $x = Box.make(realm, 0);
    Realm.watch(
      realm,
      (read) => read($x),
      () => {},
    );
    let computing = false;
    const seen: Array<boolean> = [];
    const remove = Source.onObserved($x, () => () => {
      seen.push(computing);
    });
    const square = Computed.fn(realm, (_read, n: number) => n * n);
    const $src = Box.make(realm, 0);
    const $d = Computed.make(
      realm,
      (read) => {
        const value = read($src);
        if (value === 1) {
          computing = true;
          remove();
          read(square(3));
          computing = false;
        }
        return value;
      },
      {
        equals: (_left, right) => {
          if (right === 1) {
            throw new Error("equals");
          }
          return false;
        },
      },
    );
    expect(Realm.untracked(realm, (read) => read($d))).toBe(0);
    Realm.update(realm, (_read, write) => {
      write($src, 1);
    });
    expect(() => Realm.untracked(realm, (read) => read($d))).toThrow("equals");
    expect(seen).toEqual([false]);
  });

  test("a read that throws out of equals does not leave a memo entry made in it cached", () => {
    const realm = Realm.make();
    let computes = 0;
    const square = Computed.fn(realm, (_read, n: number) => {
      computes++;
      return n * n;
    });
    const $src = Box.make(realm, 0);
    const $f = Computed.make(realm, (read) => (read($src) === 1 ? read(square(6)) : 0), {
      equals: (_left, right) => {
        if (right === 36) {
          throw new Error("equals");
        }
        return false;
      },
    });
    expect(Realm.untracked(realm, (read) => read($f))).toBe(0);
    Realm.update(realm, (_read, write) => {
      write($src, 1);
    });
    expect(() => Realm.untracked(realm, (read) => read($f))).toThrow("equals");
    computes = 0;
    Realm.untracked(realm, (read) => read(square(6)));
    expect(computes).toBe(1);
  });
});

describe("a computed value's equals is part of its compute", () => {
  test("an update in equals cannot write, and the value stays fresh", () => {
    const realm = Realm.make({ onError: () => {} });
    const $source = Box.make(realm, 0);
    const $value = Computed.make(realm, (read) => read($source), {
      equals: (left, right) => {
        if (right === 1) {
          Realm.update(realm, (_read, write) => {
            write($source, 100);
          });
        }
        return left === right;
      },
    });
    expect(Realm.untracked(realm, (read) => read($value))).toBe(0);
    Realm.update(realm, (_read, write) => {
      write($source, 1);
    });

    expect(() => Realm.untracked(realm, (read) => read($value))).toThrow(
      "update cannot run in a computed value",
    );
    expect(Realm.untracked(realm, (read) => read($source))).toBe(1);
  });
});

describe("a computed value that starts reading an atom in a run with an equal value", () => {
  test("through the realm, a cycle met through it leaves nothing observed", () => {
    const realm = Realm.make({ onError: () => {} });
    const $mode = Box.make(realm, false);
    const $flag = Box.make(realm, false);
    const $first = Box.make(realm, 0);
    const $k = Box.make(realm, 1);
    const $atom = Atom.make(realm);
    const events: Array<string> = [];
    Source.onObserved($first, () => {
      events.push("start");
      return () => events.push("stop");
    });
    let armed = false;
    let $middle: Computed<number> | undefined;
    const $outer = Computed.make(realm, (read) => {
      if (read($mode)) {
        read($atom);
        if (armed) {
          armed = false;
          if ($middle !== undefined) {
            read($middle);
          }
        }
      }
      return read($k);
    });
    const $inner = Computed.make(realm, (read) => read($first) + read($outer));
    const $watched = Computed.make(realm, (read) => (read($flag) ? read($inner) : 0));
    $middle = $watched;
    const stop = Realm.autorun(realm, (read) => {
      read($watched);
    });
    Realm.untracked(realm, (read) => read($inner));
    Realm.update(realm, (read, write) => {
      write($mode, true);
      write($flag, true);
      read($inner);
      armed = true;
      try {
        read($outer);
      } catch {}
      write($flag, false);
    });
    stop();

    expect(Source.inspect($inner).observers).toBe(0);
    expect(Source.inspect($first).observers).toBe(0);
    expect(events.filter((event) => event === "start").length).toBe(
      events.filter((event) => event === "stop").length,
    );
  });
});

describe("a value that starts reading an atom with an equal value is unchanged", () => {
  test("a realm autorun over it does not rerun", () => {
    const realm = Realm.make({ onError: () => {} });
    const $mode = Box.make(realm, false);
    const $atom = Atom.make(realm);
    const $value = Computed.make(realm, (read) => {
      if (read($mode)) {
        read($atom);
      }
      return 1;
    });
    let runs = 0;
    const stop = Realm.autorun(realm, (read) => {
      runs++;
      read($value);
    });
    Realm.update(realm, (_read, write) => {
      write($mode, true);
    });

    expect(runs).toBe(1);
    stop();
  });
});
