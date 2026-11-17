import { describe, expect, test } from "bun:test";
import {
  atom,
  box,
  computed,
  computedFunction,
  createRealm,
  inspect,
  untracked,
  update,
  watch,
} from "../src/index.ts";
import { keptWrite } from "./kept.ts";

/**
 * `Pinna.inspect`: a value's name, what it last read, how many observe it,
 * and, for a named value, why it last recomputed.
 */

describe("Pinna.inspect", () => {
  test("a named box reports its name and no dependencies", () => {
    const realm = createRealm();
    const $price = box(realm, 2, { name: "price" });
    expect(inspect($price)).toEqual({
      name: "price",
      realm: undefined,
      dependencies: [],
      observers: 0,
      lastReason: undefined,
    });
  });

  test("a value reports the name of its realm, when the realm has one", () => {
    const realm = createRealm({ name: "quotes" });
    expect(inspect(box(realm, 2)).realm).toBe("quotes");
    expect(inspect(computed(realm, () => 1)).realm).toBe("quotes");
    expect(inspect(atom(realm)).realm).toBe("quotes");
  });

  test("a realm's name is a non-empty string", () => {
    expect(() => createRealm({ name: "" })).toThrow("pinna: a name is a non-empty string");
  });

  test("an unnamed value has no name and records no reason", () => {
    const realm = createRealm();
    const $price = box(realm, 2);
    const $double = computed(realm, (read) => read($price) * 2);
    untracked(realm, (read) => read($double));
    update(realm, (_read, write) => {
      write($price, 3);
    });
    untracked(realm, (read) => read($double));
    expect(inspect($price).name).toBeUndefined();
    expect(inspect($double).name).toBeUndefined();
    expect(inspect($double).lastReason).toBeUndefined();
  });

  test("dependencies are what the last run read, each once, in read order", () => {
    const realm = createRealm();
    const $price = box(realm, 2, { name: "price" });
    const $count = box(realm, 3);
    const $total = computed(realm, (read) => read($price) * read($count) + read($price), {
      name: "total",
    });
    untracked(realm, (read) => read($total));
    expect(inspect($total).dependencies).toEqual(["price", "<anonymous>"]);
  });

  test("a named computed value records why it last recomputed", () => {
    const realm = createRealm();
    const $price = box(realm, 2, { name: "price" });
    const $count = box(realm, 3);
    const $total = computed(realm, (read) => read($price) * read($count), { name: "total" });
    expect(inspect($total).lastReason).toBeUndefined();
    untracked(realm, (read) => read($total));
    expect(inspect($total).lastReason).toBe("the first run");
    update(realm, (_read, write) => {
      write($price, 5);
    });
    untracked(realm, (read) => read($total));
    expect(inspect($total).lastReason).toBe("price changed");
    update(realm, (_read, write) => {
      write($count, 4);
    });
    untracked(realm, (read) => read($total));
    expect(inspect($total).lastReason).toBe("<anonymous> changed");
  });

  test("the reason names the computed value that changed upstream", () => {
    const realm = createRealm();
    const $price = box(realm, 2);
    const $double = computed(realm, (read) => read($price) * 2, { name: "double" });
    const $label = computed(realm, (read) => `${read($double)}`, { name: "label" });
    untracked(realm, (read) => read($label));
    update(realm, (_read, write) => {
      write($price, 3);
    });
    untracked(realm, (read) => read($label));
    expect(inspect($label).lastReason).toBe("double changed");
  });

  test("observers counts what observes the value now", () => {
    const realm = createRealm();
    const $price = box(realm, 2, { name: "price" });
    const stopFirst = watch(
      realm,
      (read) => read($price),
      () => {},
      { name: "first" },
    );
    const stopSecond = watch(
      realm,
      (read) => read($price),
      () => {},
    );
    expect(inspect($price).observers).toBe(2);
    stopFirst();
    expect(inspect($price).observers).toBe(1);
    stopSecond();
    expect(inspect($price).observers).toBe(0);
  });

  test("inspecting runs nothing: a stale value reports its last run", () => {
    const realm = createRealm();
    const $price = box(realm, 2, { name: "price" });
    const $count = box(realm, 3, { name: "count" });
    let runs = 0;
    const $total = computed(
      realm,
      (read) => {
        runs++;
        return read($price) > 0 ? read($price) : read($count);
      },
      { name: "total" },
    );
    expect(inspect($total).dependencies).toEqual([]);
    untracked(realm, (read) => read($total));
    update(realm, (_read, write) => {
      write($price, 0);
    });
    expect(inspect($total)).toEqual({
      name: "total",
      realm: undefined,
      dependencies: ["price"],
      observers: 0,
      lastReason: "the first run",
    });
    expect(runs).toBe(1);
  });

  test("a named computed value is named in the error for a write while it computes", () => {
    const realm = createRealm();
    const $price = box(realm, 2);
    const write = keptWrite(realm);
    const $bad = computed(
      realm,
      () => {
        write($price, 3);
        return 1;
      },
      { name: "bad" },
    );
    expect(() => untracked(realm, (read) => read($bad))).toThrow(
      'pinna: the computed value "bad" cannot write while it computes',
    );
  });

  test("each computed value a named memo makes carries the name", () => {
    const realm = createRealm();
    const $rate = box(realm, 2, { name: "rate" });
    const $times = computedFunction(realm, (read, amount: number) => amount * read($rate), {
      name: "times",
    });
    const $three = $times(3);
    untracked(realm, (read) => read($three));
    expect(inspect($three)).toEqual({
      name: "times",
      realm: undefined,
      dependencies: ["rate"],
      observers: 0,
      lastReason: "the first run",
    });
  });

  test("an atom has no name and no dependencies", () => {
    const realm = createRealm();
    const outside = atom(realm);
    expect(inspect(outside)).toEqual({
      name: undefined,
      realm: undefined,
      dependencies: [],
      observers: 0,
      lastReason: undefined,
    });
  });

  test("an unobserved atom read first is the reason, said as such", () => {
    const realm = createRealm();
    const outside = atom(realm);
    const $price = box(realm, 2, { name: "price" });
    const $total = computed(
      realm,
      (read) => {
        read(outside);
        return read($price) * 2;
      },
      { name: "total" },
    );
    untracked(realm, (read) => read($total));
    untracked(realm, (read) => read($total));
    expect(inspect($total).lastReason).toBe(
      "<anonymous> is an atom nothing observes, so it counts as changed",
    );
    const stop = watch(
      realm,
      (read) => read($total),
      () => {},
    );
    update(realm, (_read, write) => {
      write($price, 3);
    });
    expect(inspect($total).lastReason).toBe("price changed");
    stop();
  });

  test("an empty name throws", () => {
    const realm = createRealm();
    expect(() => box(realm, 2, { name: "" })).toThrow("pinna: a name is a non-empty string");
    expect(() => computed(realm, () => 1, { name: "" })).toThrow(
      "pinna: a name is a non-empty string",
    );
  });

  test("anything else throws", () => {
    expect(() => inspect({} as never)).toThrow(
      "pinna: inspect needs a box, a computed value, or an atom",
    );
  });
});
