import { describe, expect, test } from "bun:test";
import { box, createRealm, reconcile, untracked, update, watch } from "../src/index.ts";

/**
 * Pinna's `reconcile` takes the comparison from the caller: a refetch builds
 * new objects, so identity alone would keep nothing.
 */

interface Row {
  readonly id: string;
  readonly price: number;
}

const keyOf = (row: Row): string => row.id;
const equals = (previous: Row, next: Row): boolean => previous.price === next.price;

describe("reconcile", () => {
  test("keeps the previous instance where the key matches and equals holds", () => {
    const a = { id: "a", price: 1 };
    const b = { id: "b", price: 2 };
    const next = reconcile(
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
    const next = reconcile([a, b], [c, { id: "a", price: 1 }], { keyOf, equals });
    expect(next).toEqual([c, a]);
    expect(next[1]).toBe(a);
  });

  test("returns the previous array when every item and its place are unchanged", () => {
    const previous = [
      { id: "a", price: 1 },
      { id: "b", price: 2 },
    ];
    const next = reconcile(
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
      reconcile(
        [],
        [
          { id: "a", price: 1 },
          { id: "a", price: 2 },
        ],
        { keyOf, equals },
      ),
    ).toThrow("reconcile: the key a appears twice");
  });

  test("equals is required", () => {
    // @ts-expect-error: without a schema there is no comparison to fall back on.
    expect(() => reconcile([], [], { keyOf })).not.toThrow();
  });

  test("a refetch written through reconcile notifies nobody and keeps row identity", () => {
    const realm = createRealm();
    const $rows = box<ReadonlyArray<Row>>(realm, [
      { id: "a", price: 1 },
      { id: "b", price: 2 },
    ]);
    const first = untracked(realm, (read) => read($rows))[0];
    let notified = 0;
    const stop = watch(
      realm,
      (read) => read($rows),
      () => {
        notified++;
      },
    );
    const refetch = (rows: ReadonlyArray<Row>): void =>
      update(realm, (read, write) => write($rows, reconcile(read($rows), rows, { keyOf, equals })));
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
    expect(untracked(realm, (read) => read($rows))[0]).toBe(first);
    stop();
  });
});
