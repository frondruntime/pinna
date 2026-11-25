import { describe, expect, test } from "bun:test";
import { Atom, Box, Collection, Computed, Realm, Source, Stage, type Write } from "../src/index.ts";
import { record, testRealm } from "../src/testing/index.ts";

/**
 * A read through a stage sees the stage's own writes everywhere: a box, a
 * computed value evaluated over the stage, and a collection's keys, rows,
 * and row (`docs/api.md`, ruling 53).
 */

describe("box equality through a stage", () => {
  for (const heldBy of ["realm", "stage", "ancestor"] as const) {
    for (const modify of [false, true]) {
      test(`an equal ${modify ? "modify" : "write"} keeps the object held by the ${heldBy}`, () => {
        using realm = testRealm();
        const initial = { id: 1, label: "initial" };
        const held = heldBy === "realm" ? initial : { id: 2, label: "held" };
        const $value = Box.make(realm, initial, { equals: (left, right) => left.id === right.id });
        const $decision = Box.make(realm, "");
        let runs = 0;
        const $label = Computed.make(realm, (read) => {
          runs++;
          return read($value).label;
        });
        const root = Stage.make(realm);
        const stage = heldBy === "ancestor" ? Stage.make(root) : root;
        try {
          if (heldBy !== "realm") {
            Stage.update(heldBy === "ancestor" ? root : stage, (_read, write) => {
              write($value, held);
            });
          }
          expect(Stage.read(stage, (read) => read($label))).toBe(held.label);
          Stage.update(stage, (_read, write) => {
            if (modify) {
              write.modify($value, (draft) => {
                draft.label = "equal replacement";
              });
            } else {
              write($value, { id: held.id, label: "equal replacement" });
            }
          });
          expect(Stage.read(stage, (read) => read($value))).toBe(held);
          expect(Stage.read(stage, (read) => read($label))).toBe(held.label);
          expect(runs).toBe(1);
          if (heldBy !== "stage") expect(Stage.inspect(stage).boxes).toEqual([]);
          const decision = Stage.read(stage, (read) => read($label));
          Stage.update(stage, (_read, write) => {
            write($decision, decision);
          });
          if (stage !== root) Stage.apply(stage);
          Stage.apply(root);
          expect(Realm.untracked(realm, (read) => [read($value), read($decision)])).toEqual([
            held,
            held.label,
          ]);
        } finally {
          Stage.drop(root);
        }
      });
    }
  }
});

interface Item {
  readonly id: string;
  readonly price: number;
}

const items = (realm: Parameters<typeof Collection.make>[0]) =>
  Collection.make<string, Item>(realm, { keyOf: (item) => item.id });

describe("a computed value through a stage", () => {
  for (const verb of ["write", "modify", "upsert", "remove", "replaceAll", "changed"] as const) {
    for (const parentWriter of [false, true]) {
      test(`a computed value refuses captured ${verb} (${parentWriter ? "parent writer" : "own writer"})`, () => {
        using realm = testRealm();
        const $value = Box.make(realm, { count: 0 });
        const $rows = Collection.make<number, number>(realm, { keyOf: (row) => row });
        const $atom = Atom.make(realm);
        let captured: Write;
        const $bad = Computed.make(
          realm,
          (read) => {
            read($value);
            if (verb === "write") captured($value, { count: 1 });
            if (verb === "modify")
              captured.modify($value, (draft) => {
                draft.count++;
              });
            if (verb === "upsert") captured.upsert($rows, 1);
            if (verb === "remove") captured.remove($rows, 1);
            if (verb === "replaceAll") captured.replaceAll($rows, [1]);
            if (verb === "changed") captured.changed($atom);
            return read($value).count;
          },
          parentWriter ? { name: "bad" } : undefined,
        );
        const root = Stage.make(realm);
        const stage = parentWriter ? Stage.make(root) : root;
        try {
          if (parentWriter)
            Stage.update(root, (_read, write) => {
              captured = write;
            });
          const name = parentWriter ? 'the computed value "bad"' : "a computed value";
          expect(() =>
            Stage.update(stage, (read, write) => {
              if (!parentWriter) captured = write;
              read($bad);
            }),
          ).toThrow(`pinna: ${name} cannot write while it computes`);
          expect(Stage.read(root, (read) => [read($value), read($rows.keys)])).toEqual([
            { count: 0 },
            [],
          ]);
          Stage.update(stage, (_read, write) => {
            write($value, { count: 2 });
          });
          expect(Stage.read(stage, (read) => read($value).count)).toBe(2);
        } finally {
          Stage.drop(root);
        }
      });
    }
  }

  for (const changed of ["stage", "ancestor", "realm"] as const) {
    test(`a computed failure keeps its error until the ${changed} changes`, () => {
      using realm = testRealm();
      const $gate = Box.make(realm, false);
      let runs = 0;
      const $failing = Computed.make(realm, (read) => {
        runs++;
        if (!read($gate)) throw new Error(`failure ${runs}`);
        return 42;
      });
      const root = Stage.make(realm);
      const stage = changed === "ancestor" ? Stage.make(root) : root;
      const failure = () => {
        try {
          Stage.read(stage, (read) => read($failing));
        } catch (error) {
          return error;
        }
        throw new Error("the computed value did not throw");
      };
      try {
        const first = failure();
        expect(first).toBeInstanceOf(Error);
        expect(failure()).toBe(first);
        expect(runs).toBe(1);
        if (changed === "realm") {
          Realm.update(realm, (_read, write) => {
            write($gate, true);
          });
        } else {
          Stage.update(changed === "ancestor" ? root : stage, (_read, write) => {
            write($gate, true);
          });
        }
        expect(Stage.read(stage, (read) => read($failing))).toBe(42);
        expect(runs).toBe(2);
      } finally {
        Stage.drop(root);
      }
    });
  }

  test("is evaluated over the stage's values, and the realm's computed value does not move", () => {
    using realm = testRealm();
    const $price = Box.make(realm, 10);
    const $quantity = Box.make(realm, 2);
    const $total = Computed.make(realm, (read) => read($price) * read($quantity));
    using totals = record(realm, (read) => read($total));
    const stage = Stage.make(realm);
    Stage.update(stage, (read, write) => {
      write($quantity, read($quantity) + 1);
      // The recipe decides on the total its own write made.
      if (read($total) > 25) {
        write($price, 9);
      }
    });
    expect(Stage.read(stage, (read) => read($total))).toBe(27);
    expect(Realm.untracked(realm, (read) => read($total))).toBe(20);
    expect(totals.values).toEqual([]);
    Stage.apply(stage);
    expect(totals.values).toEqual([27]);
  });

  test("reads through computed values over computed values, and a computed function", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 1);
    const $double = Computed.make(realm, (read) => read($count) * 2);
    const $quadruple = Computed.make(realm, (read) => read($double) * 2);
    const times = Computed.fn(realm, (read, factor: number) => read($count) * factor);
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write($count, 5);
    });
    expect(Stage.read(stage, (read) => [read($quadruple), read(times(3))])).toEqual([20, 15]);
    Stage.drop(stage);
  });

  test("is cached until the stage writes or the realm changes", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 1);
    const $other = Box.make(realm, 0);
    let runs = 0;
    const $double = Computed.make(realm, (read) => {
      runs++;
      return read($count) * 2;
    });
    const stage = Stage.make(realm);
    Stage.read(stage, (read) => [read($double), read($double), read($double)]);
    expect(runs).toBe(1);
    Stage.update(stage, (read, write) => {
      write($count, read($double));
      // A write clears the cache: the next read sees it.
      expect(read($double)).toBe(4);
    });
    expect(runs).toBe(2);
    expect(Stage.read(stage, (read) => read($double))).toBe(4);
    expect(runs).toBe(2);
    Realm.update(realm, (_read, write) => {
      write($other, 1);
    });
    // Not a snapshot: a write to the realm clears it too.
    expect(Stage.read(stage, (read) => read($double))).toBe(4);
    expect(runs).toBe(3);
    Stage.drop(stage);
  });

  test("starts no onObserved source: a value nothing observes reads as it holds", () => {
    using realm = testRealm();
    const $feed = Box.make(realm, 0);
    let started = 0;
    Source.onObserved($feed, () => {
      started++;
      return undefined;
    });
    const $shown = Computed.make(realm, (read) => read($feed) + 1);
    const stage = Stage.make(realm);
    expect(Stage.read(stage, (read) => read($shown))).toBe(1);
    expect(started).toBe(0);
    Stage.drop(stage);
  });

  test("a computed value that reads itself through the stage throws a cycle", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 1);
    const $loop: { current?: ReturnType<typeof Computed.make<number>> } = {};
    $loop.current = Computed.make(
      realm,
      (read) => read($count) + read($loop.current as ReturnType<typeof Computed.make<number>>),
      { name: "loop" },
    );
    const stage = Stage.make(realm);
    expect(() =>
      Stage.read(stage, (read) => read($loop.current as ReturnType<typeof Computed.make<number>>)),
    ).toThrow('pinna: "loop" is read while a stage evaluates it (cycle)');
    Stage.drop(stage);
  });

  test("an atom reads as undefined", () => {
    using realm = testRealm();
    const $feed = Atom.make(realm);
    const stage = Stage.make(realm);
    expect(Stage.read(stage, (read) => read($feed))).toBeUndefined();
    Stage.drop(stage);
  });
});

describe("a collection through a stage", () => {
  for (const changed of ["stage", "ancestor", "realm"] as const) {
    test(`rows keep their cached array until the ${changed} changes`, () => {
      using realm = testRealm();
      const $rows = Collection.make<number, number>(realm, { keyOf: (row) => row });
      Realm.update(realm, (_read, write) => {
        write.replaceAll($rows, [1, 2]);
      });
      const root = Stage.make(realm);
      const stage = changed === "ancestor" ? Stage.make(root) : root;
      try {
        if (changed !== "realm") {
          Stage.update(changed === "ancestor" ? root : stage, (_read, write) => {
            write.replaceAll($rows, [1, 2, 3]);
          });
        }
        const first = Stage.read(stage, (read) => read($rows.rows));
        expect(Stage.read(stage, (read) => read($rows.rows))).toBe(first);
        if (changed === "realm") {
          Realm.update(realm, (_read, write) => {
            write.upsert($rows, 4);
          });
        } else {
          Stage.update(changed === "ancestor" ? root : stage, (_read, write) => {
            write.upsert($rows, 4);
          });
        }
        const next = Stage.read(stage, (read) => read($rows.rows));
        expect(next).not.toBe(first);
        expect(next).toEqual(changed === "realm" ? [4, 1, 2] : [4, 1, 2, 3]);
        expect(Stage.read(stage, (read) => read($rows.rows))).toBe(next);
      } finally {
        Stage.drop(root);
      }
    });
  }

  test("keys, rows, row, and read.row read the stage's rows; the realm keeps its own", () => {
    using realm = testRealm();
    const $items = items(realm);
    Realm.update(realm, (_read, write) => {
      write.replaceAll($items, [
        { id: "a", price: 1 },
        { id: "b", price: 2 },
      ]);
    });
    const $sum = Computed.make(realm, (read) =>
      read($items.rows).reduce((total, item) => total + item.price, 0),
    );
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write.upsert($items, { id: "c", price: 3 }, { at: "end" });
      write.upsert($items, { id: "a", price: 10 });
      write.remove($items, "b");
    });
    expect(
      Stage.read(stage, (read) => ({
        keys: read($items.keys),
        rows: read($items.rows),
        rowA: read($items.row("a")),
        missing: read($items.row("b")),
        rowC: read.row($items, "c"),
        sum: read($sum),
      })),
    ).toEqual({
      keys: ["a", "c"],
      rows: [
        { id: "a", price: 10 },
        { id: "c", price: 3 },
      ],
      rowA: { id: "a", price: 10 },
      missing: undefined,
      rowC: { id: "c", price: 3 },
      sum: 13,
    });
    expect(Realm.untracked(realm, (read) => [read($items.keys), read($sum)])).toEqual([
      ["a", "b"],
      3,
    ]);
    Stage.apply(stage);
    expect(Realm.untracked(realm, (read) => [read($items.keys), read($sum)])).toEqual([
      ["a", "c"],
      13,
    ]);
  });

  test("a collection the stage did not write reads the realm's current rows", () => {
    using realm = testRealm();
    const $items = items(realm);
    const stage = Stage.make(realm);
    Realm.update(realm, (_read, write) => {
      write.upsert($items, { id: "a", price: 1 });
    });
    expect(Stage.read(stage, (read) => [read($items.keys), read.row($items, "a")])).toEqual([
      ["a"],
      { id: "a", price: 1 },
    ]);
    Stage.drop(stage);
  });

  test("once written, the stage holds the collection's rows and order together", () => {
    using realm = testRealm();
    const $items = items(realm);
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write.upsert($items, { id: "a", price: 1 });
    });
    Realm.update(realm, (_read, write) => {
      write.upsert($items, { id: "z", price: 9 });
    });
    // The stage's copy was taken at its first write: its keys and rows agree.
    expect(Stage.read(stage, (read) => [read($items.keys), read($items.rows)])).toEqual([
      ["a"],
      [{ id: "a", price: 1 }],
    ]);
    Stage.apply(stage);
    // The replay lands over the realm's rows at that moment.
    expect(Realm.untracked(realm, (read) => read($items.keys))).toEqual(["a", "z"]);
  });
});
