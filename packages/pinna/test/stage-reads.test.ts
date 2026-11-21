import { describe, expect, test } from "bun:test";
import {
  applyStage,
  atom,
  box,
  collection,
  computed,
  computedFunction,
  dropStage,
  inspectStage,
  onObserved,
  openStage,
  stageRead,
  stageUpdate,
  untracked,
  update,
  type Write,
} from "../src/index.ts";
import { makeBox } from "../src/internal/index.ts";
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
        const $value = box(realm, initial, { equals: (left, right) => left.id === right.id });
        const $decision = box(realm, "");
        let runs = 0;
        const $label = computed(realm, (read) => {
          runs++;
          return read($value).label;
        });
        const root = openStage(realm);
        const stage = heldBy === "ancestor" ? openStage(root) : root;
        try {
          if (heldBy !== "realm") {
            stageUpdate(heldBy === "ancestor" ? root : stage, (_read, write) => {
              write($value, held);
            });
          }
          expect(stageRead(stage, (read) => read($label))).toBe(held.label);
          stageUpdate(stage, (_read, write) => {
            if (modify) {
              write.modify($value, (draft) => {
                draft.label = "equal replacement";
              });
            } else {
              write($value, { id: held.id, label: "equal replacement" });
            }
          });
          expect(stageRead(stage, (read) => read($value))).toBe(held);
          expect(stageRead(stage, (read) => read($label))).toBe(held.label);
          expect(runs).toBe(1);
          if (heldBy !== "stage") expect(inspectStage(stage).boxes).toEqual([]);
          const decision = stageRead(stage, (read) => read($label));
          stageUpdate(stage, (_read, write) => {
            write($decision, decision);
          });
          if (stage !== root) applyStage(stage);
          applyStage(root);
          expect(untracked(realm, (read) => [read($value), read($decision)])).toEqual([
            held,
            held.label,
          ]);
        } finally {
          dropStage(root);
        }
      });
    }
  }

  test("a staged write skips identical values and checks before comparing equal values", () => {
    using realm = testRealm();
    const calls: Array<string> = [];
    const initial = { id: 1, valid: true };
    const $value = makeBox(
      realm,
      (value) => {
        calls.push("check");
        return (value as typeof initial).valid
          ? undefined
          : { message: "invalid", cause: undefined };
      },
      (left, right) => {
        calls.push("equals");
        return left.id === right.id;
      },
      initial,
      undefined,
    );
    calls.length = 0;
    const stage = openStage(realm);
    try {
      stageUpdate(stage, (_read, write) => {
        write($value, initial);
        expect(calls).toEqual([]);
        expect(() => write($value, { id: 1, valid: false })).toThrow("invalid");
        expect(calls).toEqual(["check"]);
        calls.length = 0;
        write($value, { id: 1, valid: true });
        expect(calls).toEqual(["check", "equals"]);
      });
      expect(stageRead(stage, (read) => read($value))).toBe(initial);
      expect(inspectStage(stage).boxes).toEqual([]);
    } finally {
      dropStage(stage);
    }
  });
});

interface Item {
  readonly id: string;
  readonly price: number;
}

const items = (realm: Parameters<typeof collection>[0]) =>
  collection<string, Item>(realm, { keyOf: (item) => item.id });

describe("a computed value through a stage", () => {
  for (const verb of ["write", "modify", "upsert", "remove", "replaceAll", "changed"] as const) {
    for (const parentWriter of [false, true]) {
      test(`a computed value refuses captured ${verb} (${parentWriter ? "parent writer" : "own writer"})`, () => {
        using realm = testRealm();
        const $value = box(realm, { count: 0 });
        const $rows = collection<number, number>(realm, { keyOf: (row) => row });
        const $atom = atom(realm);
        let captured: Write;
        const $bad = computed(
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
        const root = openStage(realm);
        const stage = parentWriter ? openStage(root) : root;
        try {
          if (parentWriter)
            stageUpdate(root, (_read, write) => {
              captured = write;
            });
          const name = parentWriter ? 'the computed value "bad"' : "a computed value";
          expect(() =>
            stageUpdate(stage, (read, write) => {
              if (!parentWriter) captured = write;
              read($bad);
            }),
          ).toThrow(`pinna: ${name} cannot write while it computes`);
          expect(stageRead(root, (read) => [read($value), read($rows.keys)])).toEqual([
            { count: 0 },
            [],
          ]);
          stageUpdate(stage, (_read, write) => {
            write($value, { count: 2 });
          });
          expect(stageRead(stage, (read) => read($value).count)).toBe(2);
        } finally {
          dropStage(root);
        }
      });
    }
  }

  for (const changed of ["stage", "ancestor", "realm"] as const) {
    test(`a computed failure keeps its error until the ${changed} changes`, () => {
      using realm = testRealm();
      const $gate = box(realm, false);
      let runs = 0;
      const $failing = computed(realm, (read) => {
        runs++;
        if (!read($gate)) throw new Error(`failure ${runs}`);
        return 42;
      });
      const root = openStage(realm);
      const stage = changed === "ancestor" ? openStage(root) : root;
      const failure = () => {
        try {
          stageRead(stage, (read) => read($failing));
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
          update(realm, (_read, write) => {
            write($gate, true);
          });
        } else {
          stageUpdate(changed === "ancestor" ? root : stage, (_read, write) => {
            write($gate, true);
          });
        }
        expect(stageRead(stage, (read) => read($failing))).toBe(42);
        expect(runs).toBe(2);
      } finally {
        dropStage(root);
      }
    });
  }

  test("is evaluated over the stage's values, and the realm's computed value does not move", () => {
    using realm = testRealm();
    const $price = box(realm, 10);
    const $quantity = box(realm, 2);
    const $total = computed(realm, (read) => read($price) * read($quantity));
    using totals = record(realm, (read) => read($total));
    const stage = openStage(realm);
    stageUpdate(stage, (read, write) => {
      write($quantity, read($quantity) + 1);
      // The recipe decides on the total its own write made.
      if (read($total) > 25) {
        write($price, 9);
      }
    });
    expect(stageRead(stage, (read) => read($total))).toBe(27);
    expect(untracked(realm, (read) => read($total))).toBe(20);
    expect(totals.values).toEqual([]);
    applyStage(stage);
    expect(totals.values).toEqual([27]);
  });

  test("reads through computed values over computed values, and a computed function", () => {
    using realm = testRealm();
    const $count = box(realm, 1);
    const $double = computed(realm, (read) => read($count) * 2);
    const $quadruple = computed(realm, (read) => read($double) * 2);
    const times = computedFunction(realm, (read, factor: number) => read($count) * factor);
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write($count, 5);
    });
    expect(stageRead(stage, (read) => [read($quadruple), read(times(3))])).toEqual([20, 15]);
    dropStage(stage);
  });

  test("is cached until the stage writes or the realm changes", () => {
    using realm = testRealm();
    const $count = box(realm, 1);
    const $other = box(realm, 0);
    let runs = 0;
    const $double = computed(realm, (read) => {
      runs++;
      return read($count) * 2;
    });
    const stage = openStage(realm);
    stageRead(stage, (read) => [read($double), read($double), read($double)]);
    expect(runs).toBe(1);
    stageUpdate(stage, (read, write) => {
      write($count, read($double));
      // A write clears the cache: the next read sees it.
      expect(read($double)).toBe(4);
    });
    expect(runs).toBe(2);
    expect(stageRead(stage, (read) => read($double))).toBe(4);
    expect(runs).toBe(2);
    update(realm, (_read, write) => {
      write($other, 1);
    });
    // Not a snapshot: a write to the realm clears it too.
    expect(stageRead(stage, (read) => read($double))).toBe(4);
    expect(runs).toBe(3);
    dropStage(stage);
  });

  test("starts no onObserved source: a value nothing observes reads as it holds", () => {
    using realm = testRealm();
    const $feed = box(realm, 0);
    let started = 0;
    onObserved($feed, () => {
      started++;
      return undefined;
    });
    const $shown = computed(realm, (read) => read($feed) + 1);
    const stage = openStage(realm);
    expect(stageRead(stage, (read) => read($shown))).toBe(1);
    expect(started).toBe(0);
    dropStage(stage);
  });

  test("a computed value that reads itself through the stage throws a cycle", () => {
    using realm = testRealm();
    const $count = box(realm, 1);
    const $loop: { current?: ReturnType<typeof computed<number>> } = {};
    $loop.current = computed(
      realm,
      (read) => read($count) + read($loop.current as ReturnType<typeof computed<number>>),
      { name: "loop" },
    );
    const stage = openStage(realm);
    expect(() =>
      stageRead(stage, (read) => read($loop.current as ReturnType<typeof computed<number>>)),
    ).toThrow('pinna: "loop" is read while a stage evaluates it (cycle)');
    dropStage(stage);
  });

  test("an atom reads as undefined", () => {
    using realm = testRealm();
    const $feed = atom(realm);
    const stage = openStage(realm);
    expect(stageRead(stage, (read) => read($feed))).toBeUndefined();
    dropStage(stage);
  });
});

describe("a collection through a stage", () => {
  for (const changed of ["stage", "ancestor", "realm"] as const) {
    test(`rows keep their cached array until the ${changed} changes`, () => {
      using realm = testRealm();
      const $rows = collection<number, number>(realm, { keyOf: (row) => row });
      update(realm, (_read, write) => {
        write.replaceAll($rows, [1, 2]);
      });
      const root = openStage(realm);
      const stage = changed === "ancestor" ? openStage(root) : root;
      try {
        if (changed !== "realm") {
          stageUpdate(changed === "ancestor" ? root : stage, (_read, write) => {
            write.replaceAll($rows, [1, 2, 3]);
          });
        }
        const first = stageRead(stage, (read) => read($rows.rows));
        expect(stageRead(stage, (read) => read($rows.rows))).toBe(first);
        if (changed === "realm") {
          update(realm, (_read, write) => {
            write.upsert($rows, 4);
          });
        } else {
          stageUpdate(changed === "ancestor" ? root : stage, (_read, write) => {
            write.upsert($rows, 4);
          });
        }
        const next = stageRead(stage, (read) => read($rows.rows));
        expect(next).not.toBe(first);
        expect(next).toEqual(changed === "realm" ? [4, 1, 2] : [4, 1, 2, 3]);
        expect(stageRead(stage, (read) => read($rows.rows))).toBe(next);
      } finally {
        dropStage(root);
      }
    });
  }

  test("keys, rows, row, and read.row read the stage's rows; the realm keeps its own", () => {
    using realm = testRealm();
    const $items = items(realm);
    update(realm, (_read, write) => {
      write.replaceAll($items, [
        { id: "a", price: 1 },
        { id: "b", price: 2 },
      ]);
    });
    const $sum = computed(realm, (read) =>
      read($items.rows).reduce((total, item) => total + item.price, 0),
    );
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write.upsert($items, { id: "c", price: 3 }, { at: "end" });
      write.upsert($items, { id: "a", price: 10 });
      write.remove($items, "b");
    });
    expect(
      stageRead(stage, (read) => ({
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
    expect(untracked(realm, (read) => [read($items.keys), read($sum)])).toEqual([["a", "b"], 3]);
    applyStage(stage);
    expect(untracked(realm, (read) => [read($items.keys), read($sum)])).toEqual([["a", "c"], 13]);
  });

  test("a collection the stage did not write reads the realm's current rows", () => {
    using realm = testRealm();
    const $items = items(realm);
    const stage = openStage(realm);
    update(realm, (_read, write) => {
      write.upsert($items, { id: "a", price: 1 });
    });
    expect(stageRead(stage, (read) => [read($items.keys), read.row($items, "a")])).toEqual([
      ["a"],
      { id: "a", price: 1 },
    ]);
    dropStage(stage);
  });

  test("once written, the stage holds the collection's rows and order together", () => {
    using realm = testRealm();
    const $items = items(realm);
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write.upsert($items, { id: "a", price: 1 });
    });
    update(realm, (_read, write) => {
      write.upsert($items, { id: "z", price: 9 });
    });
    // The stage's copy was taken at its first write: its keys and rows agree.
    expect(stageRead(stage, (read) => [read($items.keys), read($items.rows)])).toEqual([
      ["a"],
      [{ id: "a", price: 1 }],
    ]);
    applyStage(stage);
    // The replay lands over the realm's rows at that moment.
    expect(untracked(realm, (read) => read($items.keys))).toEqual(["a", "z"]);
  });
});
