import { describe, expect, test } from "bun:test";
import { testRealm } from "@frondruntime/pinna/testing";
import { Cause, Deferred, Effect, Exit, Fiber, Schema } from "effect";
import { Box, isPinnaError, Realm, Stage, StageConflictError } from "../src/index.ts";

/**
 * Visible stages over schema boxes, and `Stage.scoped` with `visible` and
 * `guess` (ruling 68).
 */

const NonNegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

const now = (realm: Realm, $box: Box<number>) => Realm.untracked(realm, (read) => read($box));

describe("a schema box under a visible stage", () => {
  test("a guess the schema rejects throws from Stage.update and shows nothing", () => {
    using realm = testRealm();
    const $count = Box.schema(realm, NonNegative, 1);
    const guess = Stage.make(realm, { visible: true });
    expect(() => Stage.update(guess, (_read, write) => write($count, -1))).toThrow(
      "the box rejects this value",
    );
    expect(now(realm, $count)).toBe(1);
    expect(Stage.inspect(guess)).toMatchObject({ showing: true, recipes: 0 });
    Stage.drop(guess);
  });

  test("a guess valid when staged and rejected on replay stops", () => {
    const reported: Array<unknown> = [];
    using realm = testRealm({ onError: (error) => reported.push(error) });
    const $count = Box.schema(realm, NonNegative, 5);
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (read, write) => write($count, read($count) - 3));
    expect(now(realm, $count)).toBe(2);
    Realm.update(realm, (_read, write) => write($count, 1));
    expect(now(realm, $count)).toBe(1);
    expect(Stage.inspect(guess).showing).toBe(false);
    expect(reported.length).toBe(1);
    expect(isPinnaError(reported[0], "ValueRejectedError")).toBe(true);
    expect(() => Stage.apply(guess)).toThrow("the box rejects this value");
  });

  test("every read of a shown value is tracked", () => {
    using realm = testRealm();
    const $count = Box.schema(realm, NonNegative, 5);
    const seen: Array<number> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($count),
      (value) => {
        seen.push(value);
      },
    );
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (_read, write) => write($count, 9));
    Stage.drop(guess);
    expect(seen).toEqual([9, 5]);
    stop();
  });
});

describe("Stage.scoped with visible", () => {
  test("the guess is the answer: shown while the section runs, applied on success", async () => {
    using realm = testRealm();
    const $count = Box.make(realm, 10);
    const gate = Deferred.makeUnsafe<void>();
    const fiber = Effect.runFork(
      Stage.scoped(
        realm,
        (stage) =>
          Effect.gen(function* () {
            Stage.update(stage, (read, write) => write($count, read($count) + 1));
            yield* Deferred.await(gate);
            return "done";
          }),
        { visible: true },
      ),
    );
    await Effect.runPromise(Effect.yieldNow);
    expect(now(realm, $count)).toBe(11);
    await Effect.runPromise(Deferred.succeed(gate, undefined));
    expect(await Effect.runPromise(Fiber.join(fiber))).toBe("done");
    expect(now(realm, $count)).toBe(11);
  });

  test("a failure takes the guess back", async () => {
    using realm = testRealm();
    const $count = Box.make(realm, 10);
    const exit = await Effect.runPromiseExit(
      Stage.scoped(
        realm,
        (stage) =>
          Effect.gen(function* () {
            Stage.update(stage, (read, write) => write($count, read($count) + 1));
            return yield* Effect.fail("refused" as const);
          }),
        { visible: true },
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(now(realm, $count)).toBe(10);
  });

  test('a "fail" guess that stops mid-section fails the effect with StageConflictError', async () => {
    using realm = testRealm();
    const $count = Box.make(realm, 10, { name: "count" });
    const exit = await Effect.runPromiseExit(
      Stage.scoped(
        realm,
        (stage) =>
          Effect.gen(function* () {
            Stage.update(stage, (read, write) => write($count, read($count) + 1));
            Realm.update(realm, (_read, write) => write($count, 20));
            yield* Effect.sync(() => Stage.update(stage, () => undefined));
            return "unreached";
          }),
        { visible: true, conflicts: "fail" },
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
    expect(failure?._tag === "Some" && failure.value instanceof StageConflictError).toBe(true);
    expect(now(realm, $count)).toBe(20);
  });
});

describe("Stage.scoped with guess", () => {
  test("the answer wins: the guess shows, then the answer lands and the guess drops in one update", async () => {
    using realm = testRealm();
    const $count = Box.make(realm, 10);
    const seen: Array<number> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($count),
      (value) => {
        seen.push(value);
      },
    );
    const gate = Deferred.makeUnsafe<number>();
    const fiber = Effect.runFork(
      Stage.scoped(
        realm,
        (stage) =>
          Effect.gen(function* () {
            const answer = yield* Deferred.await(gate);
            Stage.update(stage, (_read, write) => write($count, answer));
            return answer;
          }),
        { name: "save", guess: (read, write) => write($count, read($count) + 1) },
      ),
    );
    await Effect.runPromise(Effect.yieldNow);
    expect(now(realm, $count)).toBe(11);
    expect(seen).toEqual([11]);
    await Effect.runPromise(Deferred.succeed(gate, 11));
    expect(await Effect.runPromise(Fiber.join(fiber))).toBe(11);
    expect(now(realm, $count)).toBe(11);
    // The answer agreed with the guess: no watcher ran for the settle.
    expect(seen).toEqual([11]);
    stop();
  });

  test("the answer differs from the guess: the screen goes from the guess to the answer", async () => {
    using realm = testRealm();
    const $count = Box.make(realm, 10);
    const seen: Array<number> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($count),
      (value) => {
        seen.push(value);
      },
    );
    await Effect.runPromise(
      Stage.scoped(
        realm,
        (stage) => Effect.sync(() => Stage.update(stage, (_read, write) => write($count, 15))),
        { guess: (read, write) => write($count, read($count) + 1) },
      ),
    );
    expect(seen).toEqual([11, 15]);
    stop();
  });

  test("failure and interruption drop both stages", async () => {
    using realm = testRealm();
    const $count = Box.make(realm, 10);
    const exit = await Effect.runPromiseExit(
      Stage.scoped(realm, () => Effect.fail("no" as const), {
        guess: (read, write) => write($count, read($count) + 1),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(now(realm, $count)).toBe(10);
    const started = Deferred.makeUnsafe<void>();
    const fiber = Effect.runFork(
      Stage.scoped(
        realm,
        () => Effect.andThen(Deferred.succeed(started, undefined), Effect.never),
        {
          guess: (read, write) => write($count, read($count) + 1),
        },
      ),
    );
    await Effect.runPromise(Deferred.await(started));
    expect(now(realm, $count)).toBe(11);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(now(realm, $count)).toBe(10);
  });

  test("a conflict of the answer fails with StageConflictError and drops the guess", async () => {
    using realm = testRealm();
    const $count = Box.make(realm, 10, { name: "count" });
    const exit = await Effect.runPromiseExit(
      Stage.scoped(
        realm,
        (stage) =>
          Effect.sync(() => {
            Stage.update(stage, (read, write) => write($count, read($count) * 2));
            Realm.update(realm, (_read, write) => write($count, 3));
          }),
        { conflicts: "fail", guess: (read, write) => write($count, read($count) + 1) },
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(now(realm, $count)).toBe(3);
  });

  test("guess with visible, or over a stage, dies with pinna/stage-visible-option", async () => {
    using realm = testRealm();
    const both = await Effect.runPromiseExit(
      Stage.scoped(realm, () => Effect.void, {
        visible: true,
        guess: () => undefined,
      }),
    );
    expect(Exit.isFailure(both)).toBe(true);
    const parent = Stage.make(realm);
    const overStage = await Effect.runPromiseExit(
      Stage.scoped(parent, () => Effect.void, { guess: (() => undefined) as never } as never),
    );
    expect(Exit.isFailure(overStage)).toBe(true);
    const defect = Exit.isFailure(overStage) ? Cause.squash(overStage.cause) : undefined;
    expect(isPinnaError(defect, "PinnaUsageError") && defect.code).toBe(
      "pinna/stage-visible-option",
    );
    Stage.drop(parent);
  });
});
