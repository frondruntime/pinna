import { describe, expect, test } from "bun:test";
import {
  Box,
  Computed,
  isPinnaError,
  Realm,
  type Realm as RealmType,
  Source,
  Stage,
  StageConflictError,
} from "../src/index.ts";
import { testRealm } from "../src/testing/index.ts";

/**
 * Visible stages (ruling 68): `Stage.make(realm, { visible: true })` shows
 * what `Stage.apply` would land now, over the confirmed values and the
 * visible stages opened before it, and `Stage.drop` takes it back.
 */

const setup = (initial = 10) => {
  const realm = testRealm();
  const $count = Box.make(realm, initial, { name: "count" });
  const $double = Computed.make(realm, (read) => read($count) * 2);
  const seen: Array<number> = [];
  const stop = Realm.watch(
    realm,
    (read) => read($double),
    (value) => {
      seen.push(value);
    },
  );
  const now = () => Realm.untracked(realm, (read) => read($count));
  const visible = (name: string) => Stage.make(realm, { name, visible: true });
  const add = (stage: Stage, by: number) =>
    Stage.update(stage, (read, write) => write($count, read($count) + by));
  return {
    realm,
    $count,
    $double,
    seen,
    now,
    visible,
    add,
    [Symbol.dispose]: () => {
      stop();
      realm[Symbol.dispose]();
    },
  };
};

describe("visible stages stack", () => {
  test("a visible stage shows at once, and a drop takes it back", () => {
    using context = setup();
    const { seen, now, visible, add } = context;
    const a = visible("a");
    add(a, 1);
    expect(now()).toBe(11);
    Stage.drop(a);
    expect(now()).toBe(10);
    expect(seen).toEqual([22, 20]);
  });

  test("applying the bottom stage notifies nobody", () => {
    using context = setup();
    const { seen, now, visible, add } = context;
    const a = visible("a");
    add(a, 1);
    seen.length = 0;
    Stage.apply(a);
    expect(now()).toBe(11);
    expect(seen).toEqual([]);
    expect(Stage.status(a)).toBe("applied");
  });

  test("two stages on one box: the lower one drops, the upper one replays", () => {
    using context = setup();
    const { seen, now, visible, add } = context;
    const a = visible("a");
    const b = visible("b");
    add(a, 1);
    add(b, 5);
    expect(now()).toBe(16);
    Stage.drop(a);
    expect(now()).toBe(15);
    Stage.apply(b);
    expect(now()).toBe(15);
    expect(seen).toEqual([22, 32, 30]);
  });

  test("the upper stage applies first: the display holds", () => {
    using context = setup();
    const { seen, now, visible, add } = context;
    const a = visible("a");
    const b = visible("b");
    add(a, 1);
    add(b, 5);
    seen.length = 0;
    Stage.apply(b);
    expect(now()).toBe(16);
    Stage.drop(a);
    expect(now()).toBe(15);
    expect(seen).toEqual([30]);
  });

  test("a write to the lower stage lands beneath the upper one", () => {
    using context = setup();
    const { $count, now, visible, add } = context;
    const a = visible("a");
    const b = visible("b");
    add(a, 1);
    Stage.update(b, (_read, write) => write($count, 100));
    add(a, 1);
    expect(now()).toBe(100);
    Stage.drop(b);
    expect(now()).toBe(12);
    Stage.drop(a);
  });

  test("an update's write is the base: the stage replays over it", () => {
    using context = setup();
    const { realm, $count, seen, now, visible, add } = context;
    const a = visible("a");
    add(a, 1);
    seen.length = 0;
    Realm.update(realm, (_read, write) => write($count, 20));
    expect(now()).toBe(21);
    expect(seen).toEqual([42]);
    Stage.drop(a);
    expect(now()).toBe(20);
  });

  test("a hidden stage reads and lands in the base", () => {
    using context = setup();
    const { realm, $count, now, visible, add } = context;
    const a = visible("a");
    add(a, 1);
    const hidden = Stage.make(realm);
    Stage.update(hidden, (read, write) => write($count, read($count) * 3));
    expect(now()).toBe(11);
    Stage.apply(hidden);
    expect(now()).toBe(31);
    Stage.apply(a);
    expect(now()).toBe(31);
  });

  test("an update recipe reads the base, so it keeps nothing a drop takes back", () => {
    using context = setup();
    const { realm, $count, now, visible, add } = context;
    const a = visible("a");
    add(a, 1);
    let read = 0;
    Realm.update(realm, (reader, write) => {
      read = reader($count);
      write($count, read + 1);
    });
    expect(read).toBe(10);
    expect(now()).toBe(12);
    Stage.drop(a);
    expect(now()).toBe(11);
  });

  test("a stage whose replay throws stops showing for good, and reports once", () => {
    const reported: Array<unknown> = [];
    using realm = testRealm({ onError: (error) => reported.push(error) });
    const $count = Box.make(realm, 10);
    const now = () => Realm.untracked(realm, (read) => read($count));
    const a = Stage.make(realm, { name: "a", visible: true });
    Stage.update(a, (read, write) => {
      if (read($count) > 50) throw new Error("too high");
      write($count, read($count) + 1);
    });
    expect(now()).toBe(11);
    Realm.update(realm, (_read, write) => write($count, 60));
    expect(now()).toBe(60);
    expect(Stage.inspect(a)).toMatchObject({ showing: false, visible: true, status: "open" });
    expect((Stage.inspect(a).failure as Error).message).toBe("too high");
    expect(reported.map((error) => (error as Error).message)).toEqual(["too high"]);
    Realm.update(realm, (_read, write) => write($count, 30));
    expect(now()).toBe(30);
    expect(reported.length).toBe(1);
    expect(() => Stage.update(a, () => undefined)).toThrow("too high");
    expect(() => Stage.read(a, (read) => read($count))).toThrow("too high");
    expect(Stage.status(a)).toBe("open");
    expect(() => Stage.apply(a)).toThrow("too high");
    expect(Stage.status(a)).toBe("dropped");
  });

  test("the outcome is the hidden stage's", () => {
    const run = (visibleStages: boolean) => {
      using realm = testRealm();
      const $count = Box.make(realm, 10);
      const open = (name: string) => Stage.make(realm, { name, visible: visibleStages });
      const a = open("a");
      const b = open("b");
      Stage.update(a, (read, write) => write($count, read($count) + 1));
      Stage.update(b, (read, write) => write($count, read($count) * 2));
      Realm.update(realm, (_read, write) => write($count, 7));
      Stage.apply(b);
      Stage.apply(a);
      return Realm.untracked(realm, (read) => read($count));
    };
    expect(run(true)).toBe(run(false));
    expect(run(true)).toBe(15);
  });
});

describe("settling a guess", () => {
  test("the result lands and the guess drops in one update, silently when they agree", () => {
    using context = setup();
    const { realm, $count, seen, now } = context;
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (read, write) => write($count, read($count) + 1));
    const result = Stage.make(realm);
    Stage.update(result, (_read, write) => write($count, 11));
    seen.length = 0;
    Realm.update(realm, () => {
      Stage.apply(result);
      Stage.drop(guess);
    });
    expect(now()).toBe(11);
    expect(seen).toEqual([]);
  });

  test("a refetch that already holds the guess shows it twice until the guess drops", () => {
    using context = setup();
    const { realm, $count, seen, now } = context;
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (read, write) => write($count, read($count) + 1));
    Realm.update(realm, (_read, write) => write($count, 11));
    expect(now()).toBe(12);
    Stage.drop(guess);
    expect(now()).toBe(11);
    expect(seen).toEqual([22, 24, 22]);
  });

  test("a constant guess over a refetch that holds it: no double count", () => {
    using context = setup();
    const { realm, $count, seen, now } = context;
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (_read, write) => write($count, 11));
    seen.length = 0;
    Realm.update(realm, (_read, write) => write($count, 11));
    expect(now()).toBe(11);
    Stage.drop(guess);
    expect(now()).toBe(11);
    expect(seen).toEqual([]);
  });

  test("stage calls inside one update: one watcher run with the net value", () => {
    using context = setup();
    const { realm, $count, seen, now } = context;
    const a = Stage.make(realm, { visible: true });
    const b = Stage.make(realm, { visible: true });
    Realm.update(realm, () => {
      Stage.update(a, (read, write) => write($count, read($count) + 1));
      Stage.update(b, (read, write) => write($count, read($count) * 2));
      Stage.drop(a);
    });
    expect(now()).toBe(20);
    expect(seen).toEqual([40]);
    Stage.apply(b);
    expect(seen).toEqual([40]);
  });

  test("an update fails inside: its writes roll back and the stack still shows", () => {
    using context = setup();
    const { realm, $count, now } = context;
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (read, write) => write($count, read($count) + 1));
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write($count, 50);
        throw new Error("no");
      }),
    ).toThrow("no");
    expect(now()).toBe(11);
    Stage.drop(guess);
    expect(now()).toBe(10);
  });
});

const probe = () => {
  const realm = testRealm();
  const $count = Box.make(realm, 10, { name: "count" });
  const $other = Box.make(realm, "a", { name: "other" });
  const now = () => Realm.untracked(realm, (read) => read($count));
  return { realm, $count, $other, now };
};

const disposeAll = (realm: RealmType): void => {
  Realm.dispose(realm);
};

describe("the nine probes", () => {
  test("a snapshot in a computed value reads shown values; one in an update recipe reads the base", () => {
    const { realm, $count, $other } = probe();
    const shape = { count: $count, other: $other };
    const $saved = Computed.make(realm, (read) => read.snapshot(shape));
    const seen: Array<unknown> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($saved),
      (value) => {
        seen.push(value);
      },
    );
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (read, write) => write($count, read($count) + 1));
    expect(seen).toEqual([{ count: 11, other: "a" }]);
    let inUpdate: unknown;
    Realm.update(realm, (read) => {
      inUpdate = read.snapshot(shape);
    });
    expect(inUpdate).toEqual({ count: 10, other: "a" });
    expect(seen.length).toBe(1);
    Stage.drop(guess);
    expect(seen.at(-1)).toEqual({ count: 10, other: "a" });
    stop();
    disposeAll(realm);
  });

  test("write.restore in a plain update under a guess: the guess replays over it", () => {
    const { realm, $count, $other, now } = probe();
    const shape = { count: $count, other: $other };
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (read, write) => write($count, read($count) + 1));
    Realm.update(realm, (_read, write) => write.restore(shape, { count: 50, other: "b" }));
    expect(now()).toBe(51);
    Stage.drop(guess);
    expect(now()).toBe(50);
    disposeAll(realm);
  });

  test("write.restore inside a visible stage's recipe shows and leaves with the stage", () => {
    const { realm, $count, $other, now } = probe();
    const shape = { count: $count, other: $other };
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (_read, write) => write.restore(shape, { count: 7, other: "z" }));
    expect(now()).toBe(7);
    expect(Realm.untracked(realm, (read) => read($other))).toBe("z");
    Stage.drop(guess);
    expect(now()).toBe(10);
    expect(Realm.untracked(realm, (read) => read($other))).toBe("a");
    disposeAll(realm);
  });

  test('a hidden "fail" stage beside a guess: no false conflict', () => {
    const { realm, $count, now } = probe();
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (read, write) => write($count, read($count) + 1));
    const hidden = Stage.make(realm, { conflicts: "fail" });
    let seen: number | undefined;
    Stage.update(hidden, (read, write) => {
      seen = read($count);
      write($count, read($count) * 3);
    });
    expect(seen).toBe(10);
    Stage.apply(hidden);
    expect(now()).toBe(31);
    Stage.drop(guess);
    disposeAll(realm);
  });

  test('a hidden "fail" stage: the guess applied under it is a conflict', () => {
    const { realm, $count } = probe();
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (read, write) => write($count, read($count) + 1));
    const hidden = Stage.make(realm, { conflicts: "fail" });
    Stage.update(hidden, (read, write) => write($count, read($count) * 3));
    Stage.apply(guess);
    expect(() => Stage.apply(hidden)).toThrow(StageConflictError);
    disposeAll(realm);
  });

  test("Realm.dispose with a guess open puts the base back", () => {
    const { realm, $count, now } = probe();
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (read, write) => write($count, read($count) + 1));
    Realm.dispose(realm);
    expect(now()).toBe(10);
    expect(Stage.status(guess)).toBe("dropped");
  });

  test("Stage.read and Stage.realmRead on a hidden stage read the base under a guess", () => {
    const { realm, $count } = probe();
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (read, write) => write($count, read($count) + 1));
    const hidden = Stage.make(realm);
    expect(Stage.read(hidden, (read) => read($count))).toBe(10);
    expect(Stage.realmRead(hidden, (read) => read($count))).toBe(10);
    expect(Stage.realmRead(guess, (read) => read($count))).toBe(10);
    expect(Stage.read(guess, (read) => read($count))).toBe(11);
    disposeAll(realm);
  });

  test("read, a computed value, and Realm.untracked inside an update recipe read the base", () => {
    const { realm, $count } = probe();
    const $double = Computed.make(realm, (read) => read($count) * 2);
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (read, write) => write($count, read($count) + 1));
    let inside: Array<number> = [];
    Realm.update(realm, (read) => {
      inside = [read($count), read($double), Realm.untracked(realm, (inner) => inner($count))];
    });
    expect(inside).toEqual([10, 20, 10]);
    expect(Realm.untracked(realm, (read) => read($double))).toBe(22);
    disposeAll(realm);
  });

  test("an autorun that copies a guessed box follows the guess and its drop", () => {
    const { realm, $count, now } = probe();
    const $mirror = Box.make(realm, 0);
    const stop = Realm.autorun(realm, (read) => {
      const value = read($count);
      Realm.update(realm, (_read, write) => write($mirror, value));
    });
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (read, write) => write($count, read($count) + 1));
    expect(Realm.untracked(realm, (read) => read($mirror))).toBe(11);
    Stage.drop(guess);
    expect(Realm.untracked(realm, (read) => read($mirror))).toBe(10);
    expect(now()).toBe(10);
    stop();
    disposeAll(realm);
  });
});

describe("errors", () => {
  test("a recipe that throws undefined on replay stops its stage all the same", () => {
    const reported: unknown[] = [];
    const realm = Realm.make({ onError: (error) => reported.push(error) });
    const $gate = Box.make(realm, false);
    const $value = Box.make(realm, 0);
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (read, write) => {
      if (read($gate)) throw undefined;
      write($value, 1);
    });
    Realm.update(realm, (_read, write) => write($gate, true));
    expect(Stage.inspect(guess).showing).toBe(false);
    expect(reported).toEqual([undefined]);
    let thrown = false;
    try {
      Stage.read(guess, (read) => read($value));
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(true);
    Realm.update(realm, (_read, write) => write($gate, false));
    thrown = false;
    try {
      Stage.apply(guess);
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(true);
    expect(Stage.status(guess)).toBe("dropped");
    expect(Realm.untracked(realm, (read) => read($value))).toBe(0);
  });

  test("an equals that updates or throws while the stack settles counts as unequal and is reported", () => {
    const reported: unknown[] = [];
    const realm = Realm.make({ onError: (error) => reported.push(error) });
    const $log = Box.make(realm, 0);
    let mode: "plain" | "update" | "throw" = "plain";
    const $value = Box.make(
      realm,
      { v: 1 },
      {
        // Misbehaves only on the comparison of two shown values, which the
        // stack makes when it settles, and never on a replay's write.
        equals: (left, right) => {
          const settling = left.v === 2 && right.v === 2;
          if (settling && mode === "update")
            Realm.update(realm, (read, write) => write($log, read($log) + 1));
          if (settling && mode === "throw") throw new Error("equals broke");
          return left.v === right.v;
        },
      },
    );
    const guess = Stage.make(realm, { visible: true });
    // The guess reads $log, so each update below replays it and settles $value.
    Stage.update(guess, (read, write) => write($value, { v: 2 + read($log) * 0 }));
    mode = "update";
    Realm.update(realm, (read, write) => write($log, read($log) + 10));
    mode = "throw";
    Realm.update(realm, (read, write) => write($log, read($log) + 10));
    mode = "plain";
    expect(Realm.untracked(realm, (read) => [read($log), read($value).v])).toEqual([20, 2]);
    expect(
      reported.map((error) =>
        isPinnaError(error, "PinnaUsageError") ? error.code : String(error),
      ),
    ).toEqual(["pinna/realm-write-in-recipe", "Error: equals broke"]);
    Stage.drop(guess);
    expect(Realm.untracked(realm, (read) => read($value).v)).toBe(1);
  });

  test("visible on a child stage, or not a boolean, throws pinna/stage-visible-option", () => {
    using realm = testRealm();
    const parent = Stage.make(realm, { visible: true });
    const codeOf = (run: () => unknown): string | undefined => {
      try {
        run();
      } catch (error) {
        return isPinnaError(error, "PinnaUsageError") ? error.code : "other";
      }
      return undefined;
    };
    expect(codeOf(() => Stage.make(parent, { visible: true }))).toBe("pinna/stage-visible-option");
    expect(codeOf(() => Stage.make(parent, { visible: false }))).toBe("pinna/stage-visible-option");
    expect(codeOf(() => Stage.make(realm, { visible: "yes" as never }))).toBe(
      "pinna/stage-visible-option",
    );
    Stage.drop(parent);
  });
});

describe("the base, records, and rollbacks", () => {
  test("a recipe writes over the base, and a rollback leaves the guess showing", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 10);
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (read, write) => write($count, read($count) + 1));
    let inside: number | undefined;
    expect(() =>
      Realm.update(realm, (read, write) => {
        inside = read($count);
        write($count, 50);
        throw new Error("roll back");
      }),
    ).toThrow("roll back");
    expect(inside).toBe(10);
    expect(Realm.untracked(realm, (read) => read($count))).toBe(11);
    Stage.drop(guess);
    expect(Realm.untracked(realm, (read) => read($count))).toBe(10);
  });

  test("Stage.apply of a visible stage that throws: the stack shows without it, the enclosing update keeps its writes", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 10, { name: "count" });
    const $note = Box.make(realm, "");
    const lower = Stage.make(realm, { name: "lower", visible: true, conflicts: "fail" });
    Stage.update(lower, (read, write) => write($count, read($count) + 1));
    const upper = Stage.make(realm, { name: "upper", visible: true });
    Stage.update(upper, (read, write) => write($count, read($count) * 2));
    expect(Realm.untracked(realm, (read) => read($count))).toBe(22);
    let caught: unknown;
    Realm.update(realm, (_read, write) => {
      write($note, "kept");
      write($count, 20);
      try {
        Stage.apply(lower);
      } catch (error) {
        caught = error;
      }
    });
    expect(caught).toBeInstanceOf(StageConflictError);
    expect(Stage.status(lower)).toBe("dropped");
    expect(Realm.untracked(realm, (read) => [read($note), read($count)])).toEqual(["kept", 40]);
    Stage.drop(upper);
  });

  test('a "fail" guess stops on a conflict, silently, and Stage.apply throws it', () => {
    const reported: Array<unknown> = [];
    using realm = testRealm({ onError: (error) => reported.push(error) });
    const $count = Box.make(realm, 10, { name: "count" });
    const guess = Stage.make(realm, { name: "guess", visible: true, conflicts: "fail" });
    Stage.update(guess, (read, write) => write($count, read($count) + 1));
    expect(Realm.untracked(realm, (read) => read($count))).toBe(11);
    Realm.update(realm, (_read, write) => write($count, 20));
    expect(Realm.untracked(realm, (read) => read($count))).toBe(20);
    expect(Stage.inspect(guess)).toMatchObject({ showing: false, status: "open" });
    expect(Stage.inspect(guess).failure).toBeInstanceOf(StageConflictError);
    expect(reported).toEqual([]);
    expect(() => Stage.update(guess, () => undefined)).toThrow(StageConflictError);
    const error = (() => {
      try {
        Stage.apply(guess);
      } catch (thrown) {
        return thrown as StageConflictError;
      }
      return undefined;
    })();
    expect(error?.changed).toEqual(["count"]);
    expect(error?.message).toBe(
      'pinna: count changed since the stage "guess" read it; nothing lands',
    );
    expect(Stage.status(guess)).toBe("dropped");
  });

  test('a "fail" guess written without reading conflicts too', () => {
    using realm = testRealm();
    const $status = Box.make(realm, "idle");
    const guess = Stage.make(realm, { visible: true, conflicts: "fail" });
    Stage.update(guess, (_read, write) => write($status, "saving"));
    Realm.update(realm, (_read, write) => write($status, "busy"));
    expect(Stage.inspect(guess).showing).toBe(false);
    expect(Realm.untracked(realm, (read) => read($status))).toBe("busy");
    Stage.drop(guess);
  });

  test('stacked "fail" guesses: the upper one stops when the lower one applies, not when it replays', () => {
    using realm = testRealm();
    const $count = Box.make(realm, 10);
    const $other = Box.make(realm, 0);
    const lower = Stage.make(realm, { visible: true });
    Stage.update(lower, (read, write) => write($count, read($count) + 1));
    const upper = Stage.make(realm, { visible: true, conflicts: "fail" });
    Stage.update(upper, (read, write) => write($count, read($count) * 2));
    expect(Realm.untracked(realm, (read) => read($count))).toBe(22);
    // The lower guess changes: no change to the base, so no conflict.
    Stage.update(lower, (read, write) => write($count, read($count) + 1));
    expect(Realm.untracked(realm, (read) => read($count))).toBe(24);
    Realm.update(realm, (_read, write) => write($other, 1));
    expect(Stage.inspect(upper).showing).toBe(true);
    Stage.apply(lower);
    expect(Stage.inspect(upper).showing).toBe(false);
    expect(Realm.untracked(realm, (read) => read($count))).toBe(12);
    expect(() => Stage.apply(upper)).toThrow(StageConflictError);
  });

  test("disposal with two guesses open: every covered box reads its base", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 1);
    const $b = Box.make(realm, "b");
    const first = Stage.make(realm, { visible: true });
    const second = Stage.make(realm, { visible: true });
    Stage.update(first, (_read, write) => write($a, 2));
    Stage.update(second, (read, write) => {
      write($a, read($a) * 10);
      write($b, "B");
    });
    expect(Realm.untracked(realm, (read) => [read($a), read($b)])).toEqual([20, "B"]);
    Realm.dispose(realm);
    expect(Realm.untracked(realm, (read) => [read($a), read($b)])).toEqual([1, "b"]);
    expect([Stage.status(first), Stage.status(second)]).toEqual(["dropped", "dropped"]);
  });

  test("testRealm reports a visible stage left open", () => {
    const realm = testRealm();
    Stage.make(realm, { name: "guess", visible: true });
    expect(() => realm[Symbol.dispose]()).toThrow('stage "guess" still running');
  });

  test("Source.inspect names the showing stages that cover a box, bottom first", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 0);
    const $plain = Box.make(realm, 0);
    expect(Source.inspect($count).stages).toEqual([]);
    const lower = Stage.make(realm, { name: "lower", visible: true });
    const upper = Stage.make(realm, { visible: true });
    Stage.update(lower, (_read, write) => write($count, 1));
    Stage.update(upper, (_read, write) => write($count, 2));
    expect(Source.inspect($count).stages).toEqual(["lower", "<anonymous>"]);
    expect(Source.inspect($plain).stages).toEqual([]);
    expect(Stage.inspect(lower)).toMatchObject({
      visible: true,
      showing: true,
      failure: undefined,
    });
    Stage.drop(lower);
    expect(Source.inspect($count).stages).toEqual(["<anonymous>"]);
    expect(Stage.inspect(lower)).toMatchObject({ visible: true, showing: false });
    Stage.drop(upper);
  });
});

describe("with the rest of the API", () => {
  test("a child of a visible stage is a hidden savepoint", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 10);
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (read, write) => write($count, read($count) + 1));
    const child = Stage.make(guess);
    Stage.update(child, (read, write) => write($count, read($count) * 2));
    expect(Stage.read(child, (read) => read($count))).toBe(22);
    expect(Realm.untracked(realm, (read) => read($count))).toBe(11);
    Stage.apply(child);
    expect(Realm.untracked(realm, (read) => read($count))).toBe(22);
    Realm.update(realm, (_read, write) => write($count, 0));
    expect(Realm.untracked(realm, (read) => read($count))).toBe(2);
    Stage.drop(guess);
  });

  test("nested updates: the window opens once, at the outermost update", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 10);
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (read, write) => write($count, read($count) + 1));
    const seen: Array<number> = [];
    Realm.update(realm, (read, write) => {
      seen.push(read($count));
      Realm.update(realm, (inner, innerWrite) => {
        seen.push(inner($count));
        innerWrite($count, 5);
      });
      seen.push(read($count));
      write($count, read($count) + 1);
    });
    expect(seen).toEqual([10, 10, 5]);
    expect(Realm.untracked(realm, (read) => read($count))).toBe(7);
    Stage.drop(guess);
  });

  test("a scheduled watch reads what is shown when it runs", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 10);
    const runs: Array<() => void> = [];
    const seen: Array<number> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($count),
      (value) => {
        seen.push(value);
      },
      { scheduler: (run) => runs.push(run) },
    );
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (read, write) => write($count, read($count) + 1));
    Stage.update(guess, (read, write) => write($count, read($count) + 1));
    for (const run of runs.splice(0)) run();
    expect(seen).toEqual([12]);
    Stage.drop(guess);
    for (const run of runs.splice(0)) run();
    expect(seen).toEqual([12, 10]);
    stop();
  });

  test("another realm's box in a visible stage's recipe throws as today", () => {
    using realm = testRealm({ name: "ui" });
    using other = testRealm({ name: "quotes" });
    const $theirs = Box.make(other, 0);
    const guess = Stage.make(realm, { visible: true });
    expect(() => Stage.update(guess, (_read, write) => write($theirs, 1))).toThrow(
      '(realm "quotes", not "ui")',
    );
    expect(Stage.inspect(guess).showing).toBe(true);
    Stage.drop(guess);
  });

  test("two realms: a guess in one shows nothing in the other", () => {
    using first = testRealm();
    using second = testRealm();
    const $a = Box.make(first, 1);
    const $b = Box.make(second, 1);
    const guess = Stage.make(first, { visible: true });
    Stage.update(guess, (_read, write) => write($a, 2));
    Realm.update(second, (_read, write) => write($b, 3));
    expect(Realm.untracked(first, (read) => read($a))).toBe(2);
    expect(Realm.untracked(second, (read) => read($b))).toBe(3);
    Stage.drop(guess);
  });

  test("a staged recipe that throws is not kept, and the stack shows as before", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 10);
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (read, write) => write($count, read($count) + 1));
    expect(() =>
      Stage.update(guess, (_read, write) => {
        write($count, 99);
        throw new Error("nope");
      }),
    ).toThrow("nope");
    expect(Realm.untracked(realm, (read) => read($count))).toBe(11);
    expect(Stage.inspect(guess)).toMatchObject({ recipes: 1, showing: true });
    Stage.drop(guess);
  });
});
