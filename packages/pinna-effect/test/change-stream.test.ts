import { describe, expect, test } from "bun:test";
import { testRealm } from "@frondruntime/pinna/testing";
import { Effect, Fiber, Schema, Stream } from "effect";
import { Box, Model, Program, Realm, type UpdateRecord, ValueRejectedError } from "../src/index.ts";

/**
 * The change stream on Effect Schema (ruling 69): `Program.updates` streams
 * every record, and a schema box, a `Model.boxField`, a model collection,
 * and `Model.restore` record as the writes they make.
 */

const settle = Effect.sleep("5 millis");

const NonNegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

class Todo extends Model.Schema<Todo>("Todo")({
  id: Schema.Number,
  title: Schema.String,
  $done: Model.boxField(Schema.Boolean),
}) {}

class List extends Model.Schema<List>("List")({
  id: Schema.String,
  $name: Model.boxField(Schema.String),
  $todos: Model.collectionField(Todo, { keyOf: (todo) => todo.id }),
}) {}

const listJson = {
  id: "inbox",
  name: "Inbox",
  todos: [
    { id: 1, title: "one", done: false },
    { id: 2, title: "two", done: true },
  ],
};

const listening = (realm: Realm) => {
  const records: Array<UpdateRecord> = [];
  const stop = Realm.onUpdate(realm, (record) => {
    records.push(record);
  });
  return { records, stop };
};

describe("Program.updates", () => {
  test("streams every record, in order, and requires nothing", async () => {
    const realm = Realm.make();
    const $count = Box.make(realm, 0);
    const stream: Stream.Stream<UpdateRecord> = Program.updates(realm);
    const records = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* stream.pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
        yield* settle;
        for (const value of [1, 2, 3]) {
          Realm.update(realm, (_read, write) => write($count, value), { name: `set ${value}` });
        }
        return yield* Fiber.join(fiber);
      }),
    );
    expect([...records].map((record) => record.name)).toEqual(["set 1", "set 2", "set 3"]);
    expect([...records].map((record) => record.boxes[0]?.after)).toEqual([1, 2, 3]);
    Realm.dispose(realm);
  });

  test("keeps every record for a consumer that falls behind", async () => {
    const realm = Realm.make();
    const $count = Box.make(realm, 0);
    const records = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Program.updates(realm).pipe(
          Stream.mapEffect((record) => Effect.as(Effect.sleep("1 millis"), record)),
          Stream.take(50),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* settle;
        for (let value = 1; value <= 50; value++) {
          Realm.update(realm, (_read, write) => write($count, value));
        }
        return yield* Fiber.join(fiber);
      }),
    );
    expect(records).toHaveLength(50);
    expect([...records].map((record) => record.boxes[0]?.after)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    );
    Realm.dispose(realm);
  });

  test("ends when the realm is disposed, and its listener stops with the stream", async () => {
    const realm = Realm.make();
    const $count = Box.make(realm, 0);
    const records = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Program.updates(realm).pipe(Stream.runCollect, Effect.forkChild);
        yield* settle;
        Realm.update(realm, (_read, write) => write($count, 1));
        Realm.dispose(realm);
        return yield* Fiber.join(fiber);
      }),
    );
    expect(records).toHaveLength(1);
  });

  test("stops its listener when the stream is interrupted, so testRealm finds nothing running", async () => {
    using realm = testRealm();
    const $count = Box.make(realm, 0);
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Program.updates(realm).pipe(Stream.runDrain, Effect.forkChild);
        yield* settle;
        Realm.update(realm, (_read, write) => write($count, 1));
        yield* Fiber.interrupt(fiber);
      }),
    );
  });
});

describe("Realm.onUpdate on Effect Schema", () => {
  test("records a Box.schema write, and a rejected write makes no record", () => {
    using realm = testRealm();
    const $amount = Box.schema(realm, NonNegative, 1);
    const { records, stop } = listening(realm);
    Realm.update(realm, (_read, write) => write($amount, 2));
    expect(() => Realm.update(realm, (_read, write) => write($amount, -1))).toThrow(
      ValueRejectedError,
    );
    expect(records).toHaveLength(1);
    expect((records[0] as UpdateRecord).boxes).toEqual([{ box: $amount, before: 1, after: 2 }]);
    stop();
  });

  test("checks a replayed value through the schema, and puts back what it wrote", () => {
    using realm = testRealm();
    const $amount = Box.schema(realm, NonNegative, 1);
    const $other = Box.make(realm, 0);
    const { records, stop } = listening(realm);
    Realm.update(realm, (_read, write) => write($amount, 2));
    const forged: UpdateRecord = {
      ...(records[0] as UpdateRecord),
      boxes: [
        { box: $other, before: 0, after: 9 },
        { box: $amount, before: 2, after: -5 },
      ],
    };
    Realm.update(realm, (_read, write) => {
      expect(() => write.replay(forged)).toThrow(ValueRejectedError);
    });
    Realm.untracked(realm, (read) => {
      expect(read($amount)).toBe(2);
      expect(read($other)).toBe(0);
    });
    stop();
  });

  test("records a Model.boxField as its box, and a model collection's merged row as its fields alone", () => {
    using realm = testRealm();
    const list = Model.decode(realm, List)(listJson);
    const first = Realm.untracked(realm, (read) => read.row(list.$todos, 1)) as Todo;
    const { records, stop } = listening(realm);
    Model.restore(realm, List)(list, {
      ...listJson,
      name: "Restored",
      todos: [
        { id: 1, title: "one", done: true },
        { id: 7, title: "seven", done: false },
      ],
    });
    expect(records).toHaveLength(1);
    const [record] = records as [UpdateRecord];
    expect(record.boxes).toEqual([
      { box: list.$name, before: "Inbox", after: "Restored" },
      { box: first.$done, before: false, after: true },
    ]);
    expect(record.collections).toHaveLength(1);
    const change = record.collections[0];
    expect(change?.collection).toBe(list.$todos);
    expect(change?.keys).toEqual({ before: [1, 2], after: [1, 7] });
    expect(
      change?.rows.map((row) => [row.key, row.before === undefined, row.after === undefined]),
    ).toEqual([
      [2, false, true],
      [7, true, false],
    ]);
    // Undo the restore: the merged row's field and the removed model come back.
    Realm.update(realm, (_read, write) => write.revert(record));
    Realm.untracked(realm, (read) => {
      expect(read(list.$name)).toBe("Inbox");
      expect(read(first.$done)).toBe(false);
      expect(read(list.$todos.keys)).toEqual([1, 2]);
      expect(read.row(list.$todos, 1)).toBe(first);
    });
    stop();
  });
});
