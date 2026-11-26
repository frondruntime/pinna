import { describe, expect, test } from "bun:test";
import { Box, Computed, Realm, Source } from "../src/index.ts";
import { keptRead } from "./kept.ts";

/**
 * `Computed.fn`: one computed value per argument tuple, kept while something
 * observes it and dropped when the last observer leaves.
 */

describe("computedFunction", () => {
  test("signed-zero arguments stay distinct while observed and after release", () => {
    const realm = Realm.make();
    const $reciprocal = Computed.fn(realm, (_read, value: number) => 1 / value);
    const positive = $reciprocal(0);
    const stopPositive = Realm.watch(
      realm,
      (read) => read(positive),
      () => {},
    );
    expect(Realm.untracked(realm, (read) => read($reciprocal(-0)))).toBe(-Infinity);
    const negative = $reciprocal(-0);
    const stopNegative = Realm.watch(
      realm,
      (read) => read(negative),
      () => {},
    );
    expect($reciprocal(0)).toBe(positive);
    expect($reciprocal(-0)).toBe(negative);
    stopNegative();
    expect($reciprocal(-0)).not.toBe(negative);
    expect($reciprocal(0)).toBe(positive);
    stopPositive();
    expect($reciprocal(0)).not.toBe(positive);
    expect(Realm.untracked(realm, (read) => read($reciprocal(-0)))).toBe(-Infinity);
  });

  test("signed zero is distinct in each argument position and NaN keeps its entry", () => {
    const realm = Realm.make();
    const $sum = Computed.fn(realm, (_read, first: number, second: number) => 1 / first + second);
    const positive = $sum(1, 0);
    const negative = $sum(1, -0);
    const nan = $sum(NaN, NaN);
    const stops = [positive, negative, nan].map((entry) =>
      Realm.watch(
        realm,
        (read) => read(entry),
        () => {},
      ),
    );
    expect($sum(1, 0)).toBe(positive);
    expect($sum(1, -0)).toBe(negative);
    expect($sum(NaN, NaN)).toBe(nan);
    for (const stop of stops) {
      stop();
    }
    expect($sum(1, 0)).not.toBe(positive);
    expect($sum(1, -0)).not.toBe(negative);
    expect($sum(NaN, NaN)).not.toBe(nan);
  });

  test("a call returns a computed value of the arguments", () => {
    const realm = Realm.make();
    const $rate = Box.make(realm, 2);
    const $times = Computed.fn(
      realm,
      (read, amount: number, extra: number) => amount * read($rate) + extra,
    );
    expect(Realm.untracked(realm, (read) => read($times(3, 1)))).toBe(7);
    expect(Realm.untracked(realm, (read) => read($times(4, 0)))).toBe(8);
  });

  test("a read kept past its place throws, as on any computed value", () => {
    const realm = Realm.make();
    const $double = Computed.fn(realm, (_read, amount: number) => amount * 2);
    const read = keptRead(realm);
    expect(() => read($double(1))).toThrow("runs outside a place");
  });

  test("while observed, the same arguments return the same computed value", () => {
    const realm = Realm.make();
    const $double = Computed.fn(realm, (_read, amount: number) => amount * 2);
    const stop = Realm.watch(
      realm,
      (read) => read($double(1)),
      () => {},
    );
    expect($double(1)).toBe($double(1));
    expect($double(2)).not.toBe($double(1));
    stop();
  });

  test("arguments are compared by identity, one per position", () => {
    const realm = Realm.make();
    const first = { rate: 2 };
    const second = { rate: 2 };
    const $scaled = Computed.fn(
      realm,
      (_read, rates: { readonly rate: number }, amount: number) => rates.rate * amount,
    );
    const stop = Realm.watch(
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
    const realm = Realm.make();
    const $sum = Computed.fn(realm, (_read, ...values: ReadonlyArray<number>) =>
      values.reduce((a, b) => a + b, 0),
    );
    const stop = Realm.watch(
      realm,
      (read) => read($sum(1)) + read($sum(1, 0)),
      () => {},
    );
    expect($sum(1)).not.toBe($sum(1, 0));
    expect(Realm.untracked(realm, (read) => read($sum(1)))).toBe(1);
    stop();
  });

  test("nothing is kept while nothing observes it", () => {
    const realm = Realm.make();
    let runs = 0;
    const $double = Computed.fn(realm, (_read, amount: number) => {
      runs++;
      return amount * 2;
    });
    expect($double(1)).not.toBe($double(1));
    expect(Realm.untracked(realm, (read) => read($double(1)))).toBe(2);
    expect(runs).toBe(1);
  });

  test("the entry is dropped when its last observer leaves", () => {
    const realm = Realm.make();
    const $double = Computed.fn(realm, (_read, amount: number) => amount * 2);
    const stop = Realm.watch(
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
    const realm = Realm.make();
    const $id = Box.make(realm, 1);
    const $double = Computed.fn(realm, (_read, amount: number) => amount * 2);
    const seen: Array<number> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($double(read($id))),
      (value) => {
        seen.push(value);
      },
    );
    const first = $double(1);
    Realm.update(realm, (_read, write) => {
      write($id, 2);
    });
    expect(seen).toEqual([4]);
    expect($double(1)).not.toBe(first);
    expect($double(2)).toBe($double(2));
    stop();
  });

  test("an entry observed twice stays until both observers leave", () => {
    const realm = Realm.make();
    const $double = Computed.fn(realm, (_read, amount: number) => amount * 2);
    const first = Realm.watch(
      realm,
      (read) => read($double(1)),
      () => {},
    );
    const kept = $double(1);
    const second = Realm.watch(
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
    const realm = Realm.make();
    const $rate = Box.make(realm, 2);
    const $times = Computed.fn(realm, (read, amount: number) => amount * read($rate));
    const stop = Realm.watch(
      realm,
      (read) => read($times(3)),
      () => {},
    );
    const kept = $times(3);
    stop();
    Realm.update(realm, (_read, write) => {
      write($rate, 5);
    });
    expect(Realm.untracked(realm, (read) => read(kept))).toBe(15);
    const seen: Array<number> = [];
    const again = Realm.watch(
      realm,
      (read) => read(kept),
      (value) => {
        seen.push(value);
      },
    );
    expect($times(3)).toBe(kept);
    Realm.update(realm, (_read, write) => {
      write($rate, 6);
    });
    expect(seen).toEqual([18]);
    again();
  });

  test("an entry recomputes when what it reads changes", () => {
    const realm = Realm.make();
    const $rate = Box.make(realm, 2);
    const $times = Computed.fn(realm, (read, amount: number) => amount * read($rate));
    const seen: Array<number> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($times(3)),
      (value) => {
        seen.push(value);
      },
    );
    Realm.update(realm, (_read, write) => {
      write($rate, 4);
    });
    expect(seen).toEqual([12]);
    stop();
  });

  test("an observed entry computes once for every reader", () => {
    const realm = Realm.make();
    const $rate = Box.make(realm, 2);
    let runs = 0;
    const $times = Computed.fn(realm, (read, amount: number) => {
      runs++;
      return amount * read($rate);
    });
    const stops = [1, 2, 3].map(() =>
      Realm.watch(
        realm,
        (read) => read($times(3)),
        () => {},
      ),
    );
    runs = 0;
    Realm.update(realm, (_read, write) => {
      write($rate, 4);
    });
    expect(runs).toBe(1);
    for (const stop of stops) {
      stop();
    }
  });

  test("equals is applied as on computed", () => {
    const realm = Realm.make();
    const $rate = Box.make(realm, 2);
    const $parity = Computed.fn(
      realm,
      (read, amount: number) => ({ even: (amount * read($rate)) % 2 === 0 }),
      {
        equals: (left, right) => left.even === right.even,
      },
    );
    const seen: Array<boolean> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($parity(3)),
      (value) => {
        seen.push(value.even);
      },
    );
    Realm.update(realm, (_read, write) => {
      write($rate, 4);
    });
    Realm.update(realm, (_read, write) => {
      write($rate, 3);
    });
    expect(seen).toEqual([false]);
    stop();
  });

  test("a computed value that reads an entry keeps it while observed", () => {
    const realm = Realm.make();
    const $double = Computed.fn(realm, (_read, amount: number) => amount * 2);
    const $total = Computed.make(realm, (read) => read($double(1)) + read($double(2)));
    const stop = Realm.watch(
      realm,
      (read) => read($total),
      () => {},
    );
    expect($double(1)).toBe($double(1));
    stop();
    expect($double(1)).not.toBe($double(1));
  });
});

describe("two entries for the same arguments", () => {
  test("releasing the kept entry hands the arguments to another still observed", () => {
    const realm = Realm.make();
    const lookup = Computed.fn(realm, (_read, key: string) => key);
    const first = lookup("row");
    const second = lookup("row");
    expect(first).not.toBe(second);
    const stopFirst = Source.observe(first);
    const stopSecond = Source.observe(second);
    expect(lookup("row")).toBe(first);
    stopFirst();
    expect(lookup("row")).toBe(second);
    stopSecond();
    const third = lookup("row");
    expect(third).not.toBe(second);
    Realm.dispose(realm);
  });

  test("releasing a spare entry first keeps the kept one", () => {
    const realm = Realm.make();
    const lookup = Computed.fn(realm, (_read, key: string) => key);
    const first = lookup("row");
    const second = lookup("row");
    const stopFirst = Source.observe(first);
    const stopSecond = Source.observe(second);
    stopSecond();
    expect(lookup("row")).toBe(first);
    stopFirst();
    expect(lookup("row")).not.toBe(first);
    Realm.dispose(realm);
  });
});
