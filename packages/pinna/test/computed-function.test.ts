import { describe, expect, test } from "bun:test";
import {
  box,
  computed,
  computedFunction,
  createRealm,
  untracked,
  update,
  watch,
} from "../src/index.ts";
import { keptRead } from "./kept.ts";

/**
 * `computedFunction`: one computed value per argument tuple, kept while something
 * observes it and dropped when the last observer leaves.
 */

describe("computedFunction", () => {
  test("a call returns a computed value of the arguments", () => {
    const realm = createRealm();
    const $rate = box(realm, 2);
    const $times = computedFunction(
      realm,
      (read, amount: number, extra: number) => amount * read($rate) + extra,
    );
    expect(untracked(realm, (read) => read($times(3, 1)))).toBe(7);
    expect(untracked(realm, (read) => read($times(4, 0)))).toBe(8);
  });

  test("a read kept past its place throws, as on any computed value", () => {
    const realm = createRealm();
    const $double = computedFunction(realm, (_read, amount: number) => amount * 2);
    const read = keptRead(realm);
    expect(() => read($double(1))).toThrow("runs outside a place");
  });

  test("while observed, the same arguments return the same computed value", () => {
    const realm = createRealm();
    const $double = computedFunction(realm, (_read, amount: number) => amount * 2);
    const stop = watch(
      realm,
      (read) => read($double(1)),
      () => {},
    );
    expect($double(1)).toBe($double(1));
    expect($double(2)).not.toBe($double(1));
    stop();
  });

  test("arguments are compared by identity, one per position", () => {
    const realm = createRealm();
    const first = { rate: 2 };
    const second = { rate: 2 };
    const $scaled = computedFunction(
      realm,
      (_read, rates: { readonly rate: number }, amount: number) => rates.rate * amount,
    );
    const stop = watch(
      realm,
      (read) => read($scaled(first, 1)) + read($scaled(second, 1)),
      () => {},
    );
    expect($scaled(first, 1)).toBe($scaled(first, 1));
    expect($scaled(second, 1)).not.toBe($scaled(first, 1));
    expect($scaled(first, 2)).not.toBe($scaled(first, 1));
    stop();
  });

  test("calls that differ only in how many arguments they pass are kept apart", () => {
    const realm = createRealm();
    const $sum = computedFunction(realm, (_read, ...values: ReadonlyArray<number>) =>
      values.reduce((a, b) => a + b, 0),
    );
    const stop = watch(
      realm,
      (read) => read($sum(1)) + read($sum(1, 0)),
      () => {},
    );
    expect($sum(1)).not.toBe($sum(1, 0));
    expect(untracked(realm, (read) => read($sum(1)))).toBe(1);
    stop();
  });

  test("nothing is kept while nothing observes it", () => {
    const realm = createRealm();
    let runs = 0;
    const $double = computedFunction(realm, (_read, amount: number) => {
      runs++;
      return amount * 2;
    });
    expect($double(1)).not.toBe($double(1));
    expect(untracked(realm, (read) => read($double(1)))).toBe(2);
    expect(runs).toBe(1);
  });

  test("the entry is dropped when its last observer leaves", () => {
    const realm = createRealm();
    const $double = computedFunction(realm, (_read, amount: number) => amount * 2);
    const stop = watch(
      realm,
      (read) => read($double(1)),
      () => {},
    );
    const kept = $double(1);
    expect($double(1)).toBe(kept);
    stop();
    expect($double(1)).not.toBe(kept);
  });

  test("an entry a watch stops reading is dropped at the end of that round", () => {
    const realm = createRealm();
    const $id = box(realm, 1);
    const $double = computedFunction(realm, (_read, amount: number) => amount * 2);
    const seen: Array<number> = [];
    const stop = watch(
      realm,
      (read) => read($double(read($id))),
      (value) => {
        seen.push(value);
      },
    );
    const first = $double(1);
    update(realm, (_read, write) => {
      write($id, 2);
    });
    expect(seen).toEqual([4]);
    expect($double(1)).not.toBe(first);
    expect($double(2)).toBe($double(2));
    stop();
  });

  test("an entry observed twice stays until both observers leave", () => {
    const realm = createRealm();
    const $double = computedFunction(realm, (_read, amount: number) => amount * 2);
    const first = watch(
      realm,
      (read) => read($double(1)),
      () => {},
    );
    const kept = $double(1);
    const second = watch(
      realm,
      (read) => read($double(1)),
      () => {},
    );
    first();
    expect($double(1)).toBe(kept);
    second();
    expect($double(1)).not.toBe(kept);
  });

  test("a computed value kept past its entry still works", () => {
    const realm = createRealm();
    const $rate = box(realm, 2);
    const $times = computedFunction(realm, (read, amount: number) => amount * read($rate));
    const stop = watch(
      realm,
      (read) => read($times(3)),
      () => {},
    );
    const kept = $times(3);
    stop();
    update(realm, (_read, write) => {
      write($rate, 5);
    });
    expect(untracked(realm, (read) => read(kept))).toBe(15);
    const seen: Array<number> = [];
    const again = watch(
      realm,
      (read) => read(kept),
      (value) => {
        seen.push(value);
      },
    );
    expect($times(3)).toBe(kept);
    update(realm, (_read, write) => {
      write($rate, 6);
    });
    expect(seen).toEqual([18]);
    again();
  });

  test("an entry recomputes when what it reads changes", () => {
    const realm = createRealm();
    const $rate = box(realm, 2);
    const $times = computedFunction(realm, (read, amount: number) => amount * read($rate));
    const seen: Array<number> = [];
    const stop = watch(
      realm,
      (read) => read($times(3)),
      (value) => {
        seen.push(value);
      },
    );
    update(realm, (_read, write) => {
      write($rate, 4);
    });
    expect(seen).toEqual([12]);
    stop();
  });

  test("an observed entry computes once for every reader", () => {
    const realm = createRealm();
    const $rate = box(realm, 2);
    let runs = 0;
    const $times = computedFunction(realm, (read, amount: number) => {
      runs++;
      return amount * read($rate);
    });
    const stops = [1, 2, 3].map(() =>
      watch(
        realm,
        (read) => read($times(3)),
        () => {},
      ),
    );
    runs = 0;
    update(realm, (_read, write) => {
      write($rate, 4);
    });
    expect(runs).toBe(1);
    for (const stop of stops) {
      stop();
    }
  });

  test("equals is applied as on computed", () => {
    const realm = createRealm();
    const $rate = box(realm, 2);
    const $parity = computedFunction(
      realm,
      (read, amount: number) => ({ even: (amount * read($rate)) % 2 === 0 }),
      {
        equals: (left, right) => left.even === right.even,
      },
    );
    const seen: Array<boolean> = [];
    const stop = watch(
      realm,
      (read) => read($parity(3)),
      (value) => {
        seen.push(value.even);
      },
    );
    update(realm, (_read, write) => {
      write($rate, 4);
    });
    update(realm, (_read, write) => {
      write($rate, 3);
    });
    expect(seen).toEqual([false]);
    stop();
  });

  test("a computed value that reads an entry keeps it while observed", () => {
    const realm = createRealm();
    const $double = computedFunction(realm, (_read, amount: number) => amount * 2);
    const $total = computed(realm, (read) => read($double(1)) + read($double(2)));
    const stop = watch(
      realm,
      (read) => read($total),
      () => {},
    );
    expect($double(1)).toBe($double(1));
    stop();
    expect($double(1)).not.toBe($double(1));
  });
});
