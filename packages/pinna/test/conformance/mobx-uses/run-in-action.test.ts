import { describe, expect, test } from "bun:test";
import { autorun as mobxAutorun, observable, runInAction } from "mobx";
import { autorun, box, createRealm, update } from "../../../src/index.ts";

/**
 * An application's `runInAction` uses, beside `update`: an outer batch around
 * several writes, and test fixtures that write a model.
 */

describe("runInAction", () => {
  // Nested batches join the outermost, so the reader sees only its end state.
  const trace = [0, 3];

  test("MobX: nested actions join the outermost one", () => {
    const state = observable({ count: 0 });
    const seen: Array<number> = [];
    const stop = mobxAutorun(() => {
      seen.push(state.count);
    });
    runInAction(() => {
      state.count = 1;
      runInAction(() => {
        state.count = 2;
      });
      state.count = 3;
    });
    stop();
    expect(seen).toEqual(trace);
  });

  test("Pinna: nested updates join the outermost one", () => {
    const realm = createRealm();
    const $count = box(realm, 0);
    const seen: Array<number> = [];
    const stop = autorun(realm, (read) => {
      seen.push(read($count));
    });
    update(realm, (_read, write) => {
      write($count, 1);
      update(realm, (_read, write) => {
        write($count, 2);
      });
      write($count, 3);
    });
    stop();
    expect(seen).toEqual(trace);
  });
});

/**
 * An application's update recipes: one recipe writes and throws inside the
 * caller's batch, which catches it. These cases differ on purpose: MobX keeps
 * the throwing recipe's writes before the throw, while Pinna rolls back
 * every box the throwing update wrote. Both keep the earlier recipe's write,
 * and the reader sees the end state once.
 */
describe("a recipe that throws inside a batch", () => {
  test("MobX: the earlier recipe's write and the throwing recipe's prefix stay", () => {
    const state = observable({ first: 0, second: 0 });
    const seen: Array<string> = [];
    const stop = mobxAutorun(() => {
      seen.push(`${state.first}/${state.second}`);
    });
    runInAction(() => {
      state.first = 1;
      try {
        runInAction(() => {
          state.second = 1;
          throw new Error("jammed");
        });
      } catch {
        // The caller catches the error and ends its batch.
      }
    });
    stop();
    expect(seen).toEqual(["0/0", "1/1"]);
  });

  test("Pinna: the earlier recipe's write stays and the throwing update's write is rolled back", () => {
    const realm = createRealm();
    const $first = box(realm, 0);
    const $second = box(realm, 0);
    const seen: Array<string> = [];
    const stop = autorun(realm, (read) => {
      seen.push(`${read($first)}/${read($second)}`);
    });
    update(realm, (_read, write) => {
      write($first, 1);
      try {
        update(realm, (_read, write) => {
          write($second, 1);
          throw new Error("jammed");
        });
      } catch {
        // The caller catches the error and ends its batch.
      }
    });
    stop();
    expect(seen).toEqual(["0/0", "1/0"]);
  });
});
