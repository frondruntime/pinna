import { describe, expect, test } from "bun:test";
import { box, untracked, update } from "../src/index.ts";
import { testRealm } from "../src/testing/index.ts";

describe("finalizing assigned containers read through a draft", () => {
  test.each(["read length", "push"])("filter then %s finalizes every item", (operation) => {
    using realm = testRealm();
    const before = { items: [{ id: 1 }, { id: 2 }, { id: 3 }] };
    const $state = box(realm, before);
    let supplied: Array<{ id: number }> | undefined;
    let firstDraft: { id: number } | undefined;
    update(realm, (_read, write) => {
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
    const result = untracked(realm, (read) => read($state));
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
    const $state = box(realm, before);
    let supplied: Wrapper | undefined;
    let firstDraft: { id: number } | undefined;
    update(realm, (_read, write) => {
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
    const result = untracked(realm, (read) => read($state));
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
    const $state = box(realm, before);
    update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        draft.items = [...draft.items].reverse();
        const first = draft.items[0];
        if (first !== undefined) {
          first.count = 1;
        }
      });
    });
    const result = untracked(realm, (read) => read($state));
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
    const $state = box(realm, before);
    update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        const first = draft.items[0];
        if (first !== undefined) {
          first.count = 5;
        }
        draft.items = draft.items.filter((item) => item.id !== 2);
        expect([...draft.items].map((item) => item.count)).toEqual([5, 0]);
      });
    });
    const result = untracked(realm, (read) => read($state));
    expect(result.items.map((item) => [item.id, item.count])).toEqual([
      [1, 5],
      [3, 0],
    ]);
    expect(result.items[1]).toBe(before.items[2]);
    expect(before.items.map((item) => item.count)).toEqual([0, 0, 0]);
  });

  test("editing a nested supplied container finalizes its untouched draft child", () => {
    using realm = testRealm();
    interface Wrapper {
      nested: { item: { id: number } | undefined; label?: string };
    }
    const before = { items: [{ id: 1 }], wrapper: undefined as Wrapper | undefined };
    const $state = box(realm, before);
    let supplied: Wrapper | undefined;
    update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        supplied = { nested: { item: draft.items[0] } };
        draft.wrapper = supplied;
        draft.wrapper.nested.label = "x";
      });
    });
    const result = untracked(realm, (read) => read($state));
    expect(result.wrapper?.nested.item?.id).toBe(1);
    expect(result.wrapper?.nested.item).toBe(before.items[0]);
    expect(result.wrapper?.nested.label).toBe("x");
    expect(supplied?.nested.label).toBeUndefined();
  });

  test.each([
    "raw first",
    "draft first",
  ])("a shared frozen cycle keeps both aliases: %s", (order) => {
    using realm = testRealm();
    interface Wrapper {
      self: Wrapper | undefined;
      root: object;
      item: { id: number } | undefined;
    }
    const before = {
      items: [{ id: 1 }],
      wrapper: undefined as Wrapper | undefined,
      shared: undefined as Wrapper | undefined,
    };
    const $state = box(realm, before);
    let supplied: Wrapper | undefined;
    let firstDraft: { id: number } | undefined;
    update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        firstDraft = draft.items[0];
        supplied = { self: undefined, root: draft, item: firstDraft };
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
    const result = untracked(realm, (read) => read($state));
    expect(result.wrapper?.item?.id).toBe(1);
    expect(result.wrapper).not.toBe(supplied);
    expect(result.wrapper).toBe(result.shared);
    expect(result.wrapper?.self).toBe(result.wrapper);
    expect(result.wrapper?.root).toBe(result);
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
    const $state = box(realm, before);
    update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        draft.wrappers.push({ item: draft.items[0] });
        draft.removed =
          operation === "shift" ? draft.wrappers.shift() : draft.wrappers.splice(0, 1)[0];
      });
    });
    const result = untracked(realm, (read) => read($state));
    expect(result.removed?.item?.id).toBe(1);
    expect(result.removed?.item).toBe(before.items[0]);
    expect(result.wrappers).toEqual([]);
    expect(before.removed).toBeUndefined();
  });
});

describe("an object assigned at two keys of a draft stays one object", () => {
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
  ] as const)("assigned to %s first, written through a", (first, second) => {
    using realm = testRealm();
    const $state = box(realm, empty());
    const shared = sharedValue();
    update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        draft[first] = shared;
        draft[second] = shared;
        if (draft.a !== undefined) {
          draft.a.n = 1;
        }
        expect(draft.b?.n).toBe(1);
        expect(draft.a?.self).toBe(draft.a);
      });
    });
    const result = untracked(realm, (read) => read($state));
    expect(result.a).toBe(result.b);
    expect(result.a?.self).toBe(result.a);
    expect(result.a?.n).toBe(1);
    expect(result.a).not.toBe(shared);
    expect(shared).toEqual({ n: 0, m: 0, self: shared });
  });

  test("writes through both keys land in the one object", () => {
    using realm = testRealm();
    const $state = box(realm, empty());
    const shared = sharedValue();
    update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        draft.a = shared;
        draft.b = shared;
        draft.a.n = 1;
        draft.b.m = 2;
      });
    });
    const result = untracked(realm, (read) => read($state));
    expect(result.a).toBe(result.b);
    expect(result.a?.n).toBe(1);
    expect(result.a?.m).toBe(2);
    expect(result.a?.self).toBe(result.a);
    expect(shared).toEqual({ n: 0, m: 0, self: shared });
  });

  test("a container assigned and never read through the draft holds the written object", () => {
    using realm = testRealm();
    const $state = box(realm, empty());
    const shared = sharedValue();
    const holder = { shared };
    update(realm, (_read, write) => {
      write.modify($state, (draft) => {
        draft.holder = holder;
        draft.a = shared;
        draft.a.n = 1;
      });
    });
    const result = untracked(realm, (read) => read($state));
    expect(result.holder?.shared).toBe(result.a);
    expect(result.a?.n).toBe(1);
    expect(result.holder).not.toBe(holder);
    expect(holder.shared).toBe(shared);
    expect(shared.n).toBe(0);
  });

  test("an assigned object moved by splice is the same draft as at its other key", () => {
    using realm = testRealm();
    const $list = box<{ list: Array<Shared>; a: Shared | undefined }>(realm, {
      list: [],
      a: undefined,
    });
    const shared = sharedValue();
    update(realm, (_read, write) => {
      write.modify($list, (draft) => {
        draft.list = [shared];
        draft.a = shared;
        const [removed] = draft.list.splice(0, 1);
        expect(removed).toBe(draft.a);
        draft.list.push(removed as Shared);
        draft.a.n = 1;
      });
    });
    const result = untracked(realm, (read) => read($list));
    expect(result.list[0]).toBe(result.a);
    expect(result.a?.n).toBe(1);
    expect(shared.n).toBe(0);
  });
});
