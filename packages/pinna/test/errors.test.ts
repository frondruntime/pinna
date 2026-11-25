import { afterEach, describe, expect, test } from "bun:test";
import { Atom, Box, Computed, Realm, Source } from "../src/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * Where an error with no caller goes: a watcher's error, and the error for
 * watchers that never settle. A realm's `onError` takes them; without one,
 * the host's `reportError` does.
 */

const original = globalThis.reportError;

afterEach(() => {
  globalThis.reportError = original;
});

const failGlobal = (): void => {
  globalThis.reportError = (error) => {
    throw new Error(`the global reporter was called with ${String(error)}`);
  };
};

describe("createRealm({ onError })", () => {
  for (const cleanup of [false, true]) {
    for (const failedRecipe of [false, true]) {
      test(`two failing ${cleanup ? "cleanups" : "starts"} on one source share a ${failedRecipe ? "failed" : "successful"} recipe's error accumulator`, () => {
        const errors: Array<string> = [];
        const host: Array<string> = [];
        globalThis.reportError = (error: unknown) => host.push((error as Error).message);
        const realm = Realm.make({
          onError: (error) => {
            const message = (error as Error).message;
            errors.push(message);
            throw new Error(`sink ${message}`);
          },
        });
        const source = Box.make(realm, 0);
        for (const message of ["A", "B"]) {
          const fail = () => {
            throw new Error(message);
          };
          Source.onObserved(source, cleanup ? () => fail : fail);
        }
        let stop: (() => void) | undefined = cleanup ? Source.observe(source) : undefined;
        let caught: unknown;
        try {
          Realm.update(realm, () => {
            if (cleanup) stop?.();
            else stop = Source.observe(source);
            if (failedRecipe) throw new Error("recipe failed");
          });
        } catch (error) {
          caught = error;
        }
        expect(errors.toSorted()).toEqual(["A", "B"]);
        expect((caught as Error).message).toBe(
          failedRecipe ? "recipe failed" : `sink ${errors[0]}`,
        );
        expect(host).toEqual(failedRecipe ? [`sink ${errors[0]}`] : []);
        stop?.();
        expectRealmAtRest(realm);
      });
    }
  }

  test("a watch effect's error goes to the realm's onError, not the global", () => {
    failGlobal();
    const reported: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => reported.push(error) });
    const $count = Box.make(realm, 0);
    const failure = new Error("boom");
    const seen: Array<number> = [];
    Realm.watch(
      realm,
      (read) => read($count),
      (value) => {
        if (value === 1) {
          throw failure;
        }
        seen.push(value);
      },
    );
    Realm.update(realm, (_read, write) => {
      write($count, 1);
    });
    Realm.update(realm, (_read, write) => {
      write($count, 2);
    });
    expect(reported).toEqual([failure]);
    expect(seen).toEqual([2]);
    expectRealmAtRest(realm);
  });

  test("two realms report apart", () => {
    failGlobal();
    const first: Array<unknown> = [];
    const second: Array<unknown> = [];
    const realmA = Realm.make({ onError: (error) => first.push(error) });
    const realmB = Realm.make({ onError: (error) => second.push(error) });
    const $a = Box.make(realmA, 0);
    const $b = Box.make(realmB, 0);
    Realm.watch(
      realmA,
      (read) => read($a),
      () => {
        throw new Error("a");
      },
    );
    Realm.watch(
      realmB,
      (read) => read($b),
      () => {
        throw new Error("b");
      },
    );
    Realm.update(realmA, (_read, write) => {
      write($a, 1);
    });
    Realm.update(realmB, (_read, write) => {
      write($b, 1);
    });
    expect(first.map((error) => (error as Error).message)).toEqual(["a"]);
    expect(second.map((error) => (error as Error).message)).toEqual(["b"]);
    expectRealmAtRest(realmA);
    expectRealmAtRest(realmB);
  });

  test("watchers that never settle are reported to onError", () => {
    failGlobal();
    const reported: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => reported.push(error) });
    const $loop = Box.make(realm, 0);
    Realm.watch(
      realm,
      (read) => read($loop),
      (value) => {
        Realm.update(realm, (_read, write) => {
          write($loop, value + 1);
        });
      },
    );
    Realm.update(realm, (_read, write) => {
      write($loop, 1);
    });
    expect(reported.map((error) => (error as Error).message)).toEqual([
      "pinna: watchers did not settle after 100 rounds",
    ]);
  });

  test("an onError that throws throws to the writer, as the global reporter does", () => {
    const realm = Realm.make({
      onError: () => {
        throw new Error("sink failed");
      },
    });
    const $count = Box.make(realm, 0);
    Realm.watch(
      realm,
      (read) => read($count),
      () => {
        throw new Error("boom");
      },
    );
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write($count, 1);
      }),
    ).toThrow("sink failed");
    expectRealmAtRest(realm);
  });

  test("a recipe's own error wins over an onError that throws during the rollback", () => {
    const reported: Array<unknown> = [];
    globalThis.reportError = (error) => {
      reported.push(error);
    };
    const realm = Realm.make({
      onError: () => {
        throw new Error("sink failed");
      },
    });
    const $count = Box.make(realm, 0);
    // A rollback does not undo an atom's change, so the watch reruns in the
    // flush that ends the failed recipe.
    const outside = Atom.make(realm);
    let armed = false;
    Realm.watch(
      realm,
      (read) => {
        read(outside);
        if (armed) {
          throw new Error("boom");
        }
        return read($count);
      },
      () => {},
    );
    expect(() =>
      Realm.update(realm, (_read, write) => {
        armed = true;
        write.changed(outside);
        write($count, 1);
        throw new Error("recipe failed");
      }),
    ).toThrow("recipe failed");
    expect(Realm.untracked(realm, (read) => read($count))).toBe(0);
    expect(reported.map((error) => (error as Error).message)).toEqual(["sink failed"]);
    expectRealmAtRest(realm);
  });

  test("the sink's error a failed recipe hides goes to the host's reportError", () => {
    const reported: Array<unknown> = [];
    globalThis.reportError = (error) => {
      reported.push(error);
    };
    const realm = Realm.make({
      onError: (error) => {
        throw error;
      },
    });
    const $count = Box.make(realm, 0);
    // A rollback does not undo an atom's change, so the watch reruns in the
    // flush that ends the failed recipe.
    const outside = Atom.make(realm);
    let armed = false;
    Realm.watch(
      realm,
      (read) => {
        read(outside);
        if (armed) {
          throw new Error("watcher failed");
        }
        return read($count);
      },
      () => {},
    );
    expect(() =>
      Realm.update(realm, (_read, write) => {
        armed = true;
        write.changed(outside);
        write($count, 1);
        throw new Error("recipe failed");
      }),
    ).toThrow("recipe failed");
    expect(reported.map((error) => (error as Error).message)).toEqual(["watcher failed"]);
    expectRealmAtRest(realm);
  });

  test("a host reportError that throws does not hide a failed recipe's error", () => {
    failGlobal();
    const realm = Realm.make({
      onError: (error) => {
        throw error;
      },
    });
    const $count = Box.make(realm, 0);
    // A rollback does not undo an atom's change, so the watch reruns in the
    // flush that ends the failed recipe.
    const outside = Atom.make(realm);
    let armed = false;
    Realm.watch(
      realm,
      (read) => {
        read(outside);
        if (armed) {
          throw new Error("watcher failed");
        }
        return read($count);
      },
      () => {},
    );
    expect(() =>
      Realm.update(realm, (_read, write) => {
        armed = true;
        write.changed(outside);
        write($count, 1);
        throw new Error("recipe failed");
      }),
    ).toThrow("recipe failed");
    expectRealmAtRest(realm);
  });

  test("an onError that throws does not stop the other watchers", () => {
    const realm = Realm.make({
      onError: () => {
        throw new Error("sink failed");
      },
    });
    const $count = Box.make(realm, 0);
    const seen: Array<number> = [];
    Realm.watch(
      realm,
      (read) => read($count),
      () => {
        throw new Error("boom");
      },
    );
    Realm.watch(
      realm,
      (read) => read($count),
      (value) => {
        seen.push(value);
      },
    );
    for (const value of [1, 2]) {
      expect(() =>
        Realm.update(realm, (_read, write) => {
          write($count, value);
        }),
      ).toThrow("sink failed");
    }
    expect(seen).toEqual([1, 2]);
    expectRealmAtRest(realm);
  });

  test("a write onError makes for watchers that never settle still notifies", () => {
    failGlobal();
    const realm = Realm.make({
      onError: () => {
        Realm.update(realm, (read, write) => {
          write($errors, read($errors) + 1);
        });
      },
    });
    const $errors = Box.make(realm, 0);
    const $loop = Box.make(realm, 0);
    const seen: Array<number> = [];
    Realm.watch(
      realm,
      (read) => read($errors),
      (count) => {
        seen.push(count);
      },
    );
    Realm.watch(
      realm,
      (read) => read($loop),
      (value) => {
        Realm.update(realm, (_read, write) => {
          write($loop, value + 1);
        });
      },
    );
    Realm.update(realm, (_read, write) => {
      write($loop, 1);
    });
    expect(seen).toEqual([1]);
  });

  test("an onError that feeds watchers that never settle is not called again", () => {
    failGlobal();
    let calls = 0;
    const realm = Realm.make({
      onError: () => {
        calls++;
        Realm.update(realm, (read, write) => {
          write($loop, read($loop) + 1);
        });
      },
    });
    const $loop = Box.make(realm, 0);
    Realm.watch(
      realm,
      (read) => read($loop),
      (value) => {
        Realm.update(realm, (_read, write) => {
          write($loop, value + 1);
        });
      },
    );
    Realm.update(realm, (_read, write) => {
      write($loop, 1);
    });
    expect(calls).toBe(1);
    const seen: Array<number> = [];
    const $calm = Box.make(realm, 0);
    Realm.watch(
      realm,
      (read) => read($calm),
      (value) => {
        seen.push(value);
      },
    );
    Realm.update(realm, (_read, write) => {
      write($calm, 1);
    });
    expect(seen).toEqual([1]);
  });

  test("without onError, the host's reportError takes the error", () => {
    const reported: Array<unknown> = [];
    globalThis.reportError = (error) => {
      reported.push(error);
    };
    const realm = Realm.make();
    const $count = Box.make(realm, 0);
    const failure = new Error("boom");
    Realm.watch(
      realm,
      (read) => read($count),
      () => {
        throw failure;
      },
    );
    Realm.update(realm, (_read, write) => {
      write($count, 1);
    });
    expect(reported).toEqual([failure]);
    expectRealmAtRest(realm);
  });
});

describe("a thrown value that is not an Error", () => {
  const values = [undefined, null, "text", Object.freeze({ reason: "frozen" })] as const;

  for (const thrown of values) {
    test(`a computed value keeps a thrown ${thrown === null ? "null" : typeof thrown} and rethrows the same value`, () => {
      const realm = Realm.make();
      let runs = 0;
      const failing = Computed.make(realm, (): number => {
        runs++;
        throw thrown;
      });
      const caught: Array<unknown> = [];
      for (let index = 0; index < 2; index++) {
        try {
          Realm.untracked(realm, (read) => read(failing));
        } catch (error) {
          caught.push(error);
        }
      }
      expect(caught.length).toBe(2);
      expect(caught.every((error) => error === thrown)).toBe(true);
      expect(runs).toBe(1);
      expectRealmAtRest(realm);
    });

    test(`a watch effect that throws ${thrown === null ? "null" : typeof thrown} hands onError the same value`, () => {
      const reports: Array<unknown> = [];
      const realm = Realm.make({ onError: (error) => reports.push(error) });
      const box = Box.make(realm, 0);
      const stop = Realm.watch(
        realm,
        (read) => read(box),
        () => {
          throw thrown;
        },
      );
      Realm.update(realm, (_read, write) => {
        write(box, 1);
      });
      expect(reports.length).toBe(1);
      expect(reports[0]).toBe(thrown);
      stop();
      expectRealmAtRest(realm);
    });
  }
});

describe("teardown errors", () => {
  test("stopping an autorun reports its cleanup's error and returns", () => {
    const reports: Array<string> = [];
    const realm = Realm.make({ onError: (error) => reports.push((error as Error).message) });
    const box = Box.make(realm, 0);
    const stop = Realm.autorun(realm, (read) => {
      read(box);
      return () => {
        throw new Error("the cleanup fails");
      };
    });
    expect(() => stop()).not.toThrow();
    expect(reports).toEqual(["the cleanup fails"]);
    expectRealmAtRest(realm);
  });

  // Ruling 57: autorun cleanups run newest first, then hook cleanups.
  test("disposing a realm reports every failing cleanup, newest autorun first and hooks last, and returns", () => {
    const reports: Array<string> = [];
    const realm = Realm.make({ onError: (error) => reports.push((error as Error).message) });
    const box = Box.make(realm, 0);
    for (const name of ["first", "second"]) {
      Realm.autorun(realm, (read) => {
        read(box);
        return () => {
          throw new Error(`the ${name} cleanup fails`);
        };
      });
    }
    Source.onObserved(box, () => () => {
      throw new Error("the hook cleanup fails");
    });
    expect(() => Realm.dispose(realm)).not.toThrow();
    expect(reports).toEqual([
      "the second cleanup fails",
      "the first cleanup fails",
      "the hook cleanup fails",
    ]);
    expect(Realm.status(realm)).toBe("disposed");
  });
});
