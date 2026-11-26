import { describe, expect, test } from "bun:test";
import { Atom, Box, Computed, type Read, Realm, Source } from "../src/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * How a write reaches what reads it, through the public API: consistency,
 * equality cutoff, updates, watches and autoruns, observed hooks, reentry,
 * and errors. The public twin of `packages/pinna-core/test/core.test.ts`,
 * which tests the same cases on the graph's own functions; the cases that
 * use a graph primitive with no public form (`beginBatch`, `restoreCell`,
 * `forgetValue`, `adopt`) have their twins named in `test/CONTRACT.md`.
 */

const realm = Realm.make();

const get = <Value>(value: Computed<Value> | Box<Value>, at: Realm = realm): Value =>
  Realm.untracked(at, (read) => read(value));

const set = <Value>(box: Box<Value>, value: Value, at: Realm = realm): void => {
  Realm.update(at, (_read, write) => {
    write(box, value);
  });
};

/** An autorun over `run`; returns its stop. */
const autorun = (run: (read: Read) => unknown, at: Realm = realm): (() => void) =>
  Realm.autorun(at, (read) => {
    run(read);
    return undefined;
  });

/** A watch that pushes each value to `seen`; returns its stop. */
const watchInto = <Value>(
  select: (read: Read) => Value,
  seen: Array<Value>,
  at: Realm = realm,
): (() => void) =>
  Realm.watch(at, select, (value) => {
    seen.push(value);
    return undefined;
  });

describe("consistency", () => {
  test("a diamond recomputes once and never shows a mixed value", () => {
    const a = Box.make(realm, 1);
    const b = Computed.make(realm, (read) => read(a) * 2);
    const c = Computed.make(realm, (read) => read(a) * 3);
    const seen: Array<string> = [];
    const d = Computed.make(realm, (read) => {
      const value = `${read(b)}+${read(c)}`;
      seen.push(value);
      return value;
    });
    const notified: Array<string> = [];
    const stop = watchInto((read) => read(d), notified);
    seen.length = 0;

    set(a, 2);

    expect(seen).toEqual(["4+6"]);
    expect(notified).toEqual(["4+6"]);
    stop();
  });

  test("an unobserved computed value reads a consistent value and caches it", () => {
    const a = Box.make(realm, 1);
    let runs = 0;
    const b = Computed.make(realm, (read) => {
      runs++;
      return read(a) + 1;
    });
    expect(get(b)).toBe(2);
    expect(get(b)).toBe(2);
    expect(runs).toBe(1);
    set(a, 5);
    expect(get(b)).toBe(6);
    expect(runs).toBe(2);
  });

  test("dependencies follow the branch the last run took", () => {
    const useLeft = Box.make(realm, true);
    const left = Box.make(realm, "left");
    const right = Box.make(realm, "right");
    let runs = 0;
    const picked = Computed.make(realm, (read) => {
      runs++;
      return read(useLeft) ? read(left) : read(right);
    });
    const stop = autorun((read) => read(picked));
    runs = 0;
    set(right, "right 2");
    expect(runs).toBe(0);
    set(useLeft, false);
    expect(get(picked)).toBe("right 2");
    set(left, "left 2");
    expect(runs).toBe(1);
    stop();
  });

  test("a computed value that reads itself throws", () => {
    const self: { readonly value: Computed<number> } = {
      value: Computed.make(realm, (read): number => read(self.value) + 1),
    };
    expect(() => get(self.value)).toThrow(/cycle/);
    expectRealmAtRest(realm);
  });
});

describe("equality cutoff", () => {
  test("dependents do not rerun when a computed value is unchanged", () => {
    const a = Box.make(realm, 1);
    const parity = Computed.make(realm, (read) => read(a) % 2);
    let runs = 0;
    const label = Computed.make(realm, (read) => {
      runs++;
      return read(parity) === 0 ? "even" : "odd";
    });
    const notified: Array<string> = [];
    const stop = watchInto((read) => read(label), notified);
    runs = 0;
    set(a, 3);
    expect(runs).toBe(0);
    expect(notified).toEqual([]);
    set(a, 4);
    expect(runs).toBe(1);
    expect(notified).toEqual(["even"]);
    stop();
  });

  test("a box's custom equals decides the cutoff", () => {
    const point = Box.make(realm, { x: 1, y: 2 }, { equals: (left, right) => left.x === right.x });
    const notified: Array<number> = [];
    const stop = watchInto((read) => read(point).y, notified);
    set(point, { x: 1, y: 3 });
    expect(notified).toEqual([]);
    set(point, { x: 2, y: 4 });
    expect(notified).toEqual([4]);
    stop();
  });
});

describe("updates", () => {
  test("an update coalesces notifications to one, with the final values", () => {
    const first = Box.make(realm, "Ada");
    const last = Box.make(realm, "Lovelace");
    const notified: Array<string> = [];
    const stop = watchInto((read) => `${read(first)} ${read(last)}`, notified);
    Realm.update(realm, (_read, write) => {
      write(first, "Grace");
      write(last, "Hopper");
    });
    expect(notified).toEqual(["Grace Hopper"]);
    stop();
  });

  test("a read inside an update sees the latest write", () => {
    const a = Box.make(realm, 1);
    const doubled = Computed.make(realm, (read) => read(a) * 2);
    let inside = 0;
    Realm.update(realm, (read, write) => {
      write(a, 10);
      inside = read(doubled);
    });
    expect(inside).toBe(20);
  });

  test("a write from a watch effect lands before the outer update returns", () => {
    const source = Box.make(realm, 1);
    const mirror = Box.make(realm, 0);
    const notified: Array<number> = [];
    const stopCopy = Realm.watch(
      realm,
      (read) => read(source),
      (value) => {
        set(mirror, value * 10);
        return undefined;
      },
    );
    const stopLog = watchInto((read) => read(mirror), notified);
    set(source, 2);
    expect(get(mirror)).toBe(20);
    expect(notified).toEqual([20]);
    stopCopy();
    stopLog();
  });
});

describe("watches and autoruns", () => {
  test("an autorun's body is the side effect, and stop ends it", () => {
    const a = Box.make(realm, 1);
    const seen: Array<number> = [];
    const stop = autorun((read) => {
      seen.push(read(a));
    });
    set(a, 2);
    stop();
    set(a, 3);
    expect(seen).toEqual([1, 2]);
  });

  test("untracked reads do not subscribe", () => {
    const tracked = Box.make(realm, 1);
    const ignored = Box.make(realm, 1);
    let runs = 0;
    const stop = autorun((read) => {
      runs++;
      read(tracked);
      get(ignored);
    });
    set(ignored, 2);
    expect(runs).toBe(1);
    set(tracked, 2);
    expect(runs).toBe(2);
    stop();
  });

  test("a watch stopped while due leaves the others due, in order", () => {
    const a = Box.make(realm, 0);
    const seen: Array<string> = [];
    const stops = ["first", "second", "third", "fourth"].map((name) =>
      Realm.watch(
        realm,
        (read) => read(a),
        () => {
          seen.push(name);
          return undefined;
        },
      ),
    );
    Realm.update(realm, (_read, write) => {
      write(a, 1);
      stops[1]?.();
    });
    expect(seen).toEqual(["first", "third", "fourth"]);
    seen.length = 0;
    set(a, 2);
    expect(seen).toEqual(["first", "third", "fourth"]);
    for (const stop of stops) {
      stop();
    }
  });

  test("a watch's effect that stops a later watch due in the same round keeps it from running", () => {
    const a = Box.make(realm, 0);
    const seen: Array<string> = [];
    const stops: Array<() => void> = [];
    stops.push(
      Realm.watch(
        realm,
        (read) => read(a),
        () => {
          seen.push("first");
          stops[1]?.();
          return undefined;
        },
      ),
    );
    stops.push(
      Realm.watch(
        realm,
        (read) => read(a),
        () => {
          seen.push("second");
          return undefined;
        },
      ),
    );
    stops.push(
      Realm.watch(
        realm,
        (read) => read(a),
        () => {
          seen.push("third");
          return undefined;
        },
      ),
    );
    set(a, 1);
    expect(seen).toEqual(["first", "third"]);
    seen.length = 0;
    set(a, 2);
    expect(seen).toEqual(["first", "third"]);
    for (const stop of stops) stop();
    expectRealmAtRest(realm);
  });

  test("a watch's effect that starts a watch does not run the new one's effect in that round", () => {
    const a = Box.make(realm, 0);
    const seen: Array<string> = [];
    let started: (() => void) | undefined;
    const stop = Realm.watch(
      realm,
      (read) => read(a),
      () => {
        seen.push("first");
        started ??= Realm.watch(
          realm,
          (read) => read(a),
          (value) => {
            seen.push(`second ${value}`);
            return undefined;
          },
        );
        return undefined;
      },
    );
    set(a, 1);
    expect(seen).toEqual(["first"]);
    seen.length = 0;
    set(a, 2);
    expect(seen).toEqual(["first", "second 2"]);
    stop();
    started?.();
    expectRealmAtRest(realm);
  });

  // A first run's reads are followed only once it ends, so no change reaches
  // a write it makes to what it read: the run itself schedules the autorun again.
  test("an autorun that writes what it read runs again, on its first run too", () => {
    const own = Realm.make();
    const a = Box.make(own, 0);
    const seen: Array<number> = [];
    const stop = autorun((read) => {
      const value = read(a);
      seen.push(value);
      if (value < 3) {
        set(a, value + 1, own);
      }
    }, own);
    expect(seen).toEqual([0, 1, 2, 3]);
    set(a, 1, own);
    expect(seen).toEqual([0, 1, 2, 3, 1, 2, 3]);
    stop();
    expectRealmAtRest(own);
  });

  test("an autorun that writes what it reads only after the write does not run again", () => {
    const own = Realm.make();
    const a = Box.make(own, 0);
    const other = Box.make(own, 0);
    let runs = 0;
    const stop = autorun((read) => {
      runs++;
      set(other, runs, own);
      set(a, 5, own);
      read(a);
    }, own);
    expect(runs).toBe(1);
    stop();
    expectRealmAtRest(own);
  });

  test("an autorun that always changes what it read stops at the round limit", () => {
    const reports: Array<unknown> = [];
    const own = Realm.make({ onError: (error) => reports.push(error) });
    const a = Box.make(own, 0);
    let runs = 0;
    autorun((read) => {
      runs++;
      set(a, read(a) + 1, own);
    }, own);
    expect(reports.map((error) => (error as Error).message)).toEqual([
      expect.stringMatching(/did not settle after 100 rounds/),
    ]);
    expect(runs).toBe(101);
    expectRealmAtRest(own);
  });
});

describe("onObserved", () => {
  /** Logs each start and stop of `observable`'s hook into `events`. */
  const logged = (observable: Box<unknown> | Computed<unknown>, events: Array<string>) =>
    Source.onObserved(observable, () => {
      events.push("start");
      return () => {
        events.push("stop");
      };
    });

  test("starts on the first observer and cleans up after the last, through a computed chain", () => {
    const source = Box.make(realm, 0);
    const events: Array<string> = [];
    logged(source, events);
    const doubled = Computed.make(realm, (read) => read(source) * 2);
    const quadrupled = Computed.make(realm, (read) => read(doubled) * 2);

    expect(get(quadrupled)).toBe(0);
    expect(events).toEqual([]);

    const stopFirst = autorun((read) => read(quadrupled));
    const stopSecond = autorun((read) => read(doubled));
    expect(events).toEqual(["start"]);

    stopFirst();
    expect(events).toEqual(["start"]);
    stopSecond();
    expect(events).toEqual(["start", "stop"]);
  });

  test("does not flap when a run reads the source again after another change", () => {
    const source = Box.make(realm, 0);
    const toggle = Box.make(realm, false);
    const events: Array<string> = [];
    logged(source, events);
    const stop = autorun((read) => {
      read(toggle);
      read(source);
    });
    set(toggle, true);
    expect(events).toEqual(["start"]);
    stop();
    expect(events).toEqual(["start", "stop"]);
  });

  test("an autorun that stops reading a source releases it", () => {
    const source = Box.make(realm, 0);
    const reading = Box.make(realm, true);
    const events: Array<string> = [];
    logged(source, events);
    const stop = autorun((read) => (read(reading) ? read(source) : -1));
    set(reading, false);
    expect(events).toEqual(["start", "stop"]);
    stop();
  });

  test("a source read again after a nested untracked read starts its hook once", () => {
    const source = Box.make(realm, 0);
    const events: Array<string> = [];
    logged(source, events);
    const stop = autorun((read) => {
      read(source);
      get(source);
      read(source);
    });
    expect(events).toEqual(["start"]);
    stop();
    expect(events).toEqual(["start", "stop"]);
  });

  for (const failing of [false, true]) {
    test(`a hook that stops the last observer${failing ? " and throws" : ""} keeps the next hook from starting`, () => {
      const reports: Array<unknown> = [];
      const local = Realm.make({ onError: (error) => reports.push(error) });
      const box = Box.make(local, 0);
      const live = new Set<string>();
      let stop: (() => void) | undefined;
      Source.onObserved(box, () => {
        live.add("first");
        stop?.();
        if (failing) {
          throw new Error("the first start fails");
        }
        return () => {
          live.delete("first");
        };
      });
      Source.onObserved(box, () => {
        live.add("second");
        return () => {
          live.delete("second");
        };
      });

      const flag = Box.make(local, false);
      stop = autorun((read) => (read(flag) ? read(box) : 0), local);

      set(flag, true, local);

      expect(reports.map((error) => (error as Error).message)).toEqual(
        failing ? ["the first start fails"] : [],
      );
      expect(Source.inspect(box).observers).toBe(0);
      expect(live.has("second")).toBe(false);
      expectRealmAtRest(local);
    });
  }

  test("an onError that stops the last observer keeps the next hook from starting", () => {
    let onReport = (): void => {};
    const local = Realm.make({ onError: () => onReport() });
    const box = Box.make(local, 0);
    const live = new Set<string>();
    const stops: Array<() => void> = [];
    onReport = () => {
      for (const stop of stops) stop();
    };
    for (const name of ["first", "second"]) {
      Source.onObserved(box, () => {
        throw new Error(`the ${name} start fails`);
      });
    }
    Source.onObserved(box, () => {
      live.add("third");
      return () => {
        live.delete("third");
      };
    });
    const flag = Box.make(local, false);
    stops.push(autorun((read) => (read(flag) ? read(box) : 0), local));

    set(flag, true, local);
    expect(Source.inspect(box).observers).toBe(0);
    expect(live.has("third")).toBe(false);
    expectRealmAtRest(local);
  });

  test("an onError that observes again leaves the next hook started", () => {
    let onReport = (): void => {};
    const local = Realm.make({ onError: () => onReport() });
    const box = Box.make(local, 0);
    const live = new Set<string>();
    for (const name of ["first", "second"]) {
      Source.onObserved(box, () => {
        live.add(name);
        return () => {
          live.delete(name);
          throw new Error(`the ${name} cleanup fails`);
        };
      });
    }
    Source.onObserved(box, () => {
      live.add("third");
      return () => {
        live.delete("third");
      };
    });
    const stop = autorun((read) => read(box), local);
    let other: (() => void) | undefined;
    onReport = () => {
      onReport = () => {};
      other = autorun((read) => read(box), local);
    };

    stop();
    expect(Source.inspect(box).observers).toBe(1);
    expect([...live].sort()).toEqual(["first", "second", "third"]);
    other?.();
    expectRealmAtRest(local);
  });
});

describe("reentry", () => {
  test("an autorun reruns when a hook writes a source it read but does not observe yet", () => {
    const local = Realm.make({ onError: () => {} });
    const first = Box.make(local, 0);
    const second = Box.make(local, 0);
    Source.onObserved(first, () => {
      set(second, 1, local);
      return undefined;
    });
    const seen: Array<number> = [];
    const stop = autorun((read) => {
      seen.push(read(first) + read(second));
    }, local);
    expect(seen).toEqual([0, 1]);
    stop();
  });

  test("an autorun reruns when a hook changes an atom it read but does not observe yet", () => {
    const local = Realm.make({ onError: () => {} });
    const first = Box.make(local, 0);
    const atom = Atom.make(local);
    Source.onObserved(first, () => {
      Realm.update(local, (_read, write) => {
        write.changed(atom);
      });
      return undefined;
    });
    let runs = 0;
    const stop = autorun((read) => {
      runs++;
      read(first);
      read(atom);
    }, local);
    expect(runs).toBe(2);
    stop();
  });
});
