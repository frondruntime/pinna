import { describe, expect, test } from "bun:test";
import { held, testRealm } from "@frondruntime/pinna/testing";
import { Context, Schema } from "effect";
import {
  Box,
  Collection,
  Computed,
  DecodeError,
  isPinnaError,
  Model,
  Realm,
  type Snapshot,
  Stage,
  ValueRejectedError,
} from "../src/index.ts";

/**
 * `read.snapshot` and `write.restore` over `Model.Schema` instances and schema
 * boxes, encoding as a tracked and staged read, and `Model.restore`
 * (ruling 64).
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
  $tags: Model.collectionField(Schema.String, { keyOf: (tag) => tag }),
}) {}

const listJson = {
  id: "inbox",
  name: "Inbox",
  todos: [
    { id: 1, title: "one", done: false },
    { id: 2, title: "two", done: true },
  ],
  tags: ["home"],
};

describe("a Model.Schema in a shape", () => {
  test("its snapshot is the wire keys, each $ field's snapshot in place of its box", () => {
    using realm = testRealm();
    const list = Model.decode(realm, List)(listJson);
    const data = Realm.untracked(realm, (read) => read.snapshot(list));
    expect(data).toEqual(listJson);
    const typed: Snapshot<List> = data;
    expect(typed.todos[1]?.done).toBe(true);
    expect(Schema.encodeSync(List)(list)).toEqual(data);
  });

  test("restores data into the same instances: a held row in place, its order the data's", () => {
    using realm = testRealm();
    const list = Model.decode(realm, List)(listJson);
    const [first, second] = Realm.untracked(realm, (read) => read(list.$todos.rows));
    Realm.update(realm, (_read, write) => {
      write.restore(list, {
        id: "inbox",
        name: "Later",
        todos: [
          { id: 2, title: "two", done: false },
          { id: 1, title: "one", done: true },
        ],
        tags: [],
      });
    });
    const rows = Realm.untracked(realm, (read) => read(list.$todos.rows));
    expect(rows[0]).toBe(second as Todo);
    expect(rows[1]).toBe(first as Todo);
    expect(Realm.untracked(realm, (read) => read.snapshot(list))).toEqual({
      id: "inbox",
      name: "Later",
      todos: [
        { id: 2, title: "two", done: false },
        { id: 1, title: "one", done: true },
      ],
      tags: [],
    });
  });

  test("a held row a reader reads is not replaced, so the row's readers do not rerun", () => {
    using realm = testRealm();
    const list = Model.decode(realm, List)(listJson);
    let rowRuns = 0;
    using _watch = held(
      Realm.watch(
        realm,
        (read) => read(list.$todos.row(1)),
        () => {
          rowRuns++;
        },
      ),
    );
    Realm.update(realm, (_read, write) => {
      write.restore(list.$todos, [
        { id: 1, title: "one", done: true },
        { id: 2, title: "two", done: true },
      ]);
    });
    expect(rowRuns).toBe(0);
  });

  test("a new row from plain data throws: a restore never makes a model", () => {
    using realm = testRealm();
    const list = Model.decode(realm, List)({ ...listJson, todos: [] });
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.restore(list.$todos, [{ id: 3, title: "three", done: false }]);
      }),
    ).toThrow("pinna: write.restore at shape[key 3] adds a model row from plain data");
    const loose = Collection.schema(realm, Todo, { keyOf: (todo) => todo.id });
    expect(
      codeOf(() =>
        Realm.update(realm, (_read, write) => {
          write.restore(loose, [{ id: 3, title: "three", done: false }]);
        }),
      ),
    ).toBe("pinna/restore-cannot-make-row");
  });

  test("a new row given as an instance is added as it is", () => {
    using realm = testRealm();
    const list = Model.decode(realm, List)(listJson);
    const three = Todo.make({ id: 3, title: "three", done: false, realm });
    Realm.update(realm, (_read, write) => {
      write.restore(list.$todos, [three, { id: 1, title: "one", done: true }]);
    });
    const rows = Realm.untracked(realm, (read) => read(list.$todos.rows));
    expect(rows[0]).toBe(three);
    expect(rows.map((row) => row.id)).toEqual([3, 1]);
  });

  test("a plain field that differs throws, at a root and in a row", () => {
    using realm = testRealm();
    const list = Model.decode(realm, List)(listJson);
    const saved = Realm.untracked(realm, (read) => read.snapshot(list));
    expect(
      codeOf(() =>
        Realm.update(realm, (_read, write) => {
          write.restore(list, { ...saved, id: "other" });
        }),
      ),
    ).toBe("pinna/restore-plain-field");
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.restore(list, {
          ...saved,
          name: "Changed",
          todos: [{ id: 1, title: "renamed", done: false }],
        });
      }),
    ).toThrow('pinna: write.restore at shape.todos[key 1] finds "title" of the Todo held there');
    expect(Realm.untracked(realm, (read) => read.snapshot(list))).toEqual(saved);
  });

  test("a schema box refuses a value, and the restore rolls back", () => {
    using realm = testRealm();
    const $price = Box.schema(realm, NonNegative, 1);
    const $other = Box.make(realm, 1);
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.restore({ $other, $price }, { $other: 2, $price: -1 });
      }),
    ).toThrow(ValueRejectedError);
    expect(Realm.untracked(realm, (read) => [read($other), read($price)])).toEqual([1, 1]);
  });

  test("another instance of the class stands in for its data", () => {
    using realm = testRealm();
    const list = Model.decode(realm, List)(listJson);
    const fresh = Model.decode(
      realm,
      List,
    )({
      ...listJson,
      name: "Fresh",
      todos: [{ id: 5, title: "five", done: true }],
    });
    const five = Realm.untracked(realm, (read) => read.row(fresh.$todos, 5));
    Realm.update(realm, (_read, write) => {
      write.restore(list, fresh);
    });
    expect(Realm.untracked(realm, (read) => read(list.$name))).toBe("Fresh");
    expect(Realm.untracked(realm, (read) => read.row(list.$todos, 5))).toBe(five as Todo);
  });

  test("an instance of another class or realm throws", () => {
    using realm = testRealm();
    using other = testRealm();
    const list = Model.decode(realm, List)(listJson);
    expect(
      codeOf(() =>
        Realm.update(realm, (_read, write) => {
          write.restore(list, Todo.make({ id: 1, title: "x", done: false, realm }) as never);
        }),
      ),
    ).toBe("pinna/restore-shape");
    expect(
      codeOf(() =>
        Realm.update(realm, (_read, write) => {
          write.restore(list, Model.decode(other, List)(listJson));
        }),
      ),
    ).toBe("pinna/foreign-realm");
  });

  test("a Model.context field is the caller's, so the snapshot leaves it out", () => {
    class Money extends Context.Service<Money, { readonly code: string }>()("Money") {}
    class Price extends Model.Schema<Price>("Price")({
      $amount: Model.boxField(Schema.Number),
      money: Model.context(Money),
    }) {}
    using realm = testRealm();
    const price = Model.decode(realm, Price, Context.make(Money, { code: "EUR" }))({ amount: 1 });
    const data = Realm.untracked(realm, (read) => read.snapshot(price));
    expect(data).toEqual({ amount: 1 });
    Realm.update(realm, (_read, write) => {
      write.restore(price, { amount: 2 });
    });
    expect(Realm.untracked(realm, (read) => read(price.$amount))).toBe(2);
  });
});

describe("encoding a Model.Schema is a read", () => {
  test("a computed value that encodes a model tracks its boxes and collections", () => {
    using realm = testRealm();
    const list = Model.decode(realm, List)(listJson);
    const $wire = Computed.make(realm, () => Schema.encodeSync(List)(list));
    const seen: Array<unknown> = [];
    using _watch = held(
      Realm.watch(
        realm,
        (read) => read($wire),
        (wire) => {
          seen.push(wire);
        },
      ),
    );
    Realm.update(realm, (read, write) => {
      const one = read.row(list.$todos, 1) as Todo;
      write(one.$done, true);
    });
    Realm.update(realm, (_read, write) => {
      write.upsert(list.$tags, "work", { at: "end" });
    });
    expect(seen).toHaveLength(2);
    expect((seen[1] as { readonly tags: ReadonlyArray<string> }).tags).toEqual(["home", "work"]);
  });

  test("inside a stage recipe, an encode reads the stage's values", () => {
    using realm = testRealm();
    const list = Model.decode(realm, List)(listJson);
    const stage = Stage.make(realm);
    let staged: unknown;
    Stage.update(stage, (_read, write) => {
      write(list.$name, "Staged");
      write.remove(list.$tags, "home");
      staged = Schema.encodeSync(List)(list);
    });
    expect(staged).toMatchObject({ name: "Staged", tags: [] });
    expect(Stage.read(stage, () => Schema.encodeSync(List)(list))).toMatchObject({
      name: "Staged",
    });
    expect(Schema.encodeSync(List)(list)).toMatchObject({ name: "Inbox", tags: ["home"] });
    Stage.drop(stage);
  });
});

describe("Model.restore", () => {
  test("decodes the input and restores it into the held instance in one update", () => {
    using realm = testRealm();
    const list = Model.decode(realm, List)(listJson);
    const first = Realm.untracked(realm, (read) => read.row(list.$todos, 1));
    let runs = 0;
    using _watch = held(
      Realm.watch(
        realm,
        (read) => read.snapshot(list),
        () => {
          runs++;
        },
      ),
    );
    Model.restore(realm, List)(list, {
      ...listJson,
      name: "Restored",
      todos: [
        { id: 1, title: "one", done: true },
        { id: 7, title: "seven", done: false },
      ],
    });
    expect(runs).toBe(1);
    expect(Realm.untracked(realm, (read) => read.row(list.$todos, 1))).toBe(first as Todo);
    expect(Realm.untracked(realm, (read) => read.snapshot(list))).toMatchObject({
      name: "Restored",
      todos: [
        { id: 1, done: true },
        { id: 7, title: "seven" },
      ],
    });
  });

  test("joins the open update, and rolls back with it", () => {
    using realm = testRealm();
    const list = Model.decode(realm, List)(listJson);
    expect(() =>
      Realm.update(realm, () => {
        Model.restore(realm, List)(list, { ...listJson, name: "Joined" });
        throw new Error("later");
      }),
    ).toThrow("later");
    expect(Realm.untracked(realm, (read) => read(list.$name))).toBe("Inbox");
  });

  test("throws DecodeError for input the schema refuses, and writes nothing", () => {
    using realm = testRealm();
    const list = Model.decode(realm, List)(listJson);
    expect(() => Model.restore(realm, List)(list, { ...listJson, name: 1 })).toThrow(DecodeError);
    expect(Realm.untracked(realm, (read) => read(list.$name))).toBe("Inbox");
  });

  test("throws for a plain field that differs from the held root", () => {
    using realm = testRealm();
    const list = Model.decode(realm, List)(listJson);
    expect(codeOf(() => Model.restore(realm, List)(list, { ...listJson, id: "other" }))).toBe(
      "pinna/restore-plain-field",
    );
  });

  test("throws inside a stage recipe, where a decode cannot make boxes", () => {
    using realm = testRealm();
    const list = Model.decode(realm, List)(listJson);
    const decoded = Model.decode(realm, List)({ ...listJson, name: "Staged" });
    const stage = Stage.make(realm);
    expect(
      codeOf(() =>
        Stage.update(stage, () => {
          Model.restore(realm, List)(list, listJson);
        }),
      ),
    ).toBe("pinna/made-in-recipe");
    Stage.update(stage, (_read, write) => {
      write.restore(list, decoded);
    });
    expect(Stage.read(stage, (read) => read(list.$name))).toBe("Staged");
    Stage.apply(stage);
    expect(Realm.untracked(realm, (read) => read(list.$name))).toBe("Staged");
  });
});

describe("restore edge cases", () => {
  class Note extends Model.Schema<Note>("Note")({
    id: Schema.Number,
    tag: Schema.optionalKey(Schema.String),
    $text: Model.boxField(Schema.String),
  }) {
    key(): number {
      return this.id;
    }
  }

  test("a model row in the data may be an instance, in the types too", () => {
    using realm = testRealm();
    const list = Model.decode(realm, List)(listJson);
    const saved = Realm.untracked(realm, (read) => read.snapshot(list));
    const three = Todo.make({ id: 3, title: "three", done: false, realm });
    Realm.update(realm, (_read, write) => {
      write.restore(list, { ...saved, todos: [...saved.todos, three] });
    });
    expect(Realm.untracked(realm, (read) => read.row(list.$todos, 3))).toBe(three);
  });

  test("an optional plain field present on one instance and absent on the other differs", () => {
    using realm = testRealm();
    const plain = Note.make({ id: 1, text: "a", realm });
    const tagged = Note.make({ id: 1, tag: "x", text: "b", realm });
    expect(
      codeOf(() =>
        Realm.update(realm, (_read, write) => {
          write.restore(plain, tagged);
        }),
      ),
    ).toBe("pinna/restore-plain-field");
    expect(Realm.untracked(realm, (read) => read(plain.$text))).toBe("a");
  });

  test("an instance with matching plain fields restores the held row in place, in any collection", () => {
    using realm = testRealm();
    const rows = Collection.make(realm, { keyOf: (note: Note) => note.id });
    const held = Note.make({ id: 1, text: "a", realm });
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, held);
    });
    const fresh = Note.make({ id: 1, text: "b", realm });
    Realm.update(realm, (_read, write) => {
      write.restore(rows, [fresh]);
    });
    expect(Realm.untracked(realm, (read) => read.row(rows, 1))).toBe(held);
    expect(Realm.untracked(realm, (read) => read(held.$text))).toBe("b");
    const retagged = Note.make({ id: 1, tag: "x", text: "c", realm });
    Realm.update(realm, (_read, write) => {
      write.restore(rows, [retagged]);
    });
    expect(Realm.untracked(realm, (read) => read.row(rows, 1))).toBe(retagged);
  });

  test("a plain row held beside model rows restores from its unchanged snapshot", () => {
    using realm = testRealm();
    type Row = Note | { readonly id: number; readonly label: string };
    const rows = Collection.make(realm, { keyOf: (row: Row) => row.id });
    Realm.update(realm, (_read, write) => {
      write.replaceAll(rows, [Note.make({ id: 1, text: "a", realm }), { id: 2, label: "plain" }]);
    });
    const saved = Realm.untracked(realm, (read) => read.snapshot({ rows }));
    Realm.update(realm, (_read, write) => {
      write.restore({ rows }, saved as never);
    });
    expect(Realm.untracked(realm, (read) => read.snapshot({ rows }))).toEqual(saved);
    expect(
      codeOf(() =>
        Realm.update(realm, (_read, write) => {
          write.restore({ rows }, {
            rows: [...(saved.rows as Array<unknown>), { id: 3, label: "new" }],
          } as never);
        }),
      ),
    ).toBe("pinna/restore-cannot-make-row");
  });

  test("a keyOf that calls a method throws a named error on a data row", () => {
    using realm = testRealm();
    const rows = Collection.schema(realm, Note, { keyOf: (note) => note.key() });
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, Note.make({ id: 1, text: "a", realm }));
    });
    const saved = Realm.untracked(realm, (read) => read.snapshot({ rows }));
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.restore({ rows }, saved);
      }),
    ).toThrow("cannot key a data row: the collection's keyOf throws on it");
  });
});

describe("restoring a collection after its last model row was removed", () => {
  class Item extends Model.Schema<Item>("Item")({
    id: Schema.Number,
    $count: Model.boxField(Schema.Number),
  }) {}

  test("plain data for a model row throws pinna/restore-cannot-make-row; the instance restores", () => {
    using realm = testRealm();
    const $rows = Collection.make(realm, { keyOf: (row: Item) => row.id });
    const item = Item.make({ realm, id: 1, count: 8 });
    Realm.update(realm, (_read, write) => {
      write.upsert($rows, item);
    });
    const saved = Realm.untracked(realm, (read) => read.snapshot($rows));
    Realm.update(realm, (_read, write) => {
      write.remove($rows, 1);
    });
    expect(
      codeOf(() =>
        Realm.update(realm, (_read, write) => {
          write.restore($rows, saved);
        }),
      ),
    ).toBe("pinna/restore-cannot-make-row");
    expect(Realm.untracked(realm, (read) => read.row($rows, 1))).toBeUndefined();
    Realm.update(realm, (_read, write) => {
      write.restore($rows, [item]);
    });
    expect(Realm.untracked(realm, (read) => read.row($rows, 1))).toBe(item);
  });

  test("a collection a restore filled with a model row refuses plain data for it after it is removed", () => {
    using realm = testRealm();
    const $rows = Collection.make(realm, { keyOf: (row: Item) => row.id });
    const item = Item.make({ realm, id: 1, count: 8 });
    Realm.update(realm, (_read, write) => {
      write.restore($rows, [item]);
    });
    Realm.update(realm, (_read, write) => {
      write.remove($rows, 1);
    });
    expect(
      codeOf(() =>
        Realm.update(realm, (_read, write) => {
          write.restore($rows, [{ id: 1, count: 8 }] as never);
        }),
      ),
    ).toBe("pinna/restore-cannot-make-row");
    expect(Realm.untracked(realm, (read) => read.row($rows, 1))).toBeUndefined();
  });
});
