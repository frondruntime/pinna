import { describe, expect, test } from "bun:test";
import {
  Atom,
  Box,
  Collection,
  Computed,
  isPinnaError,
  Model,
  Realm,
  type Realm as RealmType,
  type Snapshot,
  Stage,
} from "../src/index.ts";
import { held, testRealm } from "../src/testing/index.ts";

/** `read.snapshot` and `write.restore` over boxes and plain collections (ruling 64). */

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

interface Row {
  readonly id: number;
  readonly label: string;
}

const workspace = (realm: RealmType) => {
  const $theme = Box.make(realm, "light", { name: "theme" });
  const $open = Box.make(realm, true);
  const rows = Collection.make(realm, { keyOf: (row: Row) => row.id, name: "rows" });
  Realm.update(realm, (_read, write) => {
    write.replaceAll(rows, [
      { id: 1, label: "one" },
      { id: 2, label: "two" },
    ]);
  });
  return { $theme, panel: { $open }, rows, pair: [$theme, $open] as const };
};

describe("read.snapshot", () => {
  test("reads a shape of boxes and collections as plain data", () => {
    using realm = testRealm();
    const shape = workspace(realm);
    const data = Realm.untracked(realm, (read) => read.snapshot(shape));
    expect(data).toEqual({
      $theme: "light",
      panel: { $open: true },
      rows: [
        { id: 1, label: "one" },
        { id: 2, label: "two" },
      ],
      pair: ["light", true],
    });
    const typed: Snapshot<typeof shape> = data;
    expect(typed.rows[0]?.label).toBe("one");
  });

  test("a box's value is the held object, so an unchanged box gives the same reference", () => {
    using realm = testRealm();
    const $list = Box.make(realm, [1, 2]);
    const first = Realm.untracked(realm, (read) => read.snapshot({ $list }));
    const second = Realm.untracked(realm, (read) => read.snapshot({ $list }));
    expect(first.$list).toBe(second.$list);
    expect(first).not.toBe(second);
  });

  test("in a computed value it tracks every box and collection in the shape", () => {
    using realm = testRealm();
    const shape = workspace(realm);
    const $saved = Computed.make(realm, (read) => JSON.stringify(read.snapshot(shape)));
    const seen: Array<string> = [];
    using _watch = held(
      Realm.watch(
        realm,
        (read) => read($saved),
        (text) => {
          seen.push(text);
        },
      ),
    );
    Realm.update(realm, (_read, write) => {
      write(shape.$theme, "dark");
    });
    Realm.update(realm, (_read, write) => {
      write.upsert(shape.rows, { id: 3, label: "three" }, { at: "end" });
    });
    expect(seen.map((text) => JSON.parse(text).$theme)).toEqual(["dark", "dark"]);
    expect(JSON.parse(seen[1] as string).rows).toHaveLength(3);
  });

  test("an autorun that snapshots reruns on a write under the shape", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 0);
    const runs: Array<number> = [];
    using _autorun = held(
      Realm.autorun(realm, (read) => {
        runs.push(read.snapshot({ $count }).$count);
      }),
    );
    Realm.update(realm, (_read, write) => {
      write($count, 1);
    });
    expect(runs).toEqual([0, 1]);
  });

  test("throws for a computed value, an atom, a Model.Class instance, and a value", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 1);
    class Plain extends Model.Class {
      readonly $count = Box.make(this.realm, 1);
    }
    const shapes: ReadonlyArray<unknown> = [
      { $double: Computed.make(realm, (read) => read($count) * 2) },
      { atom: Atom.make(realm) },
      { plain: new Plain(realm) },
      { count: 1 },
      { at: new Date() },
    ];
    for (const shape of shapes) {
      expect(codeOf(() => Realm.untracked(realm, (read) => read.snapshot(shape)))).toBe(
        "pinna/snapshot-not-state",
      );
    }
    expect(() =>
      Realm.untracked(realm, (read) => read.snapshot({ deep: { $double: shapes[0] } })),
    ).toThrow("pinna: read.snapshot at shape.deep.$double.$double finds a computed value");
  });

  test("a collection holding a Model.Class row throws, naming the row", () => {
    using realm = testRealm();
    class Plain extends Model.Class {}
    const rows = Collection.make(realm, { keyOf: (_row: Plain) => 1 });
    Realm.update(realm, (_read, write) => {
      write.upsert(rows, new Plain(realm));
    });
    expect(() => Realm.untracked(realm, (read) => read.snapshot({ rows }))).toThrow(
      "pinna: read.snapshot at shape.rows[0] finds a Model.Class instance (Plain)",
    );
  });

  test("a shape that holds itself throws instead of recursing", () => {
    using realm = testRealm();
    const shape: Record<string, unknown> = { $count: Box.make(realm, 1) };
    shape["self"] = shape;
    expect(codeOf(() => Realm.untracked(realm, (read) => read.snapshot(shape)))).toBe(
      "pinna/snapshot-cycle",
    );
  });

  test("a box shared by two entries is read under both", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 1);
    expect(Realm.untracked(realm, (read) => read.snapshot({ a: $count, b: [$count] }))).toEqual({
      a: 1,
      b: [1],
    });
  });

  test("an observable of another realm throws as read does", () => {
    using realm = testRealm();
    using other = testRealm();
    const $theirs = Box.make(other, 1);
    expect(codeOf(() => Realm.untracked(realm, (read) => read.snapshot({ $theirs })))).toBe(
      "pinna/foreign-realm",
    );
  });

  test("a read kept past its place throws", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 1);
    const kept = Realm.untracked(realm, (read) => read);
    expect(codeOf(() => kept.snapshot({ $count }))).toBe("pinna/read-outside-place");
  });
});

describe("write.restore", () => {
  test("writes a snapshot back into the same boxes and collection", () => {
    using realm = testRealm();
    const shape = workspace(realm);
    const saved = Realm.untracked(realm, (read) => read.snapshot(shape));
    Realm.update(realm, (_read, write) => {
      write(shape.$theme, "dark");
      write(shape.panel.$open, false);
      write.remove(shape.rows, 1);
      write.upsert(shape.rows, { id: 3, label: "three" });
    });
    Realm.update(realm, (_read, write) => {
      write.restore(shape, saved);
    });
    expect(Realm.untracked(realm, (read) => read.snapshot(shape))).toEqual(saved);
    expect(Realm.untracked(realm, (read) => read(shape.rows.keys))).toEqual([1, 2]);
  });

  test("restoring the state held notifies nobody", () => {
    using realm = testRealm();
    const shape = workspace(realm);
    const saved = Realm.untracked(realm, (read) => read.snapshot(shape));
    let runs = 0;
    using _watch = held(
      Realm.watch(
        realm,
        (read) => read.snapshot(shape),
        () => {
          runs++;
        },
      ),
    );
    Realm.update(realm, (_read, write) => {
      write.restore(shape, saved);
    });
    expect(runs).toBe(0);
  });

  test("lands with its update: a throw later in the recipe puts the restore back", () => {
    using realm = testRealm();
    const shape = workspace(realm);
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.restore(
          { $theme: shape.$theme },
          {
            $theme: "dark",
          },
        );
        throw new Error("later");
      }),
    ).toThrow("later");
    expect(Realm.untracked(realm, (read) => read(shape.$theme))).toBe("light");
  });

  test("a restore that throws part way puts back its own writes, even when caught", () => {
    using realm = testRealm();
    const $first = Box.make(realm, 1);
    const $second = Box.make(realm, 1);
    const $other = Box.make(realm, 1);
    Realm.update(realm, (_read, write) => {
      write($other, 2);
      try {
        write.restore({ $first, $second }, { $first: 5 } as never);
      } catch {
        // The shape error is the caller's; the update goes on.
      }
      try {
        write.restore([$first, Atom.make(realm)], [5, undefined] as never);
      } catch {
        // The atom refuses after $first was written.
      }
    });
    expect(Realm.untracked(realm, (read) => [read($first), read($second), read($other)])).toEqual([
      1, 1, 2,
    ]);
  });

  test("a nested update's restore rolls back with it", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 1);
    Realm.update(realm, () => {
      try {
        Realm.update(realm, (_read, write) => {
          write.restore({ $count }, { $count: 2 });
          throw new Error("inner");
        });
      } catch {
        // The inner update rolled back.
      }
    });
    expect(Realm.untracked(realm, (read) => read($count))).toBe(1);
  });

  test("the data's shape must match exactly, and the error names the path", () => {
    using realm = testRealm();
    const shape = workspace(realm);
    const restore = (data: unknown) =>
      Realm.update(realm, (_read, write) => {
        write.restore(shape, data as never);
      });
    const saved = Realm.untracked(realm, (read) => read.snapshot(shape));
    expect(() => restore({ ...saved, extra: 1 })).toThrow(
      'pinna: write.restore at shape takes the shape\'s keys exactly; the data adds "extra"',
    );
    expect(() => restore({ ...saved, panel: {} })).toThrow(
      'pinna: write.restore at shape.panel takes the shape\'s keys exactly; the data lacks "$open"',
    );
    expect(() => restore({ ...saved, rows: {} })).toThrow(
      "pinna: write.restore at shape.rows takes an array of rows, and the data holds an object",
    );
    expect(() => restore({ ...saved, pair: ["dark"] })).toThrow(
      "pinna: write.restore at shape.pair takes an array of 2, and the data holds an array",
    );
    expect(codeOf(() => restore(null))).toBe("pinna/restore-shape");
    expect(Realm.untracked(realm, (read) => read.snapshot(shape))).toEqual(saved);
  });

  test("a write kept past its update throws", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 1);
    let kept: Parameters<Parameters<typeof Realm.update>[1]>[1] | undefined;
    Realm.update(realm, (_read, write) => {
      kept = write;
    });
    expect(codeOf(() => kept?.restore({ $count }, { $count: 2 }))).toBe(
      "pinna/write-outside-update",
    );
  });

  test("goes through each box's check and equality", () => {
    using realm = testRealm();
    const $list = Box.make(realm, [1], { equals: (a, b) => a.length === b.length });
    const before = Realm.untracked(realm, (read) => read($list));
    Realm.update(realm, (_read, write) => {
      write.restore({ $list }, { $list: [9] });
    });
    expect(Realm.untracked(realm, (read) => read($list))).toBe(before);
  });

  test("an observable of another realm throws as write does", () => {
    using realm = testRealm();
    using other = testRealm();
    const $theirs = Box.make(other, 1);
    expect(
      codeOf(() =>
        Realm.update(realm, (_read, write) => {
          write.restore({ $theirs }, { $theirs: 2 });
        }),
      ),
    ).toBe("pinna/foreign-realm");
  });

  test("restores a snapshot taken in another realm into this realm's shape", () => {
    using source = testRealm();
    using target = testRealm();
    const from = workspace(source);
    const into = workspace(target);
    Realm.update(source, (_read, write) => {
      write(from.$theme, "dark");
      write.upsert(from.rows, { id: 9, label: "nine" });
    });
    const data = Realm.untracked(source, (read) => read.snapshot(from));
    Realm.update(target, (_read, write) => {
      write.restore(into, data);
    });
    expect(Realm.untracked(target, (read) => read.snapshot(into))).toEqual(data);
  });

  test("a restore reports each row it adds, replaces, or removes", () => {
    using realm = testRealm();
    const shape = workspace(realm);
    const changes: Array<string> = [];
    using _listener = held(
      Collection.onRowChange(shape.rows, ({ key, before, after }) => {
        changes.push(`${key}:${before?.label ?? "-"}>${after?.label ?? "-"}`);
        return undefined;
      }),
    );
    // A new listener is first told of every row held.
    changes.length = 0;
    Realm.update(realm, (_read, write) => {
      write.restore(
        { rows: shape.rows },
        {
          rows: [
            { id: 2, label: "TWO" },
            { id: 4, label: "four" },
          ],
        },
      );
    });
    expect(changes.sort()).toEqual(["1:one>-", "2:two>TWO", "4:->four"]);
  });
});

describe("snapshot and restore in a stage", () => {
  test("Stage.read snapshots the state as the stage would land it", () => {
    using realm = testRealm();
    const shape = workspace(realm);
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write(shape.$theme, "dark");
      write.remove(shape.rows, 1);
    });
    expect(Stage.read(stage, (read) => read.snapshot(shape))).toMatchObject({
      $theme: "dark",
      rows: [{ id: 2, label: "two" }],
    });
    expect(Realm.untracked(realm, (read) => read.snapshot(shape).$theme)).toBe("light");
    Stage.drop(stage);
  });

  test("a recipe's restore is staged, replays, and lands at Stage.apply", () => {
    using realm = testRealm();
    const shape = workspace(realm);
    const saved = Realm.untracked(realm, (read) => read.snapshot(shape));
    Realm.update(realm, (_read, write) => {
      write(shape.$theme, "dark");
    });
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write.restore(shape, saved);
    });
    expect(Realm.untracked(realm, (read) => read(shape.$theme))).toBe("dark");
    // A base write the stage did not read: the replay lands the restore over it.
    Realm.update(realm, (_read, write) => {
      write(shape.panel.$open, false);
    });
    Stage.apply(stage);
    expect(Realm.untracked(realm, (read) => read.snapshot(shape))).toEqual(saved);
  });

  test("a recipe's restore that throws puts back only its own writes", () => {
    using realm = testRealm();
    const $first = Box.make(realm, 1);
    const atom = Atom.make(realm);
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write($first, 2);
      try {
        write.restore([$first, atom], [3, undefined] as never);
      } catch {
        // Refused after $first was staged at 3.
      }
    });
    expect(Stage.read(stage, (read) => read($first))).toBe(2);
    Stage.drop(stage);
  });
});

describe("snapshot keys", () => {
  test("an own __proto__ key in a shape round-trips as an own key", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 1);
    const shape = JSON.parse('{"__proto__": 0}') as Record<string, unknown>;
    // An own data property, as JSON.parse makes one: assignment writes it, never the prototype.
    shape["__proto__"] = $count;
    const data = Realm.untracked(realm, (read) => read.snapshot(shape)) as Record<string, unknown>;
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(Object.hasOwn(data, "__proto__")).toBe(true);
    Realm.update(realm, (_read, write) => {
      write.restore(shape, JSON.parse('{"__proto__": 2}') as never);
    });
    expect(Realm.untracked(realm, (read) => read($count))).toBe(2);
  });
});

describe("a snapshot is a copy", () => {
  test("a later write to a box or a collection leaves a snapshot taken before it unchanged", () => {
    using realm = testRealm();
    const shape = workspace(realm);
    const saved = Realm.untracked(realm, (read) => read.snapshot(shape));
    const copy = structuredClone(saved);
    Realm.update(realm, (_read, write) => {
      write(shape.$theme, "dark");
      write.upsert(shape.rows, { id: 1, label: "first" });
      write.upsert(shape.rows, { id: 3, label: "three" });
      write.remove(shape.rows, 2);
    });
    expect(saved).toEqual(copy);
  });

  test("a collection's snapshot is not the array its rows computed value returns", () => {
    using realm = testRealm();
    const shape = workspace(realm);
    const saved = Realm.untracked(realm, (read) => read.snapshot(shape));
    const rows = Realm.untracked(realm, (read) => read(shape.rows.rows));
    expect(saved.rows).toEqual([...rows]);
    expect(saved.rows).not.toBe(rows);
  });
});

describe("a restore and the computed values over its shape", () => {
  test("a restore that changes every box and the collection reruns each reader once", () => {
    using realm = testRealm();
    const shape = workspace(realm);
    const saved = Realm.untracked(realm, (read) => read.snapshot(shape));
    Realm.update(realm, (_read, write) => {
      write(shape.$theme, "dark");
      write(shape.panel.$open, false);
      write.replaceAll(shape.rows, [{ id: 9, label: "nine" }]);
    });
    let computes = 0;
    const summary = Computed.make(realm, (read) => {
      computes++;
      return `${read(shape.$theme)} ${read(shape.panel.$open)} ${read(shape.rows.keys).join(",")}`;
    });
    const seen: Array<string> = [];
    using _watch = held(
      Realm.watch(
        realm,
        (read) => read(summary),
        (value) => {
          seen.push(value);
        },
      ),
    );
    computes = 0;

    Realm.update(realm, (_read, write) => {
      write.restore(shape, saved);
    });

    expect(computes).toBe(1);
    expect(seen).toEqual(["light true 1,2"]);
  });
});

describe("snapshot keys named like Object.prototype members", () => {
  for (const name of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
    test(`a ${name} key round-trips as an own key`, () => {
      using realm = testRealm();
      const $count = Box.make(realm, 1);
      const shape = { [name]: $count } as Record<string, unknown>;
      const data = Realm.untracked(realm, (read) => read.snapshot(shape)) as Record<
        string,
        unknown
      >;
      expect(Object.hasOwn(data, name)).toBe(true);
      expect(data[name]).toBe(1);
      Realm.update(realm, (_read, write) => {
        write.restore(shape, { [name]: 2 } as never);
      });
      expect(Realm.untracked(realm, (read) => read($count))).toBe(2);
    });
  }
});

describe("symbol keys and empty slots in a shape", () => {
  test("a symbol-keyed box is snapshotted, tracked, and restored", () => {
    using realm = testRealm();
    const key = Symbol("quantity");
    const $quantity = Box.make(realm, 1);
    const shape = { [key]: $quantity };
    const $snapshot = Computed.make(realm, (read) => read.snapshot(shape));
    const seen: Array<number> = [];
    const stop = Realm.autorun(realm, (read) => {
      seen.push(read($snapshot)[key]);
      return undefined;
    });
    Realm.update(realm, (_read, write) => {
      write($quantity, 2);
    });
    Realm.update(realm, (_read, write) => {
      write.restore(shape, { [key]: 3 });
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.restore(shape, {} as never);
      }),
    ).toThrow(
      "pinna: write.restore at shape takes the shape's keys exactly; the data lacks Symbol(quantity)",
    );
    stop();
  });

  test("a snapshot of an array with an empty slot restores to the same shape", () => {
    using realm = testRealm();
    const $quantity = Box.make(realm, 1);
    const shape = Array<typeof $quantity>(2);
    shape[1] = $quantity;
    const saved = Realm.untracked(realm, (read) => read.snapshot(shape));
    Realm.update(realm, (_read, write) => {
      write($quantity, 2);
    });
    Realm.update(realm, (_read, write) => {
      write.restore(shape, saved);
    });
    expect(Realm.untracked(realm, (read) => read($quantity))).toBe(1);
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.restore(shape, [5, 6] as never);
      }),
    ).toThrow("pinna: write.restore at shape[0] takes an empty slot, and the data holds a number");
  });
});
