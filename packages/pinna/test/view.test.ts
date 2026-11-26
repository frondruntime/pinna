import { describe, expect, test } from "bun:test";
import {
  Box,
  Collection,
  Computed,
  PinnaUsageError,
  type Read,
  Realm,
  Stage,
  type UpdateRecord,
  View,
} from "../src/index.ts";
import { held, record, testRealm } from "../src/testing/index.ts";

/**
 * `View.ordered`, `View.grouped`, and `View.totals`: views kept a row at a
 * time through `Collection.onRowChange`, with their state in boxes and
 * collections, so updates, rollbacks, and stages carry them (ruling 63).
 */

interface Order {
  readonly id: string;
  readonly customer: string;
  readonly amount: number;
}

const orders = (realm: Realm) =>
  Collection.make<string, Order>(realm, {
    keyOf: (order) => order.id,
    equals: (left, right) =>
      left.customer === right.customer && left.amount === right.amount && left.id === right.id,
  });

const order = (id: string, customer: string, amount: number): Order => ({ id, customer, amount });

const byAmount = () => (left: Order, right: Order) => left.amount - right.amount;

const integers = {
  zero: 0,
  add: (a: number, b: number) => a + b,
  subtract: (a: number, b: number) => a - b,
};

/** Every value `select` gave: the first now, then each one a watch saw. */
const follow = <Value>(realm: Realm, select: (read: Read) => Value) => {
  const values: Array<Value> = [Realm.untracked(realm, select)];
  const recording = record(realm, select);
  return {
    values,
    get last(): Value {
      return recording.values.at(-1) ?? (values[0] as Value);
    },
    get count(): number {
      return 1 + recording.values.length;
    },
    [Symbol.dispose]: () => recording[Symbol.dispose](),
  };
};

const usageCode = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof PinnaUsageError ? error.code : `not a usage error: ${String(error)}`;
  }
  return undefined;
};

describe("View.ordered", () => {
  test("sorts the held rows, then keeps the order a row at a time", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    Realm.update(realm, (_read, write) => {
      write.replaceAll($orders, [order("a", "x", 30), order("b", "y", 10), order("c", "x", 20)]);
    });
    const view = View.ordered($orders, { compare: byAmount, name: "byAmount" });
    using _ = held(() => View.dispose(view));
    using keys = follow(realm, (read) => read(view.keys));
    expect(keys.last).toEqual(["b", "c", "a"]);
    Realm.update(realm, (_read, write) => {
      write.upsert($orders, order("d", "z", 15));
      write.upsert($orders, order("a", "x", 5));
      write.remove($orders, "c");
    });
    expect(keys.last).toEqual(["a", "b", "d"]);
    expect(Realm.untracked(realm, (read) => [read(view.size), read(view.totalSize)])).toEqual([
      3, 3,
    ]);
  });

  test("filters, and a tracked filter change rebuilds without a row write", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    const $customer = Box.make<string | undefined>(realm, "x");
    const view = View.ordered($orders, {
      compare: byAmount,
      filter: (read) => {
        const customer = read($customer);
        return customer === undefined ? undefined : (row) => row.customer === customer;
      },
    });
    using _ = held(() => View.dispose(view));
    Realm.update(realm, (_read, write) => {
      write.replaceAll($orders, [order("a", "x", 30), order("b", "y", 10), order("c", "x", 20)]);
    });
    using keys = follow(realm, (read) => read(view.keys));
    expect(keys.last).toEqual(["c", "a"]);
    Realm.update(realm, (_read, write) => write($customer, "y"));
    expect(keys.last).toEqual(["b"]);
    Realm.update(realm, (_read, write) => write($customer, undefined));
    expect(keys.last).toEqual(["b", "c", "a"]);
    // A row write after the change keeps the rebuilt order.
    Realm.update(realm, (_read, write) => {
      write($customer, "x");
      write.upsert($orders, order("e", "x", 1));
    });
    expect(keys.last).toEqual(["e", "c", "a"]);
    expect(Realm.untracked(realm, (read) => [read(view.size), read(view.totalSize)])).toEqual([
      3, 4,
    ]);
  });

  test("a tracked comparator change sorts again", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    const $descending = Box.make(realm, false);
    const view = View.ordered($orders, {
      compare: (read) => {
        const sign = read($descending) ? -1 : 1;
        return (left, right) => sign * (left.amount - right.amount);
      },
    });
    using _ = held(() => View.dispose(view));
    Realm.update(realm, (_read, write) => {
      write.replaceAll($orders, [order("a", "x", 30), order("b", "y", 10), order("c", "x", 20)]);
    });
    using keys = follow(realm, (read) => read(view.keys));
    Realm.update(realm, (_read, write) => write($descending, true));
    expect(keys.last).toEqual(["a", "c", "b"]);
    Realm.update(realm, (_read, write) => write.remove($orders, "c"));
    expect(keys.last).toEqual(["a", "b"]);
  });

  test("a range reruns its reader only when its keys change", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    Realm.update(realm, (_read, write) => {
      write.replaceAll(
        $orders,
        Array.from({ length: 10 }, (_, index) => order(`k${index}`, "x", index * 10)),
      );
    });
    const view = View.ordered($orders, { compare: byAmount });
    using _ = held(() => View.dispose(view));
    using window = follow(realm, (read) => read(view.range(0, 3)));
    expect(window.last).toEqual(["k0", "k1", "k2"]);
    expect(view.range(0, 3)).toBe(view.range(0, 3));
    Realm.update(realm, (_read, write) => write.upsert($orders, order("k9", "x", 95)));
    expect(window.count).toBe(1);
    Realm.update(realm, (_read, write) => write.upsert($orders, order("k9", "x", -1)));
    expect(window.last).toEqual(["k9", "k0", "k1"]);
    // Clamped to the size; an end before the start is empty.
    expect(Realm.untracked(realm, (read) => read(view.range(8, 50)))).toEqual(["k7", "k8"]);
    expect(Realm.untracked(realm, (read) => read(view.range(5, 2)))).toEqual([]);
    expect(usageCode(() => view.range(-1, 2))).toBe("pinna/view-range");
    expect(usageCode(() => view.range(0, 1.5))).toBe("pinna/view-range");
  });

  test("breaks ties by key, and throws for keys that cannot break one", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    const view = View.ordered($orders, { compare: () => () => 0 });
    using _ = held(() => View.dispose(view));
    Realm.update(realm, (_read, write) => {
      write.replaceAll($orders, [order("c", "x", 1), order("a", "x", 1), order("b", "x", 1)]);
    });
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual(["a", "b", "c"]);
    const $objects = Collection.make<object, { readonly key: object }>(realm, {
      keyOf: (row) => row.key,
    });
    const tied = View.ordered($objects, { compare: () => () => 0, name: "tied" });
    using __ = held(() => View.dispose(tied));
    expect(
      usageCode(() =>
        Realm.update(realm, (_read, write) => {
          write.replaceAll($objects, [{ key: {} }, { key: {} }]);
        }),
      ),
    ).toBe("pinna/view-tie");
    expect(Realm.untracked(realm, (read) => read($objects.keys))).toEqual([]);
  });

  test("throws for a comparator that returns NaN, and puts the rows back", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    const view = View.ordered($orders, { compare: () => () => Number.NaN });
    using _ = held(() => View.dispose(view));
    Realm.update(realm, (_read, write) => write.upsert($orders, order("a", "x", 1)));
    expect(
      usageCode(() =>
        Realm.update(realm, (_read, write) => write.upsert($orders, order("b", "x", 2))),
      ),
    ).toBe("pinna/view-compare-result");
    expect(Realm.untracked(realm, (read) => read($orders.keys))).toEqual(["a"]);
  });

  test("throws when a filter answers differently for a row it placed", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    let allow = true;
    const view = View.ordered($orders, { compare: byAmount, filter: () => () => allow });
    using _ = held(() => View.dispose(view));
    Realm.update(realm, (_read, write) => write.upsert($orders, order("a", "x", 1)));
    allow = false;
    expect(usageCode(() => Realm.update(realm, (_read, write) => write.remove($orders, "a")))).toBe(
      "pinna/view-out-of-step",
    );
    allow = true;
    Realm.update(realm, (_read, write) => write.upsert($orders, order("b", "x", 2)));
    allow = false;
    expect(
      usageCode(() =>
        Realm.update(realm, (_read, write) => write.upsert($orders, order("b", "x", 3))),
      ),
    ).toBe("pinna/view-out-of-step");
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual(["a", "b"]);
  });

  test("a failed update puts the view back with the rows", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    const view = View.ordered($orders, { compare: byAmount });
    using _ = held(() => View.dispose(view));
    Realm.update(realm, (_read, write) => write.upsert($orders, order("a", "x", 1)));
    using keys = follow(realm, (read) => read(view.keys));
    expect(() =>
      Realm.update(realm, (read, write) => {
        write.upsert($orders, order("b", "x", 0));
        expect(read(view.keys)).toEqual(["b", "a"]);
        throw new Error("refused");
      }),
    ).toThrow("refused");
    // A read inside the failed update can deliver the restored value again,
    // as with any computed value (updates.md); it is the same keys.
    expect(keys.last).toEqual(["a"]);
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual(["a"]);
  });

  test("nested updates and an autorun see each write", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    const view = View.ordered($orders, { compare: byAmount });
    using _ = held(() => View.dispose(view));
    const seen: Array<ReadonlyArray<string>> = [];
    using __ = held(Realm.autorun(realm, (read) => void seen.push(read(view.keys))));
    Realm.update(realm, (_read, write) => {
      write.upsert($orders, order("a", "x", 2));
      Realm.update(realm, (read, innerWrite) => {
        innerWrite.upsert($orders, order("b", "x", 1));
        expect(read(view.keys)).toEqual(["b", "a"]);
      });
    });
    expect(seen).toEqual([[], ["b", "a"]]);
  });

  test("a derivation over a range follows it", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    const view = View.ordered($orders, { compare: byAmount });
    using _ = held(() => View.dispose(view));
    const $top = Computed.make(realm, (read) => read(view.range(0, 1))[0] ?? "none");
    using top = follow(realm, (read) => read($top));
    Realm.update(realm, (_read, write) => write.upsert($orders, order("a", "x", 2)));
    Realm.update(realm, (_read, write) => write.upsert($orders, order("b", "x", 1)));
    expect([top.count, top.last]).toEqual([3, "b"]);
  });

  test("a stage sees the view over its staged rows, and applying lands it", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    const view = View.ordered($orders, { compare: byAmount });
    using _ = held(() => View.dispose(view));
    Realm.update(realm, (_read, write) => write.upsert($orders, order("a", "x", 2)));
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => write.upsert($orders, order("b", "x", 1)));
    expect(Stage.read(stage, (read) => read(view.keys))).toEqual(["b", "a"]);
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual(["a"]);
    Stage.apply(stage);
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual(["b", "a"]);
  });

  test("matches a sort of the rows after random writes, reverts, and replays", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    const $threshold = Box.make(realm, 50);
    const $descending = Box.make(realm, false);
    const records: Array<UpdateRecord> = [];
    const stopRecords = Realm.onUpdate(realm, (landed) => {
      records.push(landed);
    });
    using _records = held(stopRecords);
    const view = View.ordered($orders, {
      compare: (read) => {
        const sign = read($descending) ? -1 : 1;
        return (left, right) => sign * (left.amount - right.amount);
      },
      filter: (read) => {
        const threshold = read($threshold);
        return (row) => row.amount < threshold;
      },
    });
    using _ = held(() => View.dispose(view));
    const groups = View.grouped($orders, { groupOf: (row) => row.amount % 3 });
    using _groups = held(() => View.dispose(groups));
    const totals = View.totals($orders, {
      project: (row) => ({ group: row.amount % 3, value: row.amount }),
      arithmetic: integers,
    });
    using _totals = held(() => View.dispose(totals));
    let seed = 7;
    const next = (limit: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return Math.floor((seed / 2147483648) * limit);
    };
    // The records of the updates below, undone ones past `cursor`.
    const history: Array<UpdateRecord> = [];
    let cursor = 0;
    let restores = 0;
    for (let step = 0; step < 600; step++) {
      const choice = next(14);
      if (choice >= 11) {
        // An undo or a redo, in order; the view hears it as any write.
        if (choice < 13 && cursor > 0) {
          cursor--;
          Realm.update(realm, (_read, write) => write.revert(history[cursor] as UpdateRecord));
          restores++;
        } else if (choice === 13 && cursor < history.length) {
          Realm.update(realm, (_read, write) => write.replay(history[cursor] as UpdateRecord));
          cursor++;
          restores++;
        }
      } else {
        const count = records.length;
        Realm.update(realm, (read, write) => {
          if (choice === 10) write($descending, !read($descending));
          if (choice < 5) write.upsert($orders, order(`k${next(40)}`, "x", next(100)));
          else if (choice < 8) write.remove($orders, `k${next(40)}`);
          else if (choice < 9) write($threshold, next(100));
          else if (choice === 9)
            write.replaceAll(
              $orders,
              Array.from({ length: next(20) }, () => order(`k${next(40)}`, "x", next(100))).filter(
                (row, index, rows) => rows.findIndex((other) => other.id === row.id) === index,
              ),
            );
        });
        if (records.length > count) {
          history.splice(cursor);
          history.push(records[records.length - 1] as UpdateRecord);
          cursor = history.length;
        }
      }
      Realm.untracked(realm, (read) => {
        const threshold = read($threshold);
        const sign = read($descending) ? -1 : 1;
        const rows = read($orders.rows);
        const expected = [...rows]
          .filter((row) => row.amount < threshold)
          .sort(
            (left, right) => sign * (left.amount - right.amount) || (left.id < right.id ? -1 : 1),
          )
          .map((row) => row.id);
        expect(read(view.keys)).toEqual(expected);
        for (let group = 0; group < 3; group++) {
          const members = rows.filter((row) => row.amount % 3 === group);
          expect([...read(groups.group(group))].sort()).toEqual(
            members.map((row) => row.id).sort(),
          );
          expect(read(totals.group(group))).toEqual({
            count: members.length,
            total: members.reduce((sum, row) => sum + row.amount, 0),
          });
        }
      });
    }
    expect(restores).toBeGreaterThan(50);
  });

  test("disposes once, reports its status, and throws on a later read", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    const view = View.ordered($orders, { compare: byAmount, name: "book" });
    expect(View.status(view)).toBe("open");
    View.dispose(view);
    View.dispose(view);
    expect(View.status(view)).toBe("disposed");
    expect(usageCode(() => view.keys)).toBe("pinna/view-disposed");
    expect(() => view.size).toThrow('pinna: View.ordered "book" is disposed');
    // A row write after disposal reaches no listener.
    Realm.update(realm, (_read, write) => write.upsert($orders, order("a", "x", 1)));
  });

  test("Realm.dispose ends it, and testRealm reports one left running", () => {
    const realm = Realm.make();
    const view = View.ordered(orders(realm), { compare: byAmount });
    Realm.dispose(realm);
    expect(View.status(view)).toBe("disposed");
    const leaking = testRealm();
    View.ordered(orders(leaking), { compare: byAmount, name: "left" });
    expect(() => leaking[Symbol.dispose]()).toThrow('View.ordered "left" still running');
  });

  test("a view takes a collection of its own realm, and another realm's box in a factory throws", () => {
    using realm = testRealm();
    using other = testRealm();
    const $foreign = Box.make(other, 1);
    const $orders = orders(realm);
    const view = View.ordered($orders, {
      compare: (read) => {
        read($foreign);
        return byAmount();
      },
    });
    using _ = held(() => View.dispose(view));
    expect(usageCode(() => Realm.untracked(realm, (read) => read(view.keys)))).toBe(
      "pinna/foreign-realm",
    );
  });
});

describe("view review cases", () => {
  test("a view made in an update that fails is disposed with it", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    let view: ReturnType<typeof View.ordered<string, Order>> | undefined;
    expect(() =>
      Realm.update(realm, () => {
        view = View.ordered($orders, { compare: byAmount });
        throw new Error("refused");
      }),
    ).toThrow("refused");
    Realm.update(realm, (_read, write) => write.upsert($orders, order("a", "x", 1)));
    const escaped = view as NonNullable<typeof view>;
    expect(View.status(escaped)).toBe("disposed");
    expect(usageCode(() => escaped.keys)).toBe("pinna/view-disposed");
  });

  test("a computed value taken before disposal keeps its last value when a factory's box changes", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    const $descending = Box.make(realm, false);
    const view = View.ordered($orders, {
      compare: (read) => {
        const sign = read($descending) ? -1 : 1;
        return (left, right) => sign * (left.amount - right.amount);
      },
    });
    Realm.update(realm, (_read, write) => {
      write.replaceAll($orders, [order("a", "x", 1), order("b", "x", 2)]);
    });
    const $keys = view.keys;
    using keys = follow(realm, (read) => read($keys));
    View.dispose(view);
    Realm.update(realm, (_read, write) => write($descending, true));
    expect(keys.count).toBe(1);
    expect(Realm.untracked(realm, (read) => read($keys))).toEqual(["a", "b"]);
  });

  describe("a disposed view keeps the realm's confirmed order", () => {
    const setup = (realm: Realm) => {
      const $rows = Collection.make(realm, { keyOf: (value: number) => value });
      const $descending = Box.make(realm, false);
      const view = View.ordered($rows, {
        compare: (read) =>
          read($descending) ? (left, right) => right - left : (left, right) => left - right,
      });
      return { $rows, $descending, view, $keys: view.keys };
    };

    test("a handle read under a visible stage drops the stage's rows at disposal", () => {
      using realm = testRealm();
      const { $rows, view, $keys } = setup(realm);
      Realm.update(realm, (_read, write) => write.upsert($rows, 1));
      const guess = Stage.make(realm, { visible: true });
      Stage.update(guess, (_read, write) => write.upsert($rows, 2));
      using keys = follow(realm, (read) => read($keys));
      expect(keys.last).toEqual([1, 2]);
      View.dispose(view);
      expect(keys.last).toEqual([1]);
      Stage.drop(guess);
      expect(Realm.untracked(realm, (read) => read($keys))).toEqual([1]);
    });

    test("a comparator a visible stage shows is not frozen", () => {
      using realm = testRealm();
      const { $rows, $descending, view, $keys } = setup(realm);
      Realm.update(realm, (_read, write) => {
        write.upsert($rows, 1);
        write.upsert($rows, 2);
      });
      const guess = Stage.make(realm, { visible: true });
      Stage.update(guess, (_read, write) => write($descending, true));
      expect(Realm.untracked(realm, (read) => read($keys))).toEqual([2, 1]);
      View.dispose(view);
      Stage.drop(guess);
      expect(Realm.untracked(realm, (read) => read($keys))).toEqual([1, 2]);
    });

    test("a comparator a hidden stage read is not frozen", () => {
      using realm = testRealm();
      const { $rows, $descending, view, $keys } = setup(realm);
      Realm.update(realm, (_read, write) => {
        write.upsert($rows, 1);
        write.upsert($rows, 2);
      });
      expect(Realm.untracked(realm, (read) => read($keys))).toEqual([1, 2]);
      const hidden = Stage.make(realm);
      Stage.update(hidden, (_read, write) => write($descending, true));
      expect(Stage.read(hidden, (read) => read($keys))).toEqual([2, 1]);
      Stage.drop(hidden);
      View.dispose(view);
      Realm.update(realm, (_read, write) => write($descending, true));
      expect(Realm.untracked(realm, (read) => read($keys))).toEqual([1, 2]);
    });

    test("a confirmed comparator change with no row write since is kept, a visible stage open or not", () => {
      for (const visible of [false, true]) {
        using realm = testRealm();
        const { $rows, $descending, view, $keys } = setup(realm);
        Realm.update(realm, (_read, write) => {
          write.upsert($rows, 1);
          write.upsert($rows, 2);
        });
        Realm.update(realm, (_read, write) => write($descending, true));
        const guess = visible ? Stage.make(realm, { visible: true }) : undefined;
        if (guess !== undefined) {
          Stage.update(guess, (_read, write) => write($descending, false));
        }
        View.dispose(view);
        if (guess !== undefined) Stage.drop(guess);
        Realm.update(realm, (_read, write) => write($descending, false));
        expect(Realm.untracked(realm, (read) => read($keys))).toEqual([2, 1]);
      }
    });

    test("a disposal inside an update that throws keeps the rows the rollback restored", () => {
      using realm = testRealm();
      const { $rows, $descending, view, $keys } = setup(realm);
      Realm.update(realm, (_read, write) => write.upsert($rows, 1));
      using keys = follow(realm, (read) => read($keys));
      expect(() =>
        Realm.update(realm, (_read, write) => {
          write.upsert($rows, 2);
          View.dispose(view);
          throw new Error("cancel");
        }),
      ).toThrow("cancel");
      Realm.update(realm, (_read, write) => write($descending, true));
      expect(keys.last).toEqual([1]);
      expect(Realm.untracked(realm, (read) => read($keys))).toEqual([1]);
    });

    test("a disposal inside an update that lands keeps the update's rows", () => {
      using realm = testRealm();
      const { $rows, $descending, view, $keys } = setup(realm);
      Realm.update(realm, (_read, write) => {
        write.upsert($rows, 1);
        write.upsert($rows, 2);
        View.dispose(view);
      });
      Realm.update(realm, (_read, write) => {
        write($descending, true);
        write.upsert($rows, 3);
      });
      expect(Realm.untracked(realm, (read) => read($keys))).toEqual([1, 2]);
    });
  });

  test("NaN keys sort after every other number on a tie", () => {
    using realm = testRealm();
    const $numbers = Collection.make<number, { readonly key: number }>(realm, {
      keyOf: (row) => row.key,
    });
    const view = View.ordered($numbers, { compare: () => () => 0 });
    using _ = held(() => View.dispose(view));
    Realm.update(realm, (_read, write) => {
      write.upsert($numbers, { key: 0 });
      write.upsert($numbers, { key: Number.NaN });
      write.upsert($numbers, { key: 1 });
    });
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual([0, 1, Number.NaN]);
    Realm.update(realm, (_read, write) => write.remove($numbers, 0));
    Realm.update(realm, (_read, write) => write.remove($numbers, Number.NaN));
    expect(Realm.untracked(realm, (read) => read(view.keys))).toEqual([1]);
  });

  test("a view cannot start while a stage holds writes to its collection", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    const $other = orders(realm);
    const stage = Stage.make(realm, { name: "draft" });
    Stage.update(stage, (_read, write) => write.upsert($other, order("z", "x", 1)));
    // A stage that wrote another collection does not stop it.
    const view = View.ordered($orders, { compare: byAmount });
    using _ = held(() => View.dispose(view));
    Stage.update(stage, (_read, write) => write.upsert($orders, order("b", "x", 1)));
    expect(usageCode(() => View.grouped($orders, { groupOf: (row) => row.customer }))).toBe(
      "pinna/view-staged-rows",
    );
    Stage.drop(stage);
    const grouped = View.grouped($orders, { groupOf: (row) => row.customer });
    View.dispose(grouped);
  });

  test("a new value in the same group keeps the group's place", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    const totals = View.totals($orders, {
      project: (row) => ({ group: row.customer, value: row.amount }),
      arithmetic: integers,
    });
    using _ = held(() => View.dispose(totals));
    Realm.update(realm, (_read, write) => {
      write.replaceAll($orders, [order("a", "x", 1), order("b", "y", 2)]);
    });
    Realm.update(realm, (_read, write) => write.upsert($orders, order("a", "x", 5)));
    expect(Realm.untracked(realm, (read) => read(totals.groups))).toEqual(["x", "y"]);
    expect(Realm.untracked(realm, (read) => read(totals.group("x")))).toEqual({
      count: 1,
      total: 5,
    });
  });
});

describe("View.grouped", () => {
  test("keeps the keys of each group, and moves a key between groups", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    Realm.update(realm, (_read, write) => {
      write.replaceAll($orders, [order("a", "x", 1), order("b", "y", 2), order("c", "x", 3)]);
    });
    const index = View.grouped($orders, { groupOf: (row) => row.customer });
    using _ = held(() => View.dispose(index));
    using x = follow(realm, (read) => read(index.group("x")));
    using y = follow(realm, (read) => read(index.group("y")));
    expect(x.last).toEqual(["a", "c"]);
    Realm.update(realm, (_read, write) => write.upsert($orders, order("a", "y", 1)));
    expect(x.last).toEqual(["c"]);
    expect(y.last).toEqual(["b", "a"]);
    // A row that stays in its group reruns neither reader.
    Realm.update(realm, (_read, write) => write.upsert($orders, order("c", "x", 99)));
    expect(x.count).toBe(2);
    Realm.update(realm, (_read, write) => write.remove($orders, "c"));
    expect(x.last).toEqual([]);
    expect(Realm.untracked(realm, (read) => read(index.groups))).toEqual(["y"]);
  });

  test("leaves out a row whose group is undefined, and rolls back with a failed update", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    const index = View.grouped($orders, {
      groupOf: (row) => (row.amount > 0 ? row.customer : undefined),
    });
    using _ = held(() => View.dispose(index));
    Realm.update(realm, (_read, write) => write.upsert($orders, order("a", "x", 0)));
    expect(Realm.untracked(realm, (read) => read(index.groups))).toEqual([]);
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.upsert($orders, order("a", "x", 5));
        throw new Error("refused");
      }),
    ).toThrow("refused");
    expect(Realm.untracked(realm, (read) => read(index.group("x")))).toEqual([]);
  });

  test("a stage sees its staged groups", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    const index = View.grouped($orders, { groupOf: (row) => row.customer });
    using _ = held(() => View.dispose(index));
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => write.upsert($orders, order("a", "x", 1)));
    expect(Stage.read(stage, (read) => read(index.group("x")))).toEqual(["a"]);
    Stage.drop(stage);
    expect(Realm.untracked(realm, (read) => read(index.group("x")))).toEqual([]);
  });
});

describe("View.totals", () => {
  test("keeps a count and total per group", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    const totals = View.totals($orders, {
      project: (row) => ({ group: row.customer, value: row.amount }),
      arithmetic: integers,
    });
    using _ = held(() => View.dispose(totals));
    using x = follow(realm, (read) => read(totals.group("x")));
    expect(x.last).toEqual({ count: 0, total: 0 });
    Realm.update(realm, (_read, write) => {
      write.replaceAll($orders, [order("a", "x", 10), order("b", "y", 2), order("c", "x", 5)]);
    });
    expect(x.last).toEqual({ count: 2, total: 15 });
    Realm.update(realm, (_read, write) => write.upsert($orders, order("a", "x", 1)));
    expect(x.last).toEqual({ count: 2, total: 6 });
    Realm.update(realm, (_read, write) => write.upsert($orders, order("a", "y", 1)));
    expect(x.last).toEqual({ count: 1, total: 5 });
    expect(Realm.untracked(realm, (read) => read(totals.group("y")))).toEqual({
      count: 2,
      total: 3,
    });
    // An unchanged value reruns nothing.
    const runs = x.count;
    Realm.update(realm, (_read, write) => write.upsert($orders, order("b", "y", 2)));
    expect(x.count).toBe(runs);
  });

  test("bigint totals stay exact, and a failed update puts them back", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    const totals = View.totals($orders, {
      project: (row) => ({ group: "all", value: BigInt(row.amount) }),
      arithmetic: { zero: 0n, add: (a, b) => a + b, subtract: (a, b) => a - b },
    });
    using _ = held(() => View.dispose(totals));
    Realm.update(realm, (_read, write) => write.upsert($orders, order("a", "x", 7)));
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write.upsert($orders, order("b", "x", 3));
        throw new Error("refused");
      }),
    ).toThrow("refused");
    expect(Realm.untracked(realm, (read) => read(totals.group("all")))).toEqual({
      count: 1,
      total: 7n,
    });
  });

  test("matches a sum of the rows after random writes", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    const totals = View.totals($orders, {
      project: (row) =>
        row.amount % 3 === 0 ? undefined : { group: row.customer, value: row.amount },
      arithmetic: integers,
    });
    using _ = held(() => View.dispose(totals));
    let seed = 11;
    const next = (limit: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return Math.floor((seed / 2147483648) * limit);
    };
    const customers = ["x", "y", "z"];
    for (let step = 0; step < 300; step++) {
      Realm.update(realm, (read, write) => {
        if (next(3) < 2)
          write.upsert($orders, order(`k${next(30)}`, customers[next(3)] as string, next(50)));
        else write.remove($orders, `k${next(30)}`);
        for (const customer of customers) {
          const rows = read($orders.rows).filter(
            (row) => row.customer === customer && row.amount % 3 !== 0,
          );
          expect(read(totals.group(customer))).toEqual({
            count: rows.length,
            total: rows.reduce((sum, row) => sum + row.amount, 0),
          });
        }
      });
    }
  });
});

/** A seeded generator: the same seed gives the same writes on every run. */
const seeded = (seed: number) => {
  let state = seed;
  return (limit: number): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    // The high bits: the low bits of this generator repeat with a short
    // period, which kept the planted bugs below from ever being reached.
    return Math.floor((state / 2147483648) * limit);
  };
};

describe("work per row write", () => {
  const counted = (realm: Realm, size: number) => {
    const $orders = orders(realm);
    Realm.update(realm, (_read, write) => {
      write.replaceAll(
        $orders,
        Array.from({ length: size }, (_, index) =>
          order(`k${index}`, `c${index % 7}`, (index * 7919) % size),
        ),
      );
    });
    const $threshold = Box.make(realm, size);
    const calls = { compare: 0, filter: 0, groupOf: 0, project: 0 };
    const ordered = View.ordered($orders, {
      compare: () => (left, right) => {
        calls.compare++;
        return left.amount - right.amount;
      },
      filter: (read) => {
        const threshold = read($threshold);
        return (row) => {
          calls.filter++;
          return row.amount < threshold;
        };
      },
    });
    const grouped = View.grouped($orders, {
      groupOf: (row) => {
        calls.groupOf++;
        return row.customer;
      },
    });
    const totals = View.totals($orders, {
      project: (row) => {
        calls.project++;
        return { group: row.customer, value: row.amount };
      },
      arithmetic: integers,
    });
    /** The calls `run` makes, after reading the ordered keys so a rebuild runs. */
    const callsOf = (run: () => void) => {
      const before = { ...calls };
      run();
      Realm.untracked(realm, (read) => read(ordered.keys));
      return {
        compare: calls.compare - before.compare,
        filter: calls.filter - before.filter,
        groupOf: calls.groupOf - before.groupOf,
        project: calls.project - before.project,
      };
    };
    return { $orders, $threshold, ordered, grouped, totals, callsOf };
  };

  for (const size of [256, 4096]) {
    const depth = Math.log2(size);

    test(`a row write in views of ${size} rows asks compare O(log n) times and the others at most twice`, () => {
      using realm = testRealm();
      const views = counted(realm, size);
      using _ = held(() => {
        View.dispose(views.ordered);
        View.dispose(views.grouped);
        View.dispose(views.totals);
      });
      const write = (recipe: Parameters<typeof Realm.update>[1]) => () => {
        Realm.update(realm, recipe);
      };

      const replaced = views.callsOf(
        write((_read, write) => {
          write.upsert(views.$orders, order("k3", "c5", 12));
        }),
      );
      const removed = views.callsOf(
        write((_read, write) => {
          write.remove(views.$orders, "k4");
        }),
      );
      const added = views.callsOf(
        write((_read, write) => {
          write.upsert(views.$orders, order("new", "c1", 3));
        }),
      );

      for (const measured of [replaced, removed, added]) {
        expect(measured.compare).toBeLessThanOrEqual(4 * depth + 8);
        expect(measured.filter).toBeLessThanOrEqual(2);
        expect(measured.groupOf).toBeLessThanOrEqual(2);
        expect(measured.project).toBeLessThanOrEqual(2);
      }
    });

    test(`a change to what filter reads in a view of ${size} rows filters each row once and sorts nothing`, () => {
      using realm = testRealm();
      const views = counted(realm, size);
      using _ = held(() => {
        View.dispose(views.ordered);
        View.dispose(views.grouped);
        View.dispose(views.totals);
      });
      const measured = views.callsOf(() => {
        Realm.update(realm, (_read, write) => {
          write(views.$threshold, size / 2);
        });
      });
      expect(measured.compare).toBe(0);
      expect(measured.filter).toBe(size);
      expect(Realm.untracked(realm, (read) => read(views.ordered.keys)).length).toBe(size / 2);
    });
  }
});

describe("prototype-named groups", () => {
  const names = ["__proto__", "constructor", "toString", "hasOwnProperty"] as const;

  test("View.grouped keeps a group named like an Object.prototype member as any other", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    const index = View.grouped($orders, { groupOf: (row) => row.customer });
    using _ = held(() => View.dispose(index));
    Realm.update(realm, (_read, write) => {
      for (const [position, name] of names.entries()) {
        write.upsert($orders, order(`k${position}`, name, position));
      }
    });
    expect([...Realm.untracked(realm, (read) => read(index.groups))].sort()).toEqual(
      [...names].sort(),
    );
    expect(names.map((name) => Realm.untracked(realm, (read) => read(index.group(name))))).toEqual([
      ["k0"],
      ["k1"],
      ["k2"],
      ["k3"],
    ]);
    expect(Realm.untracked(realm, (read) => read(index.group("valueOf")))).toEqual([]);
    Realm.update(realm, (_read, write) => write.remove($orders, "k0"));
    expect(Realm.untracked(realm, (read) => read(index.group("__proto__")))).toEqual([]);
    expect(Realm.untracked(realm, (read) => read(index.groups))).not.toContain("__proto__");
  });

  test("View.totals keeps a group named like an Object.prototype member as any other", () => {
    using realm = testRealm();
    const $orders = orders(realm);
    const totals = View.totals($orders, {
      project: (row) => ({ group: row.customer, value: row.amount }),
      arithmetic: integers,
    });
    using _ = held(() => View.dispose(totals));
    Realm.update(realm, (_read, write) => {
      for (const [position, name] of names.entries()) {
        write.upsert($orders, order(`k${position}`, name, 10 + position));
        write.upsert($orders, order(`j${position}`, name, 1));
      }
    });
    expect(names.map((name) => Realm.untracked(realm, (read) => read(totals.group(name))))).toEqual(
      [
        { count: 2, total: 11 },
        { count: 2, total: 12 },
        { count: 2, total: 13 },
        { count: 2, total: 14 },
      ],
    );
    expect(Realm.untracked(realm, (read) => read(totals.group("valueOf")))).toEqual({
      count: 0,
      total: 0,
    });
  });
});

describe("random-write oracles", () => {
  const customers = ["x", "y", "z", "__proto__"];

  /**
   * Runs `steps` seeded upserts and removes on a View.grouped whose groupOf is
   * `viewGroupOf`, against an oracle that applies `oracleGroupOf` with the
   * documented rule: a key joins the end of its group, keeps its place while
   * it stays, and leaves on a move or a remove. Returns the first step whose
   * view differs from the oracle, or undefined.
   */
  const groupedMismatch = (
    viewGroupOf: (row: Order) => string | undefined,
    oracleGroupOf: (row: Order) => string | undefined,
    steps: number,
  ): number | undefined => {
    using realm = testRealm();
    const $orders = orders(realm);
    const index = View.grouped($orders, { groupOf: viewGroupOf });
    using _ = held(() => View.dispose(index));
    const next = seeded(13);
    const oracle = new Map<string, Array<string>>();
    const groupOfKey = new Map<string, string>();
    const leave = (key: string) => {
      const group = groupOfKey.get(key);
      if (group === undefined) return;
      const keys = oracle.get(group) as Array<string>;
      keys.splice(keys.indexOf(key), 1);
      if (keys.length === 0) oracle.delete(group);
      groupOfKey.delete(key);
    };
    for (let step = 0; step < steps; step++) {
      const key = `k${next(30)}`;
      if (next(3) < 2) {
        const row = order(key, customers[next(customers.length)] as string, next(50));
        const group = oracleGroupOf(row);
        if (groupOfKey.get(key) !== group) {
          leave(key);
          if (group !== undefined) {
            oracle.set(group, [...(oracle.get(group) ?? []), key]);
            groupOfKey.set(key, group);
          }
        }
        Realm.update(realm, (_read, write) => write.upsert($orders, row));
      } else {
        leave(key);
        Realm.update(realm, (_read, write) => write.remove($orders, key));
      }
      const matches = Realm.untracked(realm, (read) => {
        const groups = [...read(index.groups)].sort();
        if (JSON.stringify(groups) !== JSON.stringify([...oracle.keys()].sort())) return false;
        return customers.every(
          (customer) =>
            JSON.stringify(read(index.group(customer))) ===
            JSON.stringify(oracle.get(customer) ?? []),
        );
      });
      if (!matches) return step;
    }
    return undefined;
  };

  const groupOf = (row: Order) => (row.amount % 4 === 0 ? undefined : row.customer);

  test("View.grouped matches the join-order oracle after 400 random writes", () => {
    expect(groupedMismatch(groupOf, groupOf, 400)).toBeUndefined();
  });

  // The oracle is checked against a planted bug, so a pass above means the
  // oracle can fail: a view that leaves out one more amount must differ.
  test("the View.grouped oracle catches a planted bug within 400 writes", () => {
    const planted = (row: Order) =>
      row.amount % 4 === 0 || row.amount === 7 ? undefined : row.customer;
    expect(groupedMismatch(planted, groupOf, 400)).toBeNumber();
  });

  /** As the View.ordered oracle above, with the filter given apart to the view and the oracle. */
  const orderedMismatch = (
    viewKeeps: (row: Order, threshold: number) => boolean,
    oracleKeeps: (row: Order, threshold: number) => boolean,
    steps: number,
  ): number | undefined => {
    using realm = testRealm();
    const $orders = orders(realm);
    const $threshold = Box.make(realm, 50);
    const view = View.ordered($orders, {
      compare: () => (left, right) => left.amount - right.amount,
      filter: (read) => {
        const threshold = read($threshold);
        return (row) => viewKeeps(row, threshold);
      },
    });
    using _ = held(() => View.dispose(view));
    const next = seeded(7);
    for (let step = 0; step < steps; step++) {
      let matches = true;
      Realm.update(realm, (read, write) => {
        const choice = next(10);
        if (choice < 6) write.upsert($orders, order(`k${next(40)}`, "x", next(100)));
        else if (choice < 9) write.remove($orders, `k${next(40)}`);
        else write($threshold, next(100));
        const threshold = read($threshold);
        const expected = [...read($orders.rows)]
          .filter((row) => oracleKeeps(row, threshold))
          .sort((left, right) => left.amount - right.amount || (left.id < right.id ? -1 : 1))
          .map((row) => row.id);
        matches = JSON.stringify(read(view.keys)) === JSON.stringify(expected);
      });
      if (!matches) return step;
    }
    return undefined;
  };

  test("the View.ordered oracle passes the real filter and catches a planted bug", () => {
    const below = (row: Order, threshold: number) => row.amount < threshold;
    const atOrBelow = (row: Order, threshold: number) => row.amount <= threshold;
    expect(orderedMismatch(below, below, 400)).toBeUndefined();
    expect(orderedMismatch(atOrBelow, below, 400)).toBeNumber();
  });

  /** As the View.totals oracle above, with the projection given apart to the view and the oracle. */
  const totalsMismatch = (
    viewSkips: (amount: number) => boolean,
    oracleSkips: (amount: number) => boolean,
    steps: number,
  ): number | undefined => {
    using realm = testRealm();
    const $orders = orders(realm);
    const totals = View.totals($orders, {
      project: (row) =>
        viewSkips(row.amount) ? undefined : { group: row.customer, value: row.amount },
      arithmetic: integers,
    });
    using _ = held(() => View.dispose(totals));
    const next = seeded(11);
    for (let step = 0; step < steps; step++) {
      let matches = true;
      Realm.update(realm, (read, write) => {
        if (next(3) < 2)
          write.upsert(
            $orders,
            order(`k${next(30)}`, customers[next(customers.length)] as string, next(50)),
          );
        else write.remove($orders, `k${next(30)}`);
        matches = customers.every((customer) => {
          const rows = read($orders.rows).filter(
            (row) => row.customer === customer && !oracleSkips(row.amount),
          );
          const expected = {
            count: rows.length,
            total: rows.reduce((sum, row) => sum + row.amount, 0),
          };
          return JSON.stringify(read(totals.group(customer))) === JSON.stringify(expected);
        });
      });
      if (!matches) return step;
    }
    return undefined;
  };

  test("the View.totals oracle passes the real projection and catches a planted bug", () => {
    const thirds = (amount: number) => amount % 3 === 0;
    const fifths = (amount: number) => amount % 5 === 0;
    expect(totalsMismatch(thirds, thirds, 300)).toBeUndefined();
    expect(totalsMismatch(fifths, thirds, 300)).toBeNumber();
  });
});

describe("a disposed ordered view keeps the confirmed order", () => {
  test("after an update that wrote two rows, not the order between them", () => {
    using realm = testRealm();
    const $rows = Collection.make(realm, { keyOf: (value: number) => value });
    const view = View.ordered($rows, { compare: () => (left, right) => left - right });
    const keys = view.keys;
    Realm.update(realm, (_read, write) => {
      write.upsert($rows, 1);
    });
    expect(Realm.untracked(realm, (read) => read(keys))).toEqual([1]);
    Realm.update(realm, (_read, write) => {
      write.upsert($rows, 2);
      write.upsert($rows, 3);
    });
    View.dispose(view);
    expect(Realm.untracked(realm, (read) => read(keys))).toEqual([1, 2, 3]);
  });

  test("never a dropped stage's rows, after its factories change", () => {
    using realm = testRealm();
    const $rows = Collection.make(realm, { keyOf: (value: number) => value });
    const $direction = Box.make(realm, 1);
    const view = View.ordered($rows, {
      compare: (read) => {
        const sign = read($direction);
        return (left, right) => sign * (left - right);
      },
    });
    Realm.update(realm, (_read, write) => {
      write.upsert($rows, 1);
    });
    const keys = view.keys;
    expect(Realm.untracked(realm, (read) => read(keys))).toEqual([1]);
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write.upsert($rows, 2);
    });
    expect(Stage.read(stage, (read) => read(keys))).toEqual([1, 2]);
    Stage.drop(stage);
    View.dispose(view);
    Realm.update(realm, (_read, write) => {
      write($direction, -1);
    });
    expect(Realm.untracked(realm, (read) => read(keys))).toEqual([1]);
  });
});
