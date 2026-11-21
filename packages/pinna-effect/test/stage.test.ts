import { describe, expect, test } from "bun:test";
import { testRealm } from "@frondruntime/pinna/testing";
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect";
import {
  applyStage,
  BoxField,
  box,
  CollectionField,
  changes,
  decode,
  dropStage,
  openStage,
  reconcileSchema,
  SchemaModel,
  type Stage,
  StageConflict,
  schemaBox,
  stageRead,
  stageStatus,
  stageUpdate,
  untracked,
  update,
  withStage,
} from "../src/index.ts";

/**
 * Stages over schema boxes and `SchemaModel`s, and `withStage`, which holds
 * an Effect program's writes until it succeeds (`docs/api.md`, ruling 53).
 */

const NonNegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

class Quote extends SchemaModel<Quote>("Quote")({
  id: Schema.String,
  symbol: Schema.String,
  $price: BoxField(NonNegative),
}) {}

class Book extends SchemaModel<Book>("Book")({
  $quotes: CollectionField(Quote, { keyOf: (quote) => quote.id }),
}) {}

const quotesJson = (...quotes: ReadonlyArray<readonly [string, number]>) =>
  quotes.map(([id, price]) => ({ id, symbol: id.toUpperCase(), price }));

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

  test("a value refused on replay throws at applyStage and rolls back the stage's writes", () => {
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
    expect(stageStatus(stage)).toBe("dropped");
  });
});

describe("a refetch through a stage", () => {
  test("replaceAll merges into the held models: the stage reads the new prices, the realm keeps its own", () => {
    using realm = testRealm();
    const book = decode(realm, Book)({ quotes: quotesJson(["a", 1], ["b", 2]) });
    const heldA = untracked(realm, (read) => read.row(book.$quotes, "a")) as Quote;
    // Decoded outside the recipe: the recipe runs twice, and would make two.
    const fresh = decode(realm, Book)({ quotes: quotesJson(["a", 10], ["c", 3]) });
    const rows = untracked(realm, (read) => read(fresh.$quotes.rows));
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write.replaceAll(book.$quotes, rows);
    });
    expect(
      stageRead(stage, (read) => ({
        keys: read(book.$quotes.keys),
        sameA: read.row(book.$quotes, "a") === heldA,
        priceA: read(heldA.$price),
      })),
    ).toEqual({ keys: ["a", "c"], sameA: true, priceA: 10 });
    expect(untracked(realm, (read) => [read(book.$quotes.keys), read(heldA.$price)])).toEqual([
      ["a", "b"],
      1,
    ]);
    applyStage(stage);
    expect(
      untracked(realm, (read) => [
        read(book.$quotes.keys),
        read.row(book.$quotes, "a") === heldA,
        read(heldA.$price),
      ]),
    ).toEqual([["a", "c"], true, 10]);
  });

  test("upsert merges a refetched model into the held one through the stage, and dropping leaves it", () => {
    using realm = testRealm();
    const book = decode(realm, Book)({ quotes: quotesJson(["a", 1]) });
    const fresh = Quote.make({ id: "a", symbol: "A", price: 5, realm });
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write.upsert(book.$quotes, fresh);
    });
    const heldA = untracked(realm, (read) => read.row(book.$quotes, "a")) as Quote;
    expect(stageRead(stage, (read) => read(heldA.$price))).toBe(5);
    dropStage(stage);
    expect(untracked(realm, (read) => read(heldA.$price))).toBe(1);
  });

  test("reconcileSchema inside a recipe merges into the stage", () => {
    using realm = testRealm();
    const decodeQuotes = decode(realm, Schema.Array(Quote));
    const $list = schemaBox(realm, Schema.Array(Quote), decodeQuotes(quotesJson(["a", 1])));
    const held = untracked(realm, (read) => read($list)[0]) as Quote;
    const next = decodeQuotes(quotesJson(["a", 7]));
    const stage = openStage(realm);
    stageUpdate(stage, (read, write) => {
      write($list, reconcileSchema(read($list), next, { keyOf: (quote) => quote.id }));
    });
    expect(stageRead(stage, (read) => [read($list)[0] === held, read(held.$price)])).toEqual([
      true,
      7,
    ]);
    expect(untracked(realm, (read) => read(held.$price))).toBe(1);
    applyStage(stage);
    expect(untracked(realm, (read) => [read($list)[0] === held, read(held.$price)])).toEqual([
      true,
      7,
    ]);
  });

  test("decoding inside a recipe throws: the replay would make other instances", () => {
    using realm = testRealm();
    const stage = openStage(realm);
    expect(() =>
      stageUpdate(stage, () => {
        decode(realm, Quote)({ id: "a", symbol: "A", price: 1 });
      }),
    ).toThrow("is made inside a stage recipe");
    dropStage(stage);
  });
});

describe("withStage", () => {
  test("applies the stage when the section succeeds", async () => {
    using realm = testRealm();
    const $status = box(realm, "idle");
    const $total = box(realm, 0);
    const seen: Array<ReadonlyArray<unknown>> = [];
    const result = await Effect.runPromise(
      withStage(realm, (stage) =>
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
          return "done";
        }),
      ),
    );
    expect(result).toBe("done");
    expect(seen).toEqual([["idle", 0]]);
    expect(untracked(realm, (read) => [read($status), read($total)])).toEqual(["saved", 10]);
  });

  test("drops the stage when the section fails, and the failure stands", async () => {
    using realm = testRealm();
    const $total = box(realm, 0);
    let held: Stage | undefined;
    const exit = await Effect.runPromiseExit(
      withStage(realm, (stage) => {
        held = stage;
        stageUpdate(stage, (read, write) => {
          write($total, read($total) + 5);
        });
        return Effect.fail("request failed" as const);
      }),
    );
    expect(exit).toEqual(Exit.fail("request failed"));
    expect(stageStatus(held as Stage)).toBe("dropped");
    expect(untracked(realm, (read) => read($total))).toBe(0);
  });

  test("drops the stage when the section is interrupted", async () => {
    using realm = testRealm();
    const $total = box(realm, 0);
    const started = Deferred.makeUnsafe<void>();
    const fiber = Effect.runFork(
      withStage(realm, (stage) =>
        Effect.gen(function* () {
          stageUpdate(stage, (read, write) => {
            write($total, read($total) + 7);
          });
          Deferred.doneUnsafe(started, Exit.void);
          return yield* Effect.never;
        }),
      ),
    );
    await Effect.runPromise(Deferred.await(started));
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(untracked(realm, (read) => read($total))).toBe(0);
  });

  test("a cancel seen through changes, with no RealmService, drops the stage", async () => {
    using realm = testRealm();
    const $total = box(realm, 0);
    const $cancelled = box(realm, false);
    const started = Deferred.makeUnsafe<void>();
    const fiber = Effect.runFork(
      withStage(realm, (stage) =>
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
      ),
    );
    await Effect.runPromise(Deferred.await(started));
    update(realm, (_read, write) => {
      write($cancelled, true);
    });
    expect(await Effect.runPromise(Fiber.await(fiber))).toEqual(Exit.fail("cancelled"));
    expect(untracked(realm, (read) => read($total))).toBe(0);
  });

  test("a conflict fails with StageConflict, which retry reruns over the new values", async () => {
    using realm = testRealm();
    const $price = box(realm, 10, { name: "price" });
    const $total = box(realm, 0);
    let attempts = 0;
    const section = withStage(
      realm,
      (stage) =>
        Effect.sync(() => {
          attempts++;
          stageUpdate(stage, (read, write) => {
            write($total, read($price) * 2);
          });
          if (attempts === 1) {
            // Another writer moves the price before the first attempt lands.
            update(realm, (_read, write) => {
              write($price, 11);
            });
          }
        }),
      { name: "checkout", conflicts: "fail" },
    );
    const first = await Effect.runPromiseExit(section);
    expect(Exit.isFailure(first)).toBe(true);
    const failure = Exit.isFailure(first) ? Cause.findErrorOption(first.cause) : undefined;
    expect(failure?._tag === "Some" ? failure.value : undefined).toEqual(
      new StageConflict({ stage: "checkout", changed: ["price"], observables: [$price] }),
    );
    await Effect.runPromise(section.pipe(Effect.retry({ times: 1 })));
    expect(attempts).toBe(2);
    expect(untracked(realm, (read) => read($total))).toBe(22);
    const caught = await Effect.runPromise(
      withStage(realm, () =>
        Effect.fail(new StageConflict({ stage: undefined, changed: [], observables: [] })),
      ).pipe(Effect.catchTag("StageConflict", () => Effect.succeed("caught"))),
    );
    expect(caught).toBe("caught");
  });

  test("over a stage, a section that fails and is caught leaves the parent as it was", async () => {
    using realm = testRealm();
    const $a = box(realm, 0);
    const $b = box(realm, 0);
    let attempts = 0;
    await Effect.runPromise(
      withStage(realm, (parent) =>
        Effect.gen(function* () {
          stageUpdate(parent, (_read, write) => {
            write($a, 1);
          });
          // Each attempt opens a fresh child: the failed one's write never reaches the parent.
          yield* withStage(parent, (child) =>
            Effect.suspend(() => {
              attempts++;
              stageUpdate(child, (_read, write) => {
                write($b, attempts * 100);
              });
              return attempts === 1 ? Effect.fail("flaky" as const) : Effect.void;
            }),
          ).pipe(Effect.retry({ times: 1 }));
          const failed = yield* withStage(parent, (child) => {
            stageUpdate(child, (_read, write) => {
              write($a, 99);
            });
            return Effect.fail("refused" as const);
          }).pipe(Effect.catch(() => Effect.succeed("caught")));
          expect(failed).toBe("caught");
          expect(stageRead(parent, (read) => [read($a), read($b)])).toEqual([1, 200]);
        }),
      ),
    );
    expect(untracked(realm, (read) => [read($a), read($b)])).toEqual([1, 200]);
  });

  test("a recipe that throws on replay is a defect, and the stage ends dropped", async () => {
    using realm = testRealm();
    const $a = box(realm, 1);
    let held: Stage | undefined;
    const exit = await Effect.runPromiseExit(
      withStage(realm, (stage) =>
        Effect.sync(() => {
          held = stage;
          stageUpdate(stage, (read, write) => {
            if (read($a) > 1) {
              throw new Error("moved");
            }
            write($a, 0);
          });
          update(realm, (_read, write) => {
            write($a, 2);
          });
        }),
      ),
    );
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    expect(stageStatus(held as Stage)).toBe("dropped");
    expect(untracked(realm, (read) => read($a))).toBe(2);
  });
});
