import { describe, expect, test } from "bun:test";
import { Box, Collection, Realm } from "../src/index.ts";

/**
 * Pinna's `Collection.reconcile` takes the comparison from the caller: a refetch builds
 * new objects, so identity alone would keep nothing.
 */

interface Row {
  readonly id: string;
  readonly price: number;
}

const keyOf = (row: Row): string => row.id;
const equals = (previous: Row, next: Row): boolean => previous.price === next.price;

describe("reconcile", () => {
  test("identity shortcuts distinguish signed zero and preserve NaN", () => {
    const options = { keyOf: () => 1, equals: Object.is };
    const previous = [0];
    const result = Collection.reconcile(previous, [-0], options);
    expect(Object.is(result[0], -0)).toBe(true);
    expect(result).not.toBe(previous);
    const held = [NaN];
    expect(Collection.reconcile(held, [NaN], options)).toBe(held);
  });

  test("keeps the previous instance where the key matches and equals holds", () => {
    const a = { id: "a", price: 1 };
    const b = { id: "b", price: 2 };
    const next = Collection.reconcile(
      [a, b],
      [
        { id: "a", price: 1 },
        { id: "b", price: 3 },
      ],
      { keyOf, equals },
    );
    expect(next[0]).toBe(a);
    expect(next[1]).toEqual({ id: "b", price: 3 });
    expect(next[1]).not.toBe(b);
  });

  test("follows the next order, adds new keys, and drops missing ones", () => {
    const a = { id: "a", price: 1 };
    const b = { id: "b", price: 2 };
    const c = { id: "c", price: 3 };
    const next = Collection.reconcile([a, b], [c, { id: "a", price: 1 }], { keyOf, equals });
    expect(next).toEqual([c, a]);
    expect(next[1]).toBe(a);
  });

  test("returns the previous array when every item and its place are unchanged", () => {
    const previous = [
      { id: "a", price: 1 },
      { id: "b", price: 2 },
    ];
    const next = Collection.reconcile(
      previous,
      [
        { id: "a", price: 1 },
        { id: "b", price: 2 },
      ],
      { keyOf, equals },
    );
    expect(next).toBe(previous);
  });

  test("throws on a key the next array repeats", () => {
    expect(() =>
      Collection.reconcile(
        [],
        [
          { id: "a", price: 1 },
          { id: "a", price: 2 },
        ],
        { keyOf, equals },
      ),
    ).toThrow("reconcile: the key a appears twice");
  });

  test("names a repeated key with no string form by its type", () => {
    const key: unknown = Object.create(null);
    expect(() =>
      Collection.reconcile([], [1, 2], {
        keyOf: () => key,
        equals: (left, right) => left === right,
      }),
    ).toThrow("pinna: reconcile: the key (an unprintable object) appears twice");
  });

  test("equals is required", () => {
    // @ts-expect-error: without a schema there is no comparison to fall back on.
    expect(() => Collection.reconcile([], [], { keyOf })).not.toThrow();
  });

  test("a refetch written through reconcile notifies nobody and keeps row identity", () => {
    const realm = Realm.make();
    const $rows = Box.make<ReadonlyArray<Row>>(realm, [
      { id: "a", price: 1 },
      { id: "b", price: 2 },
    ]);
    const first = Realm.untracked(realm, (read) => read($rows))[0];
    let notified = 0;
    const stop = Realm.watch(
      realm,
      (read) => read($rows),
      () => {
        notified++;
      },
    );
    const refetch = (rows: ReadonlyArray<Row>): void =>
      Realm.update(realm, (read, write) =>
        write($rows, Collection.reconcile(read($rows), rows, { keyOf, equals })),
      );
    refetch([
      { id: "a", price: 1 },
      { id: "b", price: 2 },
    ]);
    expect(notified).toBe(0);
    refetch([
      { id: "a", price: 1 },
      { id: "b", price: 5 },
    ]);
    expect(notified).toBe(1);
    expect(Realm.untracked(realm, (read) => read($rows))[0]).toBe(first);
    stop();
  });
});
