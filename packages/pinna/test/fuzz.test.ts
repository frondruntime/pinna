import { describe, expect, test } from "bun:test";
import * as api from "../src/index.ts";
import { execute } from "./fuzz/interpret.ts";
import { generate } from "./fuzz/program.ts";

/**
 * The differential fuzz's smoke check. With `PINNA_REFERENCE` unset it runs a
 * few seeds against this checkout twice: traces must be equal (the program
 * generator and the implementation are deterministic) and not empty. The
 * comparison against another checkout is `bun run fuzz`.
 */

const seeds = 60;

describe("differential fuzz harness", () => {
  test("a seed gives the same program every time", () => {
    for (let seed = 1; seed <= seeds; seed++) {
      expect(generate(seed)).toEqual(generate(seed));
    }
    expect(generate(1)).not.toEqual(generate(2));
  });

  test("a program's trace is the same twice, and not empty", () => {
    let entries = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const program = generate(seed);
      const first = execute(program, api);
      const second = execute(program, api);
      expect(first.length).toBeGreaterThan(0);
      expect(first).toEqual(second);
      expect(first.filter((entry) => entry.startsWith("crash"))).toEqual([]);
      entries += first.length;
    }
    expect(entries).toBeGreaterThan(seeds * 20);
  });
});

describe("a scheduler that runs at once", () => {
  test("gives every program the trace of plain watches and autoruns", () => {
    const immediate = (run: () => void): void => run();
    // The interpreter reads `Realm.watch` and `Realm.autorun`, so the
    // scheduled forms replace them on a copy of the `Realm` module.
    const scheduledApi: typeof api = {
      ...api,
      Realm: {
        ...api.Realm,
        watch: ((realm, select, effect, options) =>
          api.Realm.watch(realm, select, effect, {
            ...options,
            scheduler: immediate,
          })) as typeof api.Realm.watch,
        autorun: ((realm, effect) =>
          api.Realm.autorun(realm, effect, { scheduler: immediate })) as typeof api.Realm.autorun,
      },
    };
    // A cycle is left out: a plain watch's settle meets it while bringing
    // the select's sources current and reports it, where a scheduled run's
    // select reads the value that keeps it. Cycles are a caller's bug.
    const differing: Array<number> = [];
    let compared = 0;
    for (let seed = 1; seed <= seeds * 4; seed++) {
      const program = generate(seed);
      const plain = execute(program, api);
      if (plain.some((entry) => entry.includes("CycleError"))) {
        continue;
      }
      compared++;
      const scheduled = execute(program, scheduledApi);
      if (JSON.stringify(plain) !== JSON.stringify(scheduled)) {
        differing.push(seed);
      }
    }
    expect(differing).toEqual([]);
    expect(compared).toBeGreaterThan(seeds);
  });
});

describe("a Realm.onUpdate listener", () => {
  test("changes no program's trace, and gets records only while updates land", () => {
    const records: Array<api.UpdateRecord> = [];
    const listenedApi: typeof api = {
      ...api,
      Realm: {
        ...api.Realm,
        make: ((options) => {
          const realm = api.Realm.make(options);
          api.Realm.onUpdate(realm, (record) => {
            records.push(record);
          });
          return realm;
        }) as typeof api.Realm.make,
      },
    };
    const differing: Array<number> = [];
    for (let seed = 1; seed <= seeds * 4; seed++) {
      const program = generate(seed);
      const plain = execute(program, api);
      const listened = execute(program, listenedApi);
      if (JSON.stringify(plain) !== JSON.stringify(listened)) {
        differing.push(seed);
      }
    }
    expect(differing).toEqual([]);
    expect(records.length).toBeGreaterThan(seeds);
    for (const record of records) {
      for (const change of record.boxes) {
        expect(Object.is(change.before, change.after)).toBe(false);
      }
    }
  });
});
