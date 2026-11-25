import { describe, expect, test } from "bun:test";
import { Atom, Box, Computed, Realm, Source } from "../src/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * `Realm.autorun(effect)`: runs `effect` now, tracked, and again whenever
 * what it read changes (ruling 24).
 */

describe("autorun", () => {
  test("runs at once, then once per update, however many writes it makes", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 1);
    const $b = Box.make(realm, 2);
    const seen: Array<number> = [];
    const stop = Realm.autorun(realm, (read) => {
      seen.push(read($a) + read($b));
    });
    expect(seen).toEqual([3]);

    Realm.update(realm, (_read, write) => {
      write($a, 10);
      write($b, 20);
    });
    expect(seen).toEqual([3, 30]);
    stop();
  });

  test("tracks what the last run read", () => {
    const realm = Realm.make();
    const $useB = Box.make(realm, false);
    const $a = Box.make(realm, 1);
    const $b = Box.make(realm, 2);
    const seen: Array<number> = [];
    const stop = Realm.autorun(realm, (read) => {
      seen.push(read($useB) ? read($b) : read($a));
    });
    expect(Source.inspect($a).observers).toBe(1);
    expect(Source.inspect($b).observers).toBe(0);

    Realm.update(realm, (_read, write) => {
      write($useB, true);
    });
    expect(Source.inspect($a).observers).toBe(0);
    expect(Source.inspect($b).observers).toBe(1);

    Realm.update(realm, (_read, write) => {
      write($a, 5);
    });
    expect(seen).toEqual([1, 2]);
    stop();
  });

  test("reads are tracked inside the effect", () => {
    const realm = Realm.make();
    const tracking: Array<boolean> = [];
    const stop = Realm.autorun(realm, () => {
      tracking.push(Realm.isTracking(realm));
    });
    expect(tracking).toEqual([true]);
    stop();
  });

  test("counts as an observer, so onObserved hooks start and stop with it", () => {
    const realm = Realm.make();
    const $value = Box.make(realm, 0);
    const events: Array<string> = [];
    Source.onObserved($value, () => {
      events.push("start");
      return () => events.push("stop");
    });
    const stop = Realm.autorun(realm, (read) => {
      read($value);
    });
    expect(events).toEqual(["start"]);
    stop();
    expect(events).toEqual(["start", "stop"]);
  });

  test("stopping ends the runs, and stopping twice does nothing", () => {
    const realm = Realm.make();
    const $value = Box.make(realm, 0);
    const seen: Array<number> = [];
    const stop = Realm.autorun(realm, (read) => {
      seen.push(read($value));
    });
    stop();
    stop();
    Realm.update(realm, (_read, write) => {
      write($value, 1);
    });
    expect(seen).toEqual([0]);
    expect(Source.inspect($value).observers).toBe(0);
  });

  test("an error on the first run reaches the caller, and nothing is watched", () => {
    const realm = Realm.make();
    const $value = Box.make(realm, 0);
    expect(() =>
      Realm.autorun(realm, (read) => {
        read($value);
        throw new Error("first");
      }),
    ).toThrow("first");
    expect(Source.inspect($value).observers).toBe(0);
  });

  test("an error on a later run goes to onError, and the autorun keeps running", () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const $value = Box.make(realm, 0);
    const seen: Array<number> = [];
    const stop = Realm.autorun(realm, (read) => {
      const value = read($value);
      if (value === 1) {
        throw new Error("one");
      }
      seen.push(value);
    });
    Realm.update(realm, (_read, write) => {
      write($value, 1);
    });
    Realm.update(realm, (_read, write) => {
      write($value, 2);
    });
    expect(errors.map((error) => (error as Error).message)).toEqual(["one"]);
    expect(seen).toEqual([0, 2]);
    stop();
  });

  test("made inside an update, it runs at once and sees the update's writes so far", () => {
    const realm = Realm.make();
    const $value = Box.make(realm, 0);
    const seen: Array<number> = [];
    let stop: (() => void) | undefined;
    Realm.update(realm, (_read, write) => {
      write($value, 1);
      stop = Realm.autorun(realm, (read) => {
        seen.push(read($value));
      });
      write($value, 2);
    });
    expect(seen).toEqual([1, 2]);
    stop?.();
  });
});

/**
 * `Realm.update` in an autorun's body (ruling 46): the recipe runs untracked, and
 * an autorun that keeps changing what it read meets the round limit.
 */
describe("autorun writes", () => {
  test("a nested update refreshes a value over an atom after a write and a rollback", () => {
    const realm = Realm.make();
    const outside = Atom.make(realm);
    const source = Box.make(realm, 0);
    let computes = 0;
    const derived = Computed.make(realm, (read) => {
      computes++;
      read(outside);
      return read(source);
    });
    const seen: Array<number> = [];
    const abort = new Error("rollback");
    const stop = Realm.autorun(realm, (read) => {
      if (read(derived) !== 0 || seen.length !== 0) return;
      expect(read(derived)).toBe(0);
      expect(computes).toBe(1);
      expect(() =>
        Realm.update(realm, (read, write) => {
          write(source, 1);
          seen.push(read(source), read(derived));
          expect(read(derived)).toBe(1);
          expect(computes).toBe(2);
          throw abort;
        }),
      ).toThrow(abort);
      seen.push(read(derived));
      expect(computes).toBe(3);
    });
    expect(seen).toEqual([1, 1, 0]);
    stop();
    expectRealmAtRest(realm);
  });

  test("a nested update retries a cached error after repairing its input", () => {
    const realm = Realm.make();
    const source = Box.make(realm, 0);
    let computes = 0;
    const derived = Computed.make(realm, (read) => {
      computes++;
      if (read(source) === 0) throw new Error("missing");
      return 1;
    });
    const stop = Realm.autorun(realm, (read) => {
      try {
        read(derived);
      } catch {
        expect(() => read(derived)).toThrow("missing");
        expect(computes).toBe(1);
        Realm.update(realm, (read, write) => {
          write(source, 1);
          expect(read(derived)).toBe(1);
          expect(read(derived)).toBe(1);
          expect(computes).toBe(2);
        });
      }
    });
    stop();
    expectRealmAtRest(realm);
  });

  const unsettled = "pinna: watchers did not settle after 100 rounds";

  const reporting = () => {
    const errors: Array<string> = [];
    const realm = Realm.make({ onError: (error) => errors.push((error as Error).message) });
    return { errors, realm };
  };

  test("a write to another box lands on the first run and on later runs", () => {
    const { errors, realm } = reporting();
    const $source = Box.make(realm, 1);
    const $copy = Box.make(realm, 0);
    const stop = Realm.autorun(realm, (read) => {
      const value = read($source);
      Realm.update(realm, (_read, write) => {
        write($copy, value);
      });
    });
    expect(Realm.untracked(realm, (read) => read($copy))).toBe(1);
    Realm.update(realm, (_read, write) => {
      write($source, 3);
    });
    expect(Realm.untracked(realm, (read) => read($copy))).toBe(3);
    expect(errors).toEqual([]);
    stop();
    expectRealmAtRest(realm);
  });

  test("a write through untracked still lands", () => {
    const { errors, realm } = reporting();
    const $source = Box.make(realm, 0);
    const $copy = Box.make(realm, 0);
    const stop = Realm.autorun(realm, (read) => {
      const value = read($source);
      Realm.untracked(realm, () =>
        Realm.update(realm, (_read, write) => {
          write($copy, value);
        }),
      );
    });
    Realm.update(realm, (_read, write) => {
      write($source, 3);
    });
    expect(Realm.untracked(realm, (read) => read($copy))).toBe(3);
    expect(errors).toEqual([]);
    stop();
  });

  test("a write that settles what it read runs once more, on the first run", () => {
    const { errors, realm } = reporting();
    const $value = Box.make(realm, 50);
    const seen: Array<number> = [];
    const stop = Realm.autorun(realm, (read) => {
      const value = read($value);
      seen.push(value);
      if (value > 10) {
        Realm.update(realm, (_read, write) => {
          write($value, 10);
        });
      }
    });
    expect(seen).toEqual([50, 10]);
    expect(Realm.untracked(realm, (read) => read($value))).toBe(10);
    expect(errors).toEqual([]);
    stop();
    expectRealmAtRest(realm);
  });

  test("a write that settles what it read runs once more, on a later run", () => {
    const { errors, realm } = reporting();
    const $value = Box.make(realm, 0);
    const seen: Array<number> = [];
    const stop = Realm.autorun(realm, (read) => {
      const value = read($value);
      seen.push(value);
      if (value > 10) {
        Realm.update(realm, (_read, write) => {
          write($value, 10);
        });
      }
    });
    Realm.update(realm, (_read, write) => {
      write($value, 50);
    });
    expect(seen).toEqual([0, 50, 10]);
    expect(Realm.untracked(realm, (read) => read($value))).toBe(10);
    expect(errors).toEqual([]);
    stop();
    expectRealmAtRest(realm);
  });

  test("a write that settles, made inside an update, lands when the update ends", () => {
    const { errors, realm } = reporting();
    const $value = Box.make(realm, 0);
    const seen: Array<number> = [];
    let stop: (() => void) | undefined;
    Realm.update(realm, (_read, write) => {
      write($value, 50);
      stop = Realm.autorun(realm, (read) => {
        const value = read($value);
        seen.push(value);
        if (value > 10) {
          Realm.update(realm, (_inner, writeInner) => {
            writeInner($value, 10);
          });
        }
      });
    });
    expect(seen).toEqual([50, 10]);
    expect(Realm.untracked(realm, (read) => read($value))).toBe(10);
    expect(errors).toEqual([]);
    stop?.();
    expectRealmAtRest(realm);
  });

  test("a write the next run reads first does not run it again", () => {
    const { realm } = reporting();
    const $value = Box.make(realm, 0);
    let runs = 0;
    const stop = Realm.autorun(realm, (read) => {
      runs++;
      Realm.update(realm, (_read, write) => {
        write($value, 1);
      });
      read($value);
    });
    expect(runs).toBe(1);
    stop();
  });

  test("a write that never settles, on the first run, goes to onError at the round limit", () => {
    const { errors, realm } = reporting();
    const $value = Box.make(realm, 0);
    let runs = 0;
    const stop = Realm.autorun(realm, (read) => {
      runs++;
      const value = read($value);
      Realm.update(realm, (_read, write) => {
        write($value, value + 1);
      });
    });
    expect(errors).toEqual([unsettled]);
    expect(runs).toBe(101);
    // The first run, then one run a round: the last round's write is left in place.
    expect(Realm.untracked(realm, (read) => read($value))).toBe(101);
    // Still watched: the next write starts the loop again, and it ends at the limit again.
    Realm.update(realm, (_read, write) => {
      write($value, 0);
    });
    expect(errors).toEqual([unsettled, unsettled]);
    expect(runs).toBe(201);
    stop();
    expectRealmAtRest(realm);
  });

  test("a write that never settles, on a later run, goes to onError at the round limit", () => {
    const { errors, realm } = reporting();
    const $value = Box.make(realm, 0);
    let runs = 0;
    const stop = Realm.autorun(realm, (read) => {
      runs++;
      const value = read($value);
      if (value > 0) {
        Realm.update(realm, (_read, write) => {
          write($value, value + 1);
        });
      }
    });
    Realm.update(realm, (_read, write) => {
      write($value, 1);
    });
    expect(errors).toEqual([unsettled]);
    expect(runs).toBe(101);
    stop();
    expectRealmAtRest(realm);
  });

  test("a write that never settles, made inside an update, keeps the update's writes", () => {
    const { errors, realm } = reporting();
    const $value = Box.make(realm, 0);
    const $other = Box.make(realm, 0);
    let runs = 0;
    let stop: (() => void) | undefined;
    Realm.update(realm, (_read, write) => {
      write($other, 1);
      stop = Realm.autorun(realm, (read) => {
        runs++;
        const value = read($value);
        Realm.update(realm, (_inner, writeInner) => {
          writeInner($value, value + 1);
        });
      });
    });
    expect(errors).toEqual([unsettled]);
    expect(runs).toBe(101);
    expect(Realm.untracked(realm, (read) => read($other))).toBe(1);
    stop?.();
    expectRealmAtRest(realm);
  });

  test("the recipe's reads do not subscribe the autorun", () => {
    const { realm } = reporting();
    const $trigger = Box.make(realm, 0);
    const $readInRecipe = Box.make(realm, 0);
    const $copy = Box.make(realm, 0);
    let runs = 0;
    const stop = Realm.autorun(realm, (read) => {
      runs++;
      read($trigger);
      Realm.update(realm, (readInRecipe, write) => {
        write($copy, readInRecipe($readInRecipe));
      });
    });
    expect(Source.inspect($readInRecipe).observers).toBe(0);
    Realm.update(realm, (_read, write) => {
      write($readInRecipe, 5);
    });
    expect(runs).toBe(1);
    Realm.update(realm, (_read, write) => {
      write($trigger, 1);
    });
    expect(runs).toBe(2);
    expect(Realm.untracked(realm, (read) => read($copy))).toBe(5);
    stop();
  });

  test("the body tracks before and after an update, and the recipe does not", () => {
    const { realm } = reporting();
    const $before = Box.make(realm, 0);
    const $after = Box.make(realm, 0);
    const tracking: Array<boolean> = [];
    let runs = 0;
    const stop = Realm.autorun(realm, (read) => {
      runs++;
      read($before);
      tracking.push(Realm.isTracking(realm));
      Realm.update(realm, () => {
        tracking.push(Realm.isTracking(realm));
      });
      tracking.push(Realm.isTracking(realm));
      read($after);
    });
    expect(tracking).toEqual([true, false, true]);
    Realm.update(realm, (_read, write) => {
      write($after, 1);
    });
    expect(runs).toBe(2);
    stop();
  });

  test("a recipe that throws is rolled back; on the first run its error reaches the caller", () => {
    const { realm } = reporting();
    const $value = Box.make(realm, 0);
    expect(() =>
      Realm.autorun(realm, (read) => {
        read($value);
        Realm.update(realm, (_read, write) => {
          write($value, 1);
          throw new Error("recipe");
        });
      }),
    ).toThrow("recipe");
    expect(Realm.untracked(realm, (read) => read($value))).toBe(0);
    expect(Source.inspect($value).observers).toBe(0);
    expectRealmAtRest(realm);
  });

  test("a recipe that throws on a later run is rolled back, goes to onError, and the body still tracks", () => {
    const { errors, realm } = reporting();
    const $value = Box.make(realm, 0);
    const $after = Box.make(realm, 0);
    let runs = 0;
    const stop = Realm.autorun(realm, (read) => {
      runs++;
      const value = read($value);
      if (value === 1) {
        try {
          Realm.update(realm, (_read, write) => {
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
    Realm.update(realm, (_read, write) => {
      write($value, 1);
    });
    // The rollback puts back the version the run read: no run follows it.
    expect(runs).toBe(2);
    expect(errors).toEqual(["body"]);
    expect(Realm.untracked(realm, (read) => read($value))).toBe(1);
    Realm.update(realm, (_read, write) => {
      write($after, 1);
    });
    expect(runs).toBe(3);
    stop();
    expectRealmAtRest(realm);
  });

  test("an autorun made in an autorun's body writes, and the outer body still writes after it", () => {
    const { errors, realm } = reporting();
    const $outer = Box.make(realm, 0);
    const $inner = Box.make(realm, 0);
    const stops: Array<() => void> = [];
    const stop = Realm.autorun(realm, (read) => {
      read($outer);
      stops.push(
        Realm.autorun(realm, () => {
          Realm.update(realm, (_read, write) => {
            write($inner, 1);
          });
        }),
      );
      Realm.update(realm, (_read, write) => {
        write($outer, 1);
      });
    });
    expect(Realm.untracked(realm, (read) => [read($outer), read($inner)])).toEqual([1, 1]);
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
    const realm = Realm.make();
    const $value = Box.make(realm, 0);
    const log: Array<string> = [];
    const stop = Realm.autorun(realm, (read) => {
      const value = read($value);
      log.push(`run ${value}`);
      return () => {
        log.push(`cleanup ${value}`);
      };
    });
    Realm.update(realm, (_read, write) => {
      write($value, 1);
    });
    expect(log).toEqual(["run 0", "cleanup 0", "run 1"]);
    stop();
    expect(log).toEqual(["run 0", "cleanup 0", "run 1", "cleanup 1"]);
    stop();
    expect(log).toEqual(["run 0", "cleanup 0", "run 1", "cleanup 1"]);
  });

  test("a cleanup reads untracked, so what it reads reruns nothing", () => {
    const realm = Realm.make();
    const $value = Box.make(realm, 0);
    const $other = Box.make(realm, 0);
    const tracking: Array<boolean> = [];
    let runs = 0;
    const stop = Realm.autorun(realm, (read) => {
      runs++;
      read($value);
      return () => {
        tracking.push(Realm.isTracking(realm));
        read($other);
      };
    });
    Realm.update(realm, (_read, write) => {
      write($value, 1);
    });
    Realm.update(realm, (_read, write) => {
      write($other, 1);
    });
    expect(runs).toBe(2);
    expect(tracking).toEqual([false]);
    expect(Source.inspect($other).observers).toBe(0);
    stop();
  });

  test("a cleanup may write through an update", () => {
    const realm = Realm.make();
    const $value = Box.make(realm, 0);
    const $cleaned = Box.make(realm, 0);
    const stop = Realm.autorun(realm, (read) => {
      const value = read($value);
      return () => {
        Realm.update(realm, (_read, write) => {
          write($cleaned, value + 100);
        });
      };
    });
    Realm.update(realm, (_read, write) => {
      write($value, 1);
    });
    expect(Realm.untracked(realm, (read) => read($cleaned))).toBe(100);
    stop();
    expect(Realm.untracked(realm, (read) => read($cleaned))).toBe(101);
  });

  test("a cleanup that stops its own autorun runs once, and the effect does not run again", () => {
    const realm = Realm.make();
    const $value = Box.make(realm, 0);
    const log: Array<string> = [];
    let stop: () => void = () => {};
    stop = Realm.autorun(realm, (read) => {
      log.push(`run ${read($value)}`);
      return () => {
        log.push("cleanup");
        stop();
      };
    });
    Realm.update(realm, (_read, write) => {
      write($value, 1);
    });
    expect(log).toEqual(["run 0", "cleanup"]);
    expect(Source.inspect($value).observers).toBe(0);
  });

  test("an effect that stops its own autorun has its cleanup run at once", () => {
    const realm = Realm.make();
    const $value = Box.make(realm, 0);
    const log: Array<string> = [];
    let stop: (() => void) | undefined;
    stop = Realm.autorun(realm, (read) => {
      const value = read($value);
      log.push(`run ${value}`);
      if (value === 1) {
        stop?.();
      }
      return () => {
        log.push(`cleanup ${value}`);
      };
    });
    Realm.update(realm, (_read, write) => {
      write($value, 1);
    });
    expect(log).toEqual(["run 0", "cleanup 0", "run 1", "cleanup 1"]);
    expect(Source.inspect($value).observers).toBe(0);
  });

  test("a cleanup error goes to onError, and the effect still runs", () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const $value = Box.make(realm, 0);
    const seen: Array<number> = [];
    const stop = Realm.autorun(realm, (read) => {
      seen.push(read($value));
      return () => {
        throw new Error("cleanup");
      };
    });
    Realm.update(realm, (_read, write) => {
      write($value, 1);
    });
    expect(seen).toEqual([0, 1]);
    expect(errors.map((error) => (error as Error).message)).toEqual(["cleanup"]);
    stop();
    expect(errors.map((error) => (error as Error).message)).toEqual(["cleanup", "cleanup"]);
  });

  test("an effect that throws still runs the cleanup before it, and leaves none", () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const $value = Box.make(realm, 0);
    const log: Array<string> = [];
    const stop = Realm.autorun(realm, (read) => {
      const value = read($value);
      if (value === 1) {
        throw new Error("one");
      }
      return () => {
        log.push(`cleanup ${value}`);
      };
    });
    Realm.update(realm, (_read, write) => {
      write($value, 1);
    });
    expect(log).toEqual(["cleanup 0"]);
    stop();
    expect(log).toEqual(["cleanup 0"]);
    expect(errors.map((error) => (error as Error).message)).toEqual(["one"]);
  });

  test("a stop that throws, inside a computed value, leaves the autorun to stop later", () => {
    const realm = Realm.make();
    const $value = Box.make(realm, 0);
    const log: Array<string> = [];
    const stop = Realm.autorun(realm, (read) => {
      const value = read($value);
      log.push(`run ${value}`);
      return () => {
        log.push(`cleanup ${value}`);
      };
    });
    const $stops = Computed.make(realm, () => {
      stop();
      return 0;
    });
    expect(() => Realm.untracked(realm, (read) => read($stops))).toThrow();
    expect(log).toEqual(["run 0"]);
    stop();
    expect(log).toEqual(["run 0", "cleanup 0"]);
    expect(Source.inspect($value).observers).toBe(0);
  });

  test("an autorun that throws after a later run left a cleanup runs it", () => {
    // A hook the first run starts writes 1, and the rerun throws. The
    // reporter writes 2 and throws, so a later rerun in the same settle
    // succeeds and leaves a cleanup, and then autorun throws the reporter's
    // error: the caller has no stop function to run that cleanup.
    const realm = Realm.make({
      onError: (error) => {
        Realm.update(realm, (_read, write) => {
          write($value, 2);
        });
        throw error;
      },
    });
    const $value = Box.make(realm, 0);
    const $trigger = Box.make(realm, 0);
    Source.onObserved($trigger, () => {
      Realm.update(realm, (_read, write) => {
        write($value, 1);
      });
      return undefined;
    });
    const log: Array<string> = [];
    expect(() =>
      Realm.autorun(realm, (read) => {
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
    expect(Source.inspect($trigger).observers).toBe(0);
  });
});
