import { afterEach, describe, expect, test } from "bun:test";
import { Graph, readCell, writeCell } from "@frondruntime/pinna-core";
import { atom, box, createRealm, untracked, update, watch } from "../src/index.ts";
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
  test("a watch effect's error goes to the realm's onError, not the global", () => {
    failGlobal();
    const reported: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => reported.push(error) });
    const $count = box(realm, 0);
    const failure = new Error("boom");
    const seen: Array<number> = [];
    watch(
      realm,
      (read) => read($count),
      (value) => {
        if (value === 1) {
          throw failure;
        }
        seen.push(value);
      },
    );
    update(realm, (_read, write) => {
      write($count, 1);
    });
    update(realm, (_read, write) => {
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
    const realmA = createRealm({ onError: (error) => first.push(error) });
    const realmB = createRealm({ onError: (error) => second.push(error) });
    const $a = box(realmA, 0);
    const $b = box(realmB, 0);
    watch(
      realmA,
      (read) => read($a),
      () => {
        throw new Error("a");
      },
    );
    watch(
      realmB,
      (read) => read($b),
      () => {
        throw new Error("b");
      },
    );
    update(realmA, (_read, write) => {
      write($a, 1);
    });
    update(realmB, (_read, write) => {
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
    const realm = createRealm({ onError: (error) => reported.push(error) });
    const $loop = box(realm, 0);
    watch(
      realm,
      (read) => read($loop),
      (value) => {
        update(realm, (_read, write) => {
          write($loop, value + 1);
        });
      },
    );
    update(realm, (_read, write) => {
      write($loop, 1);
    });
    expect(reported.map((error) => (error as Error).message)).toEqual([
      "pinna: watchers did not settle after 100 rounds",
    ]);
  });

  test("an onError that throws throws to the writer, as the global reporter does", () => {
    const realm = createRealm({
      onError: () => {
        throw new Error("sink failed");
      },
    });
    const $count = box(realm, 0);
    watch(
      realm,
      (read) => read($count),
      () => {
        throw new Error("boom");
      },
    );
    expect(() =>
      update(realm, (_read, write) => {
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
    const realm = createRealm({
      onError: () => {
        throw new Error("sink failed");
      },
    });
    const $count = box(realm, 0);
    // A rollback does not undo an atom's change, so the watch reruns in the
    // flush that ends the failed recipe.
    const outside = atom(realm);
    let armed = false;
    watch(
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
      update(realm, (_read, write) => {
        armed = true;
        write.changed(outside);
        write($count, 1);
        throw new Error("recipe failed");
      }),
    ).toThrow("recipe failed");
    expect(untracked(realm, (read) => read($count))).toBe(0);
    expect(reported.map((error) => (error as Error).message)).toEqual(["sink failed"]);
    expectRealmAtRest(realm);
  });

  test("the sink's error a failed recipe hides goes to the host's reportError", () => {
    const reported: Array<unknown> = [];
    globalThis.reportError = (error) => {
      reported.push(error);
    };
    const realm = createRealm({
      onError: (error) => {
        throw error;
      },
    });
    const $count = box(realm, 0);
    // A rollback does not undo an atom's change, so the watch reruns in the
    // flush that ends the failed recipe.
    const outside = atom(realm);
    let armed = false;
    watch(
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
      update(realm, (_read, write) => {
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
    const realm = createRealm({
      onError: (error) => {
        throw error;
      },
    });
    const $count = box(realm, 0);
    // A rollback does not undo an atom's change, so the watch reruns in the
    // flush that ends the failed recipe.
    const outside = atom(realm);
    let armed = false;
    watch(
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
      update(realm, (_read, write) => {
        armed = true;
        write.changed(outside);
        write($count, 1);
        throw new Error("recipe failed");
      }),
    ).toThrow("recipe failed");
    expectRealmAtRest(realm);
  });

  test("an onError that throws does not stop the other watchers", () => {
    const realm = createRealm({
      onError: () => {
        throw new Error("sink failed");
      },
    });
    const $count = box(realm, 0);
    const seen: Array<number> = [];
    watch(
      realm,
      (read) => read($count),
      () => {
        throw new Error("boom");
      },
    );
    watch(
      realm,
      (read) => read($count),
      (value) => {
        seen.push(value);
      },
    );
    for (const value of [1, 2]) {
      expect(() =>
        update(realm, (_read, write) => {
          write($count, value);
        }),
      ).toThrow("sink failed");
    }
    expect(seen).toEqual([1, 2]);
    expectRealmAtRest(realm);
  });

  test("a write onError makes for watchers that never settle still notifies", () => {
    failGlobal();
    const realm = createRealm({
      onError: () => {
        update(realm, (read, write) => {
          write($errors, read($errors) + 1);
        });
      },
    });
    const $errors = box(realm, 0);
    const $loop = box(realm, 0);
    const seen: Array<number> = [];
    watch(
      realm,
      (read) => read($errors),
      (count) => {
        seen.push(count);
      },
    );
    watch(
      realm,
      (read) => read($loop),
      (value) => {
        update(realm, (_read, write) => {
          write($loop, value + 1);
        });
      },
    );
    update(realm, (_read, write) => {
      write($loop, 1);
    });
    expect(seen).toEqual([1]);
  });

  test("an onError that feeds watchers that never settle is not called again", () => {
    failGlobal();
    let calls = 0;
    const realm = createRealm({
      onError: () => {
        calls++;
        update(realm, (read, write) => {
          write($loop, read($loop) + 1);
        });
      },
    });
    const $loop = box(realm, 0);
    watch(
      realm,
      (read) => read($loop),
      (value) => {
        update(realm, (_read, write) => {
          write($loop, value + 1);
        });
      },
    );
    update(realm, (_read, write) => {
      write($loop, 1);
    });
    expect(calls).toBe(1);
    const seen: Array<number> = [];
    const $calm = box(realm, 0);
    watch(
      realm,
      (read) => read($calm),
      (value) => {
        seen.push(value);
      },
    );
    update(realm, (_read, write) => {
      write($calm, 1);
    });
    expect(seen).toEqual([1]);
  });

  test("without onError, the host's reportError takes the error", () => {
    const reported: Array<unknown> = [];
    globalThis.reportError = (error) => {
      reported.push(error);
    };
    const realm = createRealm();
    const $count = box(realm, 0);
    const failure = new Error("boom");
    watch(
      realm,
      (read) => read($count),
      () => {
        throw failure;
      },
    );
    update(realm, (_read, write) => {
      write($count, 1);
    });
    expect(reported).toEqual([failure]);
    expectRealmAtRest(realm);
  });

  test("a graph made with a reporter uses it", () => {
    failGlobal();
    const reported: Array<unknown> = [];
    const graph = new Graph((error) => reported.push(error));
    const cell = graph.cell(0);
    graph.watch(() => {
      if (readCell(cell) === 1) {
        throw new Error("boom");
      }
    });
    writeCell(cell, 1);
    expect(reported.map((error) => (error as Error).message)).toEqual(["boom"]);
  });
});
