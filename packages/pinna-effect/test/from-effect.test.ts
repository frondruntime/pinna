import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Queue, Schema, Stream } from "effect";
import { Box, Computed, Program, Realm, Source, Stage, StageConflictError } from "../src/index.ts";

/**
 * `Program.fromEffect`, `Program.fromStream` over one Effect, and the bridges
 * against schema boxes and stages (`docs/api.md`, ruling 65).
 */

/** Long enough for forked fibers to run what they were handed. */
const settle = Effect.sleep("5 millis");

const currentOf = <Value>(realm: Realm, $value: Computed<Value>): Value =>
  Realm.untracked(realm, (read) => read($value));

describe("Program.fromEffect", () => {
  test("runs the effect only while observed and holds what it succeeds with", async () => {
    const realm = Realm.make();
    let runs = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const done = yield* Deferred.make<number>();
          const $value = yield* Program.fromEffect(
            realm,
            Effect.suspend(() => {
              runs += 1;
              return Deferred.await(done);
            }),
            0,
          );
          yield* settle;
          expect(runs).toBe(0);
          const release = Source.observe($value);
          yield* settle;
          expect(runs).toBe(1);
          expect(currentOf(realm, $value)).toBe(0);
          yield* Deferred.succeed(done, 7);
          yield* settle;
          expect(currentOf(realm, $value)).toBe(7);
          release();
          expect(currentOf(realm, $value)).toBe(0);
          const again = Source.observe($value);
          yield* settle;
          expect(runs).toBe(2);
          again();
        }),
      ),
    );
  });

  test("the last observer leaving interrupts the effect, and the tryPromise signal aborts", async () => {
    const realm = Realm.make();
    let signal: AbortSignal | undefined;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const $value = yield* Program.fromEffect(
            realm,
            Effect.tryPromise({
              try: (given) => {
                signal = given;
                return new Promise<number>(() => undefined);
              },
              catch: () => "failed" as const,
            }).pipe(Effect.catch(() => Effect.succeed(-1))),
            0,
          );
          const release = Source.observe($value);
          yield* settle;
          expect(signal?.aborted).toBe(false);
          release();
          yield* settle;
          expect(signal?.aborted).toBe(true);
        }),
      ),
    );
  });

  test("a failure mapped into the value with Effect.catch is the value", async () => {
    const realm = Realm.make();
    type Load =
      | { readonly state: "loading" }
      | { readonly state: "failed"; readonly error: string };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const $value = yield* Program.fromEffect(
            realm,
            Effect.fail("offline").pipe(
              Effect.catch((error) => Effect.succeed<Load>({ state: "failed", error })),
            ),
            { state: "loading" } as Load,
          );
          const release = Source.observe($value);
          yield* settle;
          expect(currentOf(realm, $value)).toEqual({ state: "failed", error: "offline" });
          release();
        }),
      ),
    );
  });

  test("Realm.dispose interrupts the effect", async () => {
    const realm = Realm.make();
    let interrupted = false;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const $value = yield* Program.fromEffect(
            realm,
            Effect.never.pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted = true;
                }),
              ),
            ),
            0,
          );
          Source.observe($value);
          yield* settle;
          Realm.dispose(realm);
          yield* settle;
          expect(interrupted).toBe(true);
        }),
      ),
    );
  });

  test("options.name names the value", async () => {
    const realm = Realm.make();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const $value = yield* Program.fromEffect(realm, Effect.succeed(1), 0, {
            name: "config",
          });
          expect(Source.inspect($value).name).toBe("config");
        }),
      ),
    );
  });
});

describe("the bridges with schema boxes and stages", () => {
  test("a Computed.fromPromise result written into a schema box is checked", async () => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const $count = Box.schema(realm, Schema.Number, 0);
    const $loaded = Computed.fromPromise(realm, () => Promise.resolve("ten" as unknown), 0);
    const stop = Realm.watch(
      realm,
      (read) => read($loaded),
      (value) => {
        Realm.update(realm, (_read, write) => write($count, value as number));
      },
    );
    await new Promise((done) => setTimeout(done, 0));
    expect(errors).toHaveLength(1);
    expect(currentOf(realm, $count)).toBe(0);
    stop();
  });

  test("a computed value over a schema box and a promise recomputes on each", async () => {
    const realm = Realm.make();
    const $rate = Box.schema(realm, Schema.Number, 2);
    const $amount = Computed.fromPromise(realm, () => Promise.resolve(10), 0);
    const $converted = Computed.make(realm, (read) => read($rate) * read($amount));
    const seen: Array<number> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($converted),
      (value) => {
        seen.push(value);
      },
    );
    await new Promise((done) => setTimeout(done, 0));
    Realm.update(realm, (_read, write) => write($rate, 3));
    expect(seen).toEqual([20, 30]);
    stop();
  });

  test("a stage that fails on conflicts conflicts when a fromStream value changed since it read it", async () => {
    const realm = Realm.make();
    const $total = Box.make(realm, 0);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<number>();
          const $value = yield* Program.fromStream(realm, Stream.fromQueue(queue), 0, {
            name: "feed",
          });
          const release = Source.observe($value);
          yield* settle;
          const stage = Stage.make(realm, { conflicts: "fail" });
          Stage.update(stage, (read, write) => write($total, read($value) + 1));
          yield* Queue.offer(queue, 41);
          yield* settle;
          let conflict: unknown;
          try {
            Stage.apply(stage);
          } catch (error) {
            conflict = error;
          }
          expect(conflict).toBeInstanceOf(StageConflictError);
          expect((conflict as StageConflictError).changed).toEqual(["feed"]);
          release();
        }),
      ),
    );
    expect(currentOf(realm, $total)).toBe(0);
  });
});
