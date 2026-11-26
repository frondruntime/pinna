import { describe, expect, test } from "bun:test";
import { held, testRealm } from "@frondruntime/pinna/testing";
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect";
import {
  Box,
  Collection,
  Computed,
  Model,
  Program,
  type Read,
  Realm,
  Stage,
  StageConflictError,
  type StageOptions,
  type UpdateRecipe,
} from "../src/index.ts";

/**
 * Stages over schema boxes and `Model.Schema`s, and `Stage.scoped`, which holds
 * an Effect program's writes until it succeeds (`docs/api.md`, ruling 53).
 */

const NonNegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

class Quote extends Model.Schema<Quote>("Quote")({
  id: Schema.String,
  symbol: Schema.String,
  $price: Model.boxField(NonNegative),
}) {}

class Book extends Model.Schema<Book>("Book")({
  $quotes: Model.collectionField(Quote, { keyOf: (quote) => quote.id }),
}) {}

class MergeRow extends Model.Schema<MergeRow>("MergeRow")({
  id: Schema.String,
  $price: Model.boxField(NonNegative),
  $items: Model.collectionField(Schema.Number, { keyOf: (value) => value }),
}) {}

class Basket extends Model.Schema<Basket>("Basket")({
  id: Schema.String,
  label: Schema.String,
  $items: Model.collectionField(Schema.Number, { keyOf: (value) => value }),
}) {}

const quotesJson = (...quotes: ReadonlyArray<readonly [string, number]>) =>
  quotes.map(([id, price]) => ({ id, symbol: id.toUpperCase(), price }));

describe("a schema box through a stage", () => {
  test("a refused value throws at stageUpdate, where the work wrote it", () => {
    using realm = testRealm();
    const $held = Box.schema(realm, NonNegative, 1);
    const stage = Stage.make(realm);
    expect(() =>
      Stage.update(stage, (_read, write) => {
        write($held, -1);
      }),
    ).toThrow("pinna: the box rejects this value");
    expect(Stage.read(stage, (read) => read($held))).toBe(1);
    Stage.drop(stage);
  });

  test("a value refused on replay throws at applyStage and rolls back the stage's writes", () => {
    using realm = testRealm();
    const $held = Box.schema(realm, NonNegative, 5);
    const $own = Box.make(realm, 0);
    const stage = Stage.make(realm);
    Stage.update(stage, (read, write) => {
      write($held, read($held) - 3);
    });
    expect(Stage.read(stage, (read) => read($held))).toBe(2);
    Realm.update(realm, (_read, write) => {
      write($held, 1);
    });
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write($own, 1);
        Stage.apply(stage);
      }),
    ).toThrow("pinna: the box rejects this value");
    expect(Realm.untracked(realm, (read) => [read($held), read($own)])).toEqual([1, 0]);
    expect(Stage.status(stage)).toBe("dropped");
  });
});

describe("a refetch through a stage", () => {
  test("replaceAll merges into the held models: the stage reads the new prices, the realm keeps its own", () => {
    using realm = testRealm();
    const book = Model.decode(realm, Book)({ quotes: quotesJson(["a", 1], ["b", 2]) });
    const heldA = Realm.untracked(realm, (read) => read.row(book.$quotes, "a")) as Quote;
    // Decoded outside the recipe: the recipe runs twice, and would make two.
    const fresh = Model.decode(realm, Book)({ quotes: quotesJson(["a", 10], ["c", 3]) });
    const rows = Realm.untracked(realm, (read) => read(fresh.$quotes.rows));
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write.replaceAll(book.$quotes, rows);
    });
    expect(
      Stage.read(stage, (read) => ({
        keys: read(book.$quotes.keys),
        sameA: read.row(book.$quotes, "a") === heldA,
        priceA: read(heldA.$price),
      })),
    ).toEqual({ keys: ["a", "c"], sameA: true, priceA: 10 });
    expect(Realm.untracked(realm, (read) => [read(book.$quotes.keys), read(heldA.$price)])).toEqual(
      [["a", "b"], 1],
    );
    Stage.apply(stage);
    expect(
      Realm.untracked(realm, (read) => [
        read(book.$quotes.keys),
        read.row(book.$quotes, "a") === heldA,
        read(heldA.$price),
      ]),
    ).toEqual([["a", "c"], true, 10]);
  });

  test("upsert merges a refetched model into the held one through the stage, and dropping leaves it", () => {
    using realm = testRealm();
    const book = Model.decode(realm, Book)({ quotes: quotesJson(["a", 1]) });
    const fresh = Quote.make({ id: "a", symbol: "A", price: 5, realm });
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write.upsert(book.$quotes, fresh);
    });
    const heldA = Realm.untracked(realm, (read) => read.row(book.$quotes, "a")) as Quote;
    expect(Stage.read(stage, (read) => read(heldA.$price))).toBe(5);
    Stage.drop(stage);
    expect(Realm.untracked(realm, (read) => read(heldA.$price))).toBe(1);
  });

  // Landing compares the held row with the staged one through the field
  // codecs, which read; a plain field that differs replaces the row.
  for (const over of ["realm", "child"] as const) {
    test(`upsert of a model whose plain field differs replaces the held row on apply (${over})`, () => {
      using realm = testRealm();
      const quotes = Collection.schema(realm, Quote, { keyOf: (quote) => quote.id });
      const baskets = Collection.schema(realm, Basket, { keyOf: (basket) => basket.id });
      const heldQuote = Quote.make({ id: "a", symbol: "A", price: 1, realm });
      const heldBasket = Basket.make({ id: "a", label: "old", items: [1], realm });
      Realm.update(realm, (_read, write) => {
        write.upsert(quotes, heldQuote);
        write.upsert(baskets, heldBasket);
      });
      const freshQuote = Quote.make({ id: "a", symbol: "RENAMED", price: 2, realm });
      const freshBasket = Basket.make({ id: "a", label: "new", items: [2], realm });
      const root = Stage.make(realm);
      const stage = over === "child" ? Stage.make(root) : root;
      Stage.update(stage, (_read, write) => {
        write.upsert(quotes, freshQuote);
        write.upsert(baskets, freshBasket);
      });
      if (over === "child") Stage.apply(stage);
      Stage.apply(root);
      expect(Stage.status(root)).toBe("applied");
      expect(
        Realm.untracked(realm, (read) => [read.row(quotes, "a"), read.row(baskets, "a")]),
      ).toEqual([freshQuote, freshBasket]);
    });
  }

  test("reconcileSchema inside a recipe merges into the stage", () => {
    using realm = testRealm();
    const decodeQuotes = Model.decode(realm, Schema.Array(Quote));
    const $list = Box.schema(realm, Schema.Array(Quote), decodeQuotes(quotesJson(["a", 1])));
    const held = Realm.untracked(realm, (read) => read($list)[0]) as Quote;
    const next = decodeQuotes(quotesJson(["a", 7]));
    const stage = Stage.make(realm);
    Stage.update(stage, (read, write) => {
      write($list, Collection.reconcile(read($list), next, { keyOf: (quote) => quote.id }));
    });
    expect(Stage.read(stage, (read) => [read($list)[0] === held, read(held.$price)])).toEqual([
      true,
      7,
    ]);
    expect(Realm.untracked(realm, (read) => read(held.$price))).toBe(1);
    Stage.apply(stage);
    expect(Realm.untracked(realm, (read) => [read($list)[0] === held, read(held.$price)])).toEqual([
      true,
      7,
    ]);
  });

  test("decoding inside a recipe throws: the replay would make other instances", () => {
    using realm = testRealm();
    const stage = Stage.make(realm);
    expect(() =>
      Stage.update(stage, () => {
        Model.decode(realm, Quote)({ id: "a", symbol: "A", price: 1 });
      }),
    ).toThrow("is made inside a stage recipe");
    Stage.drop(stage);
  });
});

for (const entry of ["reconcileSchema", "write.upsert"] as const) {
  describe(`${entry} through a stage`, () => {
    for (const destination of ["realm", "parent"] as const) {
      test(`reads incoming staged fields across recipes and applies through the ${destination}`, () => {
        using realm = testRealm();
        const previous = MergeRow.make({ realm, id: "a", price: 0, items: [] });
        const fresh = MergeRow.make({ realm, id: "a", price: 10, items: [1] });
        const $rows = Collection.schema(realm, MergeRow, { keyOf: (row) => row.id });
        Realm.update(realm, (_read, write) => write.upsert($rows, previous));
        const parent = Stage.make(realm);
        using _parent = held(() => Stage.drop(parent));
        const stage = destination === "parent" ? Stage.make(parent) : parent;
        Stage.update(parent, (_read, write) => {
          write(fresh.$price, 20);
          write.replaceAll(fresh.$items, [2]);
        });
        Stage.update(stage, (_read, write) => {
          if (entry === "reconcileSchema") {
            expect(Collection.reconcile([previous], [fresh], { keyOf: (row) => row.id })).toEqual([
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
        const preview = Stage.read(stage, inspect);
        expect(Realm.untracked(realm, inspect)).toEqual([0, [], true]);
        Stage.apply(stage);
        if (destination === "parent") {
          expect(Stage.read(parent, inspect)).toEqual([20, [2], true]);
          expect(Realm.untracked(realm, inspect)).toEqual([0, [], true]);
          Stage.apply(parent);
        }
        expect(Realm.untracked(realm, inspect)).toEqual([20, [2], true]);
        expect(preview).toEqual([20, [2], true]);
      });
    }

    for (const field of ["box", "collection", "copied collection"] as const) {
      test(`conflicts when the incoming ${field} changes after the merge`, () => {
        using realm = testRealm();
        const previous = MergeRow.make({ realm, id: "a", price: 0, items: [] });
        const fresh = MergeRow.make({ realm, id: "a", price: 10, items: [1] });
        const $rows = Collection.schema(realm, MergeRow, { keyOf: (row) => row.id });
        Realm.update(realm, (_read, write) => write.upsert($rows, previous));
        const stage = Stage.make(realm, { conflicts: "fail" });
        using _stage = held(() => Stage.drop(stage));
        if (field === "copied collection") {
          Stage.update(stage, (_read, write) => write.upsert(fresh.$items, 2));
        }
        Stage.update(stage, (_read, write) => {
          if (entry === "reconcileSchema") {
            Collection.reconcile([previous], [fresh], { keyOf: (row) => row.id });
          } else {
            write.upsert($rows, fresh);
          }
        });
        Realm.update(realm, (_read, write) => {
          if (field === "box") {
            write(fresh.$price, 99);
          } else {
            write.replaceAll(fresh.$items, [99]);
          }
        });
        expect(() => Stage.apply(stage)).toThrow(StageConflictError);
        expect(Stage.status(stage)).toBe("dropped");
        expect(
          Realm.untracked(realm, (read) => [read(previous.$price), read(previous.$items.rows)]),
        ).toEqual([0, []]);
      });
    }

    test("reads incoming writes and collection order in an ordinary update", () => {
      using realm = testRealm();
      const previous = MergeRow.make({ realm, id: "a", price: 0, items: [] });
      const fresh = MergeRow.make({ realm, id: "a", price: 10, items: [1] });
      const $rows = Collection.schema(realm, MergeRow, { keyOf: (row) => row.id });
      Realm.update(realm, (_read, write) => {
        write.upsert($rows, previous);
        write(fresh.$price, 20);
        write.replaceAll(fresh.$items, [3, 2]);
        if (entry === "reconcileSchema") {
          Collection.reconcile([previous], [fresh], { keyOf: (row) => row.id });
        } else {
          write.upsert($rows, fresh);
        }
      });
      expect(
        Realm.untracked(realm, (read) => [read(previous.$price), read(previous.$items.rows)]),
      ).toEqual([20, [3, 2]]);
    });

    for (const nested of [false, true]) {
      test(`a caught merge failure restores fields and decisions${nested ? " after a listener catches a failed write" : ""}`, () => {
        using realm = testRealm();
        const previous = MergeRow.make({ realm, id: "a", price: 0, items: [] });
        const fresh = MergeRow.make({ realm, id: "a", price: 10, items: [1] });
        const $rows = Collection.schema(realm, MergeRow, { keyOf: (row) => row.id });
        const $nested = Collection.schema(realm, Schema.Number, { keyOf: (value) => value });
        const $listener = Box.make(realm, 0);
        const $nestedListener = Box.make(realm, 0);
        const $earlier = Box.make(realm, 0);
        const $decision = Box.make(realm, false);
        const $total = Computed.make(
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
        Realm.update(realm, (_read, write) => write.upsert($rows, previous));
        using _nested = held(
          Collection.onRowChange($nested, (_change, read, write) => {
            write($nestedListener, 99);
            read($total);
            throw innerFailure;
          }),
        );
        using _listener = held(
          Collection.onRowChange(previous.$items, (_change, read, write) => {
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
        const stage = Stage.make(realm);
        using _stage = held(() => Stage.drop(stage));
        Stage.update(stage, (read, write) => {
          write($earlier, 7);
          write(previous.$price, 3);
          try {
            if (entry === "reconcileSchema") {
              Collection.reconcile([previous], [fresh], { keyOf: (row) => row.id });
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
        const preview = Stage.read(stage, inspect);
        const decision = Stage.read(stage, (read) => read($decision));
        Stage.update(stage, (_read, write) => write($decision, decision));
        expect(Realm.untracked(realm, inspect)).toEqual([0, [], 0, 0, [], 0, 0]);
        Stage.apply(stage);
        expect(caught).toEqual([outerFailure, outerFailure]);
        expect(innerReads).toEqual(
          nested
            ? [
                [[], 0, 1, 12],
                [[], 0, 1, 12],
              ]
            : [],
        );
        expect(Realm.untracked(realm, inspect)).toEqual([3, [], 0, 0, [], 7, 3]);
        expect(preview).toEqual([3, [], 0, 0, [], 7, 3]);
        expect(Realm.untracked(realm, (read) => read($decision))).toBe(false);
        expect(decision).toBe(false);
      });
    }
  });
}

describe("withStage", () => {
  test("interruption during landing leaves the stage applied and the exit interrupted", async () => {
    using realm = testRealm();
    const value = Box.make(realm, 0);
    const started = Deferred.makeUnsafe<void>();
    const gate = Deferred.makeUnsafe<void>();
    let kept!: Stage;
    const fiber = Effect.runFork(
      Stage.scoped(realm, (stage) =>
        Effect.gen(function* () {
          kept = stage;
          Stage.update(stage, (_read, write) => write(value, 1));
          Deferred.doneUnsafe(started, Exit.void);
          yield* Deferred.await(gate);
          return "landed";
        }),
      ),
    );
    await Effect.runPromise(Deferred.await(started));
    using _watch = held(
      Realm.watch(
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
    expect(Stage.status(kept)).toBe("applied");
    expect(Realm.untracked(realm, (read) => read(value))).toBe(1);
  });

  test("child options exclude conflicts, and a child cannot fail with StageConflictError, at the type boundary", () => {
    using realm = testRealm();
    const parent = Stage.make(realm);
    using _parent = held(() => Stage.drop(parent));
    const root: Effect.Effect<number, StageConflictError> = Stage.scoped(
      realm,
      () => Effect.succeed(1),
      {
        name: "root",
        conflicts: "fail",
      },
    );
    // A child never conflicts: its root checks what it read.
    const child: Effect.Effect<number, never> = Stage.scoped(parent, () => Effect.succeed(2), {
      name: "child",
    });
    // @ts-expect-error A child inherits the root's conflicts option.
    Stage.scoped(parent, () => Effect.void, { conflicts: "fail" });
    const options: StageOptions = { name: "child", conflicts: "fail" };
    // @ts-expect-error A named options variable cannot override the root either.
    Stage.scoped(parent, () => Effect.void, options);
    expect(Effect.runSync(root)).toBe(1);
    expect(Effect.runSync(child)).toBe(2);
  });

  test("release preserves dropped status after an enclosing update rolls back", () => {
    using realm = testRealm();
    const value = Box.make(realm, 0);
    let kept!: Stage;
    expect(() =>
      Realm.update(realm, () => {
        Effect.runSync(
          Stage.scoped(realm, (stage) =>
            Effect.sync(() => {
              kept = stage;
              Stage.update(stage, (_read, write) => write(value, 1));
            }),
          ),
        );
        throw new Error("host rollback");
      }),
    ).toThrow("host rollback");
    expect(Realm.untracked(realm, (read) => read(value))).toBe(0);
    expect(Stage.status(kept)).toBe("dropped");
    Stage.drop(kept);
    expect(Stage.status(kept)).toBe("dropped");
  });

  test("applies the stage when the section succeeds", async () => {
    using realm = testRealm();
    const $status = Box.make(realm, "idle");
    const $total = Box.make(realm, 0);
    const seen: Array<ReadonlyArray<unknown>> = [];
    const result = await Effect.runPromise(
      Stage.scoped(realm, (stage) =>
        Effect.gen(function* () {
          Stage.update(stage, (_read, write) => {
            write($status, "saving");
          });
          yield* Effect.sleep("1 millis");
          seen.push(Realm.untracked(realm, (read) => [read($status), read($total)]));
          Stage.update(stage, (read, write) => {
            write($total, read($total) + 10);
            write($status, "saved");
          });
          return "done";
        }),
      ),
    );
    expect(result).toBe("done");
    expect(seen).toEqual([["idle", 0]]);
    expect(Realm.untracked(realm, (read) => [read($status), read($total)])).toEqual(["saved", 10]);
  });

  test("drops the stage when the section fails, and the failure stands", async () => {
    using realm = testRealm();
    const $total = Box.make(realm, 0);
    let held: Stage | undefined;
    const exit = await Effect.runPromiseExit(
      Stage.scoped(realm, (stage) => {
        held = stage;
        Stage.update(stage, (read, write) => {
          write($total, read($total) + 5);
        });
        return Effect.fail("request failed" as const);
      }),
    );
    expect(exit).toEqual(Exit.fail("request failed"));
    expect(Stage.status(held as Stage)).toBe("dropped");
    expect(Realm.untracked(realm, (read) => read($total))).toBe(0);
  });

  test("drops the stage when the section is interrupted", async () => {
    using realm = testRealm();
    const $total = Box.make(realm, 0);
    const started = Deferred.makeUnsafe<void>();
    const fiber = Effect.runFork(
      Stage.scoped(realm, (stage) =>
        Effect.gen(function* () {
          Stage.update(stage, (read, write) => {
            write($total, read($total) + 7);
          });
          Deferred.doneUnsafe(started, Exit.void);
          return yield* Effect.never;
        }),
      ),
    );
    await Effect.runPromise(Deferred.await(started));
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(Realm.untracked(realm, (read) => read($total))).toBe(0);
  });

  test("a cancel seen through changes, with no RealmService, drops the stage", async () => {
    using realm = testRealm();
    const $total = Box.make(realm, 0);
    const $cancelled = Box.make(realm, false);
    const started = Deferred.makeUnsafe<void>();
    const fiber = Effect.runFork(
      Stage.scoped(realm, (stage) =>
        Effect.raceFirst(
          Effect.gen(function* () {
            Stage.update(stage, (read, write) => {
              write($total, read($total) + 10);
            });
            Deferred.doneUnsafe(started, Exit.void);
            return yield* Effect.never;
          }),
          Program.changes($cancelled).pipe(
            Stream.filter(Boolean),
            Stream.runHead,
            Effect.andThen(Effect.fail("cancelled" as const)),
          ),
        ),
      ),
    );
    await Effect.runPromise(Deferred.await(started));
    Realm.update(realm, (_read, write) => {
      write($cancelled, true);
    });
    expect(await Effect.runPromise(Fiber.await(fiber))).toEqual(Exit.fail("cancelled"));
    expect(Realm.untracked(realm, (read) => read($total))).toBe(0);
  });

  test("a conflict fails with pinna's StageConflictError, which retry reruns over the new values", async () => {
    using realm = testRealm();
    const $price = Box.make(realm, 10, { name: "price" });
    const $total = Box.make(realm, 0);
    let attempts = 0;
    const section = Stage.scoped(
      realm,
      (stage) =>
        Effect.sync(() => {
          attempts++;
          Stage.update(stage, (read, write) => {
            write($total, read($price) * 2);
          });
          if (attempts === 1) {
            // Another writer moves the price before the first attempt lands.
            Realm.update(realm, (_read, write) => {
              write($price, 11);
            });
          }
        }),
      { name: "checkout", conflicts: "fail" },
    );
    const first = await Effect.runPromiseExit(section);
    expect(Exit.isFailure(first)).toBe(true);
    const failure = Exit.isFailure(first) ? Cause.findErrorOption(first.cause) : undefined;
    const conflict = failure?._tag === "Some" ? failure.value : undefined;
    expect(conflict).toBeInstanceOf(StageConflictError);
    expect(conflict).toMatchObject({
      _tag: "StageConflictError",
      stage: "checkout",
      changed: ["price"],
      observables: [$price],
    });
    await Effect.runPromise(section.pipe(Effect.retry({ times: 1 })));
    expect(attempts).toBe(2);
    expect(Realm.untracked(realm, (read) => read($total))).toBe(22);
    const caught = await Effect.runPromise(
      Stage.scoped(realm, () => Effect.fail(new StageConflictError(undefined, [], []))).pipe(
        Effect.catchTag("StageConflictError", () => Effect.succeed("caught")),
      ),
    );
    expect(caught).toBe("caught");
  });

  test("over a stage, a section that fails and is caught leaves the parent as it was", async () => {
    using realm = testRealm();
    const $a = Box.make(realm, 0);
    const $b = Box.make(realm, 0);
    let attempts = 0;
    await Effect.runPromise(
      Stage.scoped(realm, (parent) =>
        Effect.gen(function* () {
          Stage.update(parent, (_read, write) => {
            write($a, 1);
          });
          // Each attempt opens a fresh child: the failed one's write never reaches the parent.
          yield* Stage.scoped(parent, (child) =>
            Effect.suspend(() => {
              attempts++;
              Stage.update(child, (_read, write) => {
                write($b, attempts * 100);
              });
              return attempts === 1 ? Effect.fail("flaky" as const) : Effect.void;
            }),
          ).pipe(Effect.retry({ times: 1 }));
          const failed = yield* Stage.scoped(parent, (child) => {
            Stage.update(child, (_read, write) => {
              write($a, 99);
            });
            return Effect.fail("refused" as const);
          }).pipe(Effect.catch(() => Effect.succeed("caught")));
          expect(failed).toBe("caught");
          expect(Stage.read(parent, (read) => [read($a), read($b)])).toEqual([1, 200]);
        }),
      ),
    );
    expect(Realm.untracked(realm, (read) => [read($a), read($b)])).toEqual([1, 200]);
  });

  test("a recipe that throws on replay is a defect, and the stage ends dropped", async () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    let held: Stage | undefined;
    const exit = await Effect.runPromiseExit(
      Stage.scoped(realm, (stage) =>
        Effect.sync(() => {
          held = stage;
          Stage.update(stage, (read, write) => {
            if (read($a) > 1) {
              throw new Error("moved");
            }
            write($a, 0);
          });
          Realm.update(realm, (_read, write) => {
            write($a, 2);
          });
        }),
      ),
    );
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    expect(Stage.status(held as Stage)).toBe("dropped");
    expect(Realm.untracked(realm, (read) => read($a))).toBe(2);
  });
});

describe("root replay schema differential", () => {
  for (const entry of ["upsert", "replaceAll", "reconcileSchema"] as const) {
    test(`${entry} merges match ordinary updates, listeners, watchers, and conflicts`, () => {
      const run = (staged: boolean) => {
        using realm = testRealm();
        const previous = MergeRow.make({ realm, id: "a", price: 1, items: [1] });
        const fresh = MergeRow.make({ realm, id: "a", price: 8, items: [2, 3] });
        const rows = Collection.schema(realm, MergeRow, { keyOf: (row) => row.id });
        Realm.update(realm, (_read, write) => write.upsert(rows, previous));
        const log: unknown[] = [];
        using _listener = held(
          Collection.onRowChange(previous.$items, (change) => {
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
          Realm.watch(realm, snapshot, (value) => {
            seen.push(value);
          }),
        );
        const conflict = Stage.make(realm, { conflicts: "fail" });
        Stage.read(conflict, snapshot);
        const recipes: ReadonlyArray<UpdateRecipe> = [
          (_read, write) => write(fresh.$price, 12),
          (_read, write) => {
            if (entry === "upsert") write.upsert(rows, fresh);
            else if (entry === "replaceAll") write.replaceAll(rows, [fresh]);
            else Collection.reconcile([previous], [fresh], { keyOf: (row) => row.id });
          },
        ];
        log.length = 0;
        if (staged) {
          const stage = Stage.make(realm);
          for (const recipe of recipes) Stage.update(stage, recipe);
          const stagedLog = [...log];
          log.length = 0;
          Stage.apply(stage);
          expect(log).toEqual(stagedLog);
        } else {
          Realm.update(realm, () => {
            for (const recipe of recipes) Realm.update(realm, recipe);
          });
        }
        expect(() => Stage.apply(conflict)).toThrow(StageConflictError);
        return {
          state: Realm.untracked(realm, snapshot),
          log,
          seen,
          status: Stage.status(conflict),
        };
      };
      expect(run(true)).toEqual(run(false));
    });
  }

  test("replay schema rejection matches update and preserves the caller's own write", () => {
    using realm = testRealm();
    const value = Box.schema(realm, NonNegative, 5);
    const own = Box.make(realm, 0);
    const recipe: UpdateRecipe = (read, write) => write(value, read(value) - 3);
    const stage = Stage.make(realm);
    Stage.update(stage, recipe);
    Realm.update(realm, (_read, write) => write(value, 1));
    const failure = (run: () => void) => {
      try {
        run();
      } catch (error) {
        return (error as Error).message;
      }
      return undefined;
    };
    const expected = failure(() => Realm.update(realm, recipe));
    Realm.update(realm, (_read, write) => {
      write(own, 7);
      expect(failure(() => Stage.apply(stage))).toBe(expected);
    });
    expect(expected).toContain("the box rejects this value");
    expect(Realm.untracked(realm, (read) => [read(value), read(own)])).toEqual([1, 7]);
    expect(Stage.status(stage)).toBe("dropped");
  });

  test("a replay-only schema check cannot start an update", () => {
    using realm = testRealm();
    let replay = false;
    let callbacks = 0;
    const schema = Schema.Number.check(
      Schema.makeFilter(() => {
        if (replay)
          Realm.update(realm, () => {
            callbacks++;
          });
        return true;
      }),
    );
    const value = Box.schema(realm, schema, 0);
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => write(value, 1));
    replay = true;
    expect(() => Stage.apply(stage)).toThrow();
    expect(callbacks).toBe(0);
    expect(Stage.status(stage)).toBe("dropped");
    expect(Realm.untracked(realm, (read) => read(value))).toBe(0);
  });
});

test("withStage releases a stage and its child after an apply precondition defect", async () => {
  using realm = testRealm();
  let parent: Stage | undefined;
  let child: Stage | undefined;
  const exit = await Effect.runPromiseExit(
    Stage.scoped(realm, (stage) =>
      Effect.sync(() => {
        parent = stage;
        child = Stage.make(stage);
      }),
    ),
  );
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
  expect(Stage.status(parent as Stage)).toBe("dropped");
  expect(Stage.status(child as Stage)).toBe("dropped");
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
  const value = Box.schema(realm, schema, 0);
  const stage = Stage.make(realm);
  Stage.update(stage, (_read, write) => {
    write(value, 1);
    write(value, 2);
  });
  expect(checks).toBe(3);
  Stage.apply(stage);
  expect(checks).toBe(5);
  expect(Realm.untracked(realm, (read) => read(value))).toBe(2);
});

describe("Stage.scoped and a conflict thrown before the section returns its Effect", () => {
  test("fails with StageConflictError, recoverable by tag", async () => {
    const realm = Realm.make();
    const $count = Box.make(realm, 10);
    const recovered = await Effect.runPromise(
      Stage.scoped(
        realm,
        (stage) => {
          Stage.update(stage, (read, write) => {
            write($count, read($count) + 1);
          });
          Realm.update(realm, (_read, write) => {
            write($count, 20);
          });
          // The stage stopped on the conflict: this call throws it, before an Effect exists.
          Stage.update(stage, () => undefined);
          return Effect.succeed("done");
        },
        { visible: true, conflicts: "fail" },
      ).pipe(Effect.catchTag("StageConflictError", () => Effect.succeed("recovered"))),
    );
    expect(recovered).toBe("recovered");
    expect(Realm.untracked(realm, (read) => read($count))).toBe(20);
    Realm.dispose(realm);
  });
});
