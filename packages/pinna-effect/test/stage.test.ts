import { describe, expect, test } from "bun:test";
import { testRealm } from "@frondruntime/pinna/testing";
import { Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect";
import {
  applyStage,
  box,
  changes,
  dropStage,
  openStage,
  schemaBox,
  stageRead,
  stageUpdate,
  untracked,
  update,
} from "../src/index.ts";

/**
 * A stage over schema boxes, and the host the plan names (`docs/api.md`,
 * ruling 53): asynchronous work that stages its writes, lands them in the
 * host's own update when it succeeds, and drops them when it fails or is
 * interrupted, built from the synchronous calls with `acquireUseRelease`.
 */

const NonNegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

describe("a schema box through a stage", () => {
  test("a refused value throws at stageUpdate, where the work wrote it", () => {
    using realm = testRealm();
    const $held = schemaBox(realm, NonNegative, 1);
    const stage = openStage(realm);
    expect(() =>
      stageUpdate(stage, (_read, write) => {
        write($held, -1);
      }),
    ).toThrow("pinna: the box rejects this value");
    expect(stageRead(stage, (read) => read($held))).toBe(1);
    dropStage(stage);
  });

  test("a value refused on replay throws at applyStage and rolls back the update it joined", () => {
    using realm = testRealm();
    const $held = schemaBox(realm, NonNegative, 5);
    const $own = box(realm, 0);
    const stage = openStage(realm);
    stageUpdate(stage, (read, write) => {
      write($held, read($held) - 3);
    });
    expect(stageRead(stage, (read) => read($held))).toBe(2);
    update(realm, (_read, write) => {
      write($held, 1);
    });
    expect(() =>
      update(realm, (_read, write) => {
        write($own, 1);
        applyStage(stage);
      }),
    ).toThrow("pinna: the box rejects this value");
    expect(untracked(realm, (read) => [read($held), read($own)])).toEqual([1, 0]);
  });
});

/** What a host does with a program's stage: land it in its own update on success, drop it otherwise. */
const staged = <A, E>(
  realm: Parameters<typeof openStage>[0],
  work: (stage: ReturnType<typeof openStage>) => Effect.Effect<A, E>,
  onLand: () => void,
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.sync(() => ({ stage: openStage(realm), applied: false })),
    (held) =>
      work(held.stage).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            update(realm, () => {
              onLand();
              applyStage(held.stage);
            });
            held.applied = true;
          }),
        ),
      ),
    (held) => Effect.sync(() => (held.applied ? undefined : dropStage(held.stage))),
  );

describe("a host running asynchronous work over a realm", () => {
  test("writes land together, in the host's own update, when the work succeeds", async () => {
    using realm = testRealm();
    const $status = box(realm, "idle");
    const $total = box(realm, 0);
    const $landed = box(realm, false);
    const seen: Array<ReadonlyArray<unknown>> = [];
    await Effect.runPromise(
      staged(
        realm,
        (stage) =>
          Effect.gen(function* () {
            stageUpdate(stage, (_read, write) => {
              write($status, "saving");
            });
            yield* Effect.sleep("1 millis");
            seen.push(untracked(realm, (read) => [read($status), read($total)]));
            stageUpdate(stage, (read, write) => {
              write($total, read($total) + 10);
              write($status, "saved");
            });
          }),
        () => {
          update(realm, (_read, write) => {
            write($landed, true);
          });
        },
      ),
    );
    expect(seen).toEqual([["idle", 0]]);
    expect(untracked(realm, (read) => [read($status), read($total), read($landed)])).toEqual([
      "saved",
      10,
      true,
    ]);
  });

  test("a cancel seen through changes, with no RealmService, drops the writes", async () => {
    using realm = testRealm();
    const $total = box(realm, 0);
    const $cancelled = box(realm, false);
    const started = Deferred.makeUnsafe<void>();
    const fiber = Effect.runFork(
      staged(
        realm,
        (stage) =>
          Effect.raceFirst(
            Effect.gen(function* () {
              stageUpdate(stage, (read, write) => {
                write($total, read($total) + 10);
              });
              Deferred.doneUnsafe(started, Exit.void);
              return yield* Effect.never;
            }),
            changes($cancelled).pipe(
              Stream.filter(Boolean),
              Stream.runHead,
              Effect.andThen(Effect.fail("cancelled" as const)),
            ),
          ),
        () => undefined,
      ),
    );
    await Effect.runPromise(Deferred.await(started));
    update(realm, (_read, write) => {
      write($cancelled, true);
    });
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(exit).toEqual(Exit.fail("cancelled"));
    expect(untracked(realm, (read) => read($total))).toBe(0);
  });

  test("a failure drops the writes", async () => {
    using realm = testRealm();
    const $total = box(realm, 0);
    const exit = await Effect.runPromiseExit(
      staged(
        realm,
        (stage) =>
          Effect.gen(function* () {
            stageUpdate(stage, (read, write) => {
              write($total, read($total) + 5);
            });
            return yield* Effect.fail("request failed");
          }),
        () => undefined,
      ),
    );
    expect(exit).toEqual(Exit.fail("request failed"));
    expect(untracked(realm, (read) => read($total))).toBe(0);
  });

  test("an interruption drops the writes", async () => {
    using realm = testRealm();
    const $total = box(realm, 0);
    const started = Deferred.makeUnsafe<void>();
    const fiber = Effect.runFork(
      staged(
        realm,
        (stage) =>
          Effect.gen(function* () {
            stageUpdate(stage, (read, write) => {
              write($total, read($total) + 7);
            });
            Deferred.doneUnsafe(started, Exit.void);
            return yield* Effect.never;
          }),
        () => undefined,
      ),
    );
    await Effect.runPromise(Deferred.await(started));
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(untracked(realm, (read) => read($total))).toBe(0);
  });
});
