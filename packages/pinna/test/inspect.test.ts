import { describe, expect, test } from "bun:test";
import { Atom, Box, Computed, Realm, Source } from "../src/index.ts";
import { keptWrite } from "./kept.ts";

/**
 * `Pinna.inspect`: a value's name, what it last read, how many observe it,
 * and, for a named value, why it last recomputed.
 */

describe("Pinna.inspect", () => {
  test("a named box reports its name and no dependencies", () => {
    const realm = Realm.make();
    const $price = Box.make(realm, 2, { name: "price" });
    expect(Source.inspect($price)).toEqual({
      name: "price",
      realm: undefined,
      dependencies: [],
      observers: 0,
      lastReason: undefined,
      stages: [],
    });
  });

  test("a value reports the name of its realm, when the realm has one", () => {
    const realm = Realm.make({ name: "quotes" });
    expect(Source.inspect(Box.make(realm, 2)).realm).toBe("quotes");
    expect(Source.inspect(Computed.make(realm, () => 1)).realm).toBe("quotes");
    expect(Source.inspect(Atom.make(realm)).realm).toBe("quotes");
  });

  test("a realm's name is a non-empty string", () => {
    expect(() => Realm.make({ name: "" })).toThrow("pinna: a name is a non-empty string");
  });

  test("an unnamed value has no name and records no reason", () => {
    const realm = Realm.make();
    const $price = Box.make(realm, 2);
    const $double = Computed.make(realm, (read) => read($price) * 2);
    Realm.untracked(realm, (read) => read($double));
    Realm.update(realm, (_read, write) => {
      write($price, 3);
    });
    Realm.untracked(realm, (read) => read($double));
    expect(Source.inspect($price).name).toBeUndefined();
    expect(Source.inspect($double).name).toBeUndefined();
    expect(Source.inspect($double).lastReason).toBeUndefined();
  });

  test("dependencies are what the last run read, each once, in read order", () => {
    const realm = Realm.make();
    const $price = Box.make(realm, 2, { name: "price" });
    const $count = Box.make(realm, 3);
    const $total = Computed.make(realm, (read) => read($price) * read($count) + read($price), {
      name: "total",
    });
    Realm.untracked(realm, (read) => read($total));
    expect(Source.inspect($total).dependencies).toEqual(["price", "<anonymous>"]);
  });

  test("a named computed value records why it last recomputed", () => {
    const realm = Realm.make();
    const $price = Box.make(realm, 2, { name: "price" });
    const $count = Box.make(realm, 3);
    const $total = Computed.make(realm, (read) => read($price) * read($count), { name: "total" });
    expect(Source.inspect($total).lastReason).toBeUndefined();
    Realm.untracked(realm, (read) => read($total));
    expect(Source.inspect($total).lastReason).toBe("the first run");
    Realm.update(realm, (_read, write) => {
      write($price, 5);
    });
    Realm.untracked(realm, (read) => read($total));
    expect(Source.inspect($total).lastReason).toBe("price changed");
    Realm.update(realm, (_read, write) => {
      write($count, 4);
    });
    Realm.untracked(realm, (read) => read($total));
    expect(Source.inspect($total).lastReason).toBe("<anonymous> changed");
  });

  test("the reason names the computed value that changed upstream", () => {
    const realm = Realm.make();
    const $price = Box.make(realm, 2);
    const $double = Computed.make(realm, (read) => read($price) * 2, { name: "double" });
    const $label = Computed.make(realm, (read) => `${read($double)}`, { name: "label" });
    Realm.untracked(realm, (read) => read($label));
    Realm.update(realm, (_read, write) => {
      write($price, 3);
    });
    Realm.untracked(realm, (read) => read($label));
    expect(Source.inspect($label).lastReason).toBe("double changed");
  });

  test("observers counts what observes the value now", () => {
    const realm = Realm.make();
    const $price = Box.make(realm, 2, { name: "price" });
    const stopFirst = Realm.watch(
      realm,
      (read) => read($price),
      () => {},
      { name: "first" },
    );
    const stopSecond = Realm.watch(
      realm,
      (read) => read($price),
      () => {},
    );
    expect(Source.inspect($price).observers).toBe(2);
    stopFirst();
    expect(Source.inspect($price).observers).toBe(1);
    stopSecond();
    expect(Source.inspect($price).observers).toBe(0);
  });

  test("inspecting runs nothing: a stale value reports its last run", () => {
    const realm = Realm.make();
    const $price = Box.make(realm, 2, { name: "price" });
    const $count = Box.make(realm, 3, { name: "count" });
    let runs = 0;
    const $total = Computed.make(
      realm,
      (read) => {
        runs++;
        return read($price) > 0 ? read($price) : read($count);
      },
      { name: "total" },
    );
    expect(Source.inspect($total).dependencies).toEqual([]);
    Realm.untracked(realm, (read) => read($total));
    Realm.update(realm, (_read, write) => {
      write($price, 0);
    });
    expect(Source.inspect($total)).toEqual({
      name: "total",
      realm: undefined,
      dependencies: ["price"],
      observers: 0,
      lastReason: "the first run",
      stages: [],
    });
    expect(runs).toBe(1);
  });

  test("a named computed value is named in the error for a write while it computes", () => {
    const realm = Realm.make();
    const $price = Box.make(realm, 2);
    const write = keptWrite(realm);
    const $bad = Computed.make(
      realm,
      () => {
        write($price, 3);
        return 1;
      },
      { name: "bad" },
    );
    expect(() => Realm.untracked(realm, (read) => read($bad))).toThrow(
      'pinna: the computed value "bad" cannot write while it computes',
    );
  });

  test("each computed value a named memo makes carries the name", () => {
    const realm = Realm.make();
    const $rate = Box.make(realm, 2, { name: "rate" });
    const $times = Computed.fn(realm, (read, amount: number) => amount * read($rate), {
      name: "times",
    });
    const $three = $times(3);
    Realm.untracked(realm, (read) => read($three));
    expect(Source.inspect($three)).toEqual({
      name: "times",
      realm: undefined,
      dependencies: ["rate"],
      observers: 0,
      lastReason: "the first run",
      stages: [],
    });
  });

  test("an atom has no name and no dependencies", () => {
    const realm = Realm.make();
    const outside = Atom.make(realm);
    expect(Source.inspect(outside)).toEqual({
      name: undefined,
      realm: undefined,
      dependencies: [],
      observers: 0,
      lastReason: undefined,
      stages: [],
    });
  });

  test("an unobserved atom read first is the reason, said as such", () => {
    const realm = Realm.make();
    const outside = Atom.make(realm);
    const $price = Box.make(realm, 2, { name: "price" });
    const $total = Computed.make(
      realm,
      (read) => {
        read(outside);
        return read($price) * 2;
      },
      { name: "total" },
    );
    Realm.untracked(realm, (read) => read($total));
    Realm.untracked(realm, (read) => read($total));
    expect(Source.inspect($total).lastReason).toBe(
      "<anonymous> is an atom nothing observes, so it counts as changed",
    );
    const stop = Realm.watch(
      realm,
      (read) => read($total),
      () => {},
    );
    Realm.update(realm, (_read, write) => {
      write($price, 3);
    });
    expect(Source.inspect($total).lastReason).toBe("price changed");
    stop();
  });

  test("an empty name throws", () => {
    const realm = Realm.make();
    expect(() => Box.make(realm, 2, { name: "" })).toThrow("pinna: a name is a non-empty string");
    expect(() => Computed.make(realm, () => 1, { name: "" })).toThrow(
      "pinna: a name is a non-empty string",
    );
  });

  test("anything else throws", () => {
    expect(() => Source.inspect({} as never)).toThrow(
      "pinna: Source.inspect needs a box, a computed value, or an atom",
    );
  });
});
