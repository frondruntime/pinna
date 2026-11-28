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
  type WatchOptions,
} from "../src/index.ts";
import { testRealm } from "../src/testing/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * `Realm.watch(realm, select, effect, { immediate: true })`: the effect runs
 * once at the call with `select`'s first result and `previous` `undefined`,
 * then on each change as a watch without the option does (ruling 78).
 */

const codeOf = (run: () => void): string | undefined => {
  try {
    run();
  } catch (error) {
    return isPinnaError(error) ? (error as PinnaUsageError).code : String(error);
  }
  return undefined;
};

/** A scheduler that holds each `run` until `flush`, as a frame does. */
const frame = () => {
  const runs: Array<() => void> = [];
  const scheduler: Scheduler = (run) => {
    runs.push(run);
  };
  return {
    scheduler,
    flush(): void {
      for (const run of runs.splice(0)) {
        run();
      }
    },
  };
};

describe("an immediate watch", () => {
  test("runs at the call with previous undefined, then on each change", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const seen: Array<[number, number | undefined]> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($a),
      (value, previous) => {
        seen.push([value, previous]);
      },
      { immediate: true },
    );
    expect(seen).toEqual([[1, undefined]]);
    Realm.update(realm, (_read, write) => write($a, 2));
    Realm.update(realm, (_read, write) => write($a, 3));
    expect(seen).toEqual([
      [1, undefined],
      [2, 1],
      [3, 2],
    ]);
    stop();
    Realm.update(realm, (_read, write) => write($a, 4));
    expect(seen.length).toBe(3);
    expectRealmAtRest(realm);
  });

  test("ignores equals on the run at the call, and keeps it for changes", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const seen: Array<number> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($a),
      (value) => {
        seen.push(value);
      },
      { immediate: true, equals: () => true, name: "never changes" },
    );
    Realm.update(realm, (_read, write) => write($a, 2));
    expect(seen).toEqual([1]);
    stop();
  });

  test("without the option, the effect runs for changes only", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const seen: Array<number> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($a),
      (value) => {
        seen.push(value);
      },
      { immediate: false },
    );
    expect(seen).toEqual([]);
    Realm.update(realm, (_read, write) => write($a, 2));
    expect(seen).toEqual([2]);
    stop();
  });

  test("its effect reads untracked", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $other = Box.make(realm, 10);
    const seen: Array<number> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($a),
      (value) => {
        seen.push(value + Realm.untracked(realm, (read) => read($other)));
        expect(Realm.isTracking(realm)).toBe(false);
      },
      { immediate: true },
    );
    Realm.update(realm, (_read, write) => write($other, 20));
    expect(seen).toEqual([11]);
    expect(Source.inspect($other).observers).toBe(0);
    expect(Source.inspect($a).observers).toBe(1);
    stop();
  });

  test("an error from the run at the call is thrown and nothing stays watched", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const failure = new Error("first");
    let runs = 0;
    expect(() =>
      Realm.watch(
        realm,
        (read) => read($a),
        () => {
          runs++;
          throw failure;
        },
        { immediate: true },
      ),
    ).toThrow(failure);
    Realm.update(realm, (_read, write) => write($a, 2));
    expect(runs).toBe(1);
    expect(Source.inspect($a).observers).toBe(0);
  });

  test("is refused inside an update, and nothing is watched", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    let runs = 0;
    const code = codeOf(() =>
      Realm.update(realm, () => {
        Realm.watch(
          realm,
          (read) => read($a),
          () => {
            runs++;
          },
          { immediate: true, name: "late" },
        );
      }),
    );
    expect(code).toBe("pinna/watch-immediate-in-update");
    expect(runs).toBe(0);
    expect(Source.inspect($a).observers).toBe(0);
  });

  test("names the watch in the refusal", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 1);
    let message = "";
    try {
      Realm.update(realm, () => {
        Realm.watch(
          realm,
          (read) => read($a),
          () => undefined,
          {
            immediate: true,
            name: "late",
          },
        );
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      "pinna: late with { immediate: true } is made inside Realm.update, where its first effect would run before the update lands; make the watch outside the update",
    );
  });

  test("an update the first run makes reruns it as a change", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const seen: Array<[number, number | undefined]> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($a),
      (value, previous) => {
        seen.push([value, previous]);
        if (value === 1) {
          Realm.update(realm, (_read, write) => write($a, 2));
        }
      },
      { immediate: true },
    );
    expect(seen).toEqual([
      [1, undefined],
      [2, 1],
    ]);
    stop();
  });

  test("nested updates after it land as one change", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const seen: Array<[number, number | undefined]> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($a),
      (value, previous) => {
        seen.push([value, previous]);
      },
      { immediate: true },
    );
    Realm.update(realm, (_read, write) => {
      write($a, 2);
      Realm.update(realm, (_inner, innerWrite) => innerWrite($a, 3));
    });
    expect(seen).toEqual([
      [1, undefined],
      [3, 1],
    ]);
    stop();
  });

  test("made in an autorun's body, it runs there and once per change", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $on = Box.make(realm, true);
    const seen: Array<number> = [];
    const stopAutorun = Realm.autorun(realm, (read) => {
      if (!read($on)) {
        return undefined;
      }
      return Realm.watch(
        realm,
        (inner) => inner($a),
        (value) => {
          seen.push(value);
        },
        { immediate: true },
      );
    });
    expect(seen).toEqual([1]);
    Realm.update(realm, (_read, write) => write($a, 2));
    expect(seen).toEqual([1, 2]);
    // The autorun's cleanup stops the watch.
    Realm.update(realm, (_read, write) => write($on, false));
    Realm.update(realm, (_read, write) => write($a, 3));
    expect(seen).toEqual([1, 2]);
    stopAutorun();
  });

  test("selects a derivation", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 2);
    const $double = Computed.make(realm, (read) => read($a) * 2);
    const seen: Array<[number, number | undefined]> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($double),
      (value, previous) => {
        seen.push([value, previous]);
      },
      { immediate: true },
    );
    Realm.update(realm, (_read, write) => write($a, 3));
    expect(seen).toEqual([
      [4, undefined],
      [6, 4],
    ]);
    stop();
  });

  test("a select over another realm's box throws at the call, before the effect", () => {
    using realm = testRealm({ name: "ui" });
    const other = Realm.make({ name: "quotes" });
    const $theirs = Box.make(other, 1);
    let runs = 0;
    const code = codeOf(() =>
      Realm.watch(
        realm,
        (read) => read($theirs),
        () => {
          runs++;
        },
        { immediate: true },
      ),
    );
    expect(code).toBe("pinna/foreign-realm");
    expect(runs).toBe(0);
  });

  test("a visible stage's guess is the first value, as the select reads it", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const stage = Stage.make(realm, { visible: true });
    Stage.update(stage, (_read, write) => write($a, 5));
    const seen: Array<[number, number | undefined]> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($a),
      (value, previous) => {
        seen.push([value, previous]);
      },
      { immediate: true },
    );
    Stage.drop(stage);
    expect(seen).toEqual([
      [5, undefined],
      [1, 5],
    ]);
    stop();
  });

  test("testRealm counts it until it is stopped", () => {
    const realm = testRealm();
    const $a = Box.make(realm, 1);
    Realm.watch(
      realm,
      (read) => read($a),
      () => undefined,
      {
        immediate: true,
        name: "left",
      },
    );
    expect(codeOf(() => realm[Symbol.dispose]())).toBe("pinna/test-realm-not-at-rest");
  });

  test("a disposed realm refuses it as every watch", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 1);
    Realm.dispose(realm);
    expect(
      codeOf(() =>
        Realm.watch(
          realm,
          (read) => read($a),
          () => undefined,
          { immediate: true },
        ),
      ),
    ).toBe("pinna/realm-disposed");
  });
});

describe("an immediate scheduled watch", () => {
  test("runs at the call, then when the scheduler runs", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const later = frame();
    const seen: Array<[number, number | undefined]> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($a),
      (value, previous) => {
        seen.push([value, previous]);
      },
      { immediate: true, scheduler: later.scheduler },
    );
    expect(seen).toEqual([[1, undefined]]);
    Realm.update(realm, (_read, write) => write($a, 2));
    Realm.update(realm, (_read, write) => write($a, 3));
    expect(seen).toEqual([[1, undefined]]);
    later.flush();
    expect(seen).toEqual([
      [1, undefined],
      [3, 1],
    ]);
    stop();
  });

  test("an error from the run at the call is thrown and nothing stays watched", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const later = frame();
    const failure = new Error("first");
    expect(() =>
      Realm.watch(
        realm,
        (read) => read($a),
        () => {
          throw failure;
        },
        { immediate: true, scheduler: later.scheduler },
      ),
    ).toThrow(failure);
    Realm.update(realm, (_read, write) => write($a, 2));
    later.flush();
    expect(Source.inspect($a).observers).toBe(0);
  });

  test("is refused inside an update", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const later = frame();
    const code = codeOf(() =>
      Realm.update(realm, () => {
        Realm.watch(
          realm,
          (read) => read($a),
          () => undefined,
          {
            immediate: true,
            scheduler: later.scheduler,
          },
        );
      }),
    );
    expect(code).toBe("pinna/watch-immediate-in-update");
  });
});

describe("an immediate watch and what it starts", () => {
  test("a hook that writes on start delivers its value first, never a stale one", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const stopHook = Source.onObserved($a, () => {
      Realm.update(realm, (_read, write) => write($a, 2));
      return undefined;
    });
    const seen: Array<[number, number | undefined]> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($a),
      (value, previous) => {
        seen.push([value, previous]);
      },
      { immediate: true },
    );
    expect(seen).toEqual([[2, undefined]]);
    Realm.update(realm, (_read, write) => write($a, 3));
    expect(seen).toEqual([
      [2, undefined],
      [3, 2],
    ]);
    stop();
    stopHook();
  });

  test("a hook's write that equals finds unchanged still leaves the first value current", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const stopHook = Source.onObserved($a, () => {
      Realm.update(realm, (_read, write) => write($a, 2));
      return undefined;
    });
    const seen: Array<[number, number | undefined]> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($a),
      (value, previous) => {
        seen.push([value, previous]);
      },
      { immediate: true, equals: () => true },
    );
    expect(seen).toEqual([[2, undefined]]);
    stop();
    stopHook();
  });

  test("a scheduled one made in an autorun's body runs its first effect untracked", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $other = Box.make(realm, 10);
    const later = frame();
    let autoruns = 0;
    let tracking: boolean | undefined;
    const stopAutorun = Realm.autorun(realm, () => {
      autoruns++;
      return Realm.watch(
        realm,
        (read) => read($a),
        () => {
          tracking = Realm.isTracking(realm);
          Source.peek($other);
        },
        { immediate: true, scheduler: later.scheduler },
      );
    });
    expect(tracking).toBe(false);
    Realm.update(realm, (_read, write) => write($other, 20));
    later.flush();
    expect(autoruns).toBe(1);
    stopAutorun();
  });
});

describe("an immediate watch's run at the call, against what it writes", () => {
  test("a write it makes settles once it returns, as an autorun's first run's does", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $b = Box.make(realm, 0);
    const log: Array<string> = [];
    const stopOther = Realm.watch(
      realm,
      (read) => read($b),
      (value) => {
        log.push(`other ${value}`);
      },
    );
    const stop = Realm.watch(
      realm,
      (read) => read($a),
      (value, previous) => {
        log.push(`start ${value} ${previous}`);
        if (value === 1) {
          Realm.update(realm, (_read, write) => {
            write($a, 2);
            write($b, 1);
          });
        }
        log.push(`end ${value}`);
      },
      { immediate: true },
    );
    // Neither this watch's change nor another watch runs inside the run at
    // the call, so the effect never starts again before it returns.
    expect(log).toEqual(["start 1 undefined", "end 1", "start 2 1", "end 2", "other 1"]);
    stop();
    stopOther();
  });

  test("an update it makes reaches Realm.onUpdate before Realm.watch returns", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $b = Box.make(realm, 0);
    const later = frame();
    for (const options of [
      { immediate: true },
      { immediate: true, scheduler: later.scheduler },
    ] as const) {
      const log: Array<string> = [];
      const stopListening = Realm.onUpdate(realm, () => {
        log.push("record");
      });
      const stop = Realm.watch(
        realm,
        (read) => read($a),
        () => {
          Realm.update(realm, (read, write) => write($b, read($b) + 1));
        },
        options,
      );
      log.push("returned");
      expect(log).toEqual(["record", "returned"]);
      stop();
      stopListening();
    }
  });

  test("lets go of the first value once it is delivered", async () => {
    // Against a watch without the option, so a GC that collects nothing
    // fails the control, not the claim.
    const firstValueKept = async (options: WatchOptions<object>): Promise<boolean> => {
      const realm = Realm.make();
      const $a = Box.make<object>(realm, { rows: new Array(1000).fill(1) });
      const first = new WeakRef(Source.peek($a));
      const stop = Realm.watch(
        realm,
        (read) => read($a),
        () => undefined,
        options,
      );
      Realm.update(realm, (_read, write) => write($a, { rows: [] }));
      await Bun.sleep(1);
      Bun.gc(true);
      await Bun.sleep(1);
      Bun.gc(true);
      const kept = first.deref() !== undefined;
      stop();
      return kept;
    };
    expect(await firstValueKept({ equals: Object.is })).toBe(false);
    expect(await firstValueKept({ immediate: true })).toBe(false);
  });
});

describe("an immediate watch made inside a settle", () => {
  test("a hook it starts begins after the run at the call, and its write is a change equals judges", () => {
    for (const [options, expected] of [
      [
        { immediate: true },
        [
          [1, undefined],
          [2, 1],
        ],
      ],
      [{ immediate: true, equals: () => true }, [[1, undefined]]],
    ] as const) {
      using realm = testRealm();
      const $a = Box.make(realm, 1);
      const $go = Box.make(realm, 0);
      const stopHook = Source.onObserved($a, () => {
        Realm.update(realm, (_read, write) => write($a, 2));
        return undefined;
      });
      const seen: Array<[number, number | undefined]> = [];
      let stopInner: (() => void) | undefined;
      const stopOuter = Realm.watch(
        realm,
        (read) => read($go),
        () => {
          stopInner = Realm.watch(
            realm,
            (read) => read($a),
            (value, previous) => {
              seen.push([value, previous]);
            },
            options,
          );
        },
      );
      Realm.update(realm, (_read, write) => write($go, 1));
      expect(seen).toEqual(expected as unknown as Array<[number, number | undefined]>);
      stopInner?.();
      stopOuter();
      stopHook();
    }
  });
});

describe("an immediate watch's run at the call that throws after an update", () => {
  test("hands the update's record out before the error reaches the caller", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $b = Box.make(realm, 0);
    const later = frame();
    for (const options of [
      { immediate: true },
      { immediate: true, scheduler: later.scheduler },
    ] as const) {
      const log: Array<string> = [];
      const stopListening = Realm.onUpdate(realm, () => {
        log.push("record");
      });
      const failure = new Error("after the update");
      try {
        Realm.watch(
          realm,
          (read) => read($a),
          () => {
            Realm.update(realm, (read, write) => write($b, read($b) + 1));
            throw failure;
          },
          options,
        );
      } catch (error) {
        log.push(error === failure ? "caught" : String(error));
      }
      // Stopped while handling the error, so a record still queued is lost.
      stopListening();
      expect(log).toEqual(["record", "caught"]);
    }
  });
});

describe("an immediate watch's run at the call that throws after writing what it selects", () => {
  test("runs no effect for that write: the watch stops before the write settles", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 0);
    const later = frame();
    for (const options of [
      { immediate: true },
      { immediate: true, scheduler: later.scheduler },
    ] as const) {
      Realm.update(realm, (_read, write) => write($a, 0));
      const seen: Array<[number, number | undefined]> = [];
      const failure = new Error("after the write");
      expect(() =>
        Realm.watch(
          realm,
          (read) => read($a),
          (value, previous) => {
            seen.push([value, previous]);
            Realm.update(realm, (_read, write) => write($a, value + 1));
            throw failure;
          },
          options,
        ),
      ).toThrow(failure);
      later.flush();
      expect(seen).toEqual([[0, undefined]]);
      expect(Source.inspect($a).observers).toBe(0);
    }
  });
});
