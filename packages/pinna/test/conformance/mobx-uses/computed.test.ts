import { describe, expect, test } from "bun:test";
import { autorun as mobxAutorun, computed as mobxComputed, observable, runInAction } from "mobx";
import {
  autorun,
  box,
  computed,
  createRealm,
  observe,
  untracked,
  update,
} from "../../../src/index.ts";

/**
 * An application's `computed` uses, beside Pinna's `computed`: a value
 * recomputed once per batch, and one kept cached with no reader.
 */

describe("computed", () => {
  // Two writes in one batch recompute once; a recompute to an equal value
  // reruns no reader.
  const trace = { seen: [3, 30], computes: 3 };

  test("MobX: recomputes once per batch and stops at an equal value", () => {
    const state = observable({ a: 1, b: 2 });
    let computes = 0;
    const sum = mobxComputed(() => {
      computes++;
      return state.a + state.b;
    });
    const seen: Array<number> = [];
    const stop = mobxAutorun(() => {
      seen.push(sum.get());
    });
    runInAction(() => {
      state.a = 10;
      state.b = 20;
    });
    runInAction(() => {
      state.a = 20;
      state.b = 10;
    });
    stop();
    expect({ seen, computes }).toEqual(trace);
  });

  test("Pinna: computed", () => {
    const realm = createRealm();
    const $a = box(realm, 1);
    const $b = box(realm, 2);
    let computes = 0;
    const sum = computed(realm, (read) => {
      computes++;
      return read($a) + read($b);
    });
    const seen: Array<number> = [];
    const stop = autorun(realm, (read) => {
      seen.push(read(sum));
    });
    update(realm, (_read, write) => {
      write($a, 10);
      write($b, 20);
    });
    update(realm, (_read, write) => {
      write($a, 20);
      write($b, 10);
    });
    stop();
    expect({ seen, computes }).toEqual(trace);
  });
});

describe("computed({ keepAlive })", () => {
  // Kept alive, reads with no reader share one computation until a source
  // changes.
  const trace = { values: [2, 2, 4], computes: 2 };

  test("MobX: keepAlive caches with no reader", () => {
    const state = observable({ count: 1 });
    let computes = 0;
    const double = mobxComputed(
      () => {
        computes++;
        return state.count * 2;
      },
      { keepAlive: true },
    );
    const values = [double.get(), double.get()];
    runInAction(() => {
      state.count = 2;
    });
    values.push(double.get());
    expect({ values, computes }).toEqual(trace);
  });

  test("Pinna: observe holds the computed value cached until released", () => {
    const realm = createRealm();
    const $count = box(realm, 1);
    let computes = 0;
    const double = computed(realm, (read) => {
      computes++;
      return read($count) * 2;
    });
    const release = observe(double);
    const values = untracked(realm, (read) => [read(double), read(double)]);
    update(realm, (_read, write) => {
      write($count, 2);
    });
    values.push(untracked(realm, (read) => read(double)));
    release();
    expect({ values, computes }).toEqual(trace);
  });
});
