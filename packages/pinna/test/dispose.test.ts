import { describe, expect, test } from "bun:test";
import {
  Atom,
  Box,
  Collection,
  Computed,
  isPinnaError,
  type PinnaError,
  type PinnaUsageError,
  Realm,
  Source,
  Stage,
  StageClosedError,
} from "../src/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * `Realm.dispose` stops everything that runs in a realm, runs every
 * `Source.onObserved` cleanup once, and refuses writes and new observers afterward,
 * while reads keep returning the last values.
 */

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    expect(isPinnaError(error)).toBe(true);
    return (error as PinnaUsageError).code;
  }
  throw new Error("expected a throw");
};

/** A source whose hook counts starts and cleanups, as a socket would. */
const socket = (realm: Realm) => {
  const $price = Box.make(realm, 1, { name: "price" });
  const counts = { starts: 0, cleanups: 0 };
  Source.onObserved($price, () => {
    counts.starts++;
    return () => {
      counts.cleanups++;
    };
  });
  return { $price, counts };
};

describe("disposeRealm", () => {
  test("moves the realm from open to disposed, and a second call does nothing", () => {
    const realm = Realm.make();
    expect(Realm.status(realm)).toBe("open");
    Realm.dispose(realm);
    expect(Realm.status(realm)).toBe("disposed");
    expect(() => Realm.dispose(realm)).not.toThrow();
    expect(Realm.status(realm)).toBe("disposed");
  });

  test("is the realm's Symbol.dispose, so using disposes it", () => {
    let kept: Realm | undefined;
    {
      using realm = Realm.make();
      kept = realm;
      expect(Realm.status(realm)).toBe("open");
    }
    expect(Realm.status(kept)).toBe("disposed");
  });

  test("ends the hook a watch kept started, once, and the watch never runs again", () => {
    const realm = Realm.make();
    const { $price, counts } = socket(realm);
    const seen: Array<number> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($price),
      (value) => {
        seen.push(value);
        return undefined;
      },
    );
    expect(counts).toEqual({ starts: 1, cleanups: 0 });
    Realm.dispose(realm);
    expect(counts).toEqual({ starts: 1, cleanups: 1 });
    expect(Source.inspect($price).observers).toBe(1);
    expect(() => stop()).not.toThrow();
    expect(counts.cleanups).toBe(1);
    expect(seen).toEqual([]);
  });

  test("stops an autorun and runs its cleanup once", () => {
    const realm = Realm.make();
    const { $price, counts } = socket(realm);
    let cleanups = 0;
    const stop = Realm.autorun(realm, (read) => {
      read($price);
      return () => {
        cleanups++;
      };
    });
    Realm.dispose(realm);
    expect(cleanups).toBe(1);
    expect(counts.cleanups).toBe(1);
    stop();
    expect(cleanups).toBe(1);
  });

  test("ends a source's hook after every autorun cleanup, even one older than the autorun observing it", () => {
    const realm = Realm.make();
    const { $price, counts } = socket(realm);
    const $other = Box.make(realm, 0);
    let cleanupsSeen: number | undefined;
    Realm.autorun(realm, (read) => {
      read($other);
      return () => {
        cleanupsSeen = counts.cleanups;
      };
    });
    Realm.autorun(realm, (read) => {
      read($price);
    });
    Realm.dispose(realm);
    expect(cleanupsSeen).toBe(0);
    expect(counts.cleanups).toBe(1);
  });

  test("ends the hook an observe kept started, through a derivation", () => {
    const realm = Realm.make();
    const { $price, counts } = socket(realm);
    const $doubled = Computed.make(realm, (read) => read($price) * 2);
    const release = Source.observe($doubled);
    expect(counts.starts).toBe(1);
    Realm.dispose(realm);
    expect(counts.cleanups).toBe(1);
    release();
    expect(counts.cleanups).toBe(1);
  });

  test("stops an onRowChange listener", () => {
    const realm = Realm.make();
    const rows = Collection.make(realm, { keyOf: (row: { readonly id: string }) => row.id });
    const changes: Array<unknown> = [];
    const stop = Collection.onRowChange(rows, (change) => {
      changes.push(change);
      return undefined;
    });
    Realm.dispose(realm);
    expect(() => stop()).not.toThrow();
    expect(changes).toEqual([]);
  });

  test("drops an open stage and its child, so applying either throws StageClosedError", () => {
    const realm = Realm.make();
    const $count = Box.make(realm, 1);
    const stage = Stage.make(realm);
    const child = Stage.make(stage);
    Stage.update(child, (_read, write) => {
      write($count, 2);
    });
    Realm.dispose(realm);
    expect(Stage.status(stage)).toBe("dropped");
    expect(Stage.status(child)).toBe("dropped");
    expect(() => Stage.apply(stage)).toThrow(StageClosedError);
    expect(Realm.untracked(realm, (read) => read($count))).toBe(1);
  });

  test("refuses a child stage an autorun cleanup opens over an older stage while it disposes", () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const stage = Stage.make(realm);
    Realm.autorun(realm, () => () => {
      Stage.make(stage);
    });
    Realm.dispose(realm);
    expect(errors).toHaveLength(1);
    expect((errors[0] as PinnaUsageError).code).toBe("pinna/realm-disposed");
    expect(Stage.status(stage)).toBe("dropped");
  });

  test("lets a cleanup write through update while it disposes", () => {
    const realm = Realm.make();
    const $status = Box.make(realm, "connected");
    const $price = Box.make(realm, 1);
    Source.onObserved($price, () => () => {
      Realm.update(realm, (_read, write) => {
        write($status, "closed");
      });
    });
    Source.observe($price);
    Realm.dispose(realm);
    expect(Realm.untracked(realm, (read) => read($status))).toBe("closed");
  });

  test("reports a cleanup's error to onError and still stops the rest", () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const failure = new Error("close failed");
    const $a = Box.make(realm, 1);
    Source.onObserved($a, () => () => {
      throw failure;
    });
    const { $price, counts } = socket(realm);
    Source.observe($a);
    Source.observe($price);
    let autorunCleanups = 0;
    Realm.autorun(realm, (read) => {
      read($a);
      return () => {
        autorunCleanups++;
      };
    });
    Realm.dispose(realm);
    expect(errors).toEqual([failure]);
    expect(counts.cleanups).toBe(1);
    expect(autorunCleanups).toBe(1);
    expect(Realm.status(realm)).toBe("disposed");
  });

  test("refuses a watch a cleanup starts while it disposes, through onError", () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const $price = Box.make(realm, 1);
    Source.onObserved($price, () => () => {
      Realm.watch(
        realm,
        (read) => read($price),
        () => undefined,
      );
    });
    Source.observe($price);
    Realm.dispose(realm);
    expect(errors).toHaveLength(1);
    expect((errors[0] as PinnaUsageError).code).toBe("pinna/realm-disposed");
  });

  test("leaves another realm running", () => {
    const first = Realm.make();
    const second = Realm.make();
    const one = socket(first);
    const two = socket(second);
    Source.observe(one.$price);
    const seen: Array<number> = [];
    Realm.watch(
      second,
      (read) => read(two.$price),
      (value) => {
        seen.push(value);
        return undefined;
      },
    );
    Realm.dispose(first);
    expect(one.counts.cleanups).toBe(1);
    expect(two.counts.cleanups).toBe(0);
    Realm.update(second, (_read, write) => {
      write(two.$price, 2);
    });
    expect(seen).toEqual([2]);
    expect(Realm.status(second)).toBe("open");
  });

  test("leaves the realm at rest", () => {
    const realm = Realm.make();
    const { $price } = socket(realm);
    Source.observe($price);
    Realm.autorun(realm, (read) => {
      read($price);
      return undefined;
    });
    Stage.make(realm);
    Realm.dispose(realm);
    expectRealmAtRest(realm);
  });
});

describe("a disposed realm", () => {
  test("still reads the last values, through boxes, derivations, and computed functions", () => {
    const realm = Realm.make();
    const $count = Box.make(realm, 2);
    const $doubled = Computed.make(realm, (read) => read($count) * 2);
    const timesOf = Computed.fn(realm, (read, factor: number) => read($count) * factor);
    Realm.update(realm, (_read, write) => {
      write($count, 3);
    });
    Realm.dispose(realm);
    expect(Realm.untracked(realm, (read) => read($count))).toBe(3);
    expect(Realm.untracked(realm, (read) => read($doubled))).toBe(6);
    expect(Realm.untracked(realm, (read) => read(timesOf(10)))).toBe(30);
  });

  test("refuses every write and every new observer with pinna/realm-disposed", () => {
    const realm = Realm.make({ name: "screen" });
    const $count = Box.make(realm, 1);
    const $atom = Atom.make(realm);
    const rows = Collection.make(realm, { keyOf: (row: { readonly id: string }) => row.id });
    Realm.dispose(realm);
    const calls: Array<() => unknown> = [
      () =>
        Realm.update(realm, (_read, write) => {
          write($count, 2);
        }),
      () =>
        Realm.update(realm, (_read, write) => {
          write.changed($atom);
        }),
      () =>
        Realm.watch(
          realm,
          (read) => read($count),
          () => undefined,
        ),
      () => Realm.autorun(realm, () => undefined),
      () => Source.observe($count),
      () => Source.onObserved($count, () => undefined),
      () => Collection.onRowChange(rows, () => undefined),
      () => Stage.make(realm),
    ];
    for (const call of calls) {
      expect(codeOf(call)).toBe("pinna/realm-disposed");
    }
    expect(() =>
      Realm.update(realm, () => {
        return undefined;
      }),
    ).toThrow('pinna: Realm.update cannot start in the disposed realm "screen"; make a new realm');
    expect(Realm.untracked(realm, (read) => read($count))).toBe(1);
  });

  test("throws for a value createRealm did not make", () => {
    expect(codeOf(() => Realm.dispose({} as Realm))).toBe("pinna/not-made-by-pinna");
    expect(codeOf(() => Realm.status({} as Realm))).toBe("pinna/not-made-by-pinna");
  });
});

describe("disposeRealm while the realm runs", () => {
  /** Expects `dispose` to throw pinna/dispose-not-at-rest, then checks that nothing stopped. */
  const refusedIn = (start: (realm: Realm, dispose: () => void) => void): void => {
    const realm = Realm.make();
    const { $price, counts } = socket(realm);
    Source.observe($price);
    let failure: unknown;
    start(realm, () => {
      try {
        Realm.dispose(realm);
      } catch (error) {
        failure = error;
        throw error;
      }
    });
    expect(isPinnaError(failure)).toBe(true);
    expect((failure as PinnaError & { code: string }).code).toBe("pinna/dispose-not-at-rest");
    expect(Realm.status(realm)).toBe("open");
    expect(counts.cleanups).toBe(0);
    Realm.dispose(realm);
    expect(counts.cleanups).toBe(1);
  };

  test("throws inside an update recipe", () => {
    refusedIn((realm, dispose) => {
      expect(() =>
        Realm.update(realm, () => {
          dispose();
        }),
      ).toThrow();
    });
  });

  test("throws inside a computed value", () => {
    refusedIn((realm, dispose) => {
      const $disposing = Computed.make(realm, () => {
        dispose();
        return 0;
      });
      expect(() => Realm.untracked(realm, (read) => read($disposing))).toThrow();
    });
  });

  test("throws inside untracked", () => {
    refusedIn((realm, dispose) => {
      expect(() => Realm.untracked(realm, () => dispose())).toThrow();
    });
  });

  test("throws inside a watch's effect, and the error goes to onError", () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const $count = Box.make(realm, 1);
    const stop = Realm.watch(
      realm,
      (read) => read($count),
      () => {
        Realm.dispose(realm);
        return undefined;
      },
    );
    Realm.update(realm, (_read, write) => {
      write($count, 2);
    });
    expect(errors).toHaveLength(1);
    expect((errors[0] as PinnaUsageError).code).toBe("pinna/dispose-not-at-rest");
    expect(Realm.status(realm)).toBe("open");
    stop();
  });

  test("throws inside an onObserved hook, and the error goes to onError", () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const $count = Box.make(realm, 1);
    Source.onObserved($count, () => {
      Realm.dispose(realm);
      return undefined;
    });
    const release = Source.observe($count);
    expect(errors).toHaveLength(1);
    expect((errors[0] as PinnaUsageError).code).toBe("pinna/dispose-not-at-rest");
    expect(Realm.status(realm)).toBe("open");
    release();
  });

  test("throws inside a nested update", () => {
    refusedIn((realm, dispose) => {
      expect(() =>
        Realm.update(realm, () => {
          Realm.update(realm, () => {
            dispose();
          });
        }),
      ).toThrow();
    });
  });

  test("throws inside an autorun's body", () => {
    refusedIn((realm, dispose) => {
      expect(() =>
        Realm.autorun(realm, () => {
          dispose();
          return undefined;
        }),
      ).toThrow();
    });
  });

  test("throws inside a stage recipe", () => {
    refusedIn((realm, dispose) => {
      const stage = Stage.make(realm);
      expect(() =>
        Stage.update(stage, () => {
          dispose();
        }),
      ).toThrow();
      Stage.apply(stage);
    });
  });

  test("throws inside a row listener", () => {
    refusedIn((realm, dispose) => {
      const rows = Collection.make(realm, { keyOf: (row: { readonly id: string }) => row.id });
      const stop = Collection.onRowChange(rows, () => {
        dispose();
        return undefined;
      });
      expect(() =>
        Realm.update(realm, (_read, write) => {
          write.upsert(rows, { id: "a" });
        }),
      ).toThrow();
      stop();
    });
  });
});

describe("disposal from a scheduled run", () => {
  for (const kind of ["watch", "autorun"] as const) {
    test(`a scheduled ${kind}'s run refuses Realm.dispose and leaves the realm open`, () => {
      const errors: Array<unknown> = [];
      const realm = Realm.make({
        onError: (error) => {
          errors.push(error);
        },
      });
      const $value = Box.make(realm, 0);
      const frame: Array<() => void> = [];
      const scheduler = (run: () => void) => {
        frame.push(run);
      };
      let runs = 0;
      const stop =
        kind === "watch"
          ? Realm.watch(
              realm,
              (read) => read($value),
              () => {
                Realm.dispose(realm);
              },
              { scheduler },
            )
          : Realm.autorun(
              realm,
              (read) => {
                read($value);
                if (runs++ > 0) {
                  Realm.dispose(realm);
                }
                return undefined;
              },
              { scheduler },
            );
      Realm.update(realm, (_read, write) => {
        write($value, 1);
      });
      frame.shift()?.();
      expect(Realm.status(realm)).toBe("open");
      expect(errors.map((error) => (error as PinnaUsageError).code)).toEqual([
        "pinna/dispose-not-at-rest",
      ]);
      Realm.update(realm, (_read, write) => {
        write($value, 2);
      });
      stop();
      Realm.dispose(realm);
      expect(Realm.status(realm)).toBe("disposed");
    });
  }
});
