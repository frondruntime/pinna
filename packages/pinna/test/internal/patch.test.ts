import { describe, expect, test } from "bun:test";
import { Journal } from "../../src/journal.ts";
import {
  beforeAllChange,
  beforeKeyChanges,
  OrderPatch,
  type RowLayer,
  RowPatch,
  removedRow,
} from "../../src/patch.ts";

/** A base layer over a plain map, as a collection is over its held rows. */
const base = (
  rows: Map<string, number>,
): RowLayer<string, number> & { rows: Map<string, number> } => {
  const layer = {
    rows,
    patches: undefined as Set<RowPatch<string, number>> | undefined,
    rowsNow: () => layer.rows,
  };
  return layer;
};

/** Writes `key` in the base as a collection does: the patches keep the row first. */
const write = (layer: ReturnType<typeof base>, key: string, row: number | undefined): void => {
  beforeKeyChanges(layer, key);
  if (row === undefined) layer.rows.delete(key);
  else layer.rows.set(key, row);
};

describe("RowPatch", () => {
  test("shows the rows beneath as they were when it began", () => {
    const layer = base(
      new Map([
        ["a", 1],
        ["b", 2],
      ]),
    );
    const patch = new RowPatch(layer);
    write(layer, "b", 20);
    write(layer, "z", 30);
    write(layer, "a", undefined);
    expect(patch.get("b")).toBe(2);
    expect(patch.has("z")).toBe(false);
    expect(patch.get("a")).toBe(1);
    // A key the base lost since comes after the keys it still holds.
    expect([...patch]).toEqual([
      ["b", 2],
      ["a", 1],
    ]);
    expect(patch.size).toBe(2);
  });

  test("its own writes win, and a removal hides the row", () => {
    const layer = base(
      new Map([
        ["a", 1],
        ["b", 2],
      ]),
    );
    const patch = new RowPatch(layer);
    patch.set("a", 10);
    patch.set("b", removedRow);
    patch.set("c", 3);
    expect([...patch]).toEqual([
      ["a", 10],
      ["c", 3],
    ]);
    expect(patch.has("b")).toBe(false);
  });

  test("an undone own write falls back to the row beneath as it was", () => {
    const layer = base(new Map([["a", 1]]));
    const patch = new RowPatch(layer);
    const journal = new Journal();
    journal.step(patch.target, "a", patch.own.has("a"), patch.own.get("a"));
    patch.set("a", 10);
    write(layer, "a", 100);
    journal.rollback(0);
    expect(patch.get("a")).toBe(1);
  });

  test("a whole replace beneath keeps every row once and stops reading through", () => {
    const layer = base(new Map([["a", 1]]));
    const patch = new RowPatch(layer);
    beforeAllChange(layer);
    layer.rows = new Map([["x", 9]]);
    expect([...patch]).toEqual([["a", 1]]);
    expect(layer.patches?.size).toBe(0);
  });

  test("a patch over a patch keeps what the lower one showed", () => {
    const layer = base(new Map([["a", 1]]));
    const lower = new RowPatch(layer);
    lower.set("a", 2);
    const upper = new RowPatch(lower);
    lower.set("a", 3);
    lower.set("b", 4);
    expect(upper.get("a")).toBe(2);
    expect(upper.has("b")).toBe(false);
    expect(lower.get("a")).toBe(3);
  });

  test("a retired patch leaves the layer beneath once nothing reads through it", () => {
    const layer = base(new Map([["a", 1]]));
    const lower = new RowPatch(layer);
    const upper = new RowPatch(lower);
    lower.retire();
    expect(layer.patches?.has(lower)).toBe(true);
    upper.retire();
    expect(layer.patches?.size).toBe(0);
    expect(lower.patches?.size).toBe(0);
  });

  test("a whole patch holds its rows and reads through nothing", () => {
    const layer = base(new Map([["a", 1]]));
    const whole = new RowPatch<string, number>(undefined, new Map([["q", 5]]));
    expect([...whole]).toEqual([["q", 5]]);
    expect(whole.has("a")).toBe(false);
    expect(layer.patches).toBeUndefined();
  });
});

describe("OrderPatch", () => {
  test("no change shows the order beneath itself", () => {
    const base = [1, 2, 3];
    expect(OrderPatch.over(base).array()).toBe(base);
  });

  test("adds at the start and the end, and removes, over the order beneath", () => {
    const base = [1, 2, 3];
    const patch = OrderPatch.over(base).add(4, "end").add(5, "start").add(6, "start").remove(2);
    expect(patch.array()).toEqual([6, 5, 1, 3, 4]);
    // The order beneath is never changed.
    expect(base).toEqual([1, 2, 3]);
  });

  test("a key added then removed leaves no trace, and a base key removed then added moves", () => {
    const patch = OrderPatch.over([1, 2, 3]).add(4, "end").remove(4).remove(1).add(1, "end");
    expect(patch.array()).toEqual([2, 3, 1]);
  });

  test("each change is a new patch: the one before shows what it showed", () => {
    const first = OrderPatch.over([1]).add(2, "end");
    const second = first.add(3, "start");
    expect(first.array()).toEqual([1, 2]);
    expect(second.array()).toEqual([3, 1, 2]);
    expect(second.array()).toBe(second.array());
  });
});
