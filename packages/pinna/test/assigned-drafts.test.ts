import { describe, expect, test } from "bun:test";
import { Box, Realm } from "../src/index.ts";
import { testRealm } from "../src/testing/index.ts";

describe("finalizing assigned containers read through a draft", () => {
  test.each(["read length", "push"])("filter then %s finalizes every item", (operation) => {
    using realm = testRealm();
    const before = { items: [{ id: 1 }, { id: 2 }, { id: 3 }] };
    const $state = Box.make(realm, before);
    let supplied: Array<{ id: number }> | undefined;
    let firstDraft: { id: number } | undefined;
    Realm.update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        supplied = draft.items.filter((item) => item.id !== 2);
        firstDraft = supplied[0];
        draft.items = supplied;
        if (operation === "push") {
          draft.items.push({ id: 4 });
        } else {
          expect(draft.items.length).toBe(2);
        }
      });
    });
    const result = Realm.untracked(realm, (read) => read($state));
    expect(result.items.map((item) => item.id)).toEqual(operation === "push" ? [1, 3, 4] : [1, 3]);
    expect(result.items[0]).toBe(before.items[0]);
    expect(result.items[1]).toBe(before.items[2]);
    expect(result.items).not.toBe(supplied);
    expect(supplied?.length).toBe(2);
    expect(supplied?.[0]).toBe(firstDraft);
    expect(before.items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  test.each([
    "read item",
    "write label",
  ])("a frozen wrapper then %s finalizes its item", (operation) => {
    using realm = testRealm();
    interface Wrapper {
      item: { id: number } | undefined;
      label?: string;
    }
    const before = {
      items: [{ id: 1 }, { id: 2 }, { id: 3 }],
      wrapper: undefined as Wrapper | undefined,
    };
    const $state = Box.make(realm, before);
    let supplied: Wrapper | undefined;
    let firstDraft: { id: number } | undefined;
    Realm.update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        firstDraft = draft.items[0];
        supplied = Object.freeze({ item: firstDraft });
        draft.wrapper = supplied;
        if (operation === "write label") {
          draft.wrapper.label = "x";
        } else {
          expect(draft.wrapper.item?.id).toBe(1);
        }
      });
    });
    const result = Realm.untracked(realm, (read) => read($state));
    expect(result.wrapper?.item?.id).toBe(1);
    expect(result.wrapper?.item).toBe(before.items[0]);
    expect(result.wrapper?.label).toBe(operation === "write label" ? "x" : undefined);
    expect(result.wrapper).not.toBe(supplied);
    expect(supplied?.item).toBe(firstDraft);
    expect(supplied?.label).toBeUndefined();
    expect(result.items).toBe(before.items);
    expect(before.wrapper).toBeUndefined();
  });

  test("reversing an assigned array then editing an item finalizes every item", () => {
    using realm = testRealm();
    const before = {
      items: [
        { id: 1, count: 0 },
        { id: 2, count: 0 },
        { id: 3, count: 0 },
      ],
    };
    const $state = Box.make(realm, before);
    Realm.update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        draft.items = [...draft.items].reverse();
        const first = draft.items[0];
        if (first !== undefined) {
          first.count = 1;
        }
      });
    });
    const result = Realm.untracked(realm, (read) => read($state));
    expect(result.items.map((item) => [item.id, item.count])).toEqual([
      [3, 1],
      [2, 0],
      [1, 0],
    ]);
    expect(result.items[1]).toBe(before.items[1]);
    expect(result.items[2]).toBe(before.items[0]);
    expect(before.items.map((item) => item.count)).toEqual([0, 0, 0]);
  });

  test("editing an item then filtering and iterating keeps the edited value", () => {
    using realm = testRealm();
    const before = {
      items: [
        { id: 1, count: 0 },
        { id: 2, count: 0 },
        { id: 3, count: 0 },
      ],
    };
    const $state = Box.make(realm, before);
    Realm.update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        const first = draft.items[0];
        if (first !== undefined) {
          first.count = 5;
        }
        draft.items = draft.items.filter((item) => item.id !== 2);
        expect([...draft.items].map((item) => item.count)).toEqual([5, 0]);
      });
    });
    const result = Realm.untracked(realm, (read) => read($state));
    expect(result.items.map((item) => [item.id, item.count])).toEqual([
      [1, 5],
      [3, 0],
    ]);
    expect(result.items[1]).toBe(before.items[2]);
    expect(before.items.map((item) => item.count)).toEqual([0, 0, 0]);
  });

  test("a written supplied object that reaches itself splits at the written key, and the supplied object stays as it was", () => {
    // Ruling 60: an object at two keys is two values once one is written, and
    // a self-reference is a second key.
    using realm = testRealm();
    interface Node {
      label: string;
      self: Node | undefined;
    }
    const before = { child: undefined as Node | undefined };
    const $state = Box.make(realm, before);
    const supplied: Node = { label: "old", self: undefined };
    supplied.self = supplied;
    Realm.update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        draft.child = supplied;
        draft.child.label = "new";
      });
    });
    const result = Realm.untracked(realm, (read) => read($state));
    expect(result.child).not.toBe(supplied);
    expect(result.child?.label).toBe("new");
    expect(result.child?.self).toBe(supplied);
    expect(supplied.label).toBe("old");
    expect(supplied.self).toBe(supplied);
  });

  test("editing a nested supplied container finalizes its untouched draft child", () => {
    using realm = testRealm();
    interface Wrapper {
      nested: { item: { id: number } | undefined; label?: string };
    }
    const before = { items: [{ id: 1 }], wrapper: undefined as Wrapper | undefined };
    const $state = Box.make(realm, before);
    let supplied: Wrapper | undefined;
    Realm.update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        supplied = { nested: { item: draft.items[0] } };
        draft.wrapper = supplied;
        draft.wrapper.nested.label = "x";
      });
    });
    const result = Realm.untracked(realm, (read) => read($state));
    expect(result.wrapper?.nested.item?.id).toBe(1);
    expect(result.wrapper?.nested.item).toBe(before.items[0]);
    expect(result.wrapper?.nested.label).toBe("x");
    expect(supplied?.nested.label).toBeUndefined();
  });

  test.each([
    "raw first",
    "draft first",
  ])("an unwritten frozen cycle at two keys finalizes to one copy: %s", (order) => {
    using realm = testRealm();
    interface Wrapper {
      self: Wrapper | undefined;
      item: { id: number } | undefined;
    }
    const before = {
      items: [{ id: 1 }],
      wrapper: undefined as Wrapper | undefined,
      shared: undefined as Wrapper | undefined,
    };
    const $state = Box.make(realm, before);
    let supplied: Wrapper | undefined;
    let firstDraft: { id: number } | undefined;
    Realm.update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        firstDraft = draft.items[0];
        supplied = { self: undefined, item: firstDraft };
        supplied.self = supplied;
        Object.freeze(supplied);
        if (order === "raw first") {
          draft.shared = supplied;
        }
        draft.wrapper = supplied;
        expect(draft.wrapper.item?.id).toBe(1);
        if (order === "draft first") {
          draft.shared = supplied;
        }
      });
    });
    const result = Realm.untracked(realm, (read) => read($state));
    expect(result.wrapper?.item?.id).toBe(1);
    expect(result.wrapper).not.toBe(supplied);
    expect(result.wrapper).toBe(result.shared);
    expect(result.wrapper?.self).toBe(result.wrapper);
    expect(result.wrapper?.item).toBe(before.items[0]);
    expect(supplied?.self).toBe(supplied);
    expect(supplied?.item).toBe(firstDraft);
  });

  test.each([
    "shift",
    "splice",
  ] as const)("%s returns a supplied wrapper with a finalized item", (operation) => {
    using realm = testRealm();
    interface Wrapper {
      item: { id: number } | undefined;
    }
    const before = {
      items: [{ id: 1 }],
      wrappers: [] as Array<Wrapper>,
      removed: undefined as Wrapper | undefined,
    };
    const $state = Box.make(realm, before);
    Realm.update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        draft.wrappers.push({ item: draft.items[0] });
        draft.removed =
          operation === "shift" ? draft.wrappers.shift() : draft.wrappers.splice(0, 1)[0];
      });
    });
    const result = Realm.untracked(realm, (read) => read($state));
    expect(result.removed?.item?.id).toBe(1);
    expect(result.removed?.item).toBe(before.items[0]);
    expect(result.wrappers).toEqual([]);
    expect(before.removed).toBeUndefined();
  });
});

describe("a box's value is a tree", () => {
  interface Shared {
    n: number;
    m: number;
    self: Shared | undefined;
  }
  interface State {
    a: Shared | undefined;
    b: Shared | undefined;
    holder: { shared: Shared } | undefined;
  }
  const sharedValue = (): Shared => {
    const shared: Shared = { n: 0, m: 0, self: undefined };
    shared.self = shared;
    return shared;
  };
  const empty = (): State => ({ a: undefined, b: undefined, holder: undefined });

  test.each([
    ["a", "b"],
    ["b", "a"],
  ] as const)("an object assigned to %s and %s, written through a, is two values", (first, second) => {
    using realm = testRealm();
    const $state = Box.make(realm, empty());
    const shared = sharedValue();
    Realm.update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        draft[first] = shared;
        draft[second] = shared;
        if (draft.a !== undefined) {
          draft.a.n = 1;
        }
        expect(draft.b?.n).toBe(0);
      });
    });
    const result = Realm.untracked(realm, (read) => read($state));
    expect(result.a?.n).toBe(1);
    expect(result.a).not.toBe(shared);
    expect(result.b).toBe(shared);
    expect(shared).toEqual({ n: 0, m: 0, self: shared });
  });

  test("writes through two keys of one assigned object land in two values", () => {
    using realm = testRealm();
    const $state = Box.make(realm, empty());
    const shared = sharedValue();
    Realm.update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        draft.a = shared;
        draft.b = shared;
        draft.a.n = 1;
        draft.b.m = 2;
      });
    });
    const result = Realm.untracked(realm, (read) => read($state));
    expect([result.a?.n, result.a?.m]).toEqual([1, 0]);
    expect([result.b?.n, result.b?.m]).toEqual([0, 2]);
    expect(shared).toEqual({ n: 0, m: 0, self: shared });
  });

  test("a container assigned and never read through the draft keeps the unwritten object", () => {
    using realm = testRealm();
    const $state = Box.make(realm, empty());
    const shared = sharedValue();
    const holder = { shared };
    Realm.update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        draft.holder = holder;
        draft.a = shared;
        draft.a.n = 1;
      });
    });
    const result = Realm.untracked(realm, (read) => read($state));
    expect(result.a?.n).toBe(1);
    expect(result.holder).toBe(holder);
    expect(holder.shared).toBe(shared);
    expect(shared.n).toBe(0);
  });

  test("an object moved by splice gets a draft of its own", () => {
    using realm = testRealm();
    const $list = Box.make<{ list: Array<Shared>; a: Shared | undefined }>(realm, {
      list: [],
      a: undefined,
    });
    const shared = sharedValue();
    Realm.update(realm, (_read, write) => {
      write.modify($list, (draft) => {
        draft.list = [shared];
        draft.a = shared;
        const [removed] = draft.list.splice(0, 1);
        expect(removed).not.toBe(draft.a);
        draft.list.push(removed as Shared);
        draft.a.n = 1;
      });
    });
    const result = Realm.untracked(realm, (read) => read($list));
    expect(result.list[0]).toBe(shared);
    expect(result.a?.n).toBe(1);
    expect(shared.n).toBe(0);
  });

  test("an unwritten draft at two keys finalizes to the one object the box held", () => {
    using realm = testRealm();
    const before = { left: { n: 0 }, right: undefined as { n: number } | undefined };
    const $state = Box.make(realm, before);
    Realm.update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        draft.right = draft.left;
      });
    });
    const result = Realm.untracked(realm, (read) => read($state));
    expect(result.left).toBe(before.left);
    expect(result.right).toBe(before.left);
  });

  test.each([
    ["the base's object", "itself"],
    ["the base's object", "a nested object"],
    ["an assigned object", "itself"],
    ["an assigned object", "a nested object"],
  ])("a written draft of %s left under two keys throws when the recipe writes %s, and the update is undone", (origin, target) => {
    using realm = testRealm();
    interface Side {
      n: number;
      inner: { n: number };
    }
    const before = { left: { n: 0, inner: { n: 0 } }, right: undefined as Side | undefined };
    const $state = Box.make(realm, before);
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.modify($state, (draft) => {
          if (origin === "an assigned object") {
            draft.left = { n: 0, inner: { n: 0 } };
          }
          draft.right = draft.left;
          if (target === "itself") {
            draft.left.n = 1;
          } else {
            draft.left.inner.n = 1;
          }
        });
      }),
    ).toThrow("pinna: write.modify left an object it wrote under two keys");
    expect(Realm.untracked(realm, (read) => read($state))).toBe(before);
  });

  test("a written draft placed inside itself throws when the recipe writes a nested object", () => {
    using realm = testRealm();
    interface Node {
      inner: { n: number };
      self?: Node;
    }
    const before: { node: Node } = { node: { inner: { n: 0 } } };
    const $state = Box.make(realm, before);
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.modify($state, (draft) => {
          draft.node.self = draft.node;
          draft.node.inner.n = 1;
        });
      }),
    ).toThrow("pinna: write.modify left an object it wrote under two keys");
    expect(Realm.untracked(realm, (read) => read($state))).toBe(before);
  });

  test.each([
    "an object",
    "an array",
  ])("%s the recipe builds around a written draft and places at two keys throws", (shape) => {
    using realm = testRealm();
    const before: { item?: { n: number }; a?: unknown; b?: unknown } = { item: { n: 0 } };
    const $state = Box.make(realm, before);
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.modify($state, (draft) => {
          const item = draft.item as { n: number };
          item.n = 1;
          // The written draft keeps no key of its own: only the wrapper,
          // reached twice, carries it to two places.
          delete draft.item;
          const wrapper = shape === "an object" ? { item } : [item];
          draft.a = wrapper;
          draft.b = wrapper;
        });
      }),
    ).toThrow("pinna: write.modify left an object it wrote under two keys");
    expect(Realm.untracked(realm, (read) => read($state))).toBe(before);
  });

  test("a wrapper that reaches itself before the written draft it holds throws", () => {
    using realm = testRealm();
    interface Wrapper {
      back?: Wrapper;
      item?: { n: number };
    }
    const before: { item?: { n: number }; wrapper?: Wrapper } = { item: { n: 0 } };
    const $state = Box.make(realm, before);
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.modify($state, (draft) => {
          const item = draft.item as { n: number };
          item.n = 1;
          delete draft.item;
          // `back` is walked before `item`, so the wrapper is reached again
          // before finalization knows it holds a written draft.
          const wrapper: Wrapper = {};
          wrapper.back = wrapper;
          wrapper.item = item;
          draft.wrapper = wrapper;
        });
      }),
    ).toThrow("pinna: write.modify left an object it wrote under two keys");
    expect(Realm.untracked(realm, (read) => read($state))).toBe(before);
  });

  test("a wrapper the recipe builds around unwritten values stays one object at two keys", () => {
    using realm = testRealm();
    const before = { item: { n: 0 }, a: undefined as unknown, b: undefined as unknown };
    const $state = Box.make(realm, before);
    Realm.update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        const wrapper = { item: draft.item, tags: [] as string[] };
        draft.a = wrapper;
        draft.b = wrapper;
      });
    });
    const after = Realm.untracked(realm, (read) => read($state));
    expect(after.a).toBe(after.b);
    expect((after.a as { item: unknown }).item).toBe(before.item);
  });

  test("a snapshot read from the box before the write keeps the old value in the history", () => {
    using realm = testRealm();
    const before = { present: { count: 0 }, history: [] as Array<{ count: number }> };
    const $state = Box.make(realm, before);
    Realm.update(realm, (read, write) => {
      write.modify($state, (draft) => {
        draft.history.push(read($state).present);
        draft.present.count++;
      });
    });
    const after = Realm.untracked(realm, (read) => read($state));
    expect(after.history[0]).toBe(before.present);
    expect(after.present).toEqual({ count: 1 });
    expect(before.present).toEqual({ count: 0 });
  });

  test("a written draft moved to another key, with the old key deleted, is one value", () => {
    using realm = testRealm();
    const $state = Box.make<{ a?: { n: number }; b?: { n: number } }>(realm, { a: { n: 1 } });
    Realm.update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        const moved = draft.a as { n: number };
        moved.n++;
        draft.b = moved;
        delete draft.a;
      });
    });
    expect(Realm.untracked(realm, (read) => read($state))).toEqual({ b: { n: 2 } });
  });

  test("a draft pushed into a history and then written throws", () => {
    using realm = testRealm();
    const before = { present: { count: 0 }, history: [] as Array<{ count: number }> };
    const $state = Box.make(realm, before);
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.modify($state, (draft) => {
          draft.history.push(draft.present);
          draft.present.count++;
        });
      }),
    ).toThrow("pinna: write.modify left an object it wrote under two keys");
    expect(Realm.untracked(realm, (read) => read($state))).toBe(before);
  });

  test("a selection held as a key follows its item across calls", () => {
    using realm = testRealm();
    const $state = Box.make(realm, { items: [{ id: 1, n: 0 }], selectedId: 0 });
    Realm.update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        draft.selectedId = 1;
      });
    });
    Realm.update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        const item = draft.items.find((entry) => entry.id === draft.selectedId);
        if (item !== undefined) {
          item.n = 1;
        }
      });
    });
    const result = Realm.untracked(realm, (read) => read($state));
    expect(result.items.find((entry) => entry.id === result.selectedId)?.n).toBe(1);
  });

  test.each([
    "get",
    "descriptor",
  ])("a child at a symbol key of an assigned object, drafted by %s, finalizes", (path) => {
    using realm = testRealm();
    const key = Symbol("row");
    const supplied = { [key]: { n: 0 } };
    const $state = Box.make(realm, { wrapper: undefined as typeof supplied | undefined });
    Realm.update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        draft.wrapper = supplied;
        const child =
          path === "get"
            ? draft.wrapper[key]
            : (Reflect.getOwnPropertyDescriptor(draft.wrapper, key)?.value as { n: number });
        child.n = 1;
      });
    });
    const result = Realm.untracked(realm, (read) => read($state));
    expect(result.wrapper?.[key].n).toBe(1);
    expect(result.wrapper).not.toBe(supplied);
    expect(supplied[key].n).toBe(0);
  });

  test("a draft of an assigned object pushed into a second key's list stays the unwritten object", () => {
    using realm = testRealm();
    interface Holder {
      list: Array<Holder>;
    }
    const supplied: Holder = { list: [] };
    const $state = Box.make(realm, {
      holder: undefined as Holder | undefined,
      list: undefined as Array<Holder> | undefined,
    });
    Realm.update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        draft.holder = supplied;
        draft.list = supplied.list;
        // `list` is drafted apart from `holder.list`; the holder's draft is
        // never written, so both keys finalize to the supplied object.
        draft.list.push(draft.holder);
      });
    });
    const result = Realm.untracked(realm, (read) => read($state));
    expect(result.holder).toBe(supplied);
    expect(result.list).toEqual([supplied]);
    expect(result.list?.[0]).toBe(supplied);
    expect(supplied.list).toEqual([]);
  });

  test("an unwritten draft held inside its own supplied object follows the object's copy", () => {
    using realm = testRealm();
    interface Wrapper {
      back: Wrapper | undefined;
      item: { id: number };
    }
    const before = { items: [{ id: 1 }], wrapper: undefined as Wrapper | undefined };
    const $state = Box.make(realm, before);
    Realm.update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        const supplied: Wrapper = { back: undefined, item: draft.items[0] as { id: number } };
        draft.wrapper = supplied;
        // The wrapper's draft goes back into the raw object, which copies
        // later to replace the item's draft; `back` follows that copy.
        supplied.back = draft.wrapper;
      });
    });
    const result = Realm.untracked(realm, (read) => read($state));
    expect(result.wrapper?.item).toBe(before.items[0]);
    expect(result.wrapper?.back).toBe(result.wrapper);
  });
});

describe("a draft copies the value it was given", () => {
  test("a match array keeps its index, input, and groups", () => {
    using realm = testRealm();
    const match = /(?<letter>a)/.exec("cat") as RegExpExecArray;
    const $result = Box.make(realm, match);
    Realm.update(realm, (_read, write) => {
      write.modify($result, (draft) => {
        draft[0] = "A";
      });
    });
    const edited = Realm.untracked(realm, (read) => read($result));
    expect([edited[0], edited.index, edited.input, edited.groups?.["letter"]]).toEqual([
      "A",
      1,
      "cat",
      "a",
    ]);
  });

  test("a null-prototype dictionary stays one, and a symbol key stays", () => {
    using realm = testRealm();
    const tag = Symbol("tag");
    const original = Object.assign(Object.create(null) as Record<PropertyKey, string>, {
      [tag]: "kept",
    });
    const $state = Box.make(realm, original);
    Realm.update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        draft["item"] = "one";
      });
    });
    const after = Realm.untracked(realm, (read) => read($state));
    expect(Object.getPrototypeOf(after)).toBe(null);
    expect("toString" in after).toBe(false);
    expect([after["item"], after[tag]]).toEqual(["one", "kept"]);
  });

  test("a written outer draft assigned in an inner modify throws pinna/draft-of-another-recipe and the update is undone", () => {
    using realm = testRealm();
    const $outer = Box.make(realm, { row: { n: 0 } });
    const $inner = Box.make(realm, { row: { n: 0 } });
    const seen: Array<number> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($inner).row.n,
      (value) => {
        seen.push(value);
      },
    );
    let code: unknown;
    try {
      Realm.update(realm, (_read, write) => {
        write.modify($outer, (draft) => {
          draft.row.n = 1;
          write.modify($inner, (destination) => {
            destination.row = draft.row;
          });
          draft.row.n = -1;
        });
      });
    } catch (error) {
      code = (error as { code?: unknown }).code;
    }
    const [outer, inner] = Realm.untracked(realm, (read) => [read($outer), read($inner)]);
    expect([code, outer.row.n, inner.row.n, seen]).toEqual([
      "pinna/draft-of-another-recipe",
      0,
      0,
      [],
    ]);
    stop();
  });

  test("a plain box given a live draft by a plain write lands it, and reads after the recipe throw pinna/draft-kept", () => {
    using realm = testRealm();
    const $outer = Box.make(realm, { child: { n: 1 } });
    const $plain = Box.make<{ n: number }>(realm, { n: 0 });
    Realm.update(realm, (_read, write) => {
      write.modify($outer, (draft) => {
        draft.child.n = 2;
        write($plain, draft.child);
      });
    });
    let code: unknown;
    try {
      Realm.untracked(realm, (read) => read($plain).n);
    } catch (error) {
      code = (error as { code?: unknown }).code;
    }
    expect(code).toBe("pinna/draft-kept");
  });

  test("an unwritten outer draft assigned in an inner modify lands as the value it drafts", () => {
    using realm = testRealm();
    const $outer = Box.make(realm, { row: { n: 0 } });
    const $inner = Box.make(realm, { row: { n: 5 } });
    Realm.update(realm, (_read, write) => {
      write.modify($outer, (draft) => {
        write.modify($inner, (destination) => {
          destination.row = draft.row;
        });
        draft.row.n = -1;
      });
    });
    const [outer, inner] = Realm.untracked(realm, (read) => [read($outer), read($inner)]);
    expect([outer.row.n, inner.row.n]).toEqual([-1, 0]);
  });

  test("an unwritten outer container assigned in an inner modify lands with the outer drafts it holds as values", () => {
    using realm = testRealm();
    interface Row {
      n: number;
    }
    const before = { row: { n: 0 }, wrapper: undefined as { row: Row } | undefined };
    const $outer = Box.make(realm, before);
    const $inner = Box.make(realm, { held: undefined as { row: Row } | undefined });
    Realm.update(realm, (_read, write) => {
      write.modify($outer, (draft) => {
        draft.wrapper = { row: draft.row };
        write.modify($inner, (destination) => {
          destination.held = draft.wrapper;
        });
      });
    });
    const inner = Realm.untracked(realm, (read) => read($inner));
    expect(inner.held?.row).toBe(before.row);
  });

  test("an outer container holding a written outer draft, assigned in an inner modify, throws pinna/draft-of-another-recipe", () => {
    using realm = testRealm();
    interface Row {
      n: number;
    }
    const $outer = Box.make(realm, {
      row: { n: 0 },
      wrapper: undefined as { row: Row } | undefined,
    });
    const $inner = Box.make(realm, { held: undefined as { row: Row } | undefined });
    let code: unknown;
    try {
      Realm.update(realm, (_read, write) => {
        write.modify($outer, (draft) => {
          draft.row.n = 1;
          draft.wrapper = { row: draft.row };
          write.modify($inner, (destination) => {
            destination.held = draft.wrapper;
          });
        });
      });
    } catch (error) {
      code = (error as { code?: unknown }).code;
    }
    const inner = Realm.untracked(realm, (read) => read($inner));
    expect([code, inner.held]).toEqual(["pinna/draft-of-another-recipe", undefined]);
  });

  test("an assigned array's symbol keys and match keys holding drafts finalize to values", () => {
    using realm = testRealm();
    const tag = Symbol("tag");
    const before = { row: { n: 1 }, other: { n: 2 }, output: [] as Array<{ n: number }> };
    const $state = Box.make(realm, before);
    Realm.update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        draft.output = Object.assign([draft.row], {
          [tag]: draft.other,
          index: 0,
          input: "x",
          groups: draft.other,
        });
      });
    });
    const output = Realm.untracked(realm, (read) => read($state)).output as unknown as Record<
      PropertyKey,
      unknown
    >;
    expect([output[0], output[tag], output["groups"], output["index"]]).toEqual([
      before.row,
      before.other,
      before.other,
      0,
    ]);
    expect(output[tag]).toBe(before.other);
  });
});
