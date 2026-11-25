import { describe, expect, test } from "bun:test";
import { Atom, Box, Computed, Realm } from "../src/index.ts";

/**
 * The verbs each place hands out: `read` in every place that reads, and
 * `write` in `Realm.update` alone.
 */

describe("read", () => {
  test("untracked preserves a watch select's update guard before its recipe runs", () => {
    const realm = Realm.make();
    const value = Box.make(realm, 0);
    let recipes = 0;
    expect(() =>
      Realm.watch(
        realm,
        () =>
          Realm.untracked(realm, () =>
            Realm.untracked(realm, () =>
              Realm.update(realm, (_read, write) => {
                recipes++;
                write(value, 5);
              }),
            ),
          ),
        () => undefined,
      ),
    ).toThrow("pinna: Realm.update cannot run in a watch's select or a selector");
    expect(recipes).toBe(0);
    expect(Realm.untracked(realm, (read) => read(value))).toBe(0);
    Realm.untracked(realm, () => Realm.update(realm, (_read, write) => write(value, 1)));
    expect(Realm.untracked(realm, (read) => read(value))).toBe(1);
  });

  test("untracked preserves a computed update guard before its recipe runs", () => {
    const realm = Realm.make();
    let recipes = 0;
    const value = Computed.make(realm, () =>
      Realm.untracked(realm, () => {
        Realm.update(realm, () => {
          recipes++;
        });
      }),
    );
    expect(() => Realm.untracked(realm, (read) => read(value))).toThrow(
      "pinna: Realm.update cannot run in a computed value",
    );
    expect(recipes).toBe(0);
  });

  test("tracks in a computed value, a watch, and an autorun", () => {
    const realm = Realm.make();
    const $count = Box.make(realm, 1);
    const $double = Computed.make(realm, (read) => read($count) * 2);
    const watched: Array<number> = [];
    const ran: Array<number> = [];
    const stopWatch = Realm.watch(
      realm,
      (read) => read($double),
      (value) => {
        watched.push(value);
      },
    );
    const stopAutorun = Realm.autorun(realm, (read) => {
      ran.push(read($count));
      return undefined;
    });
    Realm.update(realm, (read, write) => write($count, read($count) + 1));
    expect(watched).toEqual([4]);
    expect(ran).toEqual([1, 2]);
    stopWatch();
    stopAutorun();
  });

  test("reads in untracked and subscribes nothing", () => {
    const realm = Realm.make();
    const $count = Box.make(realm, 3);
    expect(Realm.untracked(realm, (read) => read($count))).toBe(3);
  });

  test("subscribes an atom and returns undefined", () => {
    const realm = Realm.make();
    const $ticker = Atom.make(realm);
    let runs = 0;
    const stop = Realm.autorun(realm, (read) => {
      expect(read($ticker)).toBeUndefined();
      runs++;
      return undefined;
    });
    Realm.update(realm, (_read, write) => write.changed($ticker));
    expect(runs).toBe(2);
    stop();
  });

  test("reading another realm's box throws, inside a computed value or untracked", () => {
    const realm = Realm.make();
    const other = Realm.make();
    const $theirs = Box.make(other, 1, { name: "theirs" });
    expect(() =>
      Realm.untracked(realm, (read) => read(Computed.make(realm, (read) => read($theirs)))),
    ).toThrow('read("theirs") is handed an observable of another realm');
    expect(() => Realm.untracked(realm, (read) => read($theirs))).toThrow("another realm");
  });

  test("the error names each realm that has a name, and realms are told apart by identity", () => {
    const realm = Realm.make({ name: "ui" });
    const $theirs = Box.make(Realm.make({ name: "quotes" }), 1, { name: "theirs" });
    expect(() => Realm.untracked(realm, (read) => read($theirs))).toThrow(
      'read("theirs") is handed an observable of another realm (realm "quotes", not "ui")',
    );
    const $unnamed = Box.make(Realm.make(), 1);
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write($unnamed, 2);
      }),
    ).toThrow(
      'write($observable) is handed an observable of another realm (realm unnamed, not "ui")',
    );
    const $namesake = Box.make(Realm.make({ name: "ui" }), 1);
    expect(() => Realm.untracked(realm, (read) => read($namesake))).toThrow(
      '(realm "ui", not "ui")',
    );
  });

  test("reading another realm's box throws even while that realm has an update open", () => {
    const realm = Realm.make();
    const other = Realm.make();
    const $theirs = Box.make(other, 1);
    const $mine = Computed.make(realm, (read) => read($theirs) + 1);
    expect(() =>
      Realm.update(other, (_read, write) => {
        write($theirs, 2);
        Realm.untracked(realm, (read) => read($mine));
      }),
    ).toThrow("another realm");
    expect(Realm.untracked(other, (read) => read($theirs))).toBe(1);
  });
});

describe("write", () => {
  test("every verb returns undefined, so a recipe can end in one", () => {
    const realm = Realm.make();
    const $count = Box.make(realm, 1);
    const $list = Box.make<ReadonlyArray<number>>(realm, []);
    const results: Array<unknown> = [];
    Realm.update(realm, (_read, write) => {
      results.push(write($count, 2));
      results.push(write.modify($list, () => undefined));
      return undefined;
    });
    expect(results).toEqual([undefined, undefined]);
  });

  test("write.modify drafts an array", () => {
    const realm = Realm.make();
    const $list = Box.make<ReadonlyArray<number>>(realm, [1]);
    Realm.update(realm, (_read, write) =>
      write.modify($list, (draft) => {
        draft.push(2);
        return undefined;
      }),
    );
    expect(Realm.untracked(realm, (read) => read($list))).toEqual([1, 2]);
  });

  test("writing another realm's box throws inside this realm's update", () => {
    const realm = Realm.make();
    const other = Realm.make();
    const $theirs = Box.make(other, 1);
    expect(() => Realm.update(realm, (_read, write) => write($theirs, 2))).toThrow(
      "write($observable) is handed an observable of another realm",
    );
    expect(Realm.untracked(other, (read) => read($theirs))).toBe(1);
  });

  test("every verb throws for another realm's observable, even while that realm has an update open", () => {
    const realm = Realm.make();
    const other = Realm.make();
    const $theirs = Box.make<ReadonlyArray<number>>(other, [1]);
    const $ticker = Atom.make(other);
    Realm.update(other, () => {
      expect(() => Realm.update(realm, (_read, write) => write($theirs, [2]))).toThrow(
        "another realm",
      );
      expect(() =>
        Realm.update(realm, (_read, write) => write.modify($theirs, () => undefined)),
      ).toThrow("write.modify");
      expect(() => Realm.update(realm, (_read, write) => write.changed($ticker))).toThrow(
        "write.changed",
      );
      return undefined;
    });
    expect(Realm.untracked(other, (read) => read($theirs))).toEqual([1]);
  });
});
