import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { Box, Program, Realm, type Scheduler } from "../src/index.ts";

/**
 * A scheduler with a schema box and with `Program.watchScoped`
 * (ruling 58 of `docs/api.md`): the run reads the checked value current
 * when the scheduler calls it, once for every write before it.
 */

/** Long enough for forked fibers to run what they were handed. */
const settle = Effect.sleep("5 millis");

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

describe("a scheduled watch over a schema box", () => {
  test("runs once with the last accepted value; a rejected write schedules nothing", () => {
    const realm = Realm.make();
    const $count = Box.schema(realm, Schema.Number, 0);
    const later = frame();
    const seen: Array<number> = [];
    Realm.watch(
      realm,
      (read) => read($count),
      (value) => {
        seen.push(value);
      },
      { scheduler: later.scheduler },
    );
    Realm.update(realm, (_read, write) => write($count, 1));
    Realm.update(realm, (_read, write) => write($count, 2));
    expect(() =>
      Realm.update(realm, (_read, write) => write($count, "three" as unknown as number)),
    ).toThrow();
    later.flush();
    expect(seen).toEqual([2]);
  });
});

describe("watchScoped with a scheduler", () => {
  test("runs the effect once per call of run, with the latest value", async () => {
    const realm = Realm.make();
    const $count = Box.schema(realm, Schema.Number, 0);
    const later = frame();
    const seen: Array<[number, number]> = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Program.watchScoped(
            realm,
            (read) => read($count),
            (value, previous) =>
              Effect.sync(() => {
                seen.push([value, previous]);
              }),
            { scheduler: later.scheduler },
          );
          for (let value = 1; value <= 3; value++) {
            Realm.update(realm, (_read, write) => write($count, value));
          }
          yield* settle;
          expect(seen).toEqual([]);
          later.flush();
          yield* settle;
          expect(seen).toEqual([[3, 0]]);
        }),
      ),
    );
    // The scope closed: a later write schedules nothing.
    Realm.update(realm, (_read, write) => write($count, 4));
    later.flush();
    expect(seen).toEqual([[3, 0]]);
    Realm.dispose(realm);
  });
});
