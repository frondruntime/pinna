import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Schema, Stream } from "effect";
import {
  Box,
  type PinnaUsageError,
  Program,
  Realm,
  Source,
  ValueRejectedError,
} from "../src/index.ts";

/**
 * Disposing a realm ends the Effect programs over it: `Program.watchScoped`'s
 * running effect is interrupted, `Program.changes` completes, and `Program.fromStream` and
 * `Program.whileObserved` interrupt their fibers through their hooks' cleanups.
 * `Realm.scoped` disposes its realm when the scope closes.
 */

/** Long enough for forked fibers to run what they were handed. */
const settle = Effect.sleep("5 millis");

describe("createRealmScoped", () => {
  test("disposes the realm when the scope closes, after the programs started in it", async () => {
    let kept: Realm | undefined;
    let interrupted = false;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const realm = yield* Realm.scoped({ name: "scoped" });
          kept = realm;
          const $count = Box.make(realm, 0);
          yield* Program.watchScoped(
            realm,
            (read) => read($count),
            () =>
              Effect.never.pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    interrupted = true;
                  }),
                ),
              ),
          );
          Realm.update(realm, (_read, write) => {
            write($count, 1);
          });
          yield* settle;
          expect(Realm.status(realm)).toBe("open");
        }),
      ),
    );
    expect(interrupted).toBe(true);
    expect(Realm.status(kept as Realm)).toBe("disposed");
  });
});

describe("disposeRealm and the Effect programs", () => {
  test("interrupts the effect watchScoped is running, before the scope closes", async () => {
    const realm = Realm.make();
    const $count = Box.make(realm, 0);
    let interrupted = false;
    let afterDispose = false;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Program.watchScoped(
            realm,
            (read) => read($count),
            () =>
              Effect.never.pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    interrupted = true;
                  }),
                ),
              ),
          );
          Realm.update(realm, (_read, write) => {
            write($count, 1);
          });
          yield* settle;
          Realm.dispose(realm);
          yield* settle;
          afterDispose = interrupted;
        }),
      ),
    );
    expect(afterDispose).toBe(true);
  });

  test("completes changes with the values it streamed", async () => {
    const realm = Realm.make();
    const $count = Box.make(realm, 0);
    const values = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Stream.runCollect(Program.changes($count)).pipe(Effect.forkChild);
        yield* settle;
        Realm.update(realm, (_read, write) => {
          write($count, 1);
        });
        yield* settle;
        Realm.dispose(realm);
        return yield* Fiber.join(fiber);
      }),
    );
    expect(values).toEqual([0, 1]);
  });

  for (const kind of ["fromStream", "whileObserved"] as const) {
    test(`interrupts the fiber ${kind} runs`, async () => {
      const realm = Realm.make();
      let interrupted = false;
      const program = Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const $source =
              kind === "fromStream"
                ? yield* Program.fromStream(realm, Stream.fromEffect(program), undefined)
                : Box.make(realm, 0);
            if (kind === "whileObserved") {
              yield* Program.whileObserved($source, program);
            }
            Source.observe($source);
            yield* settle;
            expect(interrupted).toBe(false);
            Realm.dispose(realm);
            yield* settle;
            expect(interrupted).toBe(true);
          }),
        ),
      );
    });
  }

  test("keeps a schema box's last value readable and refuses a write", () => {
    const realm = Realm.make();
    const $count = Box.schema(realm, Schema.Number, 1);
    Realm.update(realm, (_read, write) => {
      write($count, 2);
    });
    Realm.dispose(realm);
    expect(Realm.untracked(realm, (read) => read($count))).toBe(2);
    let error: unknown;
    try {
      Realm.update(realm, (_read, write) => {
        write($count, 3);
      });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).not.toBeInstanceOf(ValueRejectedError);
    expect((error as PinnaUsageError).code).toBe("pinna/realm-disposed");
  });

  test("refuses a program started in a disposed realm as a defect", async () => {
    const realm = Realm.make();
    const $count = Box.make(realm, 0);
    Realm.dispose(realm);
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Program.watchScoped(
          realm,
          (read) => read($count),
          () => Effect.void,
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });
});
