import { describe, expect, test } from "bun:test";
import { testRealm } from "@frondruntime/pinna/testing";
import { Effect, Fiber, Schema, Stream } from "effect";
import {
  Box,
  Collection,
  isPinnaError,
  Model,
  Program,
  Realm,
  Stage,
  type UpdateRecord,
  ValueRejectedError,
} from "../src/index.ts";

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
    // A schema whose answer the test changes, so a recorded value can fail it later.
    let limit = 10;
    const Limited = Schema.Number.check(
      Schema.makeFilter((value: number) => value <= limit || `above ${limit}`),
    );
    const $amount = Box.schema(realm, Limited, 1);
    const $other = Box.make(realm, 0);
    const { records, stop } = listening(realm);
    Realm.update(realm, (_read, write) => {
      write($other, 9);
      write($amount, 5);
    });
    const [record] = records as [UpdateRecord];
    Realm.update(realm, (_read, write) => write.revert(record));
    limit = 3;
    Realm.update(realm, (_read, write) => {
      expect(() => write.replay(record)).toThrow(ValueRejectedError);
    });
    Realm.untracked(realm, (read) => {
      expect(read($amount)).toBe(1);
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

describe("restore once on Effect Schema (ruling 74)", () => {
  const notApplicable = (run: () => void): void => {
    let thrown: unknown;
    try {
      run();
    } catch (error) {
      thrown = error;
    }
    expect(isPinnaError(thrown, "PinnaUsageError")).toBe(true);
    expect((thrown as { code: string }).code).toBe("pinna/record-not-applicable");
  };

  test("reverts and replays a Box.schema and a Model.boxField, each value checked as it lands", () => {
    using realm = testRealm();
    const $amount = Box.schema(realm, NonNegative, 1);
    const list = Model.decode(realm, List)(listJson);
    const { records, stop } = listening(realm);
    Realm.update(realm, (_read, write) => {
      write($amount, 4);
      write(list.$name, "Work");
    });
    const [record] = records as [UpdateRecord];
    Realm.update(realm, (_read, write) => write.revert(record));
    Realm.untracked(realm, (read) =>
      expect([read($amount), read(list.$name)]).toEqual([1, "Inbox"]),
    );
    Realm.update(realm, (_read, write) => write.replay(record));
    Realm.untracked(realm, (read) =>
      expect([read($amount), read(list.$name)]).toEqual([4, "Work"]),
    );
    stop();
  });

  test("throws pinna/record-not-applicable when a schema box moved since, and writes nothing", () => {
    using realm = testRealm();
    const $amount = Box.schema(realm, NonNegative, 1);
    const list = Model.decode(realm, List)(listJson);
    const { records, stop } = listening(realm);
    Realm.update(realm, (_read, write) => {
      write($amount, 2);
      write(list.$name, "Work");
    });
    Realm.update(realm, (_read, write) => write($amount, 3));
    notApplicable(() =>
      Realm.update(realm, (_read, write) => write.revert(records[0] as UpdateRecord)),
    );
    Realm.untracked(realm, (read) =>
      expect([read($amount), read(list.$name)]).toEqual([3, "Work"]),
    );
    stop();
  });

  test("a restore installs a model row by identity, not through its merge", () => {
    using realm = testRealm();
    const list = Model.decode(realm, List)(listJson);
    const first = Realm.untracked(realm, (read) => read.row(list.$todos, 1)) as Todo;
    const second = Model.decode(realm, Todo)({ id: 1, title: "one", done: true });
    const { records, stop } = listening(realm);
    // Another instance with the same plain fields, put in by remove and upsert.
    Realm.update(realm, (_read, write) => {
      write.remove(list.$todos, 1);
      write.upsert(list.$todos, second, { at: "end" });
    });
    Realm.update(realm, (_read, write) => write(second.$done, false));
    const [replaced, toggled] = records as [UpdateRecord, UpdateRecord];
    expect(replaced.collections[0]?.rows).toEqual([{ key: 1, before: first, after: second }]);
    const heard: Array<readonly [unknown, unknown]> = [];
    const stopLater = Collection.onRowChange(list.$todos, (change) => {
      heard.push([change.before, change.after]);
    });
    heard.length = 0;
    const state = () =>
      Realm.untracked(realm, (read) => [
        read.row(list.$todos, 1),
        read(first.$done),
        read(second.$done),
      ]);
    Realm.update(realm, (_read, write) => write.revert(toggled));
    expect(state()).toEqual([second, false, true]);
    Realm.update(realm, (_read, write) => write.revert(replaced));
    expect(state()[0]).toBe(first);
    expect(state()).toEqual([first, false, true]);
    Realm.update(realm, (_read, write) => write.replay(replaced));
    expect(state()[0]).toBe(second);
    expect(state()).toEqual([second, false, true]);
    Realm.update(realm, (_read, write) => write.replay(toggled));
    expect(state()).toEqual([second, false, false]);
    // The later listener heard each row change with the recorded objects.
    expect(heard).toHaveLength(2);
    expect(heard[0]?.[0]).toBe(second);
    expect(heard[0]?.[1]).toBe(first);
    expect(heard[1]?.[0]).toBe(first);
    expect(heard[1]?.[1]).toBe(second);
    stopLater();
    stop();
  });

  for (const [visible, at] of [
    [false, "start"],
    [true, "start"],
    [false, "end"],
    [true, "end"],
  ] as const) {
    test(`a restore in a ${visible ? "visible " : ""}stage recipe lands a model row by identity, the row put back at the ${at}`, () => {
      using realm = testRealm();
      const list = Model.decode(realm, List)(listJson);
      const first = Realm.untracked(realm, (read) => read.row(list.$todos, 1)) as Todo;
      const second = Model.decode(realm, Todo)({ id: 1, title: "one", done: false });
      const third = Model.decode(realm, Todo)({ id: 1, title: "one", done: false });
      const { records, stop } = listening(realm);
      const replace = (next: Todo, where: "start" | "end") =>
        Realm.update(realm, (_read, write) => {
          write.remove(list.$todos, 1);
          write.upsert(list.$todos, next, { at: where });
        });
      replace(second, "start");
      replace(third, at);
      const [older, newer] = records as [UpdateRecord, UpdateRecord];
      // Put back at the end, the newer record moved the order, so its
      // revert goes through `write.replaceAll`; at the start, `write.upsert`.
      expect(newer.collections[0]?.keys === undefined).toBe(at === "start");
      const row = () => Realm.untracked(realm, (read) => read.row(list.$todos, 1));
      const stage = Stage.make(realm, { name: "undo", visible });
      Stage.update(stage, (_read, write) => write.revert(newer));
      Stage.read(stage, (read) => expect(read.row(list.$todos, 1)).toBe(second));
      Stage.apply(stage);
      // The stage lands outside the restore, and the row is the record's before.
      expect(row()).toBe(second);
      Realm.update(realm, (_read, write) => write.revert(older));
      expect(row()).toBe(first);
      expect(Realm.untracked(realm, (read) => read(list.$todos.keys))).toEqual([1, 2]);
      stop();
    });
  }

  test("a row listener on a model collection stays silent on restore, and one added later runs", () => {
    using realm = testRealm();
    const list = Model.decode(realm, List)(listJson);
    const $open = Box.make(realm, 0);
    let heard = 0;
    const stopOpen = Collection.onRowChange(list.$todos, (change, read, write) => {
      heard++;
      const open = (todo: Todo | undefined) => (todo === undefined ? 0 : read(todo.$done) ? 0 : 1);
      write($open, read($open) + open(change.after) - open(change.before));
    });
    expect(Realm.untracked(realm, (read) => read($open))).toBe(1);
    const { records, stop } = listening(realm);
    const added = Model.decode(realm, Todo)({ id: 3, title: "three", done: false });
    Realm.update(realm, (_read, write) => write.upsert(list.$todos, added));
    expect(Realm.untracked(realm, (read) => read($open))).toBe(2);
    const record = records[records.length - 1] as UpdateRecord;
    heard = 0;
    let later = 0;
    const stopLater = Collection.onRowChange(list.$todos, () => {
      later++;
    });
    later = 0;
    Realm.update(realm, (_read, write) => write.revert(record));
    Realm.untracked(realm, (read) => {
      expect(read(list.$todos.keys)).toEqual([1, 2]);
      expect(read($open)).toBe(1);
    });
    Realm.update(realm, (_read, write) => write.replay(record));
    Realm.untracked(realm, (read) => {
      expect(read.row(list.$todos, 3)).toBe(added);
      expect(read($open)).toBe(2);
    });
    expect([heard, later]).toEqual([0, 2]);
    stopLater();
    stopOpen();
    stop();
  });
});
