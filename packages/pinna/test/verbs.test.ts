import { describe, expect, test } from "bun:test";
import {
  atom,
  autorun,
  box,
  computed,
  createRealm,
  untracked,
  update,
  watch,
} from "../src/index.ts";

/**
 * The verbs each place hands out: `read` in every place that reads, and
 * `write` in `update` alone.
 */

describe("read", () => {
  test("untracked preserves a watch select's update guard before its recipe runs", () => {
    const realm = createRealm();
    const value = box(realm, 0);
    let recipes = 0;
    expect(() =>
      watch(
        realm,
        () =>
          untracked(realm, () =>
            untracked(realm, () =>
              update(realm, (_read, write) => {
                recipes++;
                write(value, 5);
              }),
            ),
          ),
        () => undefined,
      ),
    ).toThrow("pinna: update cannot run in a watch's select or a selector");
    expect(recipes).toBe(0);
    expect(untracked(realm, (read) => read(value))).toBe(0);
    untracked(realm, () => update(realm, (_read, write) => write(value, 1)));
    expect(untracked(realm, (read) => read(value))).toBe(1);
  });

  test("untracked preserves a computed update guard before its recipe runs", () => {
    const realm = createRealm();
    let recipes = 0;
    const value = computed(realm, () =>
      untracked(realm, () => {
        update(realm, () => {
          recipes++;
        });
      }),
    );
    expect(() => untracked(realm, (read) => read(value))).toThrow(
      "pinna: update cannot run in a computed value",
    );
    expect(recipes).toBe(0);
  });

  test("tracks in a computed value, a watch, and an autorun", () => {
    const realm = createRealm();
    const $count = box(realm, 1);
    const $double = computed(realm, (read) => read($count) * 2);
    const watched: Array<number> = [];
    const ran: Array<number> = [];
    const stopWatch = watch(
      realm,
      (read) => read($double),
      (value) => {
        watched.push(value);
      },
    );
    const stopAutorun = autorun(realm, (read) => {
      ran.push(read($count));
      return undefined;
    });
    update(realm, (read, write) => write($count, read($count) + 1));
    expect(watched).toEqual([4]);
    expect(ran).toEqual([1, 2]);
    stopWatch();
    stopAutorun();
  });

  test("reads in untracked and subscribes nothing", () => {
    const realm = createRealm();
    const $count = box(realm, 3);
    expect(untracked(realm, (read) => read($count))).toBe(3);
  });

  test("subscribes an atom and returns undefined", () => {
    const realm = createRealm();
    const $ticker = atom(realm);
    let runs = 0;
    const stop = autorun(realm, (read) => {
      expect(read($ticker)).toBeUndefined();
      runs++;
      return undefined;
    });
    update(realm, (_read, write) => write.changed($ticker));
    expect(runs).toBe(2);
    stop();
  });

  test("reading another realm's box throws, inside a computed value or untracked", () => {
    const realm = createRealm();
    const other = createRealm();
    const $theirs = box(other, 1, { name: "theirs" });
    expect(() =>
      untracked(realm, (read) => read(computed(realm, (read) => read($theirs)))),
    ).toThrow('read("theirs") is handed an observable of another realm');
    expect(() => untracked(realm, (read) => read($theirs))).toThrow("another realm");
  });

  test("the error names each realm that has a name, and realms are told apart by identity", () => {
    const realm = createRealm({ name: "ui" });
    const $theirs = box(createRealm({ name: "quotes" }), 1, { name: "theirs" });
    expect(() => untracked(realm, (read) => read($theirs))).toThrow(
      'read("theirs") is handed an observable of another realm (realm "quotes", not "ui")',
    );
    const $unnamed = box(createRealm(), 1);
    expect(() =>
      update(realm, (_read, write) => {
        write($unnamed, 2);
      }),
    ).toThrow(
      'write($observable) is handed an observable of another realm (realm unnamed, not "ui")',
    );
    const $namesake = box(createRealm({ name: "ui" }), 1);
    expect(() => untracked(realm, (read) => read($namesake))).toThrow('(realm "ui", not "ui")');
  });

  test("reading another realm's box throws even while that realm has an update open", () => {
    const realm = createRealm();
    const other = createRealm();
    const $theirs = box(other, 1);
    const $mine = computed(realm, (read) => read($theirs) + 1);
    expect(() =>
      update(other, (_read, write) => {
        write($theirs, 2);
        untracked(realm, (read) => read($mine));
      }),
    ).toThrow("another realm");
    expect(untracked(other, (read) => read($theirs))).toBe(1);
  });
});

describe("write", () => {
  test("every verb returns undefined, so a recipe can end in one", () => {
    const realm = createRealm();
    const $count = box(realm, 1);
    const $list = box<ReadonlyArray<number>>(realm, []);
    const results: Array<unknown> = [];
    update(realm, (_read, write) => {
      results.push(write($count, 2));
      results.push(write.modify($list, () => undefined));
      return undefined;
    });
    expect(results).toEqual([undefined, undefined]);
  });

  test("write.modify drafts an array", () => {
    const realm = createRealm();
    const $list = box<ReadonlyArray<number>>(realm, [1]);
    update(realm, (_read, write) =>
      write.modify($list, (draft) => {
        draft.push(2);
        return undefined;
      }),
    );
    expect(untracked(realm, (read) => read($list))).toEqual([1, 2]);
  });

  test("writing another realm's box throws inside this realm's update", () => {
    const realm = createRealm();
    const other = createRealm();
    const $theirs = box(other, 1);
    expect(() => update(realm, (_read, write) => write($theirs, 2))).toThrow(
      "write($observable) is handed an observable of another realm",
    );
    expect(untracked(other, (read) => read($theirs))).toBe(1);
  });

  test("every verb throws for another realm's observable, even while that realm has an update open", () => {
    const realm = createRealm();
    const other = createRealm();
    const $theirs = box<ReadonlyArray<number>>(other, [1]);
    const $ticker = atom(other);
    update(other, () => {
      expect(() => update(realm, (_read, write) => write($theirs, [2]))).toThrow("another realm");
      expect(() => update(realm, (_read, write) => write.modify($theirs, () => undefined))).toThrow(
        "write.modify",
      );
      expect(() => update(realm, (_read, write) => write.changed($ticker))).toThrow(
        "write.changed",
      );
      return undefined;
    });
    expect(untracked(other, (read) => read($theirs))).toEqual([1]);
  });
});
