import { describe, expect, test } from "bun:test";
import { held, testRealm } from "@frondruntime/pinna/testing";
import { Deferred, Effect, Schema } from "effect";
import { isPinnaError, Model, Program, Realm, Source, View } from "../src/index.ts";

/**
 * Views (ruling 63), `Model.restore` (ruling 64), and `Program.fromEffect`
 * (ruling 65) on the same `Model.Schema` state. Each feature's own file tests
 * it alone; this file tests what one feature does to another.
 */

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    if (isPinnaError(error, "PinnaUsageError")) {
      return error.code;
    }
    throw error;
  }
  return undefined;
};

/** Long enough for forked fibers to run what they were handed. */
const settle = Effect.sleep("5 millis");

class Task extends Model.Schema<Task>("TogetherTask")({
  id: Schema.Number,
  title: Schema.String,
  $rank: Model.boxField(Schema.Number),
}) {}

class Board extends Model.Schema<Board>("TogetherBoard")({
  id: Schema.String,
  $tasks: Model.collectionField(Task, { keyOf: (task) => task.id }),
}) {}

const boardJson = {
  id: "board",
  tasks: [
    { id: 1, title: "one", rank: 3 },
    { id: 2, title: "two", rank: 1 },
  ],
};

describe("a view over a Model.Schema collection that Model.restore writes", () => {
  test("follows the rows a restore adds and removes, and keeps held rows in place", () => {
    using realm = testRealm();
    const board = Model.decode(realm, Board)(boardJson);
    const view = View.ordered(board.$tasks, { compare: () => (left, right) => left.id - right.id });
    using _ = held(() => View.dispose(view));
    const first = Realm.untracked(realm, (read) => read.row(board.$tasks, 1));
    Model.restore(realm, Board)(board, {
      id: "board",
      tasks: [
        { id: 3, title: "three", rank: 0 },
        { id: 1, title: "one", rank: 9 },
      ],
    });
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual([1, 3]);
    expect(Realm.untracked(realm, (read) => read.row(board.$tasks, 1))).toBe(first as Task);
  });

  test("a restore inside an update that throws leaves the view as it was", () => {
    using realm = testRealm();
    const board = Model.decode(realm, Board)(boardJson);
    const view = View.ordered(board.$tasks, { compare: () => (left, right) => left.id - right.id });
    using _ = held(() => View.dispose(view));
    expect(() =>
      Realm.update(realm, () => {
        Model.restore(realm, Board)(board, { id: "board", tasks: [] });
        throw new Error("after the restore");
      }),
    ).toThrow("after the restore");
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual([1, 2]);
  });
});

describe("Program.fromEffect beside views and snapshots", () => {
  test("a snapshot refuses a value from an Effect, as any computed value", async () => {
    using realm = testRealm();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const $remote = yield* Program.fromEffect(realm, Effect.succeed(1), 0);
          expect(codeOf(() => Realm.untracked(realm, (read) => read.snapshot({ $remote })))).toBe(
            "pinna/snapshot-not-state",
          );
        }),
      ),
    );
  });

  test("a scoped view whose filter reads a value from an Effect rebuilds when it succeeds, and the scope disposes the view", async () => {
    const realm = Realm.make();
    const board = Model.decode(realm, Board)(boardJson);
    const view = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const done = yield* Deferred.make<number>();
          const $least = yield* Program.fromEffect(realm, Deferred.await(done), 0);
          const ordered = yield* View.orderedScoped(board.$tasks, {
            compare: () => (left, right) => left.id - right.id,
            filter: (read) => {
              const least = read($least);
              return (task) => task.id > least;
            },
          });
          const release = Source.observe(ordered.keys);
          yield* settle;
          expect(Realm.untracked(realm, (read) => read(ordered.keys))).toEqual([1, 2]);
          yield* Deferred.succeed(done, 1);
          yield* settle;
          expect(Realm.untracked(realm, (read) => read(ordered.keys))).toEqual([2]);
          release();
          return ordered;
        }),
      ),
    );
    expect(View.status(view)).toBe("disposed");
    Realm.dispose(realm);
  });
});
