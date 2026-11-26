import { describe, expect, test } from "bun:test";
import { Box, Computed, Realm } from "../../src/index.ts";
import type { ObservableRealm } from "../../src/internal/index.ts";
import { expectRealmAtRest } from "../rest.ts";

/**
 * Internals: an undo step recorded straight on the realm, which only Pinna's
 * own modules do. The public twin is every rollback test in
 * `test/observable.test.ts`.
 */

describe("write rule", () => {
  test("a box an undo writes during a rollback is put back when the outer update fails", () => {
    const realm = Realm.make();
    const $first = Box.make(realm, 1);
    const $other = Box.make(realm, 10);
    const $sum = Computed.make(realm, (read) => read($first) + read($other));
    const seen: Array<ReadonlyArray<number>> = [];
    const stop = Realm.watch(
      realm,
      (read) => [read($first), read($other)],
      (value) => {
        seen.push(value);
      },
    );
    expect(() =>
      Realm.update(realm, (read, write) => {
        write($first, 2);
        expect(() =>
          Realm.update(realm, () => {
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
    expect(Realm.untracked(realm, (read) => [read($first), read($other), read($sum)])).toEqual([
      1, 10, 11,
    ]);
    expect(seen).toEqual([]);
    expectRealmAtRest(realm);
    // A later update records the box anew: its failure puts back 10.
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write($other, 30);
        throw new Error("later");
      }),
    ).toThrow("later");
    expect(Realm.untracked(realm, (read) => read($other))).toBe(10);
    Realm.update(realm, (_read, write) => {
      write($other, 30);
    });
    expect(Realm.untracked(realm, (read) => [read($other), read($sum)])).toEqual([30, 31]);
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
    const realm = Realm.make();
    const $first = Box.make(realm, 1);
    const $box = Box.make(realm, 0);
    const $double = Computed.make(realm, (read) => read($box) * 2);
    const seen: Array<number> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($box),
      (value) => {
        seen.push(value);
      },
    );
    Realm.update(realm, (read, write) => {
      write($first, 2);
      expect(() =>
        Realm.update(realm, (_read, write) => {
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
    expect(Realm.untracked(realm, (read) => [read($first), read($box), read($double)])).toEqual([
      2,
      settled,
      settled * 2,
    ]);
    expect(seen).toEqual(settled === 0 ? [] : [settled]);
    expectRealmAtRest(realm);
    // A later update records the box anew: its failure puts back what the
    // first update left.
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write($box, 9);
        throw new Error("later");
      }),
    ).toThrow("later");
    expect(Realm.untracked(realm, (read) => read($box))).toBe(settled);
    Realm.update(realm, (_read, write) => {
      write($box, 9);
    });
    expect(Realm.untracked(realm, (read) => [read($box), read($double)])).toEqual([9, 18]);
    expect(seen).toEqual(settled === 0 ? [9] : [settled, 9]);
    stop();
    expectRealmAtRest(realm);
  });
});
