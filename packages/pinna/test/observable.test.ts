import { describe, expect, test } from "bun:test";
import { Atom, Box, Computed, type Read, Realm, Source } from "../src/index.ts";
import { keptRead, keptWrite } from "./kept.ts";
import { expectRealmAtRest } from "./rest.ts";

const realm = Realm.make();

interface Todo {
  readonly title: string;
  readonly done: boolean;
}

const collect = <Value>(
  select: (read: Read) => Value,
): { readonly seen: Array<Value>; stop(): void } => {
  const seen: Array<Value> = [];
  const stop = Realm.watch(realm, select, (value) => {
    seen.push(value);
  });
  return { seen, stop };
};

describe("read rule", () => {
  test("a read kept past its place throws", () => {
    const $count = Box.make(realm, 1);
    const $double = Computed.make(realm, (read) => read($count) * 2);
    const read = keptRead(realm);
    expect(() => read($count)).toThrow("runs outside a place");
    expect(() => read($double)).toThrow("runs outside a place");
    expectRealmAtRest(realm);
  });

  test("a read kept from a tracked place throws once that place has returned", () => {
    const $count = Box.make(realm, 1);
    const kept: Array<Read> = [];
    const stop = Realm.autorun(realm, (read) => {
      kept.push(read);
      read($count);
    });
    const [read] = kept;
    expect(() => read?.($count)).toThrow("runs outside a place");
    stop();
    expectRealmAtRest(realm);
  });

  test("a kept read inside another place reads as that place's own read", () => {
    const $count = Box.make(realm, 1);
    const read = keptRead(realm);
    const $double = Computed.make(realm, () => read($count) * 2);
    const seen: Array<number> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($double),
      (value) => {
        seen.push(value);
      },
    );
    Realm.update(realm, (_read, write) => write($count, 2));
    expect(seen).toEqual([4]);
    stop();
  });

  test("the read error names a named observable and says what to use instead", () => {
    const $count = Box.make(realm, 1, { name: "Counter.count" });
    const $double = Computed.make(realm, (read) => read($count) * 2, { name: "Counter.double" });
    const read = keptRead(realm);
    expect(() => read($count)).toThrow('pinna: read("Counter.count") runs outside a place');
    expect(() => read($double)).toThrow('read("Counter.double")');
    expect(() => read($count)).toThrow("In a component, use useValue($observable) or useSelect");
    expect(() => read($count)).toThrow("in a handler, Realm.untracked");
    expectRealmAtRest(realm);
  });

  test("computed, watch, update, and untracked may read", () => {
    const $count = Box.make(realm, 1);
    const $double = Computed.make(realm, (read) => read($count) * 2);
    const { seen, stop } = collect((read) => read($double));
    Realm.update(realm, (read, write) => {
      write($count, read($count) + 1);
    });
    expect(seen).toEqual([4]);
    expect(Realm.untracked(realm, (read) => read($double))).toBe(4);
    stop();
  });

  test("untracked subscribes nothing, even inside a tracked place", () => {
    const $count = Box.make(realm, 1);
    const $other = Box.make(realm, 10);
    const $double = Computed.make(realm, (read) => read($count) * 2);
    const { seen, stop } = collect(
      (read) => read($other) + Realm.untracked(realm, (read) => read($count) + read($double)),
    );
    Realm.update(realm, (_read, write) => {
      write($count, 2);
    });
    expect(seen).toEqual([]);
    Realm.update(realm, (_read, write) => {
      write($other, 20);
    });
    expect(seen).toEqual([26]);
    stop();
  });

  test("a watch effect is untracked, so it reads through untracked", () => {
    const $count = Box.make(realm, 1);
    let seen: unknown;
    const stop = Realm.watch(
      realm,
      (read) => read($count),
      () => {
        seen = Realm.untracked(realm, (read) => read($count));
      },
    );
    Realm.update(realm, (_read, write) => {
      write($count, 2);
    });
    expect(seen).toBe(2);
    stop();
  });
});

describe("write rule", () => {
  test("a write kept past its update throws", () => {
    const $count = Box.make(realm, 1);
    const write = keptWrite(realm);
    expect(() => write($count, 2)).toThrow("write inside Realm.update");
    expectRealmAtRest(realm);
  });

  test("a computed value cannot write", () => {
    const $count = Box.make(realm, 1);
    const write = keptWrite(realm);
    const $bad = Computed.make(realm, () => {
      write($count, 2);
      return 0;
    });
    expect(() => Realm.update(realm, (read) => void read($bad))).toThrow(
      "cannot write while it computes",
    );
    expectRealmAtRest(realm);
  });

  const inComputed =
    "pinna: Realm.update cannot run in a computed value; write from an event, a watch's effect, or an autorun";
  const inSelect =
    "pinna: Realm.update cannot run in a watch's select or a selector; write from an event, a watch's effect, or an autorun";

  test("update cannot run in a computed value", () => {
    const $count = Box.make(realm, 1);
    const $bad = Computed.make(realm, (read) => {
      Realm.update(realm, () => undefined);
      return read($count);
    });
    expect(() => Realm.untracked(realm, (read) => read($bad))).toThrow(inComputed);
    expectRealmAtRest(realm);
  });

  test("update cannot run in a computed function's value", () => {
    const $count = Box.make(realm, 1);
    const $bad = Computed.fn(realm, (read, offset: number) => {
      Realm.update(realm, () => undefined);
      return read($count) + offset;
    });
    expect(() => Realm.untracked(realm, (read) => read($bad(1)))).toThrow(inComputed);
    expectRealmAtRest(realm);
  });

  test("update cannot run in a watch's select", () => {
    const $count = Box.make(realm, 1);
    expect(() =>
      Realm.watch(
        realm,
        (read) => {
          Realm.update(realm, () => undefined);
          return read($count);
        },
        () => undefined,
      ),
    ).toThrow(inSelect);
    expectRealmAtRest(realm);
  });

  test("a computed value an autorun reads still cannot update", () => {
    const errors: Array<unknown> = [];
    const own = Realm.make({ onError: (error) => errors.push(error) });
    const $count = Box.make(own, 1);
    const $bad = Computed.make(own, (read) => {
      Realm.update(own, () => undefined);
      return read($count);
    });
    let caught: unknown;
    const stop = Realm.autorun(own, (read) => {
      try {
        read($bad);
      } catch (error) {
        caught = error;
      }
    });
    expect(String(caught)).toBe(`PinnaUsageError: ${inComputed}`);
    expect(errors).toEqual([]);
    stop();
    expectRealmAtRest(own);
  });

  test("a watch an autorun makes still cannot update in its select", () => {
    const own = Realm.make();
    const $count = Box.make(own, 1);
    let caught: unknown;
    const stop = Realm.autorun(own, () => {
      try {
        Realm.watch(
          own,
          (read) => {
            Realm.update(own, () => undefined);
            return read($count);
          },
          () => undefined,
        );
      } catch (error) {
        caught = error;
      }
    });
    expect(String(caught)).toBe(`PinnaUsageError: ${inSelect}`);
    stop();
    expectRealmAtRest(own);
  });

  test("an async recipe throws", () => {
    const recipe = (async () => {}) as unknown as () => undefined;
    expect(() => Realm.update(realm, recipe)).toThrow("update recipes are synchronous");
    expectRealmAtRest(realm);
  });

  test("watchers see an update's end state once", () => {
    const $first = Box.make(realm, 1);
    const $second = Box.make(realm, 1);
    const { seen, stop } = collect((read) => read($first) + read($second));
    Realm.update(realm, (_read, write) => {
      write($first, 2);
      Realm.update(realm, (_read, write) => {
        write($second, 3);
      });
    });
    expect(seen).toEqual([5]);
    stop();
  });

  test("a rolled-back update reruns no autorun", () => {
    const $count = Box.make(realm, 0);
    let runs = 0;
    const stop = Realm.autorun(realm, (read) => {
      runs++;
      read($count);
    });
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write($count, 1);
        throw new Error("abandoned");
      }),
    ).toThrow("abandoned");
    expect(Realm.untracked(realm, (read) => read($count))).toBe(0);
    expect(runs).toBe(1);
    stop();
    expectRealmAtRest(realm);
  });

  test("a value written back before the throw reruns no autorun", () => {
    const $count = Box.make(realm, 0);
    let runs = 0;
    const stop = Realm.autorun(realm, (read) => {
      runs++;
      read($count);
    });
    expect(() =>
      Realm.update(realm, (_read, write) => {
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
    const $count = Box.make(realm, 0);
    let runs = 0;
    const stop = Realm.autorun(realm, (read) => {
      runs++;
      read($count);
    });
    Realm.update(realm, (_read, write) => {
      write($count, 1);
      write($count, 0);
    });
    expect(runs).toBe(1);
    Realm.update(realm, (_read, write) => {
      write($count, 5);
    });
    expect(runs).toBe(2);
    stop();
  });

  test("a value written back across nested updates reruns no autorun", () => {
    const $count = Box.make(realm, 0);
    let runs = 0;
    const stop = Realm.autorun(realm, (read) => {
      runs++;
      read($count);
    });
    Realm.update(realm, () => {
      Realm.update(realm, (_read, write) => {
        write($count, 1);
      });
      Realm.update(realm, (_read, write) => {
        write($count, 0);
      });
    });
    expect(runs).toBe(1);
    stop();
  });

  // The box gets back the version it had, so only a reader that read the
  // value in between has something new to read.
  test("a computed read in between follows a value written back", () => {
    const $count = Box.make(realm, 0);
    let computes = 0;
    const $double = Computed.make(realm, (read) => {
      computes++;
      return read($count) * 2;
    });
    expect(Realm.untracked(realm, (read) => read($double))).toBe(0);
    Realm.update(realm, (read, write) => {
      write($count, 1);
      expect(read($double)).toBe(2);
      write($count, 0);
    });
    expect(Realm.untracked(realm, (read) => read($double))).toBe(0);
    expect(computes).toBe(3);
  });

  test("a nested update that fails puts back only what it wrote", () => {
    const $first = Box.make(realm, 0);
    const $second = Box.make(realm, 0);
    Realm.update(realm, (read, write) => {
      write($first, 1);
      expect(() =>
        Realm.update(realm, (_read, write) => {
          write($first, 2);
          write($second, 2);
          Realm.update(realm, (_read, write) => {
            write($second, 3);
          });
          throw new Error("abandoned");
        }),
      ).toThrow("abandoned");
      expect([read($first), read($second)]).toEqual([1, 0]);
      write($second, 4);
    });
    expect(Realm.untracked(realm, (read) => [read($first), read($second)])).toEqual([1, 4]);
    expectRealmAtRest(realm);
  });

  test("an update after a failed nested one rolls back from where it began", () => {
    const $count = Box.make(realm, 0);
    const $other = Box.make(realm, 0);
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write($count, 1);
        expect(() =>
          Realm.update(realm, (_read, write) => {
            write($other, 1);
            throw new Error("inner");
          }),
        ).toThrow("inner");
        write($other, 2);
        write($count, 3);
        throw new Error("outer");
      }),
    ).toThrow("outer");
    expect(Realm.untracked(realm, (read) => [read($count), read($other)])).toEqual([0, 0]);
    expectRealmAtRest(realm);
  });

  test("a box first written in a failed nested update is put back by the outer one", () => {
    const $count = Box.make(realm, 0);
    const $other = Box.make(realm, 0);
    expect(() =>
      Realm.update(realm, (_read, write) => {
        expect(() =>
          Realm.update(realm, (_read, write) => {
            write($count, 1);
            throw new Error("inner");
          }),
        ).toThrow("inner");
        write($other, 1);
        write($count, 2);
        throw new Error("outer");
      }),
    ).toThrow("outer");
    expect(Realm.untracked(realm, (read) => [read($count), read($other)])).toEqual([0, 0]);
    expectRealmAtRest(realm);
  });

  test("a computed read inside a rolled-back update follows a later write", () => {
    const $count = Box.make(realm, 0);
    const $double = Computed.make(realm, (read) => read($count) * 2);
    expect(() =>
      Realm.update(realm, (read, write) => {
        write($count, 1);
        expect(read($double)).toBe(2);
        throw new Error("abandoned");
      }),
    ).toThrow("abandoned");
    expect(Realm.untracked(realm, (read) => read($double))).toBe(0);
    Realm.update(realm, (_read, write) => {
      write($count, 5);
    });
    expect(Realm.untracked(realm, (read) => read($double))).toBe(10);
    expectRealmAtRest(realm);
  });
});

describe("plain values", () => {
  test("a value is not frozen when it enters a box", () => {
    const todos = [{ title: "a", done: false }];
    Box.make<ReadonlyArray<Todo>>(realm, todos);
    expect(Object.isFrozen(todos)).toBe(false);
    expect(Object.isFrozen(todos[0])).toBe(false);
  });
});

describe("write.modify", () => {
  test("an assigned child from another box stays isolated through rollback and commit", () => {
    const original = { name: "old" };
    const before = { row: { name: "b" }, rows: [] as ReadonlyArray<{ name: string }> };
    const $source = Box.make(realm, original);
    const $target = Box.make(realm, before);
    let notifications = 0;
    const stop = Realm.watch(
      realm,
      (read) => read($source).name,
      () => {
        notifications++;
      },
    );
    const abort = new Error("rollback");
    const modify = (): void =>
      Realm.update(realm, (read, write) => {
        write.modify($target, (draft) => {
          draft.row = read($source);
          draft.row.name = "new";
          draft.rows = [read($source)];
          draft.rows.push({ name: "added" });
        });
      });
    expect(() =>
      Realm.update(realm, () => {
        modify();
        throw abort;
      }),
    ).toThrow(abort);
    expect(original.name).toBe("old");
    expect(Realm.untracked(realm, (read) => read($source))).toBe(original);
    expect(Realm.untracked(realm, (read) => read($target))).toBe(before);
    expect(before.row.name).toBe("b");
    expect(notifications).toBe(0);
    modify();
    const after = Realm.untracked(realm, (read) => read($target));
    expect(original.name).toBe("old");
    expect(after.row).toEqual({ name: "new" });
    expect(after.row).not.toBe(original);
    // The value is a tree: the row written at `row` is a copy of its own, and
    // `rows` holds the unwritten object.
    expect(after.rows).toEqual([{ name: "old" }, { name: "added" }]);
    expect(after.rows[0]).toBe(original);
    expect(notifications).toBe(0);
    stop();
  });

  test("an assigned child only read in a draft keeps its supplied identity", () => {
    const supplied = { name: "supplied" };
    const $target = Box.make(realm, { row: { name: "before" } });
    Realm.update(realm, (_read, write) => {
      write.modify($target, (draft) => {
        draft.row = supplied;
        expect(draft.row.name).toBe("supplied");
        expect(draft.row).toBe(draft.row);
      });
    });
    expect(Realm.untracked(realm, (read) => read($target).row)).toBe(supplied);
  });

  test("writes through a draft; unchanged items keep their identity", () => {
    const $todos = Box.make<ReadonlyArray<Todo>>(realm, [
      { title: "a", done: false },
      { title: "b", done: false },
    ]);
    const before = Realm.untracked(realm, (read) => read($todos));
    Realm.update(realm, (_read, write) => {
      write.modify($todos, (todos) => {
        const first = todos[0];
        if (first !== undefined) {
          first.done = true;
        }
        todos.push({ title: "c", done: false });
      });
    });
    const after = Realm.untracked(realm, (read) => read($todos));
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
    const $node = Box.make<{ readonly items: ReadonlyArray<unknown> }>(realm, { items: [] });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    Realm.update(realm, (_read, write) => {
      write.modify($node, (node) => {
        node.items.push(cyclic);
      });
    });
    expect(Realm.untracked(realm, (read) => read($node).items[0])).toBe(cyclic);
  });

  test("finalizing an appended frozen object preserves its identity", () => {
    const frozen = Object.freeze({ price: 3 });
    const $rows = Box.make<ReadonlyArray<{ readonly price: number }>>(realm, []);
    Realm.update(realm, (_read, write) => {
      write.modify($rows, (rows) => {
        rows.push(frozen);
      });
    });
    expect(Realm.untracked(realm, (read) => read($rows)[0])).toBe(frozen);
  });

  test("a written draft placed inside itself throws and the update is undone", () => {
    interface Row {
      readonly child: Row | null;
    }
    const before: Row = { child: null };
    const $row = Box.make(realm, before);
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.modify($row, (row) => {
          row.child = row;
        });
      }),
    ).toThrow("pinna: write.modify left an object it wrote under two keys");
    expect(Realm.untracked(realm, (read) => read($row))).toBe(before);
    expect(before.child).toBeNull();
  });

  test("finalization copies supplied containers only to replace nested drafts", () => {
    const unchanged = Object.freeze({ price: 3 });
    const before = { price: 1, child: null as unknown, item: { id: 1 } };
    const $row = Box.make<{
      readonly price: number;
      readonly child: unknown;
      readonly item: object;
    }>(realm, before);
    let supplied: { self?: unknown; item: unknown; unchanged: unknown } | undefined;
    let itemDraft: unknown;
    Realm.update(realm, (_read, write) => {
      write.modify($row, (row) => {
        itemDraft = row.item;
        supplied = { self: undefined, item: itemDraft, unchanged };
        supplied.self = supplied;
        Object.freeze(supplied);
        row.child = supplied;
      });
    });
    const result = Realm.untracked(realm, (read) => read($row));
    const child = result.child as NonNullable<typeof supplied>;
    expect(child).not.toBe(supplied);
    expect(child.self).toBe(child);
    expect(child.item).toBe(before.item);
    expect(child.unchanged).toBe(unchanged);
    expect(supplied?.self).toBe(supplied);
    expect(supplied?.item).toBe(itemDraft);
  });

  test("filter on a draft keeps the kept items", () => {
    const $todos = Box.make<{ readonly items: ReadonlyArray<Todo> }>(realm, {
      items: [
        { title: "a", done: true },
        { title: "b", done: false },
      ],
    });
    const kept = Realm.untracked(realm, (read) => read($todos).items[1]);
    Realm.update(realm, (_read, write) => {
      write.modify($todos, (todos) => {
        todos.items = todos.items.filter((todo) => !todo.done);
      });
    });
    expect(Realm.untracked(realm, (read) => read($todos).items)).toEqual([
      { title: "b", done: false },
    ]);
    expect(Realm.untracked(realm, (read) => read($todos).items[0])).toBe(kept);
  });

  test("an item read twice in a recipe stays one draft", () => {
    const $todos = Box.make<ReadonlyArray<Todo>>(realm, [{ title: "a", done: false }]);
    Realm.update(realm, (_read, write) => {
      write.modify($todos, (todos) => {
        const first = todos[0];
        if (first !== undefined) {
          first.done = true;
        }
        expect(todos[0]).toBe(first);
        expect(Reflect.ownKeys(todos)).toEqual(["0", "length"]);
      });
    });
    expect(Realm.untracked(realm, (read) => read($todos))).toEqual([{ title: "a", done: true }]);
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
      const $rows = Box.make(realm, original);
      Realm.update(realm, (_read, write) => {
        write.modify($rows, (rows) => {
          expect(rows[0]?.id).toBe(0);
          expect(rows[0]).toBe(rows[0]);
        });
      });
      expect(Realm.untracked(realm, (read) => read($rows))).toBe(original);
      return reads;
    });
    expect(indexedReads[0]).toBeLessThanOrEqual(4);
    expect(indexedReads[1]).toBe(indexedReads[0]);
  });

  test("cached child drafts follow shift, unshift, and splice before their first write", () => {
    const original = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const $rows = Box.make(realm, original);
    Realm.update(realm, (_read, write) => {
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
    expect(Realm.untracked(realm, (read) => read($rows))).toEqual([
      { id: 5 },
      { id: 6 },
      { id: 20 },
      { id: 3 },
    ]);
    expect(original).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(Realm.untracked(realm, (read) => read($rows)[3])).toBe(original[2]);
  });

  test("a property descriptor gives the cached child draft, with its writes", () => {
    const original = { row: { id: 1 } };
    const $state = Box.make(realm, original);
    Realm.update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        const row = draft.row;
        row.id = 2;
        const descriptor = Object.getOwnPropertyDescriptor(draft, "row");
        expect(descriptor?.value).toBe(row);
        expect(descriptor?.value.id).toBe(2);
      });
    });
    expect(Realm.untracked(realm, (read) => read($state))).toEqual({ row: { id: 2 } });
    expect(original.row.id).toBe(1);
  });

  test.each([
    [
      "a descriptor",
      (draft: { row: { id: number } }) => Object.getOwnPropertyDescriptor(draft, "row")?.value,
    ],
    [
      "the descriptors",
      (draft: { row: { id: number } }) => Object.getOwnPropertyDescriptors(draft).row.value,
    ],
  ] as const)("a write through %s before any read rolls back with the update", (_name, child) => {
    const original = { row: { id: 1 } };
    const $state = Box.make(realm, original);
    const $id = Computed.make(realm, (read) => read($state).row.id);
    expect(Realm.untracked(realm, (read) => read($id))).toBe(1);
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.modify($state, (draft) => {
          child(draft).id = 9;
          throw new Error("undone");
        });
      }),
    ).toThrow("undone");
    expect(original.row.id).toBe(1);
    expect(Realm.untracked(realm, (read) => read($state)).row.id).toBe(1);
    expect(Realm.untracked(realm, (read) => read($id))).toBe(1);
  });

  test("a descriptor of a draft kept past its recipe refuses writes", () => {
    const original = { row: { id: 1 }, count: 1 };
    const $state = Box.make(realm, original);
    let kept: typeof original | undefined;
    Realm.update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        kept = draft;
        draft.count = 2;
      });
    });
    const row = Object.getOwnPropertyDescriptor(kept, "row")?.value as { id: number };
    expect(() => {
      row.id = 9;
    }).toThrow("pinna: a draft is used after its recipe returned");
    expect(original.row.id).toBe(1);
    expect(Realm.untracked(realm, (read) => read($state))).toEqual({ row: { id: 1 }, count: 2 });
  });

  test("items moved by sort, splice, and shift leave no draft behind", () => {
    const $todos = Box.make<ReadonlyArray<Todo>>(realm, [
      { title: "c", done: false },
      { title: "a", done: false },
      { title: "d", done: false },
      { title: "b", done: false },
    ]);
    const before = Realm.untracked(realm, (read) => read($todos));
    Realm.update(realm, (_read, write) => {
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
    const after = Realm.untracked(realm, (read) => read($todos));
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
    const $rows = Box.make<ReadonlyArray<unknown>>(
      realm,
      Array.from({ length: 1000 }, (_, id) => counted(id)),
    );
    let readsInRecipe = -1;
    Realm.update(realm, (_read, write) => {
      write.modify($rows, (rows) => {
        reads = 0;
        rows.shift();
        rows.splice(0, 1, { id: -1 });
        rows.unshift({ id: -2 });
        readsInRecipe = reads;
      });
    });
    expect(readsInRecipe).toBeLessThan(10);
    expect(Realm.untracked(realm, (read) => read($rows)).length).toBe(1000);
  });

  test("writes through rows that shift, splice, and unshift move or remove never reach the held value", () => {
    interface Row {
      readonly id: string;
      readonly price: number;
    }
    const $book = Box.make<{ readonly rows: ReadonlyArray<Row> }>(realm, {
      rows: [
        { id: "a", price: 1 },
        { id: "b", price: 2 },
        { id: "c", price: 3 },
        { id: "d", price: 4 },
        { id: "e", price: 5 },
      ],
    });
    const held = Realm.untracked(realm, (read) => read($book));
    const snapshot = structuredClone(held);
    Realm.update(realm, (_read, write) => {
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
    const after = Realm.untracked(realm, (read) => read($book));
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
    const $rows = Box.make<ReadonlyArray<{ readonly id: number }>>(realm, start());
    let draftResults = "";
    Realm.update(realm, (_read, write) => {
      write.modify($rows, (rows) => {
        draftResults = JSON.stringify(run(rows));
      });
    });
    expect(draftResults).toBe(results);
    expect(Realm.untracked(realm, (read) => read($rows))).toEqual(expected);
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
    const $rows = Box.make<ReadonlyArray<{ readonly id: number } | undefined>>(realm, start());
    const held = Realm.untracked(realm, (read) => read($rows));
    const snapshot = structuredClone(held);
    let draftResults = "";
    Realm.update(realm, (_read, write) => {
      write.modify($rows, (rows) => {
        draftResults = JSON.stringify(run(rows as Array<{ id: number }>));
      });
    });
    expect(draftResults).toBe(results);
    expect(JSON.stringify(Realm.untracked(realm, (read) => read($rows)))).toBe(
      JSON.stringify(expected),
    );
    expect(held).toEqual(snapshot);
  });

  test("a row spliced out and put back keeps its identity, or its write when written", () => {
    const $todos = Box.make<ReadonlyArray<Todo>>(realm, [
      { title: "a", done: false },
      { title: "b", done: false },
      { title: "c", done: false },
      { title: "d", done: false },
    ]);
    const before = Realm.untracked(realm, (read) => read($todos));
    Realm.update(realm, (_read, write) => {
      write.modify($todos, (todos) => {
        todos.unshift(...todos.splice(3, 1));
      });
    });
    const moved = Realm.untracked(realm, (read) => read($todos));
    expect(moved[0]).toBe(before[3]);
    expect(moved[1]).toBe(before[0]);
    Realm.update(realm, (_read, write) => {
      write.modify($todos, (todos) => {
        const [row] = todos.splice(2, 1);
        if (row !== undefined) {
          row.done = true;
          todos.unshift(row);
        }
      });
    });
    const after = Realm.untracked(realm, (read) => read($todos));
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
    const $todos = Box.make<ReadonlyArray<Todo>>(realm, [
      { title: "a", done: false },
      { title: "b", done: false },
      { title: "c", done: false },
      { title: "d", done: false },
      { title: "e", done: false },
    ]);
    const before = Realm.untracked(realm, (read) => read($todos));
    Realm.update(realm, (_read, write) => {
      write.modify($todos, (todos) => {
        const fourth = todos[3];
        if (fourth !== undefined) {
          fourth.done = true;
        }
        todos.shift();
        todos.splice(0, 1);
      });
    });
    const after = Realm.untracked(realm, (read) => read($todos));
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
    const $todos = Box.make<ReadonlyArray<Todo>>(realm, [
      { title: "a", done: false },
      { title: "b", done: false },
      { title: "c", done: false },
    ]);
    const before = Realm.untracked(realm, (read) => read($todos));
    Realm.update(realm, (_read, write) => {
      write.modify($todos, (todos) => {
        todos.shift();
        todos.push({ title: "d", done: false });
      });
    });
    const after = Realm.untracked(realm, (read) => read($todos));
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[2]);
    expect(after[2]).toEqual({ title: "d", done: false });
  });

  test("shift on an empty draft keeps the value", () => {
    const $todos = Box.make<ReadonlyArray<Todo>>(realm, []);
    const before = Realm.untracked(realm, (read) => read($todos));
    let shifted: unknown = null;
    Realm.update(realm, (_read, write) => {
      write.modify($todos, (todos) => {
        shifted = todos.shift();
      });
    });
    expect(shifted).toBeUndefined();
    expect(Realm.untracked(realm, (read) => read($todos))).toBe(before);
  });

  test("a recipe that writes nothing keeps the value", () => {
    const $todos = Box.make<ReadonlyArray<Todo>>(realm, [{ title: "a", done: false }]);
    const before = Realm.untracked(realm, (read) => read($todos));
    Realm.update(realm, (_read, write) => {
      write.modify($todos, (todos) => {
        void todos[0]?.title;
      });
    });
    expect(Realm.untracked(realm, (read) => read($todos))).toBe(before);
  });

  test("a draft used after its recipe throws", () => {
    const $todos = Box.make<ReadonlyArray<Todo>>(realm, [{ title: "a", done: false }]);
    let leaked: Array<{ title: string; done: boolean }> | undefined;
    Realm.update(realm, (_read, write) => {
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
      const $held = Box.make<Held>(realm, held());
      const before = Realm.untracked(realm, (read) => read($held));
      Realm.update(realm, (_read, write) => {
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
      expect(Realm.untracked(realm, (read) => read($held))).toBe(before);
      expectRealmAtRest(realm);
    });

    test("a draft replaces one, and the held value keeps its contents", () => {
      const $held = Box.make<Held>(realm, held());
      const before = Realm.untracked(realm, (read) => read($held));
      Realm.update(realm, (_read, write) => {
        write.modify($held, (draft) => {
          draft.at = new Date(draft.at.getTime() + 1);
          draft.due = new Map([...draft.due, ["b", new Date(3)]]);
          draft.links = new Map([...draft.links, ["b", 2]]);
          draft.tags = new Set([...draft.tags, "u"]);
        });
      });
      const after = Realm.untracked(realm, (read) => read($held));
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
    const $count = Box.make(realm, 1);
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.modify($count, () => undefined);
      }),
    ).toThrow("write other values whole with write($box, value)");
    expectRealmAtRest(realm);
  });
});

describe("onObserved", () => {
  test("starts with the first observer and stops with the last", () => {
    const $count = Box.make(realm, 1);
    const events: Array<string> = [];
    Source.onObserved($count, () => {
      events.push("start");
      return () => events.push("stop");
    });
    const stop = Realm.watch(
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
    const $source = Atom.make(realm);
    let outside = 1;
    const $read = Computed.make(realm, (read) => {
      read($source);
      return outside;
    });
    const { seen, stop } = collect((read) => read($read));
    outside = 2;
    Realm.update(realm, (_read, write) => {
      write.changed($source);
    });
    expect(seen).toEqual([2]);
    stop();
  });

  test("an atom read untracked does nothing and does not throw", () => {
    const $source = Atom.make(realm);
    expect(() => Realm.untracked(realm, (read) => read($source))).not.toThrow();
    expectRealmAtRest(realm);
  });

  test("an atom read inside untracked does not subscribe", () => {
    const $source = Atom.make(realm);
    let runs = 0;
    const stop = Realm.watch(
      realm,
      () => {
        runs++;
        Realm.untracked(realm, (read) => read($source));
        return runs;
      },
      () => {},
    );
    Realm.update(realm, (_read, write) => {
      write.changed($source);
    });
    expect(runs).toBe(1);
    stop();
  });

  test("write.changed kept past its update throws, outside an update and inside a computed value", () => {
    const $source = Atom.make(realm);
    const write = keptWrite(realm);
    expect(() => write.changed($source)).toThrow("write inside Realm.update");
    const $bad = Computed.make(realm, () => {
      write.changed($source);
      return 1;
    });
    expect(() => Realm.untracked(realm, (read) => read($bad))).toThrow();
    expectRealmAtRest(realm);
  });

  test("onObserved starts with the first observer and stops with the last", () => {
    const $source = Atom.make(realm);
    const events: Array<string> = [];
    Source.onObserved($source, () => {
      events.push("start");
      return () => events.push("stop");
    });
    Realm.untracked(realm, (read) => read($source));
    expect(events).toEqual([]);
    const stop = Realm.watch(
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
    const $source = Atom.make(realm);
    Source.onObserved($source, () => {
      const listener = (): void =>
        Realm.update(realm, (_read, write) => {
          write.changed($source);
        });
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const $value = Computed.make(realm, (read) => {
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
    expect(Realm.untracked(realm, (read) => read($value))).toBe(3);
  });

  test("a computed value over an atom reads fresh while nothing observes it", () => {
    let value = 1;
    const $source = Atom.make(realm);
    const $value = Computed.make(realm, (read) => {
      read($source);
      return value;
    });
    const $double = Computed.make(realm, (read) => read($value) * 2);
    expect(Realm.untracked(realm, (read) => read($double))).toBe(2);
    value = 2;
    expect(Realm.untracked(realm, (read) => read($double))).toBe(4);
  });

  test("write.changed inside a batch notifies once at its end", () => {
    const $source = Atom.make(realm);
    let runs = 0;
    const stop = Realm.watch(
      realm,
      (read) => {
        read($source);
        return ++runs;
      },
      () => {},
    );
    Realm.update(realm, (_read, write) => {
      write.changed($source);
      write.changed($source);
    });
    expect(runs).toBe(2);
    stop();
  });
});
