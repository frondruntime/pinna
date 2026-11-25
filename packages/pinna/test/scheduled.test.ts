import { describe, expect, test } from "bun:test";
import {
  Box,
  Computed,
  isPinnaError,
  type PinnaUsageError,
  Realm,
  type Scheduler,
  Source,
  Stage,
} from "../src/index.ts";
import { testRealm } from "../src/testing/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * A `scheduler` on `Realm.watch` and `Realm.autorun`: the first run is synchronous, and
 * each later one runs when the scheduler calls `run`, once for every write
 * before it (ruling 58 of `docs/api.md`).
 */

/** A scheduler that holds each `run` until `flush`, as a frame does. */
const frame = () => {
  const runs: Array<() => void> = [];
  const scheduler: Scheduler = (run) => {
    runs.push(run);
  };
  return {
    scheduler,
    get size(): number {
      return runs.length;
    },
    flush(): void {
      for (const run of runs.splice(0)) {
        run();
      }
    },
  };
};

const immediate: Scheduler = (run) => run();

const set = (realm: Realm, $box: ReturnType<typeof Box.make<number>>, value: number): void => {
  Realm.update(realm, (_read, write) => write($box, value));
};

const codeOf = (run: () => void): string | undefined => {
  try {
    run();
  } catch (error) {
    return isPinnaError(error) ? (error as PinnaUsageError).code : String(error);
  }
  return undefined;
};

describe("a scheduled watch", () => {
  test("runs once for many writes, with the latest value and the last run's as previous", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 0);
    const later = frame();
    const seen: Array<[number, number]> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($a),
      (value, previous) => {
        seen.push([value, previous]);
      },
      { scheduler: later.scheduler },
    );
    for (let value = 1; value <= 5; value++) {
      set(realm, $a, value);
    }
    expect(seen).toEqual([]);
    expect(later.size).toBe(1);
    later.flush();
    expect(seen).toEqual([[5, 0]]);
    set(realm, $a, 6);
    later.flush();
    expect(seen).toEqual([
      [5, 0],
      [6, 5],
    ]);
    stop();
    expectRealmAtRest(realm);
  });

  test("leaves synchronous watches as they are: they run before update returns", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 0);
    const later = frame();
    const order: Array<string> = [];
    Realm.watch(
      realm,
      (read) => read($a),
      () => {
        order.push("scheduled");
      },
      { scheduler: later.scheduler },
    );
    Realm.watch(
      realm,
      (read) => read($a),
      () => {
        order.push("synchronous");
      },
    );
    set(realm, $a, 1);
    expect(order).toEqual(["synchronous"]);
    later.flush();
    expect(order).toEqual(["synchronous", "scheduled"]);
  });

  test("runs its first select at once and throws its error there", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 0);
    const later = frame();
    let selects = 0;
    Realm.watch(
      realm,
      (read) => {
        selects++;
        return read($a);
      },
      () => undefined,
      { scheduler: later.scheduler },
    );
    expect(selects).toBe(1);
    expect(() =>
      Realm.watch(
        realm,
        () => {
          throw new Error("first");
        },
        () => undefined,
        { scheduler: later.scheduler },
      ),
    ).toThrow("first");
    expect(Source.inspect($a).observers).toBe(1);
  });

  test("computes a derived value once per run, however many writes reached it", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 0);
    let computes = 0;
    const $double = Computed.make(realm, (read) => {
      computes++;
      return read($a) * 2;
    });
    const later = frame();
    const seen: Array<number> = [];
    Realm.watch(
      realm,
      (read) => read($double),
      (value) => {
        seen.push(value);
      },
      { scheduler: later.scheduler },
    );
    computes = 0;
    for (let value = 1; value <= 100; value++) {
      set(realm, $a, value);
    }
    expect(computes).toBe(0);
    later.flush();
    expect(computes).toBe(1);
    expect(seen).toEqual([200]);
  });

  test("runs nothing when a derived value cuts the change off, and when equals says equal", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 0);
    const $parity = Computed.make(realm, (read) => read($a) % 2);
    const later = frame();
    let selects = 0;
    let effects = 0;
    Realm.watch(
      realm,
      (read) => {
        selects++;
        return read($parity);
      },
      () => {
        effects++;
      },
      { scheduler: later.scheduler },
    );
    set(realm, $a, 2);
    later.flush();
    expect([selects, effects]).toEqual([1, 0]);

    const $b = Box.make(realm, 1);
    Realm.watch(
      realm,
      (read) => read($b),
      () => {
        effects++;
      },
      { scheduler: later.scheduler, equals: (left, right) => left % 10 === right % 10 },
    );
    set(realm, $b, 11);
    later.flush();
    expect(effects).toBe(0);
  });

  test("a write undone before the run, by a failed update, runs nothing", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 0);
    const later = frame();
    let effects = 0;
    Realm.watch(
      realm,
      (read) => read($a),
      () => {
        effects++;
      },
      { scheduler: later.scheduler },
    );
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write($a, 1);
        throw new Error("rolled back");
      }),
    ).toThrow("rolled back");
    later.flush();
    expect(effects).toBe(0);
  });

  test("with a scheduler that runs at once, sees what a plain watch sees", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 0);
    const $b = Box.make(realm, 0);
    const plain: Array<number> = [];
    const scheduled: Array<number> = [];
    Realm.watch(
      realm,
      (read) => read($a) + read($b),
      (value) => {
        plain.push(value);
      },
    );
    Realm.watch(
      realm,
      (read) => read($a) + read($b),
      (value) => {
        scheduled.push(value);
      },
      { scheduler: immediate },
    );
    Realm.update(realm, (_read, write) => {
      write($a, 1);
      write($b, 2);
    });
    Realm.update(realm, (_read, write) => {
      Realm.update(realm, (_inner, innerWrite) => innerWrite($a, 5));
      write($b, 5);
    });
    expect(scheduled).toEqual(plain);
    expect(plain).toEqual([3, 10]);
    expectRealmAtRest(realm);
  });

  test("a scheduler that never calls run leaves it pending, and no later change schedules it again", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 0);
    const held: Array<() => void> = [];
    let effects = 0;
    Realm.watch(
      realm,
      (read) => read($a),
      () => {
        effects++;
      },
      { scheduler: (run) => held.push(run) },
    );
    set(realm, $a, 1);
    set(realm, $a, 2);
    expect(held.length).toBe(1);
    (held[0] as () => void)();
    (held[0] as () => void)();
    expect(effects).toBe(1);
  });

  test("stopping ends a due run, and stopping twice does nothing", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 0);
    const later = frame();
    let effects = 0;
    const stop = Realm.watch(
      realm,
      (read) => read($a),
      () => {
        effects++;
      },
      { scheduler: later.scheduler },
    );
    set(realm, $a, 1);
    stop();
    stop();
    later.flush();
    expect(effects).toBe(0);
    expect(Source.inspect($a).observers).toBe(0);
  });

  test("an effect's write settles at once, and a watch it reaches runs before update returns", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 0);
    const $b = Box.make(realm, 0);
    const later = frame();
    const seen: Array<number> = [];
    Realm.watch(
      realm,
      (read) => read($a),
      (value) => {
        set(realm, $b, value * 10);
      },
      { scheduler: later.scheduler },
    );
    Realm.watch(
      realm,
      (read) => read($b),
      (value) => {
        seen.push(value);
      },
    );
    set(realm, $a, 1);
    later.flush();
    expect(seen).toEqual([10]);
  });

  test("starts the onObserved hooks of what it reads, and ends them when stopped", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 0);
    const events: Array<string> = [];
    Source.onObserved($a, () => {
      events.push("start");
      return () => {
        events.push("end");
      };
    });
    const stop = Realm.watch(
      realm,
      (read) => read($a),
      () => undefined,
      { scheduler: frame().scheduler },
    );
    expect(events).toEqual(["start"]);
    stop();
    expect(events).toEqual(["start", "end"]);
  });

  test("a hook that writes on start schedules a run", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 0);
    Source.onObserved($a, () => {
      Realm.update(realm, (_read, write) => write($a, 1));
      return undefined;
    });
    const later = frame();
    const seen: Array<number> = [];
    Realm.watch(
      realm,
      (read) => read($a),
      (value) => {
        seen.push(value);
      },
      { scheduler: later.scheduler },
    );
    later.flush();
    expect(seen).toEqual([1]);
  });

  test("in two realms, each scheduled watch follows its own", () => {
    const first = Realm.make();
    const second = Realm.make();
    const $a = Box.make(first, 0);
    const $b = Box.make(second, 0);
    const later = frame();
    const seen: Array<string> = [];
    Realm.watch(
      first,
      (read) => read($a),
      (value) => {
        seen.push(`first ${value}`);
      },
      { scheduler: later.scheduler },
    );
    Realm.watch(
      second,
      (read) => read($b),
      (value) => {
        seen.push(`second ${value}`);
      },
      { scheduler: later.scheduler },
    );
    set(second, $b, 2);
    set(first, $a, 1);
    later.flush();
    expect(seen).toEqual(["second 2", "first 1"]);
  });
});

describe("a scheduled autorun", () => {
  test("runs at once, then once per call of run, with its cleanup before each", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 0);
    const later = frame();
    const events: Array<string> = [];
    const stop = Realm.autorun(
      realm,
      (read) => {
        const value = read($a);
        events.push(`run ${value}`);
        return () => {
          events.push(`clean ${value}`);
        };
      },
      { scheduler: later.scheduler },
    );
    set(realm, $a, 1);
    set(realm, $a, 2);
    expect(events).toEqual(["run 0"]);
    later.flush();
    expect(events).toEqual(["run 0", "clean 0", "run 2"]);
    stop();
    stop();
    expect(events).toEqual(["run 0", "clean 0", "run 2", "clean 2"]);
    expectRealmAtRest(realm);
  });

  test("sees its own write to what it read, at the next run", () => {
    const realm = Realm.make();
    const $gate = Box.make(realm, false);
    const $a = Box.make(realm, 0);
    const later = frame();
    const seen: Array<number> = [];
    Realm.autorun(
      realm,
      (read) => {
        if (!read($gate)) {
          return undefined;
        }
        const value = read($a);
        seen.push(value);
        if (value < 3) {
          Realm.update(realm, (_read, write) => write($a, value + 1));
        }
        return undefined;
      },
      { scheduler: later.scheduler },
    );
    Realm.update(realm, (_read, write) => write($gate, true));
    for (let frames = 0; frames < 10 && later.size > 0; frames++) {
      later.flush();
    }
    expect(seen).toEqual([0, 1, 2, 3]);
    expectRealmAtRest(realm);
  });

  test("one that keeps writing what it read is reported at 100 runs in a row, then waits", () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const $a = Box.make(realm, 0);
    const $outside = Box.make(realm, 0);
    const later = frame();
    let runs = 0;
    Realm.autorun(
      realm,
      (read) => {
        read($outside);
        const value = read($a);
        runs++;
        Realm.update(realm, (_read, write) => write($a, value + 1));
        return undefined;
      },
      { scheduler: later.scheduler },
    );
    runs = 0;
    for (let frames = 0; frames < 500 && later.size > 0; frames++) {
      later.flush();
    }
    expect(runs).toBe(100);
    expect(later.size).toBe(0);
    expect(errors.map((error) => (error as PinnaUsageError).code)).toEqual([
      "pinna/watchers-unsettled",
    ]);
    set(realm, $outside, 1);
    expect(later.size).toBe(1);
  });

  test("with a scheduler that runs at once, ends at the round limit as a plain autorun does", () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const $a = Box.make(realm, 0);
    const $gate = Box.make(realm, false);
    Realm.autorun(
      realm,
      (read) => {
        if (read($gate)) {
          const value = read($a);
          Realm.update(realm, (_read, write) => write($a, value + 1));
        }
        return undefined;
      },
      { scheduler: immediate },
    );
    Realm.update(realm, (_read, write) => write($gate, true));
    expect(errors.map((error) => (error as PinnaUsageError).code)).toContain(
      "pinna/watchers-unsettled",
    );
  });
});

describe("a scheduled run's errors", () => {
  test("an error from a deferred run goes to onError, and the watch keeps running", () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const $a = Box.make(realm, 0);
    const later = frame();
    const seen: Array<number> = [];
    Realm.watch(
      realm,
      (read) => read($a),
      (value) => {
        if (value === 1) {
          throw new Error("effect failed");
        }
        seen.push(value);
      },
      { scheduler: later.scheduler },
    );
    set(realm, $a, 1);
    later.flush();
    expect(errors.map((error) => (error as Error).message)).toEqual(["effect failed"]);
    set(realm, $a, 2);
    later.flush();
    expect(seen).toEqual([2]);
  });

  test("an error from a run in the settle goes where a plain watch's goes", () => {
    const failing = (realm: Realm): ReturnType<typeof Box.make<number>> => {
      const $a = Box.make(realm, 0);
      Realm.watch(
        realm,
        (read) => read($a),
        () => {
          throw new Error("effect failed");
        },
        { scheduler: immediate },
      );
      return $a;
    };
    const reported: Array<unknown> = [];
    const withReporter = Realm.make({ onError: (error) => reported.push(error) });
    set(withReporter, failing(withReporter), 1);
    expect(reported.map((error) => (error as Error).message)).toEqual(["effect failed"]);
    const withoutReporter = Realm.make();
    const $a = failing(withoutReporter);
    expect(() => set(withoutReporter, $a, 1)).toThrow("effect failed");
  });

  test("an error the scheduler throws reaches the writer, and the next change schedules again", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 0);
    let fail = true;
    const runs: Array<() => void> = [];
    Realm.watch(
      realm,
      (read) => read($a),
      () => undefined,
      {
        scheduler: (run) => {
          if (fail) {
            throw new Error("scheduler failed");
          }
          runs.push(run);
        },
      },
    );
    expect(() => set(realm, $a, 1)).toThrow("scheduler failed");
    fail = false;
    set(realm, $a, 2);
    expect(runs.length).toBe(1);
  });

  test("run refuses inside an update, a computed value, a select, an autorun, and a stage recipe", () => {
    const realm = Realm.make({ onError: () => undefined });
    const $a = Box.make(realm, 0);
    let held: (() => void) | undefined;
    Realm.watch(
      realm,
      (read) => read($a),
      () => undefined,
      {
        scheduler: (run) => {
          held = run;
        },
      },
    );
    set(realm, $a, 1);
    // A refused run stays pending, so each place below calls the same one.
    const flush = (): void => (held as () => void)();
    const codes: Array<string | undefined> = [];
    codes.push(
      codeOf(() =>
        Realm.update(realm, () => {
          flush();
        }),
      ),
    );
    const $flushing = Computed.make(realm, () => {
      flush();
      return 0;
    });
    codes.push(codeOf(() => Realm.untracked(realm, (read) => read($flushing))));
    codes.push(
      codeOf(() =>
        Realm.watch(
          realm,
          () => flush(),
          () => undefined,
        ),
      ),
    );
    codes.push(
      codeOf(() =>
        Realm.autorun(realm, () => {
          flush();
          return undefined;
        }),
      ),
    );
    const stage = Stage.make(realm);
    codes.push(
      codeOf(() =>
        Stage.update(stage, () => {
          flush();
        }),
      ),
    );
    Stage.drop(stage);
    expect(codes).toEqual([
      "pinna/scheduled-run-not-at-rest",
      "pinna/scheduled-run-not-at-rest",
      "pinna/scheduled-run-not-at-rest",
      "pinna/scheduled-run-not-at-rest",
      "pinna/scheduled-run-not-at-rest",
    ]);
    expectRealmAtRest(realm);
  });

  test("run is allowed in a plain watch's effect and in untracked", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 0);
    const $b = Box.make(realm, 0);
    const later = frame();
    const seen: Array<number> = [];
    Realm.watch(
      realm,
      (read) => read($a),
      (value) => {
        seen.push(value);
      },
      { scheduler: later.scheduler },
    );
    Realm.watch(
      realm,
      (read) => read($b),
      () => {
        later.flush();
      },
    );
    set(realm, $a, 1);
    set(realm, $b, 1);
    expect(seen).toEqual([1]);
    set(realm, $a, 2);
    Realm.untracked(realm, () => later.flush());
    expect(seen).toEqual([1, 2]);
  });
});

describe("scheduled reactions and stages", () => {
  test("a stage's writes reach a scheduled watch when applied, never before", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 0);
    const later = frame();
    const seen: Array<number> = [];
    Realm.watch(
      realm,
      (read) => read($a),
      (value) => {
        seen.push(value);
      },
      { scheduler: later.scheduler },
    );
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => write($a, 5));
    expect(later.size).toBe(0);
    Stage.apply(stage);
    later.flush();
    expect(seen).toEqual([5]);
  });

  test("a dropped stage schedules nothing", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 0);
    const later = frame();
    Realm.watch(
      realm,
      (read) => read($a),
      () => undefined,
      { scheduler: later.scheduler },
    );
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => write($a, 5));
    Stage.drop(stage);
    expect(later.size).toBe(0);
  });
});

describe("scheduled reactions and disposal", () => {
  test("disposal stops each, runs an autorun's cleanup, and a due run does nothing", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 0);
    const later = frame();
    const events: Array<string> = [];
    Realm.watch(
      realm,
      (read) => read($a),
      (value) => {
        events.push(`watch ${value}`);
      },
      { scheduler: later.scheduler },
    );
    Realm.autorun(
      realm,
      (read) => {
        events.push(`autorun ${read($a)}`);
        return () => {
          events.push("cleanup");
        };
      },
      { scheduler: later.scheduler },
    );
    set(realm, $a, 1);
    Realm.dispose(realm);
    later.flush();
    expect(events).toEqual(["autorun 0", "cleanup"]);
    expect(Source.inspect($a).observers).toBe(0);
  });

  test("a scheduled watch cannot start once the realm is disposed", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 0);
    Realm.dispose(realm);
    expect(
      codeOf(() =>
        Realm.watch(
          realm,
          (read) => read($a),
          () => undefined,
          { scheduler: immediate },
        ),
      ),
    ).toBe("pinna/realm-disposed");
  });

  test("testRealm reports a scheduled watch and autorun still running", () => {
    const realm = testRealm();
    const $a = Box.make(realm, 0);
    Realm.watch(
      realm,
      (read) => read($a),
      () => undefined,
      { scheduler: immediate },
    );
    Realm.autorun(
      realm,
      (read) => {
        read($a);
        return undefined;
      },
      { scheduler: immediate },
    );
    expect(() => realm[Symbol.dispose]()).toThrow(
      "scheduled watch still running; scheduled autorun still running",
    );
  });
});

describe("scheduled reactions, edge cases from review", () => {
  test("a scheduled autorun's cleanup may write through update", () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const $a = Box.make(realm, 0);
    const $cleaned = Box.make(realm, 0);
    const later = frame();
    Realm.autorun(
      realm,
      (read) => {
        read($a);
        return () => {
          Realm.update(realm, (read, write) => write($cleaned, read($cleaned) + 1));
        };
      },
      { scheduler: later.scheduler },
    );
    set(realm, $a, 1);
    later.flush();
    expect(errors).toEqual([]);
    expect(Realm.untracked(realm, (read) => read($cleaned))).toBe(1);
  });

  test("a watch a hook stops during its run calls no effect", () => {
    const realm = Realm.make();
    const $switch = Box.make(realm, false);
    const $other = Box.make(realm, 0);
    const later = frame();
    let effects = 0;
    let stop: () => void = () => undefined;
    Source.onObserved($other, () => {
      stop();
      return undefined;
    });
    stop = Realm.watch(
      realm,
      (read) => (read($switch) ? read($other) : -1),
      () => {
        effects++;
      },
      { scheduler: later.scheduler },
    );
    Realm.update(realm, (_read, write) => write($switch, true));
    later.flush();
    expect(effects).toBe(0);
  });

  test("run inside untracked inside a tracked run is refused", () => {
    const realm = Realm.make({ onError: () => undefined });
    const $a = Box.make(realm, 0);
    let held: (() => void) | undefined;
    Realm.watch(
      realm,
      (read) => read($a),
      () => undefined,
      {
        scheduler: (run) => {
          held = run;
        },
      },
    );
    set(realm, $a, 1);
    expect(
      codeOf(() =>
        Realm.autorun(realm, () => {
          Realm.untracked(realm, () => (held as () => void)());
          return undefined;
        }),
      ),
    ).toBe("pinna/scheduled-run-not-at-rest");
  });

  test("a start whose settle throws, through an onError that rethrows, leaves nothing linked", () => {
    const realm = Realm.make({
      onError: (error) => {
        throw error;
      },
    });
    const $a = Box.make(realm, 0);
    Source.onObserved($a, () => {
      Realm.update(realm, (_read, write) => write($a, 1));
      return undefined;
    });
    expect(() =>
      Realm.watch(
        realm,
        (read) => read($a),
        () => undefined,
        {
          scheduler: () => {
            throw new Error("scheduler failed");
          },
        },
      ),
    ).toThrow("scheduler failed");
    expect(Source.inspect($a).observers).toBe(0);
  });

  test("a change from outside breaks the streak of own runs", () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const $a = Box.make(realm, 0);
    const $outside = Box.make(realm, 0);
    const later = frame();
    Realm.autorun(
      realm,
      (read) => {
        read($outside);
        const value = read($a);
        if (value < 150) {
          Realm.update(realm, (_read, write) => write($a, value + 1));
        }
        return undefined;
      },
      { scheduler: later.scheduler },
    );
    for (let frames = 0; frames < 300 && later.size > 0; frames++) {
      if (frames === 60) {
        set(realm, $outside, 1);
      }
      later.flush();
    }
    expect(errors).toEqual([]);
    expect(Realm.untracked(realm, (read) => read($a))).toBe(150);
  });

  test("an earlier schedule's run does not take a later schedule's turn", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 0);
    const held: Array<() => void> = [];
    const seen: Array<number> = [];
    Realm.watch(
      realm,
      (read) => read($a),
      (value) => {
        seen.push(value);
      },
      { scheduler: (run) => held.push(run) },
    );
    set(realm, $a, 1);
    (held[0] as () => void)();
    set(realm, $a, 2);
    (held[0] as () => void)();
    expect(seen).toEqual([1]);
    (held[1] as () => void)();
    expect(seen).toEqual([1, 2]);
  });

  test("a stopped watch's run inside an update does nothing, and does not throw", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 0);
    const later = frame();
    const stop = Realm.watch(
      realm,
      (read) => read($a),
      () => undefined,
      { scheduler: later.scheduler },
    );
    set(realm, $a, 1);
    stop();
    Realm.update(realm, (_read, write) => {
      later.flush();
      write($a, 2);
    });
    expect(Realm.untracked(realm, (read) => read($a))).toBe(2);
  });
});
