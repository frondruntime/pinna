import { describe, expect, test } from "bun:test";
import {
  autorun,
  box,
  computed,
  createRealm,
  inspect,
  isTracking,
  onObserved,
  untracked,
  update,
} from "../src/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * `autorun(effect)`: runs `effect` now, tracked, and again whenever
 * what it read changes (ruling 24).
 */

describe("autorun", () => {
  test("runs at once, then once per update, however many writes it makes", () => {
    const realm = createRealm();
    const $a = box(realm, 1);
    const $b = box(realm, 2);
    const seen: Array<number> = [];
    const stop = autorun(realm, (read) => {
      seen.push(read($a) + read($b));
    });
    expect(seen).toEqual([3]);

    update(realm, (_read, write) => {
      write($a, 10);
      write($b, 20);
    });
    expect(seen).toEqual([3, 30]);
    stop();
  });

  test("tracks what the last run read", () => {
    const realm = createRealm();
    const $useB = box(realm, false);
    const $a = box(realm, 1);
    const $b = box(realm, 2);
    const seen: Array<number> = [];
    const stop = autorun(realm, (read) => {
      seen.push(read($useB) ? read($b) : read($a));
    });
    expect(inspect($a).observers).toBe(1);
    expect(inspect($b).observers).toBe(0);

    update(realm, (_read, write) => {
      write($useB, true);
    });
    expect(inspect($a).observers).toBe(0);
    expect(inspect($b).observers).toBe(1);

    update(realm, (_read, write) => {
      write($a, 5);
    });
    expect(seen).toEqual([1, 2]);
    stop();
  });

  test("reads are tracked inside the effect", () => {
    const realm = createRealm();
    const tracking: Array<boolean> = [];
    const stop = autorun(realm, () => {
      tracking.push(isTracking(realm));
    });
    expect(tracking).toEqual([true]);
    stop();
  });

  test("counts as an observer, so onObserved hooks start and stop with it", () => {
    const realm = createRealm();
    const $value = box(realm, 0);
    const events: Array<string> = [];
    onObserved($value, () => {
      events.push("start");
      return () => events.push("stop");
    });
    const stop = autorun(realm, (read) => {
      read($value);
    });
    expect(events).toEqual(["start"]);
    stop();
    expect(events).toEqual(["start", "stop"]);
  });

  test("stopping ends the runs, and stopping twice does nothing", () => {
    const realm = createRealm();
    const $value = box(realm, 0);
    const seen: Array<number> = [];
    const stop = autorun(realm, (read) => {
      seen.push(read($value));
    });
    stop();
    stop();
    update(realm, (_read, write) => {
      write($value, 1);
    });
    expect(seen).toEqual([0]);
    expect(inspect($value).observers).toBe(0);
  });

  test("an error on the first run reaches the caller, and nothing is watched", () => {
    const realm = createRealm();
    const $value = box(realm, 0);
    expect(() =>
      autorun(realm, (read) => {
        read($value);
        throw new Error("first");
      }),
    ).toThrow("first");
    expect(inspect($value).observers).toBe(0);
  });

  test("an error on a later run goes to onError, and the autorun keeps running", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const $value = box(realm, 0);
    const seen: Array<number> = [];
    const stop = autorun(realm, (read) => {
      const value = read($value);
      if (value === 1) {
        throw new Error("one");
      }
      seen.push(value);
    });
    update(realm, (_read, write) => {
      write($value, 1);
    });
    update(realm, (_read, write) => {
      write($value, 2);
    });
    expect(errors.map((error) => (error as Error).message)).toEqual(["one"]);
    expect(seen).toEqual([0, 2]);
    stop();
  });

  test("made inside an update, it runs at once and sees the update's writes so far", () => {
    const realm = createRealm();
    const $value = box(realm, 0);
    const seen: Array<number> = [];
    let stop: (() => void) | undefined;
    update(realm, (_read, write) => {
      write($value, 1);
      stop = autorun(realm, (read) => {
        seen.push(read($value));
      });
      write($value, 2);
    });
    expect(seen).toEqual([1, 2]);
    stop?.();
  });
});

/**
 * `update` in an autorun's body (ruling 46): the recipe runs untracked, and
 * an autorun that keeps changing what it read meets the round limit.
 */
describe("autorun writes", () => {
  const unsettled = "pinna: watchers did not settle after 100 rounds";

  const reporting = () => {
    const errors: Array<string> = [];
    const realm = createRealm({ onError: (error) => errors.push((error as Error).message) });
    return { errors, realm };
  };

  test("a write to another box lands on the first run and on later runs", () => {
    const { errors, realm } = reporting();
    const $source = box(realm, 1);
    const $copy = box(realm, 0);
    const stop = autorun(realm, (read) => {
      const value = read($source);
      update(realm, (_read, write) => {
        write($copy, value);
      });
    });
    expect(untracked(realm, (read) => read($copy))).toBe(1);
    update(realm, (_read, write) => {
      write($source, 3);
    });
    expect(untracked(realm, (read) => read($copy))).toBe(3);
    expect(errors).toEqual([]);
    stop();
    expectRealmAtRest(realm);
  });

  test("a write through untracked still lands", () => {
    const { errors, realm } = reporting();
    const $source = box(realm, 0);
    const $copy = box(realm, 0);
    const stop = autorun(realm, (read) => {
      const value = read($source);
      untracked(realm, () =>
        update(realm, (_read, write) => {
          write($copy, value);
        }),
      );
    });
    update(realm, (_read, write) => {
      write($source, 3);
    });
    expect(untracked(realm, (read) => read($copy))).toBe(3);
    expect(errors).toEqual([]);
    stop();
  });

  test("a write that settles what it read runs once more, on the first run", () => {
    const { errors, realm } = reporting();
    const $value = box(realm, 50);
    const seen: Array<number> = [];
    const stop = autorun(realm, (read) => {
      const value = read($value);
      seen.push(value);
      if (value > 10) {
        update(realm, (_read, write) => {
          write($value, 10);
        });
      }
    });
    expect(seen).toEqual([50, 10]);
    expect(untracked(realm, (read) => read($value))).toBe(10);
    expect(errors).toEqual([]);
    stop();
    expectRealmAtRest(realm);
  });

  test("a write that settles what it read runs once more, on a later run", () => {
    const { errors, realm } = reporting();
    const $value = box(realm, 0);
    const seen: Array<number> = [];
    const stop = autorun(realm, (read) => {
      const value = read($value);
      seen.push(value);
      if (value > 10) {
        update(realm, (_read, write) => {
          write($value, 10);
        });
      }
    });
    update(realm, (_read, write) => {
      write($value, 50);
    });
    expect(seen).toEqual([0, 50, 10]);
    expect(untracked(realm, (read) => read($value))).toBe(10);
    expect(errors).toEqual([]);
    stop();
    expectRealmAtRest(realm);
  });

  test("a write that settles, made inside an update, lands when the update ends", () => {
    const { errors, realm } = reporting();
    const $value = box(realm, 0);
    const seen: Array<number> = [];
    let stop: (() => void) | undefined;
    update(realm, (_read, write) => {
      write($value, 50);
      stop = autorun(realm, (read) => {
        const value = read($value);
        seen.push(value);
        if (value > 10) {
          update(realm, (_inner, writeInner) => {
            writeInner($value, 10);
          });
        }
      });
    });
    expect(seen).toEqual([50, 10]);
    expect(untracked(realm, (read) => read($value))).toBe(10);
    expect(errors).toEqual([]);
    stop?.();
    expectRealmAtRest(realm);
  });

  test("a write the next run reads first does not run it again", () => {
    const { realm } = reporting();
    const $value = box(realm, 0);
    let runs = 0;
    const stop = autorun(realm, (read) => {
      runs++;
      update(realm, (_read, write) => {
        write($value, 1);
      });
      read($value);
    });
    expect(runs).toBe(1);
    stop();
  });

  test("a write that never settles, on the first run, goes to onError at the round limit", () => {
    const { errors, realm } = reporting();
    const $value = box(realm, 0);
    let runs = 0;
    const stop = autorun(realm, (read) => {
      runs++;
      const value = read($value);
      update(realm, (_read, write) => {
        write($value, value + 1);
      });
    });
    expect(errors).toEqual([unsettled]);
    expect(runs).toBe(101);
    // The first run, then one run a round: the last round's write is left in place.
    expect(untracked(realm, (read) => read($value))).toBe(101);
    // Still watched: the next write starts the loop again, and it ends at the limit again.
    update(realm, (_read, write) => {
      write($value, 0);
    });
    expect(errors).toEqual([unsettled, unsettled]);
    expect(runs).toBe(201);
    stop();
    expectRealmAtRest(realm);
  });

  test("a write that never settles, on a later run, goes to onError at the round limit", () => {
    const { errors, realm } = reporting();
    const $value = box(realm, 0);
    let runs = 0;
    const stop = autorun(realm, (read) => {
      runs++;
      const value = read($value);
      if (value > 0) {
        update(realm, (_read, write) => {
          write($value, value + 1);
        });
      }
    });
    update(realm, (_read, write) => {
      write($value, 1);
    });
    expect(errors).toEqual([unsettled]);
    expect(runs).toBe(101);
    stop();
    expectRealmAtRest(realm);
  });

  test("a write that never settles, made inside an update, keeps the update's writes", () => {
    const { errors, realm } = reporting();
    const $value = box(realm, 0);
    const $other = box(realm, 0);
    let runs = 0;
    let stop: (() => void) | undefined;
    update(realm, (_read, write) => {
      write($other, 1);
      stop = autorun(realm, (read) => {
        runs++;
        const value = read($value);
        update(realm, (_inner, writeInner) => {
          writeInner($value, value + 1);
        });
      });
    });
    expect(errors).toEqual([unsettled]);
    expect(runs).toBe(101);
    expect(untracked(realm, (read) => read($other))).toBe(1);
    stop?.();
    expectRealmAtRest(realm);
  });

  test("the recipe's reads do not subscribe the autorun", () => {
    const { realm } = reporting();
    const $trigger = box(realm, 0);
    const $readInRecipe = box(realm, 0);
    const $copy = box(realm, 0);
    let runs = 0;
    const stop = autorun(realm, (read) => {
      runs++;
      read($trigger);
      update(realm, (readInRecipe, write) => {
        write($copy, readInRecipe($readInRecipe));
      });
    });
    expect(inspect($readInRecipe).observers).toBe(0);
    update(realm, (_read, write) => {
      write($readInRecipe, 5);
    });
    expect(runs).toBe(1);
    update(realm, (_read, write) => {
      write($trigger, 1);
    });
    expect(runs).toBe(2);
    expect(untracked(realm, (read) => read($copy))).toBe(5);
    stop();
  });

  test("the body tracks before and after an update, and the recipe does not", () => {
    const { realm } = reporting();
    const $before = box(realm, 0);
    const $after = box(realm, 0);
    const tracking: Array<boolean> = [];
    let runs = 0;
    const stop = autorun(realm, (read) => {
      runs++;
      read($before);
      tracking.push(isTracking(realm));
      update(realm, () => {
        tracking.push(isTracking(realm));
      });
      tracking.push(isTracking(realm));
      read($after);
    });
    expect(tracking).toEqual([true, false, true]);
    update(realm, (_read, write) => {
      write($after, 1);
    });
    expect(runs).toBe(2);
    stop();
  });

  test("a recipe that throws is rolled back; on the first run its error reaches the caller", () => {
    const { realm } = reporting();
    const $value = box(realm, 0);
    expect(() =>
      autorun(realm, (read) => {
        read($value);
        update(realm, (_read, write) => {
          write($value, 1);
          throw new Error("recipe");
        });
      }),
    ).toThrow("recipe");
    expect(untracked(realm, (read) => read($value))).toBe(0);
    expect(inspect($value).observers).toBe(0);
    expectRealmAtRest(realm);
  });

  test("a recipe that throws on a later run is rolled back, goes to onError, and the body still tracks", () => {
    const { errors, realm } = reporting();
    const $value = box(realm, 0);
    const $after = box(realm, 0);
    let runs = 0;
    const stop = autorun(realm, (read) => {
      runs++;
      const value = read($value);
      if (value === 1) {
        try {
          update(realm, (_read, write) => {
            write($value, 2);
            throw new Error("recipe");
          });
        } catch {
          // The body goes on after a failed update.
        }
        read($after);
        throw new Error("body");
      }
    });
    update(realm, (_read, write) => {
      write($value, 1);
    });
    // The rollback puts back the version the run read: no run follows it.
    expect(runs).toBe(2);
    expect(errors).toEqual(["body"]);
    expect(untracked(realm, (read) => read($value))).toBe(1);
    update(realm, (_read, write) => {
      write($after, 1);
    });
    expect(runs).toBe(3);
    stop();
    expectRealmAtRest(realm);
  });

  test("an autorun made in an autorun's body writes, and the outer body still writes after it", () => {
    const { errors, realm } = reporting();
    const $outer = box(realm, 0);
    const $inner = box(realm, 0);
    const stops: Array<() => void> = [];
    const stop = autorun(realm, (read) => {
      read($outer);
      stops.push(
        autorun(realm, () => {
          update(realm, (_read, write) => {
            write($inner, 1);
          });
        }),
      );
      update(realm, (_read, write) => {
        write($outer, 1);
      });
    });
    expect(untracked(realm, (read) => [read($outer), read($inner)])).toEqual([1, 1]);
    expect(errors).toEqual([]);
    stop();
    for (const stopInner of stops) {
      stopInner();
    }
    expectRealmAtRest(realm);
  });
});

describe("autorun cleanup", () => {
  test("a function the effect returns runs before the next run and on stop", () => {
    const realm = createRealm();
    const $value = box(realm, 0);
    const log: Array<string> = [];
    const stop = autorun(realm, (read) => {
      const value = read($value);
      log.push(`run ${value}`);
      return () => {
        log.push(`cleanup ${value}`);
      };
    });
    update(realm, (_read, write) => {
      write($value, 1);
    });
    expect(log).toEqual(["run 0", "cleanup 0", "run 1"]);
    stop();
    expect(log).toEqual(["run 0", "cleanup 0", "run 1", "cleanup 1"]);
    stop();
    expect(log).toEqual(["run 0", "cleanup 0", "run 1", "cleanup 1"]);
  });

  test("a cleanup reads untracked, so what it reads reruns nothing", () => {
    const realm = createRealm();
    const $value = box(realm, 0);
    const $other = box(realm, 0);
    const tracking: Array<boolean> = [];
    let runs = 0;
    const stop = autorun(realm, (read) => {
      runs++;
      read($value);
      return () => {
        tracking.push(isTracking(realm));
        read($other);
      };
    });
    update(realm, (_read, write) => {
      write($value, 1);
    });
    update(realm, (_read, write) => {
      write($other, 1);
    });
    expect(runs).toBe(2);
    expect(tracking).toEqual([false]);
    expect(inspect($other).observers).toBe(0);
    stop();
  });

  test("a cleanup may write through an update", () => {
    const realm = createRealm();
    const $value = box(realm, 0);
    const $cleaned = box(realm, 0);
    const stop = autorun(realm, (read) => {
      const value = read($value);
      return () => {
        update(realm, (_read, write) => {
          write($cleaned, value + 100);
        });
      };
    });
    update(realm, (_read, write) => {
      write($value, 1);
    });
    expect(untracked(realm, (read) => read($cleaned))).toBe(100);
    stop();
    expect(untracked(realm, (read) => read($cleaned))).toBe(101);
  });

  test("a cleanup that stops its own autorun runs once, and the effect does not run again", () => {
    const realm = createRealm();
    const $value = box(realm, 0);
    const log: Array<string> = [];
    let stop: () => void = () => {};
    stop = autorun(realm, (read) => {
      log.push(`run ${read($value)}`);
      return () => {
        log.push("cleanup");
        stop();
      };
    });
    update(realm, (_read, write) => {
      write($value, 1);
    });
    expect(log).toEqual(["run 0", "cleanup"]);
    expect(inspect($value).observers).toBe(0);
  });

  test("an effect that stops its own autorun has its cleanup run at once", () => {
    const realm = createRealm();
    const $value = box(realm, 0);
    const log: Array<string> = [];
    let stop: (() => void) | undefined;
    stop = autorun(realm, (read) => {
      const value = read($value);
      log.push(`run ${value}`);
      if (value === 1) {
        stop?.();
      }
      return () => {
        log.push(`cleanup ${value}`);
      };
    });
    update(realm, (_read, write) => {
      write($value, 1);
    });
    expect(log).toEqual(["run 0", "cleanup 0", "run 1", "cleanup 1"]);
    expect(inspect($value).observers).toBe(0);
  });

  test("a cleanup error goes to onError, and the effect still runs", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const $value = box(realm, 0);
    const seen: Array<number> = [];
    const stop = autorun(realm, (read) => {
      seen.push(read($value));
      return () => {
        throw new Error("cleanup");
      };
    });
    update(realm, (_read, write) => {
      write($value, 1);
    });
    expect(seen).toEqual([0, 1]);
    expect(errors.map((error) => (error as Error).message)).toEqual(["cleanup"]);
    stop();
    expect(errors.map((error) => (error as Error).message)).toEqual(["cleanup", "cleanup"]);
  });

  test("an effect that throws still runs the cleanup before it, and leaves none", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const $value = box(realm, 0);
    const log: Array<string> = [];
    const stop = autorun(realm, (read) => {
      const value = read($value);
      if (value === 1) {
        throw new Error("one");
      }
      return () => {
        log.push(`cleanup ${value}`);
      };
    });
    update(realm, (_read, write) => {
      write($value, 1);
    });
    expect(log).toEqual(["cleanup 0"]);
    stop();
    expect(log).toEqual(["cleanup 0"]);
    expect(errors.map((error) => (error as Error).message)).toEqual(["one"]);
  });

  test("a stop that throws, inside a computed value, leaves the autorun to stop later", () => {
    const realm = createRealm();
    const $value = box(realm, 0);
    const log: Array<string> = [];
    const stop = autorun(realm, (read) => {
      const value = read($value);
      log.push(`run ${value}`);
      return () => {
        log.push(`cleanup ${value}`);
      };
    });
    const $stops = computed(realm, () => {
      stop();
      return 0;
    });
    expect(() => untracked(realm, (read) => read($stops))).toThrow();
    expect(log).toEqual(["run 0"]);
    stop();
    expect(log).toEqual(["run 0", "cleanup 0"]);
    expect(inspect($value).observers).toBe(0);
  });

  test("an autorun that throws after a later run left a cleanup runs it", () => {
    // A hook the first run starts writes 1, and the rerun throws. The
    // reporter writes 2 and throws, so a later rerun in the same settle
    // succeeds and leaves a cleanup, and then autorun throws the reporter's
    // error: the caller has no stop function to run that cleanup.
    const realm = createRealm({
      onError: (error) => {
        update(realm, (_read, write) => {
          write($value, 2);
        });
        throw error;
      },
    });
    const $value = box(realm, 0);
    const $trigger = box(realm, 0);
    onObserved($trigger, () => {
      update(realm, (_read, write) => {
        write($value, 1);
      });
      return undefined;
    });
    const log: Array<string> = [];
    expect(() =>
      autorun(realm, (read) => {
        read($trigger);
        const value = read($value);
        if (value === 1) {
          throw new Error("one");
        }
        log.push(`run ${value}`);
        return () => {
          log.push(`cleanup ${value}`);
        };
      }),
    ).toThrow("one");
    expect(log).toEqual(["run 0", "cleanup 0", "run 2", "cleanup 2"]);
    expect(inspect($trigger).observers).toBe(0);
  });
});
