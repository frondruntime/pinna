import { describe, expect, test } from "bun:test";
import {
  Box,
  Collection,
  Computed,
  isPinnaError,
  Realm,
  Source,
  Stage,
  View,
} from "../src/index.ts";
import { held, record, testRealm } from "../src/testing/index.ts";

/**
 * Views (ruling 63), snapshot and restore (ruling 64), and
 * `Computed.fromPromise` (ruling 65) used on the same state. Each feature's
 * own file tests it alone; this file tests what one feature does to another.
 */

interface Order {
  readonly id: string;
  readonly customer: string;
  readonly amount: number;
}

const order = (id: string, customer: string, amount: number): Order => ({ id, customer, amount });

const orders = (realm: Realm) =>
  Collection.make<string, Order>(realm, {
    keyOf: (row) => row.id,
    equals: (left, right) =>
      left.id === right.id && left.customer === right.customer && left.amount === right.amount,
    name: "orders",
  });

const byAmount = () => (left: Order, right: Order) => left.amount - right.amount;

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    if (isPinnaError(error, "PinnaUsageError")) {
      return error.code;
    }
    throw error;
  }
  return undefined;
};

const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

describe("a view over a restored collection", () => {
  test("follows the rows a restore adds, replaces, and removes", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    const $note = Box.make(realm, "");
    const shape = { $orders, $note };
    Realm.update(realm, (_read, write) => {
      write.replaceAll($orders, [order("a", "x", 30), order("b", "y", 10)]);
    });
    const view = View.ordered($orders, { compare: byAmount });
    using _ = held(() => View.dispose(view));
    using keys = record(realm, (read) => read(view.keys));
    Realm.update(realm, (_read, write) => {
      write.restore(shape, {
        $orders: [order("b", "y", 50), order("c", "x", 5)],
        $note: "restored",
      });
    });
    expect(keys.values.at(-1)).toEqual(["c", "b"]);
  });

  test("a restore that a later throw puts back leaves the view as it was", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    Realm.update(realm, (_read, write) => write.upsert($orders, order("a", "x", 1)));
    const view = View.ordered($orders, { compare: byAmount });
    using _ = held(() => View.dispose(view));
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.restore({ $orders }, { $orders: [order("z", "x", 0), order("a", "x", 9)] });
        throw new Error("after the restore");
      }),
    ).toThrow("after the restore");
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual(["a"]);
    expect(Realm.untracked(realm, (read) => read.snapshot({ $orders }))).toEqual({
      $orders: [order("a", "x", 1)],
    });
  });

  test("a stage recipe's restore shows in the view through the stage, and lands at apply", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    Realm.update(realm, (_read, write) => write.upsert($orders, order("a", "x", 2)));
    const view = View.ordered($orders, { compare: byAmount });
    using _ = held(() => View.dispose(view));
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write.restore({ $orders }, { $orders: [order("a", "x", 2), order("b", "x", 1)] });
    });
    expect(Stage.read(stage, (read) => read(view.keys))).toEqual(["b", "a"]);
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual(["a"]);
    Stage.apply(stage);
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual(["b", "a"]);
  });

  test("a view cannot start while a stage's restore holds writes to its collection", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write.restore({ $orders }, { $orders: [order("a", "x", 1)] });
    });
    expect(codeOf(() => View.ordered($orders, { compare: byAmount }))).toBe(
      "pinna/view-staged-rows",
    );
    Stage.drop(stage);
  });
});

describe("Computed.fromPromise beside views and snapshots", () => {
  test("a snapshot refuses a value from a promise, as any computed value", () => {
    using realm = testRealm();
    const $remote = Computed.fromPromise(realm, () => Promise.resolve(1), 0);
    expect(codeOf(() => Realm.untracked(realm, (read) => read.snapshot({ $remote })))).toBe(
      "pinna/snapshot-not-state",
    );
  });

  test("a view's filter that reads a value from a promise rebuilds when it resolves", async () => {
    using realm = testRealm();
    const $orders = orders(realm);
    Realm.update(realm, (_read, write) => {
      write.replaceAll($orders, [order("a", "x", 30), order("b", "y", 10), order("c", "x", 20)]);
    });
    let resolve: (customer: string) => void = () => undefined;
    const $customer = Computed.fromPromise(
      realm,
      () =>
        new Promise<string>((onResolve) => {
          resolve = onResolve;
        }),
      "",
    );
    const view = View.ordered($orders, {
      compare: byAmount,
      filter: (read) => {
        const customer = read($customer);
        return customer === "" ? undefined : (row) => row.customer === customer;
      },
    });
    using _ = held(() => View.dispose(view));
    using keys = record(realm, (read) => read(view.keys));
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual(["b", "c", "a"]);
    resolve("x");
    await settle();
    expect(keys.values.at(-1)).toEqual(["c", "a"]);
  });

  test("Realm.dispose ends the view and the promise's observation together", async () => {
    const realm = Realm.make();
    const $orders = orders(realm);
    let aborted = false;
    const $limit = Computed.fromPromise(
      realm,
      (signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise<number>(() => undefined);
      },
      100,
    );
    const view = View.ordered($orders, {
      compare: byAmount,
      filter: (read) => {
        const limit = read($limit);
        return (row) => row.amount < limit;
      },
    });
    const watch = Realm.watch(
      realm,
      (read) => read(view.keys),
      () => undefined,
    );
    expect(Source.inspect($limit).observers).toBeGreaterThan(0);
    Realm.dispose(realm);
    expect(View.status(view)).toBe("disposed");
    expect(aborted).toBe(true);
    watch();
    await settle();
  });
});
