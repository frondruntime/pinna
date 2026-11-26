import { describe, expect, test } from "bun:test";
import { Realm, type Scheduler } from "../../src/index.ts";
import { type Check, makeBox } from "../../src/internal/index.ts";

/** Internals: a box over a custom check, made with `makeBox`. The public form is `Box.schema` in pinna-effect. */

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

describe("a scheduled watch", () => {
  test("a box with a check is watched as any box", () => {
    const realm = Realm.make();
    const check: Check = (value) => {
      if (typeof value !== "number" || value < 0) {
        throw new Error("negative");
      }
    };
    const $checked = makeBox<number>(realm, check, Object.is, 0, undefined);
    const later = frame();
    const seen: Array<number> = [];
    Realm.watch(
      realm,
      (read) => read($checked),
      (value) => {
        seen.push(value);
      },
      { scheduler: later.scheduler },
    );
    Realm.update(realm, (_read, write) => write($checked, 3));
    expect(() => Realm.update(realm, (_read, write) => write($checked, -1))).toThrow();
    later.flush();
    expect(seen).toEqual([3]);
  });
});
