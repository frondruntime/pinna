import { describe, expect, test } from "bun:test";
import {
  atom,
  autorun,
  box,
  computed,
  computedFunction,
  createRealm,
  onObserved,
  type Read,
  untracked,
  update,
  watch,
} from "../src/index.ts";
import type { ObservableRealm } from "../src/internal/index.ts";
import { keptRead, keptWrite } from "./kept.ts";
import { expectRealmAtRest } from "./rest.ts";

const realm = createRealm();

interface Todo {
  readonly title: string;
  readonly done: boolean;
}

const collect = <Value>(
  select: (read: Read) => Value,
): { readonly seen: Array<Value>; stop(): void } => {
  const seen: Array<Value> = [];
  const stop = watch(realm, select, (value) => {
    seen.push(value);
  });
  return { seen, stop };
};

describe("read rule", () => {
  test("a read kept past its place throws", () => {
    const $count = box(realm, 1);
    const $double = computed(realm, (read) => read($count) * 2);
    const read = keptRead(realm);
    expect(() => read($count)).toThrow("runs outside a place");
    expect(() => read($double)).toThrow("runs outside a place");
    expectRealmAtRest(realm);
  });

  test("a read kept from a tracked place throws once that place has returned", () => {
    const $count = box(realm, 1);
    const kept: Array<Read> = [];
    const stop = autorun(realm, (read) => {
      kept.push(read);
      read($count);
    });
    const [read] = kept;
    expect(() => read?.($count)).toThrow("runs outside a place");
    stop();
    expectRealmAtRest(realm);
  });

  test("a kept read inside another place reads as that place's own read", () => {
    const $count = box(realm, 1);
    const read = keptRead(realm);
    const $double = computed(realm, () => read($count) * 2);
    const seen: Array<number> = [];
    const stop = watch(
      realm,
      (read) => read($double),
      (value) => {
        seen.push(value);
      },
    );
    update(realm, (_read, write) => write($count, 2));
    expect(seen).toEqual([4]);
    stop();
  });

  test("the read error names a named observable and says what to use instead", () => {
    const $count = box(realm, 1, { name: "Counter.count" });
    const $double = computed(realm, (read) => read($count) * 2, { name: "Counter.double" });
    const read = keptRead(realm);
    expect(() => read($count)).toThrow('pinna: read("Counter.count") runs outside a place');
    expect(() => read($double)).toThrow('read("Counter.double")');
    expect(() => read($count)).toThrow("In a component, use useValue($observable) or useSelect");
    expect(() => read($count)).toThrow("in a handler, untracked");
    expectRealmAtRest(realm);
  });

  test("computed, watch, update, and untracked may read", () => {
    const $count = box(realm, 1);
    const $double = computed(realm, (read) => read($count) * 2);
    const { seen, stop } = collect((read) => read($double));
    update(realm, (read, write) => {
      write($count, read($count) + 1);
    });
    expect(seen).toEqual([4]);
    expect(untracked(realm, (read) => read($double))).toBe(4);
    stop();
  });

  test("untracked subscribes nothing, even inside a tracked place", () => {
    const $count = box(realm, 1);
    const $other = box(realm, 10);
    const $double = computed(realm, (read) => read($count) * 2);
    const { seen, stop } = collect(
      (read) => read($other) + untracked(realm, (read) => read($count) + read($double)),
    );
    update(realm, (_read, write) => {
      write($count, 2);
    });
    expect(seen).toEqual([]);
    update(realm, (_read, write) => {
      write($other, 20);
    });
    expect(seen).toEqual([26]);
    stop();
  });

  test("a watch effect is untracked, so it reads through untracked", () => {
    const $count = box(realm, 1);
    let seen: unknown;
    const stop = watch(
      realm,
      (read) => read($count),
      () => {
        seen = untracked(realm, (read) => read($count));
      },
    );
    update(realm, (_read, write) => {
      write($count, 2);
    });
    expect(seen).toBe(2);
    stop();
  });
});

describe("write rule", () => {
  test("a write kept past its update throws", () => {
    const $count = box(realm, 1);
    const write = keptWrite(realm);
    expect(() => write($count, 2)).toThrow("write inside update");
    expectRealmAtRest(realm);
  });

  test("a computed value cannot write", () => {
    const $count = box(realm, 1);
    const write = keptWrite(realm);
    const $bad = computed(realm, () => {
      write($count, 2);
      return 0;
    });
    expect(() => update(realm, (read) => void read($bad))).toThrow(
      "cannot write while it computes",
    );
    expectRealmAtRest(realm);
  });

  const inComputed =
    "pinna: update cannot run in a computed value; write from an event, a watch's effect, or an autorun";
  const inSelect =
    "pinna: update cannot run in a watch's select or a selector; write from an event, a watch's effect, or an autorun";

  test("update cannot run in a computed value", () => {
    const $count = box(realm, 1);
    const $bad = computed(realm, (read) => {
      update(realm, () => undefined);
      return read($count);
    });
    expect(() => untracked(realm, (read) => read($bad))).toThrow(inComputed);
    expectRealmAtRest(realm);
  });

  test("update cannot run in a computed function's value", () => {
    const $count = box(realm, 1);
    const $bad = computedFunction(realm, (read, offset: number) => {
      update(realm, () => undefined);
      return read($count) + offset;
    });
    expect(() => untracked(realm, (read) => read($bad(1)))).toThrow(inComputed);
    expectRealmAtRest(realm);
  });

  test("update cannot run in a watch's select", () => {
    const $count = box(realm, 1);
    expect(() =>
      watch(
        realm,
        (read) => {
          update(realm, () => undefined);
          return read($count);
        },
        () => undefined,
      ),
    ).toThrow(inSelect);
    expectRealmAtRest(realm);
  });

  test("a computed value an autorun reads still cannot update", () => {
    const errors: Array<unknown> = [];
    const own = createRealm({ onError: (error) => errors.push(error) });
    const $count = box(own, 1);
    const $bad = computed(own, (read) => {
      update(own, () => undefined);
      return read($count);
    });
    let caught: unknown;
    const stop = autorun(own, (read) => {
      try {
        read($bad);
      } catch (error) {
        caught = error;
      }
    });
    expect(String(caught)).toBe(`Error: ${inComputed}`);
    expect(errors).toEqual([]);
    stop();
    expectRealmAtRest(own);
  });

  test("a watch an autorun makes still cannot update in its select", () => {
    const own = createRealm();
    const $count = box(own, 1);
    let caught: unknown;
    const stop = autorun(own, () => {
      try {
        watch(
          own,
          (read) => {
            update(own, () => undefined);
            return read($count);
          },
          () => undefined,
        );
      } catch (error) {
        caught = error;
      }
    });
    expect(String(caught)).toBe(`Error: ${inSelect}`);
    stop();
    expectRealmAtRest(own);
  });

  test("an async recipe throws", () => {
    const recipe = (async () => {}) as unknown as () => undefined;
    expect(() => update(realm, recipe)).toThrow("update recipes are synchronous");
    expectRealmAtRest(realm);
  });

  test("watchers see an update's end state once", () => {
    const $first = box(realm, 1);
    const $second = box(realm, 1);
    const { seen, stop } = collect((read) => read($first) + read($second));
    update(realm, (_read, write) => {
      write($first, 2);
      update(realm, (_read, write) => {
        write($second, 3);
      });
    });
    expect(seen).toEqual([5]);
    stop();
  });

  test("a rolled-back update reruns no autorun", () => {
    const $count = box(realm, 0);
    let runs = 0;
    const stop = autorun(realm, (read) => {
      runs++;
      read($count);
    });
    expect(() =>
      update(realm, (_read, write) => {
        write($count, 1);
        throw new Error("abandoned");
      }),
    ).toThrow("abandoned");
    expect(untracked(realm, (read) => read($count))).toBe(0);
    expect(runs).toBe(1);
    stop();
    expectRealmAtRest(realm);
  });

  test("a value written back before the throw reruns no autorun", () => {
    const $count = box(realm, 0);
    let runs = 0;
    const stop = autorun(realm, (read) => {
      runs++;
      read($count);
    });
    expect(() =>
      update(realm, (_read, write) => {
        write($count, 1);
        write($count, 0);
        throw new Error("abandoned");
      }),
    ).toThrow("abandoned");
    expect(runs).toBe(1);
    stop();
    expectRealmAtRest(realm);
  });

  test("a value written back within one update reruns no autorun", () => {
    const $count = box(realm, 0);
    let runs = 0;
    const stop = autorun(realm, (read) => {
      runs++;
      read($count);
    });
    update(realm, (_read, write) => {
      write($count, 1);
      write($count, 0);
    });
    expect(runs).toBe(1);
    update(realm, (_read, write) => {
      write($count, 5);
    });
    expect(runs).toBe(2);
    stop();
  });

  test("a value written back across nested updates reruns no autorun", () => {
    const $count = box(realm, 0);
    let runs = 0;
    const stop = autorun(realm, (read) => {
      runs++;
      read($count);
    });
    update(realm, () => {
      update(realm, (_read, write) => {
        write($count, 1);
      });
      update(realm, (_read, write) => {
        write($count, 0);
      });
    });
    expect(runs).toBe(1);
    stop();
  });

  // The box gets back the version it had, so only a reader that read the
  // value in between has something new to read.
  test("a computed read in between follows a value written back", () => {
    const $count = box(realm, 0);
    let computes = 0;
    const $double = computed(realm, (read) => {
      computes++;
      return read($count) * 2;
    });
    expect(untracked(realm, (read) => read($double))).toBe(0);
    update(realm, (read, write) => {
      write($count, 1);
      expect(read($double)).toBe(2);
      write($count, 0);
    });
    expect(untracked(realm, (read) => read($double))).toBe(0);
    expect(computes).toBe(3);
  });

  test("a nested update that fails puts back only what it wrote", () => {
    const $first = box(realm, 0);
    const $second = box(realm, 0);
    update(realm, (read, write) => {
      write($first, 1);
      expect(() =>
        update(realm, (_read, write) => {
          write($first, 2);
          write($second, 2);
          update(realm, (_read, write) => {
            write($second, 3);
          });
          throw new Error("abandoned");
        }),
      ).toThrow("abandoned");
      expect([read($first), read($second)]).toEqual([1, 0]);
      write($second, 4);
    });
    expect(untracked(realm, (read) => [read($first), read($second)])).toEqual([1, 4]);
    expectRealmAtRest(realm);
  });

  test("an update after a failed nested one rolls back from where it began", () => {
    const $count = box(realm, 0);
    const $other = box(realm, 0);
    expect(() =>
      update(realm, (_read, write) => {
        write($count, 1);
        expect(() =>
          update(realm, (_read, write) => {
            write($other, 1);
            throw new Error("inner");
          }),
        ).toThrow("inner");
        write($other, 2);
        write($count, 3);
        throw new Error("outer");
      }),
    ).toThrow("outer");
    expect(untracked(realm, (read) => [read($count), read($other)])).toEqual([0, 0]);
    expectRealmAtRest(realm);
  });

  test("a box first written in a failed nested update is put back by the outer one", () => {
    const $count = box(realm, 0);
    const $other = box(realm, 0);
    expect(() =>
      update(realm, (_read, write) => {
        expect(() =>
          update(realm, (_read, write) => {
            write($count, 1);
            throw new Error("inner");
          }),
        ).toThrow("inner");
        write($other, 1);
        write($count, 2);
        throw new Error("outer");
      }),
    ).toThrow("outer");
    expect(untracked(realm, (read) => [read($count), read($other)])).toEqual([0, 0]);
    expectRealmAtRest(realm);
  });

  test("a computed read inside a rolled-back update follows a later write", () => {
    const $count = box(realm, 0);
    const $double = computed(realm, (read) => read($count) * 2);
    expect(() =>
      update(realm, (read, write) => {
        write($count, 1);
        expect(read($double)).toBe(2);
        throw new Error("abandoned");
      }),
    ).toThrow("abandoned");
    expect(untracked(realm, (read) => read($double))).toBe(0);
    update(realm, (_read, write) => {
      write($count, 5);
    });
    expect(untracked(realm, (read) => read($double))).toBe(10);
    expectRealmAtRest(realm);
  });

  test("a box an undo writes during a rollback is put back when the outer update fails", () => {
    const realm = createRealm();
    const $first = box(realm, 1);
    const $other = box(realm, 10);
    const $sum = computed(realm, (read) => read($first) + read($other));
    const seen: Array<ReadonlyArray<number>> = [];
    const stop = watch(
      realm,
      (read) => [read($first), read($other)],
      (value) => {
        seen.push(value);
      },
    );
    expect(() =>
      update(realm, (read, write) => {
        write($first, 2);
        expect(() =>
          update(realm, () => {
            // The undo writes a box the outermost update has not recorded.
            (realm as ObservableRealm).recordUndo(() => {
              write($other, 20);
            });
            throw new Error("inner");
          }),
        ).toThrow("inner");
        expect([read($first), read($other), read($sum)]).toEqual([2, 20, 22]);
        throw new Error("outer");
      }),
    ).toThrow("outer");
    expect(untracked(realm, (read) => [read($first), read($other), read($sum)])).toEqual([
      1, 10, 11,
    ]);
    expect(seen).toEqual([]);
    expectRealmAtRest(realm);
    // A later update records the box anew: its failure puts back 10.
    expect(() =>
      update(realm, (_read, write) => {
        write($other, 30);
        throw new Error("later");
      }),
    ).toThrow("later");
    expect(untracked(realm, (read) => read($other))).toBe(10);
    update(realm, (_read, write) => {
      write($other, 30);
    });
    expect(untracked(realm, (read) => [read($other), read($sum)])).toEqual([30, 31]);
    expect(seen).toEqual([[1, 30]]);
    stop();
    expectRealmAtRest(realm);
  });

  test.each([
    { order: "after the box's write", undoFirst: false, settled: 0 },
    { order: "before the box's write", undoFirst: true, settled: 7 },
  ])("an undo recorded $order writes a box the same rollback restores", ({
    undoFirst,
    settled,
  }) => {
    const realm = createRealm();
    const $first = box(realm, 1);
    const $box = box(realm, 0);
    const $double = computed(realm, (read) => read($box) * 2);
    const seen: Array<number> = [];
    const stop = watch(
      realm,
      (read) => read($box),
      (value) => {
        seen.push(value);
      },
    );
    update(realm, (read, write) => {
      write($first, 2);
      expect(() =>
        update(realm, (_read, write) => {
          const undo = (): void => {
            write($box, 7);
          };
          if (undoFirst) {
            (realm as ObservableRealm).recordUndo(undo);
            write($box, 5);
          } else {
            write($box, 5);
            (realm as ObservableRealm).recordUndo(undo);
          }
          throw new Error("inner");
        }),
      ).toThrow("inner");
      // The rollback runs its steps in the reverse of the order they were recorded in.
      expect([read($box), read($double)]).toEqual([settled, settled * 2]);
    });
    expect(untracked(realm, (read) => [read($first), read($box), read($double)])).toEqual([
      2,
      settled,
      settled * 2,
    ]);
    expect(seen).toEqual(settled === 0 ? [] : [settled]);
    expectRealmAtRest(realm);
    // A later update records the box anew: its failure puts back what the
    // first update left.
    expect(() =>
      update(realm, (_read, write) => {
        write($box, 9);
        throw new Error("later");
      }),
    ).toThrow("later");
    expect(untracked(realm, (read) => read($box))).toBe(settled);
    update(realm, (_read, write) => {
      write($box, 9);
    });
    expect(untracked(realm, (read) => [read($box), read($double)])).toEqual([9, 18]);
    expect(seen).toEqual(settled === 0 ? [9] : [settled, 9]);
    stop();
    expectRealmAtRest(realm);
  });
});

describe("plain values", () => {
  test("a value is not frozen when it enters a box", () => {
    const todos = [{ title: "a", done: false }];
    box<ReadonlyArray<Todo>>(realm, todos);
    expect(Object.isFrozen(todos)).toBe(false);
    expect(Object.isFrozen(todos[0])).toBe(false);
  });
});

describe("write.modify", () => {
  test("an assigned child from another box stays isolated through rollback and commit", () => {
    const original = { name: "old" };
    const before = { row: { name: "b" }, rows: [] as ReadonlyArray<{ name: string }> };
    const $source = box(realm, original);
    const $target = box(realm, before);
    let notifications = 0;
    const stop = watch(
      realm,
      (read) => read($source).name,
      () => {
        notifications++;
      },
    );
    const abort = new Error("rollback");
    const modify = (): void =>
      update(realm, (read, write) => {
        write.modify($target, (draft) => {
          draft.row = read($source);
          draft.row.name = "new";
          draft.rows = [read($source)];
          draft.rows.push({ name: "added" });
        });
      });
    expect(() =>
      update(realm, () => {
        modify();
        throw abort;
      }),
    ).toThrow(abort);
    expect(original.name).toBe("old");
    expect(untracked(realm, (read) => read($source))).toBe(original);
    expect(untracked(realm, (read) => read($target))).toBe(before);
    expect(before.row.name).toBe("b");
    expect(notifications).toBe(0);
    modify();
    const after = untracked(realm, (read) => read($target));
    expect(original.name).toBe("old");
    expect(after.row).toEqual({ name: "new" });
    expect(after.row).not.toBe(original);
    expect(after.rows).toEqual([original, { name: "added" }]);
    expect(notifications).toBe(0);
    stop();
  });

  test("an assigned child only read in a draft keeps its supplied identity", () => {
    const supplied = { name: "supplied" };
    const $target = box(realm, { row: { name: "before" } });
    update(realm, (_read, write) => {
      write.modify($target, (draft) => {
        draft.row = supplied;
        expect(draft.row.name).toBe("supplied");
        expect(draft.row).toBe(draft.row);
      });
    });
    expect(untracked(realm, (read) => read($target).row)).toBe(supplied);
  });

  test("writes through a draft; unchanged items keep their identity", () => {
    const $todos = box<ReadonlyArray<Todo>>(realm, [
      { title: "a", done: false },
      { title: "b", done: false },
    ]);
    const before = untracked(realm, (read) => read($todos));
    update(realm, (_read, write) => {
      write.modify($todos, (todos) => {
        const first = todos[0];
        if (first !== undefined) {
          first.done = true;
        }
        todos.push({ title: "c", done: false });
      });
    });
    const after = untracked(realm, (read) => read($todos));
    expect(after).not.toBe(before);
    expect(after).toEqual([
      { title: "a", done: true },
      { title: "b", done: false },
      { title: "c", done: false },
    ]);
    expect(after[1]).toBe(before[1]);
    expect(before).toEqual([
      { title: "a", done: false },
      { title: "b", done: false },
    ]);
  });

  test("a cycle in a value written through a draft ends", () => {
    const $node = box<{ readonly items: ReadonlyArray<unknown> }>(realm, { items: [] });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    update(realm, (_read, write) => {
      write.modify($node, (node) => {
        node.items.push(cyclic);
      });
    });
    expect(untracked(realm, (read) => read($node).items[0])).toBe(cyclic);
  });

  test("finalizing an appended frozen object preserves its identity", () => {
    const frozen = Object.freeze({ price: 3 });
    const $rows = box<ReadonlyArray<{ readonly price: number }>>(realm, []);
    update(realm, (_read, write) => {
      write.modify($rows, (rows) => {
        rows.push(frozen);
      });
    });
    expect(untracked(realm, (read) => read($rows)[0])).toBe(frozen);
  });

  test("a finalized draft self-reference points to its result", () => {
    interface Row {
      readonly child: Row | null;
    }
    const before: Row = { child: null };
    const $row = box(realm, before);
    update(realm, (_read, write) => {
      write.modify($row, (row) => {
        row.child = row;
      });
    });
    const result = untracked(realm, (read) => read($row));
    expect(result.child).toBe(result);
    expect(before.child).toBeNull();
  });

  test("finalization copies supplied containers only to replace nested drafts", () => {
    const unchanged = Object.freeze({ price: 3 });
    const $row = box<{ readonly price: number; readonly child: unknown }>(realm, {
      price: 1,
      child: null,
    });
    let supplied: { self?: unknown; row: unknown; unchanged: unknown } | undefined;
    update(realm, (_read, write) => {
      write.modify($row, (row) => {
        supplied = { self: undefined, row, unchanged };
        supplied.self = supplied;
        Object.freeze(supplied);
        row.child = supplied;
      });
    });
    const result = untracked(realm, (read) => read($row));
    const child = result.child as NonNullable<typeof supplied>;
    expect(child).not.toBe(supplied);
    expect(child.self).toBe(child);
    expect(child.row).toBe(result);
    expect(child.unchanged).toBe(unchanged);
    expect(supplied?.self).toBe(supplied);
    expect(supplied?.row).not.toBe(result);
  });

  test("filter on a draft keeps the kept items", () => {
    const $todos = box<{ readonly items: ReadonlyArray<Todo> }>(realm, {
      items: [
        { title: "a", done: true },
        { title: "b", done: false },
      ],
    });
    const kept = untracked(realm, (read) => read($todos).items[1]);
    update(realm, (_read, write) => {
      write.modify($todos, (todos) => {
        todos.items = todos.items.filter((todo) => !todo.done);
      });
    });
    expect(untracked(realm, (read) => read($todos).items)).toEqual([{ title: "b", done: false }]);
    expect(untracked(realm, (read) => read($todos).items[0])).toBe(kept);
  });

  test("an item read twice in a recipe stays one draft", () => {
    const $todos = box<ReadonlyArray<Todo>>(realm, [{ title: "a", done: false }]);
    update(realm, (_read, write) => {
      write.modify($todos, (todos) => {
        const first = todos[0];
        if (first !== undefined) {
          first.done = true;
        }
        expect(todos[0]).toBe(first);
        expect(Reflect.ownKeys(todos)).toEqual(["0", "length"]);
      });
    });
    expect(untracked(realm, (read) => read($todos))).toEqual([{ title: "a", done: true }]);
  });

  test("a no-op child read has constant indexed reads at 1000 and 10000 rows", () => {
    const indexedReads = [1000, 10000].map((length) => {
      let reads = 0;
      const original = new Proxy(
        Array.from({ length }, (_, id) => ({ id })),
        {
          get(target, key, receiver) {
            if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) {
              reads++;
            }
            return Reflect.get(target, key, receiver);
          },
        },
      );
      const $rows = box(realm, original);
      update(realm, (_read, write) => {
        write.modify($rows, (rows) => {
          expect(rows[0]?.id).toBe(0);
          expect(rows[0]).toBe(rows[0]);
        });
      });
      expect(untracked(realm, (read) => read($rows))).toBe(original);
      return reads;
    });
    expect(indexedReads[0]).toBeLessThanOrEqual(4);
    expect(indexedReads[1]).toBe(indexedReads[0]);
  });

  test("cached child drafts follow shift, unshift, and splice before their first write", () => {
    const original = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const $rows = box(realm, original);
    update(realm, (_read, write) => {
      write.modify($rows, (rows) => {
        const second = rows[1];
        rows.shift();
        expect(rows[0]).toBe(second);
        rows.unshift({ id: 4 });
        expect(rows[1]).toBe(second);
        rows.splice(0, 1, { id: 5 }, { id: 6 });
        expect(rows[2]).toBe(second);
        if (second !== undefined) {
          second.id = 20;
        }
      });
    });
    expect(untracked(realm, (read) => read($rows))).toEqual([
      { id: 5 },
      { id: 6 },
      { id: 20 },
      { id: 3 },
    ]);
    expect(original).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(untracked(realm, (read) => read($rows)[3])).toBe(original[2]);
  });

  test("a property descriptor gives the cached child draft, with its writes", () => {
    const original = { row: { id: 1 } };
    const $state = box(realm, original);
    update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        const row = draft.row;
        row.id = 2;
        const descriptor = Object.getOwnPropertyDescriptor(draft, "row");
        expect(descriptor?.value).toBe(row);
        expect(descriptor?.value.id).toBe(2);
      });
    });
    expect(untracked(realm, (read) => read($state))).toEqual({ row: { id: 2 } });
    expect(original.row.id).toBe(1);
  });

  test("items moved by sort, splice, and shift leave no draft behind", () => {
    const $todos = box<ReadonlyArray<Todo>>(realm, [
      { title: "c", done: false },
      { title: "a", done: false },
      { title: "d", done: false },
      { title: "b", done: false },
    ]);
    const before = untracked(realm, (read) => read($todos));
    update(realm, (_read, write) => {
      write.modify($todos, (todos) => {
        const third = todos[2];
        if (third !== undefined) {
          third.done = true;
        }
        todos.sort((left, right) => left.title.localeCompare(right.title));
        todos.splice(1, 1);
        todos.shift();
        delete todos[5];
      });
    });
    const after = untracked(realm, (read) => read($todos));
    expect(after).toEqual([
      { title: "c", done: false },
      { title: "d", done: true },
    ]);
    expect(after[0]).toBe(before[0]);
    expect(Object.hasOwn(after, 5)).toBe(false);
  });

  test("shift, splice, and unshift read only the elements they remove", () => {
    let reads = 0;
    const counted = (id: number): object =>
      new Proxy(
        { id },
        {
          get: (target, key) => {
            reads++;
            return Reflect.get(target, key);
          },
          has: (target, key) => {
            reads++;
            return Reflect.has(target, key);
          },
          getPrototypeOf: (target) => {
            reads++;
            return Reflect.getPrototypeOf(target);
          },
        },
      );
    const $rows = box<ReadonlyArray<unknown>>(
      realm,
      Array.from({ length: 1000 }, (_, id) => counted(id)),
    );
    let readsInRecipe = -1;
    update(realm, (_read, write) => {
      write.modify($rows, (rows) => {
        reads = 0;
        rows.shift();
        rows.splice(0, 1, { id: -1 });
        rows.unshift({ id: -2 });
        readsInRecipe = reads;
      });
    });
    expect(readsInRecipe).toBeLessThan(10);
    expect(untracked(realm, (read) => read($rows)).length).toBe(1000);
  });

  test("writes through rows that shift, splice, and unshift move or remove never reach the held value", () => {
    interface Row {
      readonly id: string;
      readonly price: number;
    }
    const $book = box<{ readonly rows: ReadonlyArray<Row> }>(realm, {
      rows: [
        { id: "a", price: 1 },
        { id: "b", price: 2 },
        { id: "c", price: 3 },
        { id: "d", price: 4 },
        { id: "e", price: 5 },
      ],
    });
    const held = untracked(realm, (read) => read($book));
    const snapshot = structuredClone(held);
    update(realm, (_read, write) => {
      write.modify($book, (book) => {
        const shifted = book.rows.shift();
        if (shifted !== undefined) {
          shifted.price = -1;
        }
        const moved = book.rows[0];
        if (moved !== undefined) {
          moved.price = 20;
        }
        for (const removed of book.rows.splice(1, 2)) {
          removed.price = -1;
        }
        book.rows.unshift({ id: "z", price: 0 });
        const last = book.rows[2];
        if (last !== undefined) {
          last.price = 50;
        }
      });
    });
    expect(held).toEqual(snapshot);
    const after = untracked(realm, (read) => read($book));
    expect(after.rows).toEqual([
      { id: "z", price: 0 },
      { id: "b", price: 20 },
      { id: "e", price: 50 },
    ]);
  });

  test("shift, splice, and unshift on a draft return and leave what they do on an array", () => {
    const run = (rows: Array<{ id: number }>): Array<unknown> => [
      rows.shift(),
      rows.splice(-2, 1),
      rows.splice(1, -1, { id: 10 }),
      rows.splice(-20, 1.7, { id: 11 }, { id: 12 }),
      rows.unshift({ id: 13 }, { id: 14 }),
      rows.splice(2.5, 1),
      rows.splice(30, 1, { id: 15 }),
      rows.splice(6),
      Reflect.apply(rows.splice, rows, []),
    ];
    const start = (): Array<{ id: number }> => Array.from({ length: 9 }, (_, id) => ({ id }));
    const expected = start();
    const results = JSON.stringify(run(expected));
    const $rows = box<ReadonlyArray<{ readonly id: number }>>(realm, start());
    let draftResults = "";
    update(realm, (_read, write) => {
      write.modify($rows, (rows) => {
        draftResults = JSON.stringify(run(rows));
      });
    });
    expect(draftResults).toBe(results);
    expect(untracked(realm, (read) => read($rows))).toEqual(expected);
  });

  test("pop, delete, and a shorter length between moves leave the held value intact", () => {
    const run = (rows: Array<{ id: number }>): Array<unknown> => {
      const results: Array<unknown> = [rows.pop()];
      delete rows[2];
      rows.shift();
      rows.length = 5;
      results.push(rows.splice(0, 1), rows.unshift({ id: 20 }));
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        if (row !== undefined) {
          row.id += 100;
        }
      }
      return results;
    };
    const start = (): Array<{ id: number }> => Array.from({ length: 8 }, (_, id) => ({ id }));
    const expected = start();
    const results = JSON.stringify(run(expected));
    const $rows = box<ReadonlyArray<{ readonly id: number } | undefined>>(realm, start());
    const held = untracked(realm, (read) => read($rows));
    const snapshot = structuredClone(held);
    let draftResults = "";
    update(realm, (_read, write) => {
      write.modify($rows, (rows) => {
        draftResults = JSON.stringify(run(rows as Array<{ id: number }>));
      });
    });
    expect(draftResults).toBe(results);
    expect(JSON.stringify(untracked(realm, (read) => read($rows)))).toBe(JSON.stringify(expected));
    expect(held).toEqual(snapshot);
  });

  test("a row spliced out and put back keeps its identity, or its write when written", () => {
    const $todos = box<ReadonlyArray<Todo>>(realm, [
      { title: "a", done: false },
      { title: "b", done: false },
      { title: "c", done: false },
      { title: "d", done: false },
    ]);
    const before = untracked(realm, (read) => read($todos));
    update(realm, (_read, write) => {
      write.modify($todos, (todos) => {
        todos.unshift(...todos.splice(3, 1));
      });
    });
    const moved = untracked(realm, (read) => read($todos));
    expect(moved[0]).toBe(before[3]);
    expect(moved[1]).toBe(before[0]);
    update(realm, (_read, write) => {
      write.modify($todos, (todos) => {
        const [row] = todos.splice(2, 1);
        if (row !== undefined) {
          row.done = true;
          todos.unshift(row);
        }
      });
    });
    const after = untracked(realm, (read) => read($todos));
    expect(JSON.stringify(after)).toBe(
      JSON.stringify([
        { title: "b", done: true },
        { title: "d", done: false },
        { title: "a", done: false },
        { title: "c", done: false },
      ]),
    );
    expect(after[1]).toBe(before[3]);
    expect(before[1]).toEqual({ title: "b", done: false });
  });

  test("a written row moved down by removals before it keeps its write", () => {
    const $todos = box<ReadonlyArray<Todo>>(realm, [
      { title: "a", done: false },
      { title: "b", done: false },
      { title: "c", done: false },
      { title: "d", done: false },
      { title: "e", done: false },
    ]);
    const before = untracked(realm, (read) => read($todos));
    update(realm, (_read, write) => {
      write.modify($todos, (todos) => {
        const fourth = todos[3];
        if (fourth !== undefined) {
          fourth.done = true;
        }
        todos.shift();
        todos.splice(0, 1);
      });
    });
    const after = untracked(realm, (read) => read($todos));
    expect(after).toEqual([
      { title: "c", done: false },
      { title: "d", done: true },
      { title: "e", done: false },
    ]);
    expect(after[0]).toBe(before[2]);
    expect(after[2]).toBe(before[4]);
    expect(before[3]).toEqual({ title: "d", done: false });
  });

  test("rows that shift and push move keep their identity", () => {
    const $todos = box<ReadonlyArray<Todo>>(realm, [
      { title: "a", done: false },
      { title: "b", done: false },
      { title: "c", done: false },
    ]);
    const before = untracked(realm, (read) => read($todos));
    update(realm, (_read, write) => {
      write.modify($todos, (todos) => {
        todos.shift();
        todos.push({ title: "d", done: false });
      });
    });
    const after = untracked(realm, (read) => read($todos));
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[2]);
    expect(after[2]).toEqual({ title: "d", done: false });
  });

  test("shift on an empty draft keeps the value", () => {
    const $todos = box<ReadonlyArray<Todo>>(realm, []);
    const before = untracked(realm, (read) => read($todos));
    let shifted: unknown = null;
    update(realm, (_read, write) => {
      write.modify($todos, (todos) => {
        shifted = todos.shift();
      });
    });
    expect(shifted).toBeUndefined();
    expect(untracked(realm, (read) => read($todos))).toBe(before);
  });

  test("a recipe that writes nothing keeps the value", () => {
    const $todos = box<ReadonlyArray<Todo>>(realm, [{ title: "a", done: false }]);
    const before = untracked(realm, (read) => read($todos));
    update(realm, (_read, write) => {
      write.modify($todos, (todos) => {
        void todos[0]?.title;
      });
    });
    expect(untracked(realm, (read) => read($todos))).toBe(before);
  });

  test("a draft used after its recipe throws", () => {
    const $todos = box<ReadonlyArray<Todo>>(realm, [{ title: "a", done: false }]);
    let leaked: Array<{ title: string; done: boolean }> | undefined;
    update(realm, (_read, write) => {
      write.modify($todos, (todos) => {
        leaked = todos;
      });
    });
    expect(() => leaked?.push({ title: "b", done: false })).toThrow("used after its recipe");
    expectRealmAtRest(realm);
  });

  describe("a Date, Map or Set is not drafted", () => {
    interface Held {
      readonly at: Date;
      readonly due: ReadonlyMap<string, Date>;
      readonly seen: ReadonlySet<string>;
      readonly links: Map<string, number>;
      readonly tags: Set<string>;
    }
    const held = () => ({
      at: new Date(1),
      due: new Map([["a", new Date(2)]]),
      seen: new Set(["x"]),
      links: new Map([["a", 1]]),
      tags: new Set(["t"]),
    });

    test("a write in place goes unseen, so the draft's types leave it read-only", () => {
      const $held = box<Held>(realm, held());
      const before = untracked(realm, (read) => read($held));
      update(realm, (_read, write) => {
        write.modify($held, (draft) => {
          expect(draft.at.getTime()).toBe(1);
          expect(draft.due.get("a")?.getTime()).toBe(2);
          // @ts-expect-error A Date is not drafted; assign a new Date.
          draft.at.setTime(5);
          // @ts-expect-error A Date in a map is not drafted; assign a new map.
          draft.due.get("a")?.setTime(6);
          // @ts-expect-error A Map is not drafted; assign a new Map.
          draft.links.set("b", 2);
          // @ts-expect-error A Set is not drafted; assign a new Set.
          draft.tags.add("u");
        });
      });
      expect(untracked(realm, (read) => read($held))).toBe(before);
      expectRealmAtRest(realm);
    });

    test("a draft replaces one, and the held value keeps its contents", () => {
      const $held = box<Held>(realm, held());
      const before = untracked(realm, (read) => read($held));
      update(realm, (_read, write) => {
        write.modify($held, (draft) => {
          draft.at = new Date(draft.at.getTime() + 1);
          draft.due = new Map([...draft.due, ["b", new Date(3)]]);
          draft.links = new Map([...draft.links, ["b", 2]]);
          draft.tags = new Set([...draft.tags, "u"]);
        });
      });
      const after = untracked(realm, (read) => read($held));
      expect(after.at.getTime()).toBe(2);
      expect([...after.due.keys()]).toEqual(["a", "b"]);
      expect([...after.links]).toEqual([
        ["a", 1],
        ["b", 2],
      ]);
      expect([...after.tags]).toEqual(["t", "u"]);
      expect(after.seen).toBe(before.seen);
      expect(before.at.getTime()).toBe(1);
      expect(before.due.size).toBe(1);
      expect(before.links.size).toBe(1);
      expect(before.tags.size).toBe(1);
      expectRealmAtRest(realm);
    });
  });

  test("a primitive is written whole with write", () => {
    const $count = box(realm, 1);
    expect(() =>
      update(realm, (_read, write) => {
        write.modify($count, () => undefined);
      }),
    ).toThrow("write other values whole with write($box, value)");
    expectRealmAtRest(realm);
  });
});

describe("onObserved", () => {
  test("starts with the first observer and stops with the last", () => {
    const $count = box(realm, 1);
    const events: Array<string> = [];
    onObserved($count, () => {
      events.push("start");
      return () => events.push("stop");
    });
    const stop = watch(
      realm,
      (read) => read($count),
      () => {},
    );
    stop();
    expect(events).toEqual(["start", "stop"]);
  });
});

describe("atom", () => {
  test("an atom read inside a computed value is tracked, and write.changed reruns it", () => {
    const $source = atom(realm);
    let outside = 1;
    const $read = computed(realm, (read) => {
      read($source);
      return outside;
    });
    const { seen, stop } = collect((read) => read($read));
    outside = 2;
    update(realm, (_read, write) => {
      write.changed($source);
    });
    expect(seen).toEqual([2]);
    stop();
  });

  test("an atom read untracked does nothing and does not throw", () => {
    const $source = atom(realm);
    expect(() => untracked(realm, (read) => read($source))).not.toThrow();
    expectRealmAtRest(realm);
  });

  test("an atom read inside untracked does not subscribe", () => {
    const $source = atom(realm);
    let runs = 0;
    const stop = watch(
      realm,
      () => {
        runs++;
        untracked(realm, (read) => read($source));
        return runs;
      },
      () => {},
    );
    update(realm, (_read, write) => {
      write.changed($source);
    });
    expect(runs).toBe(1);
    stop();
  });

  test("write.changed kept past its update throws, outside an update and inside a computed value", () => {
    const $source = atom(realm);
    const write = keptWrite(realm);
    expect(() => write.changed($source)).toThrow("write inside update");
    const $bad = computed(realm, () => {
      write.changed($source);
      return 1;
    });
    expect(() => untracked(realm, (read) => read($bad))).toThrow();
    expectRealmAtRest(realm);
  });

  test("onObserved starts with the first observer and stops with the last", () => {
    const $source = atom(realm);
    const events: Array<string> = [];
    onObserved($source, () => {
      events.push("start");
      return () => events.push("stop");
    });
    untracked(realm, (read) => read($source));
    expect(events).toEqual([]);
    const stop = watch(
      realm,
      (read) => read($source),
      () => {},
    );
    expect(events).toEqual(["start"]);
    stop();
    expect(events).toEqual(["start", "stop"]);
  });

  test("an outside source reports through an atom while observed", () => {
    let value = 0;
    const listeners = new Set<() => void>();
    const emit = (next: number): void => {
      value = next;
      for (const listener of listeners) {
        listener();
      }
    };
    const $source = atom(realm);
    onObserved($source, () => {
      const listener = (): void =>
        update(realm, (_read, write) => {
          write.changed($source);
        });
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const $value = computed(realm, (read) => {
      read($source);
      return value;
    });
    const { seen, stop } = collect((read) => read($value));
    emit(1);
    emit(2);
    expect(seen).toEqual([1, 2]);
    stop();
    expect(listeners.size).toBe(0);
    emit(3);
    expect(untracked(realm, (read) => read($value))).toBe(3);
  });

  test("a computed value over an atom reads fresh while nothing observes it", () => {
    let value = 1;
    const $source = atom(realm);
    const $value = computed(realm, (read) => {
      read($source);
      return value;
    });
    const $double = computed(realm, (read) => read($value) * 2);
    expect(untracked(realm, (read) => read($double))).toBe(2);
    value = 2;
    expect(untracked(realm, (read) => read($double))).toBe(4);
  });

  test("write.changed inside a batch notifies once at its end", () => {
    const $source = atom(realm);
    let runs = 0;
    const stop = watch(
      realm,
      (read) => {
        read($source);
        return ++runs;
      },
      () => {},
    );
    update(realm, (_read, write) => {
      write.changed($source);
      write.changed($source);
    });
    expect(runs).toBe(2);
    stop();
  });
});
