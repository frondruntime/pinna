import { describe, expect, test } from "bun:test";
import {
  atom,
  autorun,
  box,
  computed,
  computedFunction,
  createRealm,
  inspect,
  isTracking,
  observe,
  onObserved,
  type Realm,
  untracked,
  update,
  type Write,
  watch,
} from "../src/index.ts";

/**
 * Observation: when `onObserved` hooks run, holding an observable observed
 * with `observe`, and asking whether reads are tracked.
 */

/** A box whose hook logs "start" and "stop". */
const hooked = (realm: Realm) => {
  const $value = box(realm, 0);
  const events: Array<string> = [];
  onObserved($value, () => {
    events.push("start");
    return () => events.push("stop");
  });
  return { $value, events };
};

/** A watcher that rewrites its own box until the round limit stops it. */
const runaway = (realm: Realm) => {
  const $count = box(realm, 0);
  const stop = watch(
    realm,
    (read) => read($count),
    (count) => {
      if (count > 0 && count < 1000) {
        update(realm, (_read, write) => {
          write($count, count + 1);
        });
      }
    },
  );
  return {
    start: (write: Write) => write($count, 1),
    stop,
  };
};

describe("onObserved inside an update", () => {
  test("an observer lost and gained within one update fires nothing", () => {
    const realm = createRealm();
    const { $value, events } = hooked(realm);
    const first = observe($value);
    expect(events).toEqual(["start"]);

    let second: () => void = () => {};
    update(realm, () => {
      first();
      second = observe($value);
    });

    expect(events).toEqual(["start"]);
    second();
    expect(events).toEqual(["start", "stop"]);
  });

  test("a gain fires once, after the recipe returns", () => {
    const realm = createRealm();
    const { $value, events } = hooked(realm);
    let release: () => void = () => {};

    update(realm, () => {
      release = observe($value);
      events.push("recipe ends");
    });

    expect(events).toEqual(["recipe ends", "start"]);
    release();
  });

  test("a gain and loss within one update fires nothing", () => {
    const realm = createRealm();
    const { $value, events } = hooked(realm);

    update(realm, () => {
      observe($value)();
    });

    expect(events).toEqual([]);
  });

  test("a watcher that drops a source and another that picks it up in one flush fire nothing", () => {
    const realm = createRealm();
    const { $value, events } = hooked(realm);
    const $left = box(realm, true);
    const stopLeft = watch(
      realm,
      (read) => (read($left) ? read($value) : -1),
      () => {},
    );
    const stopRight = watch(
      realm,
      (read) => (read($left) ? -1 : read($value)),
      () => {},
    );
    expect(events).toEqual(["start"]);

    update(realm, (_read, write) => {
      write($left, false);
    });

    expect(events).toEqual(["start"]);
    stopLeft();
    stopRight();
    expect(events).toEqual(["start", "stop"]);
  });

  test("a hook that writes runs the watchers of what it wrote", () => {
    const realm = createRealm();
    const $value = box(realm, 0);
    const $loaded = box(realm, false);
    onObserved($value, () => {
      update(realm, (_read, write) => {
        write($loaded, true);
      });
      return undefined;
    });
    const seen: Array<boolean> = [];
    const stopLoaded = watch(
      realm,
      (read) => read($loaded),
      (loaded) => {
        seen.push(loaded);
      },
    );
    let release: () => void = () => {};

    update(realm, () => {
      release = observe($value);
    });

    expect(seen).toEqual([true]);
    release();
    stopLoaded();
  });

  test("a failed update settles against what is observed after it", () => {
    const realm = createRealm();
    const { $value, events } = hooked(realm);

    expect(() =>
      update(realm, () => {
        observe($value)();
        throw new Error("the recipe fails");
      }),
    ).toThrow("the recipe fails");

    expect(events).toEqual([]);
  });

  test("a hook's error inside an update goes to the realm's sink", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const $value = box(realm, 0);
    onObserved($value, () => {
      throw new Error("the hook fails");
    });
    let release: () => void = () => {};

    update(realm, () => {
      release = observe($value);
    });

    expect(errors).toEqual([new Error("the hook fails")]);
    release();
  });

  test("a stop due when the watchers never settle still runs, and a later start runs once", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const { $value, events } = hooked(realm);
    const stopLoop = runaway(realm);
    const first = observe($value);

    update(realm, (_read, write) => {
      first();
      stopLoop.start(write);
    });
    expect(events).toEqual(["start", "stop"]);

    observe($value)();
    expect(events).toEqual(["start", "stop", "start", "stop"]);
    expect(errors.length).toBe(1);
    stopLoop.stop();
  });

  test("a start due when the watchers never settle still runs", () => {
    const realm = createRealm({ onError: () => {} });
    const { $value, events } = hooked(realm);
    const stopLoop = runaway(realm);
    let release: () => void = () => {};

    update(realm, (_read, write) => {
      release = observe($value);
      stopLoop.start(write);
    });
    expect(events).toEqual(["start"]);

    release();
    expect(events).toEqual(["start", "stop"]);
    stopLoop.stop();
  });

  test("a hook added while its source waits to stop does not start", () => {
    const realm = createRealm();
    const { $value } = hooked(realm);
    const release = observe($value);
    const added: Array<string> = [];

    update(realm, () => {
      release();
      onObserved($value, () => {
        added.push("start");
        return () => added.push("stop");
      });
    });

    expect(added).toEqual([]);
  });

  test("a hook added while its source is lost and gained starts once the update ends", () => {
    const realm = createRealm();
    const { $value, events } = hooked(realm);
    const first = observe($value);
    const added: Array<string> = [];
    let second: () => void = () => {};

    update(realm, () => {
      first();
      onObserved($value, () => {
        added.push("start");
        return () => added.push("stop");
      });
      second = observe($value);
    });

    expect(events).toEqual(["start"]);
    expect(added).toEqual(["start"]);
    second();
    expect(added).toEqual(["start", "stop"]);
  });

  test("a memo read by two watchers made in one update computes once", () => {
    const realm = createRealm();
    let runs = 0;
    const double = computedFunction(realm, (_read, value: number) => {
      runs++;
      return value * 2;
    });
    const stops: Array<() => void> = [];

    update(realm, () => {
      stops.push(
        watch(
          realm,
          (read) => read(double(2)),
          () => {},
        ),
      );
      stops.push(
        watch(
          realm,
          (read) => read(double(2)),
          () => {},
        ),
      );
    });

    expect(runs).toBe(1);
    for (const stop of stops) {
      stop();
    }
  });

  test("a memo entry made in an update and left unobserved is not kept", () => {
    const realm = createRealm();
    const double = computedFunction(realm, (_read, value: number) => value * 2);
    let made: unknown;

    update(realm, () => {
      made = double(2);
    });

    expect(double(2)).not.toBe(made);
  });

  test("a hook that removes itself while it starts still has its cleanup run", () => {
    const realm = createRealm();
    const $value = box(realm, 0);
    let live = 0;
    let remove: () => void = () => {};
    remove = onObserved($value, () => {
      live++;
      remove();
      return () => {
        live--;
      };
    });

    observe($value)();

    expect(live).toBe(0);
  });

  test("a hook that removes and adds itself back while it starts keeps one cleanup", () => {
    const realm = createRealm();
    const $value = box(realm, 0);
    let live = 0;
    let added = false;
    const hook = (): (() => void) => {
      live++;
      if (!added) {
        added = true;
        remove();
        remove = onObserved($value, hook);
      }
      return () => {
        live--;
      };
    };
    let remove = onObserved($value, hook);

    const release = observe($value);
    expect(live).toBe(1);
    release();
    expect(live).toBe(0);
    remove();
  });

  test("a hook removed by an earlier hook's start does not start", () => {
    const realm = createRealm();
    const $value = box(realm, 0);
    const events: Array<string> = [];
    let removeSecond: () => void = () => {};
    onObserved($value, () => {
      removeSecond();
      return undefined;
    });
    removeSecond = onObserved($value, () => {
      events.push("start");
      return () => events.push("stop");
    });

    observe($value)();

    expect(events).toEqual([]);
  });

  test("a hook a settle at the round limit makes due still starts in that flush", () => {
    const realm = createRealm({ onError: () => {} });
    const $outer = box(realm, 0);
    const { $value, events } = hooked(realm);
    onObserved($outer, () => observe($value));
    const stopLoop = runaway(realm);
    let release: () => void = () => {};

    update(realm, (_read, write) => {
      release = observe($outer);
      stopLoop.start(write);
    });
    expect(events).toEqual(["start"]);

    release();
    expect(events).toEqual(["start", "stop"]);
    stopLoop.stop();
  });

  // The round limit counts the passes that begin a hook: each cleanup here
  // only stops the next autorun, so the chain is longer than the limit and
  // still ends.
  test("a chain of cleanups, each stopping the next autorun, settles in one flush", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const length = 300;
    const boxes = Array.from({ length }, () => box(realm, 0));
    const stops = boxes.map(($box) =>
      autorun(realm, (read) => {
        read($box);
      }),
    );
    let stopped = 0;
    boxes.forEach(($box, index) => {
      onObserved($box, () => () => {
        stopped++;
        stops[index + 1]?.();
      });
    });

    stops[0]?.();

    expect({ stopped, errors }).toEqual({ stopped: length, errors: [] });
  });

  test("hooks that keep starting and stopping each other are stopped and reported", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const $first = box(realm, 0);
    const $second = box(realm, 0);
    let releaseFirst: () => void = () => {};
    let releaseSecond: () => void = () => {};
    let starts = 0;
    onObserved($first, () => {
      starts++;
      releaseSecond = observe($second);
      return () => releaseSecond();
    });
    onObserved($second, () => {
      releaseFirst();
      return () => {
        releaseFirst = observe($first);
      };
    });

    update(realm, () => {
      releaseFirst = observe($first);
    });

    expect(starts).toBeGreaterThan(1);
    expect(starts).toBeLessThan(1000);
    expect(errors.map(String)).toEqual([
      "Error: pinna: onObserved hooks did not settle after 100 passes",
    ]);
  });

  // No source is due twice here, so only a bound on the passes that begin a
  // hook stops it: each of the 100 passes begins one. `cap` only keeps a
  // failing run from going on forever.
  test("hooks that each observe a new source are left due and reported", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const cap = 10_000;
    let starts = 0;
    const grow = (): (() => void) | undefined => {
      starts++;
      if (starts >= cap) {
        return undefined;
      }
      const $next = box(realm, 0);
      onObserved($next, grow);
      return observe($next);
    };
    const $first = box(realm, 0);
    onObserved($first, grow);

    update(realm, () => {
      observe($first);
    });

    expect({ starts, errors: errors.map(String) }).toEqual({
      starts: 100,
      errors: ["Error: pinna: onObserved hooks did not settle after 100 passes"],
    });
  });

  // Each hook's write sets a watcher going, so the watchers reach their
  // round limit too; the watcher only reads, and the hooks are what did not
  // settle. How the update begins does not change the report.
  test("hooks that never settle are reported as hooks when a write begins them and a watcher follows them", () => {
    const run = (writeFirst: boolean) => {
      const errors: Array<unknown> = [];
      const realm = createRealm({ onError: (error) => errors.push(error) });
      const $log = box(realm, 0);
      watch(
        realm,
        (read) => read($log),
        () => {},
      );
      const cap = 10_000;
      let starts = 0;
      const grow = (): (() => void) | undefined => {
        starts++;
        if (starts >= cap) {
          return undefined;
        }
        update(realm, (read, write) => {
          write($log, read($log) + 1);
        });
        const $next = box(realm, 0);
        onObserved($next, grow);
        return observe($next);
      };
      const $first = box(realm, 0);
      onObserved($first, grow);
      update(realm, (_read, write) => {
        if (writeFirst) {
          write($log, -1);
        }
        observe($first);
      });
      return errors.map(String);
    };

    expect({ observed: run(false), written: run(true) }).toEqual({
      observed: ["Error: pinna: onObserved hooks did not settle after 100 passes"],
      written: ["Error: pinna: onObserved hooks did not settle after 100 passes"],
    });
  });

  // The watchers reach their round limit first; the hooks due then settle
  // under their own limit, and are what the report names.
  test("hooks that keep beginning once the watchers reach their limit stop at the hook limit", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const $loop = box(realm, 0);
    watch(
      realm,
      (read) => read($loop),
      (value) => {
        if (value > 0) {
          update(realm, (_read, write) => {
            write($loop, value + 1);
          });
        }
      },
    );
    const cap = 10_000;
    let starts = 0;
    const grow = (): (() => void) | undefined => {
      starts++;
      if (starts >= cap) {
        return undefined;
      }
      const $next = box(realm, 0);
      onObserved($next, grow);
      return observe($next);
    };
    const $first = box(realm, 0);
    onObserved($first, grow);

    update(realm, (_read, write) => {
      write($loop, 1);
      observe($first);
    });

    expect(errors.map(String)).toEqual([
      "Error: pinna: onObserved hooks did not settle after 100 passes",
    ]);
    expect(starts).toBeLessThan(cap);
  });

  // A chain of hooks that each start the next is cut off after 100 links;
  // the rest are left due, and the next flush goes on from there.
  test("a chain of 150 starts is cut off at 100 and goes on at the next flush", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const length = 150;
    let starts = 0;
    const link = (): (() => void) | undefined => {
      starts++;
      if (starts >= length) {
        return undefined;
      }
      const $next = box(realm, 0);
      onObserved($next, link);
      return observe($next);
    };
    const $first = box(realm, 0);
    onObserved($first, link);

    update(realm, () => {
      observe($first);
    });
    const firstFlush = starts;
    update(realm, () => {});

    expect({ firstFlush, starts, errors: errors.map(String) }).toEqual({
      firstFlush: 100,
      starts: length,
      errors: ["Error: pinna: onObserved hooks did not settle after 100 passes"],
    });
  });

  test("a chain of cleanups that each touch one shared hooked source settles", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const $shared = box(realm, 0);
    let sharedStarts = 0;
    onObserved($shared, () => {
      sharedStarts++;
      return undefined;
    });
    const length = 300;
    const boxes = Array.from({ length }, () => box(realm, 0));
    const stops = boxes.map(($box) =>
      autorun(realm, (read) => {
        read($box);
      }),
    );
    let stopped = 0;
    boxes.forEach(($box, index) => {
      onObserved($box, () => () => {
        stopped++;
        observe($shared)();
        stops[index + 1]?.();
      });
    });

    stops[0]?.();

    expect({ stopped, sharedStarts, errors }).toEqual({
      stopped: length,
      sharedStarts: 0,
      errors: [],
    });
  });

  // A memo read inside a cleanup caches its entry at once, which is not a
  // hook the user wrote beginning, so the chain still only runs cleanups.
  test("a chain of cleanups that each read a memo settles", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const label = computedFunction(realm, (_read, index: number) => `item ${index}`);
    const length = 300;
    const boxes = Array.from({ length }, () => box(realm, 0));
    const stops = boxes.map(($box) =>
      autorun(realm, (read) => {
        read($box);
      }),
    );
    let stopped = 0;
    boxes.forEach(($box, index) => {
      onObserved($box, () => () => {
        stopped++;
        untracked(realm, (read) => read(label(index)));
        stops[index + 1]?.();
      });
    });

    stops[0]?.();

    expect({ stopped, errors }).toEqual({ stopped: length, errors: [] });
  });

  test("outside an update a hook fires at once", () => {
    const realm = createRealm();
    const { $value, events } = hooked(realm);

    const release = observe($value);
    expect(events).toEqual(["start"]);
    release();
    expect(events).toEqual(["start", "stop"]);
  });
});

/**
 * Two hooks on one box, the first failing where `failing` says, both logging
 * what runs.
 */
const twoHooks = (realm: Realm, failing: "start" | "stop") => {
  const $value = box(realm, 0);
  const events: Array<string> = [];
  onObserved($value, () => {
    events.push("first start");
    if (failing === "start") {
      throw new Error("the first start fails");
    }
    return () => {
      events.push("first stop");
      throw new Error("the first stop fails");
    };
  });
  onObserved($value, () => {
    events.push("second start");
    return () => events.push("second stop");
  });
  return { $value, events };
};

describe("a hook that throws", () => {
  test("outside an update, a failing start does not stop the next hook, and its error is reported", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const { $value, events } = twoHooks(realm, "start");

    const release = observe($value);
    expect(events).toEqual(["first start", "second start"]);
    expect(errors).toEqual([new Error("the first start fails")]);

    release();
    expect(events).toEqual(["first start", "second start", "second stop"]);
  });

  test("inside an update, a failing start does not stop the next hook, and its error is reported", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const { $value, events } = twoHooks(realm, "start");

    let release: () => void = () => {};
    update(realm, () => {
      release = observe($value);
    });
    expect(events).toEqual(["first start", "second start"]);
    expect(errors).toEqual([new Error("the first start fails")]);

    release();
    expect(events).toEqual(["first start", "second start", "second stop"]);
  });

  test("outside an update, a failing cleanup does not stop the next, its error is reported, and the hooks start again in step", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const { $value, events } = twoHooks(realm, "stop");

    const release = observe($value);
    release();
    expect(events).toEqual(["first start", "second start", "first stop", "second stop"]);
    expect(errors).toEqual([new Error("the first stop fails")]);

    events.length = 0;
    const again = observe($value);
    expect(events).toEqual(["first start", "second start"]);
    again();
    expect(events).toEqual(["first start", "second start", "first stop", "second stop"]);
    expect(errors).toEqual([new Error("the first stop fails"), new Error("the first stop fails")]);
  });

  test("inside an update, a failing cleanup does not stop the next, and its error is reported", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const { $value, events } = twoHooks(realm, "stop");

    const release = observe($value);
    update(realm, () => {
      release();
    });
    expect(events).toEqual(["first start", "second start", "first stop", "second stop"]);
    expect(errors).toEqual([new Error("the first stop fails")]);
  });

  for (const failing of [false, true]) {
    test(`a cleanup that observes again${failing ? " and throws" : ""} leaves the next hook started`, () => {
      const errors: Array<unknown> = [];
      const realm = createRealm({ onError: (error) => errors.push(error) });
      const $value = box(realm, 0);
      const live = new Set<string>();
      let hold: (() => void) | undefined;
      onObserved($value, () => {
        live.add("first");
        return () => {
          live.delete("first");
          if (hold !== undefined) {
            return;
          }
          hold = observe($value);
          if (failing) {
            throw new Error("the first stop fails");
          }
        };
      });
      onObserved($value, () => {
        live.add("second");
        return () => live.delete("second");
      });
      const release = observe($value);

      release();
      expect(errors).toEqual(failing ? [new Error("the first stop fails")] : []);
      expect(inspect($value).observers).toBe(1);
      expect([...live].sort()).toEqual(["first", "second"]);
      hold?.();
      expect(live.size).toBe(0);
    });
  }

  test("two failing hooks: both errors are reported, in no promised order", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const $value = box(realm, 0);
    onObserved($value, () => {
      throw new Error("one");
    });
    onObserved($value, () => {
      throw new Error("two");
    });

    const release = observe($value);
    expect(errors).toHaveLength(2);
    expect(errors).toContainEqual(new Error("one"));
    expect(errors).toContainEqual(new Error("two"));
    release();
  });

  test("a hook added to an observed observable reports its error, and its remove still works", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const $value = box(realm, 0);
    const release = observe($value);
    let starts = 0;
    const remove = onObserved($value, () => {
      starts++;
      throw new Error("the start fails");
    });
    expect(errors).toEqual([new Error("the start fails")]);
    remove();
    release();
    observe($value)();
    expect(starts).toBe(1);
  });

  test("removing a started hook reports its cleanup's error", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const $value = box(realm, 0);
    const release = observe($value);
    const remove = onObserved($value, () => () => {
      throw new Error("the cleanup fails");
    });
    remove();
    expect(errors).toEqual([new Error("the cleanup fails")]);
    release();
    expect(errors).toEqual([new Error("the cleanup fails")]);
  });

  test("a reporter that throws does not stop the next hook, and its error is thrown after", () => {
    const realm = createRealm({
      onError: () => {
        throw new Error("the reporter fails");
      },
    });
    const { $value, events } = twoHooks(realm, "start");

    expect(() =>
      update(realm, () => {
        observe($value);
      }),
    ).toThrow("the reporter fails");
    expect(events).toEqual(["first start", "second start"]);
  });
});

describe("an observe or watch whose hook throws", () => {
  test("observe keeps the observable observed and returns its release", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const { $value, events } = twoHooks(realm, "start");

    const release = observe($value);
    expect(errors).toEqual([new Error("the first start fails")]);
    expect(inspect($value).observers).toBe(1);

    release();
    expect(inspect($value).observers).toBe(0);
    events.length = 0;
    observe($value)();
    expect(events).toEqual(["first start", "second start", "second stop"]);
  });

  test("an autorun keeps every source it read, and its stop function stops them", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const events: Array<string> = [];
    const $first = box(realm, 0);
    const $second = box(realm, 0);
    const $failing = box(realm, 0);
    for (const [name, $box] of [
      ["first", $first],
      ["second", $second],
    ] as const) {
      onObserved($box, () => {
        events.push(`${name} start`);
        return () => events.push(`${name} stop`);
      });
    }
    onObserved($failing, () => {
      throw new Error("the hook fails");
    });

    const stop = autorun(realm, (read) => {
      read($first);
      read($second);
      read($failing);
    });
    expect(errors).toEqual([new Error("the hook fails")]);
    expect(events).toEqual(["first start", "second start"]);
    for (const $box of [$first, $second, $failing]) {
      expect(inspect($box).observers).toBe(1);
    }

    stop();
    expect(events).toEqual(["first start", "second start", "first stop", "second stop"]);
    for (const $box of [$first, $second, $failing]) {
      expect(inspect($box).observers).toBe(0);
    }
  });

  test("a watch whose select reads a failing observable still watches it", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const { $value } = twoHooks(realm, "start");
    const seen: Array<number> = [];

    const stop = watch(
      realm,
      (read) => read($value),
      (value) => {
        seen.push(value);
      },
    );
    expect(errors).toEqual([new Error("the first start fails")]);
    update(realm, (_read, write) => {
      write($value, 1);
    });
    expect(seen).toEqual([1]);

    stop();
    expect(inspect($value).observers).toBe(0);
  });

  test("an observed computed value keeps the source whose hook failed", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const { $value } = twoHooks(realm, "start");
    const $double = computed(realm, (read) => read($value) * 2);

    const release = observe($double);
    expect(errors).toEqual([new Error("the first start fails")]);
    expect(inspect($double).observers).toBe(1);
    expect(inspect($value).observers).toBe(1);

    release();
    expect(inspect($double).observers).toBe(0);
    expect(inspect($value).observers).toBe(0);
  });

  test("a hook that fails leaves the hooks that started running until the release", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const $value = box(realm, 0);
    onObserved($value, () => () => {
      throw new Error("the cleanup fails");
    });
    onObserved($value, () => {
      throw new Error("the hook fails");
    });

    const release = observe($value);
    expect(errors).toEqual([new Error("the hook fails")]);
    expect(inspect($value).observers).toBe(1);

    release();
    expect(errors).toEqual([new Error("the hook fails"), new Error("the cleanup fails")]);
    expect(inspect($value).observers).toBe(0);
  });

  test("a hook that fails inside an observed computed value leaves its other sources started", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const events: Array<string> = [];
    const $a = box(realm, 0);
    const $b = box(realm, 0);
    onObserved($a, () => {
      events.push("a start");
      return () => {
        events.push("a stop");
        throw new Error("the a cleanup fails");
      };
    });
    onObserved($b, () => {
      events.push("b start");
      return () => events.push("b stop");
    });
    onObserved($b, () => {
      throw new Error("the b hook fails");
    });
    const $sum = computed(realm, (read) => read($a) + read($b));

    const release = observe($sum);
    expect(errors).toEqual([new Error("the b hook fails")]);
    expect(events).toEqual(["a start", "b start"]);
    for (const observable of [$sum, $a, $b]) {
      expect(inspect(observable).observers).toBe(1);
    }

    release();
    expect(errors).toEqual([new Error("the b hook fails"), new Error("the a cleanup fails")]);
    expect(events).toEqual(["a start", "b start", "a stop", "b stop"]);
    for (const observable of [$sum, $a, $b]) {
      expect(inspect(observable).observers).toBe(0);
    }
  });

  test("a release whose cleanups fail still stops every source and reports each error", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const events: Array<string> = [];
    const $a = box(realm, 0);
    const $b = box(realm, 0);
    onObserved($a, () => () => {
      events.push("a stop");
      throw new Error("the a cleanup fails");
    });
    onObserved($b, () => () => {
      events.push("b stop");
      throw new Error("the b cleanup fails");
    });
    const $sum = computed(realm, (read) => read($a) + read($b));

    const stop = autorun(realm, (read) => {
      read($a);
      read($b);
    });
    stop();
    expect(errors).toEqual([new Error("the a cleanup fails"), new Error("the b cleanup fails")]);

    errors.length = 0;
    const release = observe($sum);
    release();
    expect(errors).toEqual([new Error("the a cleanup fails"), new Error("the b cleanup fails")]);
    expect(events).toEqual(["a stop", "b stop", "a stop", "b stop"]);
    for (const observable of [$sum, $a, $b]) {
      expect(inspect(observable).observers).toBe(0);
    }
  });

  test("inside an update, the hook's error goes to onError and the update's writes stay", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const { $value, events } = twoHooks(realm, "start");
    const $other = box(realm, 0);

    let release: () => void = () => {};
    update(realm, (_read, write) => {
      write($other, 1);
      release = observe($value);
      write($value, 2);
    });
    expect(errors).toEqual([new Error("the first start fails")]);
    expect(untracked(realm, (read) => [read($value), read($other)])).toEqual([2, 1]);
    expect(inspect($value).observers).toBe(1);

    release();
    expect(events).toEqual(["first start", "second start", "second stop"]);
  });
});

describe("a hook or cleanup that reenters", () => {
  test("a cleanup that observes the computed value being released keeps it whole", () => {
    const realm = createRealm();
    const $a = box(realm, 0);
    const $b = box(realm, 0);
    let hold: (() => void) | undefined;
    onObserved($a, () => () => {
      hold ??= observe($sum);
    });
    const $sum = computed(realm, (read) => read($a) + read($b));
    let runs = 0;
    onObserved($sum, () => {
      runs++;
      return undefined;
    });

    observe($sum)();
    expect(hold).toBeDefined();
    for (const observable of [$sum, $a, $b]) {
      expect(inspect(observable).observers).toBe(1);
    }
    expect(runs).toBe(1);

    hold?.();
    for (const observable of [$sum, $a, $b]) {
      expect(inspect(observable).observers).toBe(0);
    }
  });

  // Ruling 28: the cleanup's watch links the computed value back before the
  // settle goes on, so $b, lost and gained in that settle, restarts nothing.
  test("a cleanup that observes the computed value again while its observe stops restarts no other hook", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const $a = box(realm, 0);
    const $b = box(realm, 0);
    const $c = box(realm, 0);
    const $sum = computed(realm, (read) => read($a) + read($b) + read($c));
    const seen: Array<number> = [];
    let stop: (() => void) | undefined;
    onObserved($a, () => () => {
      stop ??= watch(
        realm,
        (read) => read($sum),
        (value) => {
          seen.push(value);
        },
      );
    });
    let starts = 0;
    onObserved($b, () => {
      starts++;
      if (starts === 2) {
        throw new Error("the b restart fails");
      }
      return undefined;
    });

    observe($sum)();
    expect(errors).toEqual([]);
    expect(starts).toBe(1);
    for (const observable of [$sum, $a, $b, $c]) {
      expect(inspect(observable).observers).toBe(1);
    }
    update(realm, (_read, write) => {
      write($c, 5);
    });
    expect(seen).toEqual([5]);
    stop?.();
  });

  test("an autorun does not rerun when a hook writes what it did not read", () => {
    const realm = createRealm();
    const tick = atom(realm);
    let computes = 0;
    const $clock = computed(realm, (read) => {
      read(tick);
      return ++computes;
    });
    const $value = box(realm, 0);
    const $unrelated = box(realm, 0);
    onObserved($value, () => {
      update(realm, (_read, write) => {
        write($unrelated, 1);
      });
      return undefined;
    });
    let runs = 0;

    const stop = autorun(realm, (read) => {
      read($clock);
      read($value);
      runs++;
    });
    expect(runs).toBe(1);
    stop();
  });

  test("a rerun whose error the reporter throws leaves the autorun stopped", () => {
    const realm = createRealm({
      onError: (error) => {
        throw error;
      },
    });
    const $value = box(realm, 0);
    onObserved($value, () => {
      update(realm, (_read, write) => {
        write($value, 5);
      });
      return undefined;
    });

    expect(() =>
      autorun(realm, (read) => {
        if (read($value) === 5) {
          throw new Error("five");
        }
      }),
    ).toThrow("five");
    expect(inspect($value).observers).toBe(0);
  });

  test("an autorun reruns when a hook it started writes what it read", () => {
    const realm = createRealm();
    const $value = box(realm, 0);
    onObserved($value, () => {
      update(realm, (_read, write) => {
        write($value, 5);
      });
      return undefined;
    });
    const seen: Array<number> = [];

    const stop = autorun(realm, (read) => {
      seen.push(read($value));
    });
    expect(seen).toEqual([0, 5]);
    stop();
  });

  test("a watch's effect runs when a hook its select started writes what it read", () => {
    const realm = createRealm();
    const $value = box(realm, 0);
    onObserved($value, () => {
      update(realm, (_read, write) => {
        write($value, 5);
      });
      return undefined;
    });
    const changes: Array<[number, number]> = [];

    const stop = watch(
      realm,
      (read) => read($value),
      (value, previous) => {
        changes.push([value, previous]);
      },
    );
    expect(changes).toEqual([[5, 0]]);
    stop();
  });
});

describe("observe", () => {
  test("holds a box observed until released, and a second release does nothing", () => {
    const realm = createRealm();
    const { $value, events } = hooked(realm);

    const release = observe($value);
    release();
    release();

    expect(events).toEqual(["start", "stop"]);
  });

  test("two holders release independently", () => {
    const realm = createRealm();
    const { $value, events } = hooked(realm);

    const first = observe($value);
    const second = observe($value);
    first();
    first();
    expect(events).toEqual(["start"]);
    second();
    expect(events).toEqual(["start", "stop"]);
  });

  test("keeps a computed value cached and its sources observed", () => {
    const realm = createRealm();
    const { $value, events } = hooked(realm);
    let runs = 0;
    const $double = computed(realm, (read) => {
      runs++;
      return read($value) * 2;
    });

    const release = observe($double);
    expect(events).toEqual(["start"]);
    expect(untracked(realm, (read) => read($double))).toBe(0);
    expect(untracked(realm, (read) => read($double))).toBe(0);
    expect(runs).toBe(1);

    update(realm, (_read, write) => {
      write($value, 2);
    });
    expect(untracked(realm, (read) => read($double))).toBe(4);
    expect(runs).toBe(2);
    release();
    expect(events).toEqual(["start", "stop"]);
  });

  test("a computed value that throws is held without the error escaping", () => {
    const realm = createRealm();
    const { $value, events } = hooked(realm);
    const $failing = computed(realm, (read) => {
      if (read($value) === 0) {
        throw new Error("zero");
      }
      return read($value);
    });

    const release = observe($failing);
    expect(events).toEqual(["start"]);
    release();
    expect(events).toEqual(["start", "stop"]);
  });

  test("holds an atom observed", () => {
    const realm = createRealm();
    const $atom = atom(realm);
    const events: Array<string> = [];
    onObserved($atom, () => {
      events.push("start");
      return () => events.push("stop");
    });

    const release = observe($atom);
    release();

    expect(events).toEqual(["start", "stop"]);
  });

  test("works where reads are tracked, without subscribing what tracks", () => {
    const realm = createRealm();
    const { $value, events } = hooked(realm);
    const $trigger = box(realm, 0);
    const releases: Array<() => void> = [];
    let runs = 0;
    const stop = watch(
      realm,
      (read) => read($trigger),
      () => {
        runs++;
        releases.push(observe($value));
      },
    );

    update(realm, (_read, write) => {
      write($trigger, 1);
    });
    update(realm, (_read, write) => {
      write($value, 5);
    });

    expect(runs).toBe(1);
    expect(events).toEqual(["start"]);
    stop();
    for (const release of releases) {
      release();
    }
    expect(events).toEqual(["start", "stop"]);
  });
});

describe("isTracking", () => {
  test("is true while a computed value or a watch's select runs", () => {
    const realm = createRealm();
    const $value = box(realm, 0);
    const seen: Array<boolean> = [];
    const $tracked = computed(realm, (read) => {
      seen.push(isTracking(realm));
      return read($value);
    });
    const stop = watch(
      realm,
      (read) => {
        seen.push(isTracking(realm));
        return read($tracked);
      },
      () => {},
    );

    expect(seen).toEqual([true, true]);
    stop();
  });

  test("is false in an update, untracked, a watch effect, a hook, and at the top level", () => {
    const realm = createRealm();
    const $value = box(realm, 0);
    const seen: Record<string, boolean> = {};
    seen["top level"] = isTracking(realm);
    onObserved($value, () => {
      seen["hook"] = isTracking(realm);
      return undefined;
    });
    const stop = watch(
      realm,
      (read) => {
        untracked(realm, () => {
          seen["untracked"] = isTracking(realm);
        });
        return read($value);
      },
      () => {
        seen["effect"] = isTracking(realm);
      },
    );
    update(realm, (_read, write) => {
      seen["update"] = isTracking(realm);
      write($value, 1);
    });

    expect(seen).toEqual({
      "top level": false,
      hook: false,
      untracked: false,
      effect: false,
      update: false,
    });
    stop();
  });
});
