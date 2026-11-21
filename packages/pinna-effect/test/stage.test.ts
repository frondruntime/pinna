import { describe, expect, test } from "bun:test";
import { held, testRealm } from "@frondruntime/pinna/testing";
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect";
import {
  applyStage,
  BoxField,
  box,
  CollectionField,
  changes,
  computed,
  decode,
  dropStage,
  onRowChange,
  openStage,
  type Read,
  type Recipe,
  reconcileSchema,
  SchemaModel,
  type Stage,
  StageConflict,
  StageConflictError,
  type StageOptions,
  schemaBox,
  schemaCollection,
  stageRead,
  stageStatus,
  stageUpdate,
  untracked,
  update,
  watch,
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

class MergeRow extends SchemaModel<MergeRow>("MergeRow")({
  id: Schema.String,
  $price: BoxField(NonNegative),
  $items: CollectionField(Schema.Number, { keyOf: (value) => value }),
}) {}

class Basket extends SchemaModel<Basket>("Basket")({
  id: Schema.String,
  label: Schema.String,
  $items: CollectionField(Schema.Number, { keyOf: (value) => value }),
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

  // Landing compares the held row with the staged one through the field
  // codecs, which read; a plain field that differs replaces the row.
  for (const over of ["realm", "child"] as const) {
    test(`upsert of a model whose plain field differs replaces the held row on apply (${over})`, () => {
      using realm = testRealm();
      const quotes = schemaCollection(realm, Quote, { keyOf: (quote) => quote.id });
      const baskets = schemaCollection(realm, Basket, { keyOf: (basket) => basket.id });
      const heldQuote = Quote.make({ id: "a", symbol: "A", price: 1, realm });
      const heldBasket = Basket.make({ id: "a", label: "old", items: [1], realm });
      update(realm, (_read, write) => {
        write.upsert(quotes, heldQuote);
        write.upsert(baskets, heldBasket);
      });
      const freshQuote = Quote.make({ id: "a", symbol: "RENAMED", price: 2, realm });
      const freshBasket = Basket.make({ id: "a", label: "new", items: [2], realm });
      const root = openStage(realm);
      const stage = over === "child" ? openStage(root) : root;
      stageUpdate(stage, (_read, write) => {
        write.upsert(quotes, freshQuote);
        write.upsert(baskets, freshBasket);
      });
      if (over === "child") applyStage(stage);
      applyStage(root);
      expect(stageStatus(root)).toBe("applied");
      expect(untracked(realm, (read) => [read.row(quotes, "a"), read.row(baskets, "a")])).toEqual([
        freshQuote,
        freshBasket,
      ]);
    });
  }

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

for (const entry of ["reconcileSchema", "write.upsert"] as const) {
  describe(`${entry} through a stage`, () => {
    for (const destination of ["realm", "parent"] as const) {
      test(`reads incoming staged fields across recipes and applies through the ${destination}`, () => {
        using realm = testRealm();
        const previous = MergeRow.make({ realm, id: "a", price: 0, items: [] });
        const fresh = MergeRow.make({ realm, id: "a", price: 10, items: [1] });
        const $rows = schemaCollection(realm, MergeRow, { keyOf: (row) => row.id });
        update(realm, (_read, write) => write.upsert($rows, previous));
        const parent = openStage(realm);
        using _parent = held(() => dropStage(parent));
        const stage = destination === "parent" ? openStage(parent) : parent;
        stageUpdate(parent, (_read, write) => {
          write(fresh.$price, 20);
          write.replaceAll(fresh.$items, [2]);
        });
        stageUpdate(stage, (_read, write) => {
          if (entry === "reconcileSchema") {
            expect(reconcileSchema([previous], [fresh], { keyOf: (row) => row.id })).toEqual([
              previous,
            ]);
          } else {
            write.upsert($rows, fresh);
          }
        });
        const inspect = (read: Read) => [
          read(previous.$price),
          read(previous.$items.rows),
          read.row($rows, "a") === previous,
        ];
        const preview = stageRead(stage, inspect);
        expect(untracked(realm, inspect)).toEqual([0, [], true]);
        applyStage(stage);
        if (destination === "parent") {
          expect(stageRead(parent, inspect)).toEqual([20, [2], true]);
          expect(untracked(realm, inspect)).toEqual([0, [], true]);
          applyStage(parent);
        }
        expect(untracked(realm, inspect)).toEqual([20, [2], true]);
        expect(preview).toEqual([20, [2], true]);
      });
    }

    for (const field of ["box", "collection", "copied collection"] as const) {
      test(`conflicts when the incoming ${field} changes after the merge`, () => {
        using realm = testRealm();
        const previous = MergeRow.make({ realm, id: "a", price: 0, items: [] });
        const fresh = MergeRow.make({ realm, id: "a", price: 10, items: [1] });
        const $rows = schemaCollection(realm, MergeRow, { keyOf: (row) => row.id });
        update(realm, (_read, write) => write.upsert($rows, previous));
        const stage = openStage(realm, { conflicts: "fail" });
        using _stage = held(() => dropStage(stage));
        if (field === "copied collection") {
          stageUpdate(stage, (_read, write) => write.upsert(fresh.$items, 2));
        }
        stageUpdate(stage, (_read, write) => {
          if (entry === "reconcileSchema") {
            reconcileSchema([previous], [fresh], { keyOf: (row) => row.id });
          } else {
            write.upsert($rows, fresh);
          }
        });
        update(realm, (_read, write) => {
          if (field === "box") {
            write(fresh.$price, 99);
          } else {
            write.replaceAll(fresh.$items, [99]);
          }
        });
        expect(() => applyStage(stage)).toThrow(StageConflictError);
        expect(stageStatus(stage)).toBe("dropped");
        expect(
          untracked(realm, (read) => [read(previous.$price), read(previous.$items.rows)]),
        ).toEqual([0, []]);
      });
    }

    test("reads incoming writes and collection order in an ordinary update", () => {
      using realm = testRealm();
      const previous = MergeRow.make({ realm, id: "a", price: 0, items: [] });
      const fresh = MergeRow.make({ realm, id: "a", price: 10, items: [1] });
      const $rows = schemaCollection(realm, MergeRow, { keyOf: (row) => row.id });
      update(realm, (_read, write) => {
        write.upsert($rows, previous);
        write(fresh.$price, 20);
        write.replaceAll(fresh.$items, [3, 2]);
        if (entry === "reconcileSchema") {
          reconcileSchema([previous], [fresh], { keyOf: (row) => row.id });
        } else {
          write.upsert($rows, fresh);
        }
      });
      expect(
        untracked(realm, (read) => [read(previous.$price), read(previous.$items.rows)]),
      ).toEqual([20, [3, 2]]);
    });

    for (const nested of [false, true]) {
      test(`a caught merge failure restores fields and decisions${nested ? " after a listener catches a failed write" : ""}`, () => {
        using realm = testRealm();
        const previous = MergeRow.make({ realm, id: "a", price: 0, items: [] });
        const fresh = MergeRow.make({ realm, id: "a", price: 10, items: [1] });
        const $rows = schemaCollection(realm, MergeRow, { keyOf: (row) => row.id });
        const $nested = schemaCollection(realm, Schema.Number, { keyOf: (value) => value });
        const $listener = box(realm, 0);
        const $nestedListener = box(realm, 0);
        const $earlier = box(realm, 0);
        const $decision = box(realm, false);
        const $total = computed(
          realm,
          (read) =>
            read(previous.$price) +
            read(previous.$items.rows).length +
            read($listener) +
            read($nestedListener) +
            read($nested.rows).length,
        );
        const innerFailure = new Error("inner refused");
        const outerFailure = new Error("merge refused");
        const innerReads: Array<ReadonlyArray<unknown>> = [];
        const caught: Array<unknown> = [];
        update(realm, (_read, write) => write.upsert($rows, previous));
        using _nested = held(
          onRowChange($nested, (_change, read, write) => {
            write($nestedListener, 99);
            read($total);
            throw innerFailure;
          }),
        );
        using _listener = held(
          onRowChange(previous.$items, (_change, read, write) => {
            write($listener, 1);
            if (nested) {
              try {
                write.upsert($nested, 1);
              } catch (error) {
                expect(error).toBe(innerFailure);
              }
              innerReads.push([
                read($nested.rows),
                read($nestedListener),
                read($listener),
                read($total),
              ]);
            }
            read($total);
            throw outerFailure;
          }),
        );
        const stage = openStage(realm);
        using _stage = held(() => dropStage(stage));
        stageUpdate(stage, (read, write) => {
          write($earlier, 7);
          write(previous.$price, 3);
          try {
            if (entry === "reconcileSchema") {
              reconcileSchema([previous], [fresh], { keyOf: (row) => row.id });
            } else {
              write.upsert($rows, fresh);
            }
          } catch (error) {
            caught.push(error);
          }
          write($decision, read($total) !== 3);
        });
        const inspect = (read: Read) => [
          read(previous.$price),
          read(previous.$items.rows),
          read($listener),
          read($nestedListener),
          read($nested.rows),
          read($earlier),
          read($total),
        ];
        const preview = stageRead(stage, inspect);
        const decision = stageRead(stage, (read) => read($decision));
        stageUpdate(stage, (_read, write) => write($decision, decision));
        expect(untracked(realm, inspect)).toEqual([0, [], 0, 0, [], 0, 0]);
        applyStage(stage);
        expect(caught).toEqual([outerFailure, outerFailure]);
        expect(innerReads).toEqual(
          nested
            ? [
                [[], 0, 1, 12],
                [[], 0, 1, 12],
              ]
            : [],
        );
        expect(untracked(realm, inspect)).toEqual([3, [], 0, 0, [], 7, 3]);
        expect(preview).toEqual([3, [], 0, 0, [], 7, 3]);
        expect(untracked(realm, (read) => read($decision))).toBe(false);
        expect(decision).toBe(false);
      });
    }
  });
}

describe("withStage", () => {
  test("interruption during landing leaves the stage applied and the exit interrupted", async () => {
    using realm = testRealm();
    const value = box(realm, 0);
    const started = Deferred.makeUnsafe<void>();
    const gate = Deferred.makeUnsafe<void>();
    let kept!: Stage;
    const fiber = Effect.runFork(
      withStage(realm, (stage) =>
        Effect.gen(function* () {
          kept = stage;
          stageUpdate(stage, (_read, write) => write(value, 1));
          Deferred.doneUnsafe(started, Exit.void);
          yield* Deferred.await(gate);
          return "landed";
        }),
      ),
    );
    await Effect.runPromise(Deferred.await(started));
    using _watch = held(
      watch(
        realm,
        (read) => read(value),
        () => {
          Effect.runFork(Fiber.interrupt(fiber));
        },
      ),
    );
    await Effect.runPromise(Deferred.succeed(gate, undefined));
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(stageStatus(kept)).toBe("applied");
    expect(untracked(realm, (read) => read(value))).toBe(1);
  });

  test("child options exclude conflicts at the type boundary", () => {
    using realm = testRealm();
    const parent = openStage(realm);
    using _parent = held(() => dropStage(parent));
    const root: Effect.Effect<number, StageConflict> = withStage(realm, () => Effect.succeed(1), {
      name: "root",
      conflicts: "fail",
    });
    const child: Effect.Effect<number, StageConflict> = withStage(parent, () => Effect.succeed(2), {
      name: "child",
    });
    // @ts-expect-error A child inherits the root's conflicts option.
    withStage(parent, () => Effect.void, { conflicts: "fail" });
    const options: StageOptions = { name: "child", conflicts: "fail" };
    // @ts-expect-error A named options variable cannot override the root either.
    withStage(parent, () => Effect.void, options);
    expect(Effect.runSync(root)).toBe(1);
    expect(Effect.runSync(child)).toBe(2);
  });

  test("release preserves dropped status after an enclosing update rolls back", () => {
    using realm = testRealm();
    const value = box(realm, 0);
    let kept!: Stage;
    expect(() =>
      update(realm, () => {
        Effect.runSync(
          withStage(realm, (stage) =>
            Effect.sync(() => {
              kept = stage;
              stageUpdate(stage, (_read, write) => write(value, 1));
            }),
          ),
        );
        throw new Error("host rollback");
      }),
    ).toThrow("host rollback");
    expect(untracked(realm, (read) => read(value))).toBe(0);
    expect(stageStatus(kept)).toBe("dropped");
    dropStage(kept);
    expect(stageStatus(kept)).toBe("dropped");
  });

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

describe("root replay schema differential", () => {
  for (const entry of ["upsert", "replaceAll", "reconcileSchema"] as const) {
    test(`${entry} merges match ordinary updates, listeners, watchers, and conflicts`, () => {
      const run = (staged: boolean) => {
        using realm = testRealm();
        const previous = MergeRow.make({ realm, id: "a", price: 1, items: [1] });
        const fresh = MergeRow.make({ realm, id: "a", price: 8, items: [2, 3] });
        const rows = schemaCollection(realm, MergeRow, { keyOf: (row) => row.id });
        update(realm, (_read, write) => write.upsert(rows, previous));
        const log: unknown[] = [];
        using _listener = held(
          onRowChange(previous.$items, (change) => {
            log.push(change);
          }),
        );
        const snapshot = (read: Read) => [
          read(previous.$price),
          read(previous.$items.rows),
          read(rows.keys),
          read.row(rows, "a") === previous,
        ];
        const seen: unknown[] = [];
        using _watcher = held(
          watch(realm, snapshot, (value) => {
            seen.push(value);
          }),
        );
        const conflict = openStage(realm, { conflicts: "fail" });
        stageRead(conflict, snapshot);
        const recipes: ReadonlyArray<Recipe> = [
          (_read, write) => write(fresh.$price, 12),
          (_read, write) => {
            if (entry === "upsert") write.upsert(rows, fresh);
            else if (entry === "replaceAll") write.replaceAll(rows, [fresh]);
            else reconcileSchema([previous], [fresh], { keyOf: (row) => row.id });
          },
        ];
        log.length = 0;
        if (staged) {
          const stage = openStage(realm);
          for (const recipe of recipes) stageUpdate(stage, recipe);
          const stagedLog = [...log];
          log.length = 0;
          applyStage(stage);
          expect(log).toEqual(stagedLog);
        } else {
          update(realm, () => {
            for (const recipe of recipes) update(realm, recipe);
          });
        }
        expect(() => applyStage(conflict)).toThrow(StageConflictError);
        return { state: untracked(realm, snapshot), log, seen, status: stageStatus(conflict) };
      };
      expect(run(true)).toEqual(run(false));
    });
  }

  test("replay schema rejection matches update and preserves the caller's own write", () => {
    using realm = testRealm();
    const value = schemaBox(realm, NonNegative, 5);
    const own = box(realm, 0);
    const recipe: Recipe = (read, write) => write(value, read(value) - 3);
    const stage = openStage(realm);
    stageUpdate(stage, recipe);
    update(realm, (_read, write) => write(value, 1));
    const failure = (run: () => void) => {
      try {
        run();
      } catch (error) {
        return (error as Error).message;
      }
      return undefined;
    };
    const expected = failure(() => update(realm, recipe));
    update(realm, (_read, write) => {
      write(own, 7);
      expect(failure(() => applyStage(stage))).toBe(expected);
    });
    expect(expected).toContain("the box rejects this value");
    expect(untracked(realm, (read) => [read(value), read(own)])).toEqual([1, 7]);
    expect(stageStatus(stage)).toBe("dropped");
  });

  test("a replay-only schema check cannot start an update", () => {
    using realm = testRealm();
    let replay = false;
    let callbacks = 0;
    const schema = Schema.Number.check(
      Schema.makeFilter(() => {
        if (replay)
          update(realm, () => {
            callbacks++;
          });
        return true;
      }),
    );
    const value = schemaBox(realm, schema, 0);
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => write(value, 1));
    replay = true;
    expect(() => applyStage(stage)).toThrow();
    expect(callbacks).toBe(0);
    expect(stageStatus(stage)).toBe("dropped");
    expect(untracked(realm, (read) => read(value))).toBe(0);
  });
});

test("withStage releases a stage and its child after an apply precondition defect", async () => {
  using realm = testRealm();
  let parent: Stage | undefined;
  let child: Stage | undefined;
  const exit = await Effect.runPromiseExit(
    withStage(realm, (stage) =>
      Effect.sync(() => {
        parent = stage;
        child = openStage(stage);
      }),
    ),
  );
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
  expect(stageStatus(parent as Stage)).toBe("dropped");
  expect(stageStatus(child as Stage)).toBe("dropped");
});

test("schema checks run for staged writes and replay, without an extra check on landing", () => {
  using realm = testRealm();
  let checks = 0;
  const schema = Schema.Number.check(
    Schema.makeFilter(() => {
      checks++;
      return true;
    }),
  );
  const value = schemaBox(realm, schema, 0);
  const stage = openStage(realm);
  stageUpdate(stage, (_read, write) => {
    write(value, 1);
    write(value, 2);
  });
  expect(checks).toBe(3);
  applyStage(stage);
  expect(checks).toBe(5);
  expect(untracked(realm, (read) => read(value))).toBe(2);
});
