import { describe, expect, test } from "bun:test";
import {
  applyStage,
  atom,
  autorun,
  type Box,
  box,
  collection,
  computed,
  createRealm,
  dropStage,
  openStage,
  type Read,
  type Realm,
  realmRead,
  stageRead,
  stageUpdate,
  untracked,
  update,
  type Write,
  watch,
} from "../src/index.ts";
import { type Check, makeBox } from "../src/internal/index.ts";
import { held, record, testRealm } from "../src/testing/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * A stage collects the writes of asynchronous work and lands them in one
 * update, or drops them. The numbered tests are the ones the plan owes
 * (`docs/api.md`, ruling 53).
 */

/** A box over `check`, as pinna-effect's `schemaBox` builds one over its schema. */
const makeCheckedBox = <Value>(realm: Realm, initial: Value, check: Check): Box<Value> =>
  makeBox(realm, check, Object.is, initial, undefined);

describe("stageUpdate", () => {
  test("1: a staged write leaves the realm's value, and nothing reruns, until applyStage", () => {
    using realm = testRealm();
    const $held = box(realm, 1);
    using values = record(realm, (read) => read($held));
    let derivedRuns = 0;
    const $double = computed(realm, (read) => {
      derivedRuns++;
      return read($held) * 2;
    });
    using doubled = record(realm, (read) => read($double));
    const runsBefore = derivedRuns;
    const stage = openStage(realm);
    stageUpdate(stage, (read, write) => {
      write($held, read($held) + 2);
    });
    expect(untracked(realm, (read) => read($held))).toBe(1);
    expect(values.values).toEqual([]);
    expect(doubled.values).toEqual([]);
    expect(derivedRuns).toBe(runsBefore);
    applyStage(stage);
    expect(untracked(realm, (read) => read($held))).toBe(3);
    expect(values.values).toEqual([3]);
    expect(doubled.values).toEqual([6]);
    expectRealmAtRest(realm);
  });

  test("4: a second recipe reads the first's value of the same box", () => {
    using realm = testRealm();
    const $held = box(realm, 1);
    const stage = openStage(realm);
    stageUpdate(stage, (read, write) => {
      write($held, read($held) + 2);
    });
    stageUpdate(stage, (read, write) => {
      write($held, read($held) * 10);
    });
    expect(stageRead(stage, (read) => read($held))).toBe(30);
    applyStage(stage);
    expect(untracked(realm, (read) => read($held))).toBe(30);
  });

  test("write.modify drafts the staged value and leaves the realm's array alone", () => {
    using realm = testRealm();
    const initial: ReadonlyArray<string> = ["a"];
    const $tags = box(realm, initial);
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write.modify($tags, (tags) => {
        tags.push("b");
      });
    });
    stageUpdate(stage, (_read, write) => {
      write.modify($tags, (tags) => {
        tags.push("c");
      });
    });
    expect(stageRead(stage, (read) => read($tags))).toEqual(["a", "b", "c"]);
    expect(untracked(realm, (read) => read($tags))).toBe(initial);
    expect(initial).toEqual(["a"]);
    applyStage(stage);
    expect(untracked(realm, (read) => read($tags))).toEqual(["a", "b", "c"]);
  });

  test("10: a recipe that throws leaves the overlay as it was, is not kept, and its error reaches the caller", () => {
    using realm = testRealm();
    const $a = box(realm, 1);
    const $b = box(realm, 1);
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write($a, 2);
    });
    const failure = new Error("refused");
    expect(() =>
      stageUpdate(stage, (_read, write) => {
        write($a, 3);
        write($b, 3);
        write($a, 4);
        throw failure;
      }),
    ).toThrow(failure);
    expect(stageRead(stage, (read) => [read($a), read($b)])).toEqual([2, 1]);
    applyStage(stage);
    expect(untracked(realm, (read) => [read($a), read($b)])).toEqual([2, 1]);
  });

  test("a recipe that returns a promise throws at once, as update's does, and is not kept", () => {
    using realm = testRealm();
    const $a = box(realm, 1);
    const stage = openStage(realm);
    expect(() =>
      stageUpdate(stage, (async (_read: Read, write: Write) => {
        write($a, 2);
      }) as unknown as (read: Read, write: Write) => undefined),
    ).toThrow("pinna: stageUpdate recipes are synchronous; await outside, then stageUpdate");
    expect(stageRead(stage, (read) => read($a))).toBe(1);
    expect(() =>
      stageUpdate(stage, (() => 1) as unknown as (read: Read, write: Write) => undefined),
    ).toThrow("pinna: a stageUpdate recipe returns nothing");
    dropStage(stage);
  });

  test("11: stageUpdate inside a computed value throws, as update does", () => {
    using realm = testRealm();
    const $a = box(realm, 1);
    const stage = openStage(realm);
    const $bad = computed(realm, (read) => {
      stageUpdate(stage, (_read, write) => {
        write($a, 2);
      });
      return read($a);
    });
    expect(() => untracked(realm, (read) => read($bad))).toThrow(
      "pinna: stageUpdate cannot run in a computed value",
    );
    expect(() =>
      watch(
        realm,
        (read) => {
          stageUpdate(stage, () => undefined);
          return read($a);
        },
        () => undefined,
      ),
    ).toThrow("pinna: stageUpdate cannot run in a watch's select or a selector");
    expect(stageRead(stage, (read) => read($a))).toBe(1);
    dropStage(stage);
    expectRealmAtRest(realm);
  });

  test("runs in an autorun's body, untracked, as update does", () => {
    using realm = testRealm();
    const $trigger = box(realm, 0);
    const $a = box(realm, 1);
    const stage = openStage(realm);
    let runs = 0;
    using _ = held(
      autorun(realm, (read) => {
        runs++;
        read($trigger);
        stageUpdate(stage, (stagedRead, write) => {
          write($a, stagedRead($a) + 1);
        });
        return undefined;
      }),
    );
    expect(runs).toBe(1);
    // The recipe read $a through the stage: the autorun does not observe it.
    update(realm, (_read, write) => {
      write($a, 100);
    });
    expect(runs).toBe(1);
    expect(stageRead(stage, (read) => read($a))).toBe(2);
    applyStage(stage);
    expect(untracked(realm, (read) => read($a))).toBe(101);
    expect(runs).toBe(1);
  });

  test("a box of another realm throws, naming both realms", () => {
    using ui = testRealm({ name: "ui" });
    using quotes = testRealm({ name: "quotes" });
    const $theirs = box(quotes, 1, { name: "price" });
    const stage = openStage(ui);
    expect(() =>
      stageUpdate(stage, (_read, write) => {
        write($theirs, 2);
      }),
    ).toThrow(
      'pinna: write("price") is handed an observable of another realm (realm "quotes", not "ui")',
    );
    expect(() => stageRead(stage, (read) => read($theirs))).toThrow(
      'pinna: read("price") is handed an observable of another realm (realm "quotes", not "ui")',
    );
    dropStage(stage);
  });

  test("a schema box's check runs at stageUpdate, against the staged value", () => {
    using realm = testRealm();
    const rejects = { message: "not positive", cause: undefined };
    const checks: Array<[unknown, unknown]> = [];
    const $positive = makeCheckedBox(realm, 1, (value, previous) => {
      checks.push([value, previous]);
      return typeof value === "number" && value > 0 ? undefined : rejects;
    });
    // Making the box checked its initial value.
    expect(checks).toEqual([[1, undefined]]);
    checks.length = 0;
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write($positive, 5);
    });
    expect(() =>
      stageUpdate(stage, (_read, write) => {
        write($positive, -1);
      }),
    ).toThrow("pinna: the box rejects this value: not positive");
    expect(checks).toEqual([
      [5, 1],
      [-1, 5],
    ]);
    expect(stageRead(stage, (read) => read($positive))).toBe(5);
    applyStage(stage);
    // Checked again where it lands, against the realm's value.
    expect(checks.at(-1)).toEqual([5, 1]);
    expect(untracked(realm, (read) => read($positive))).toBe(5);
  });
});

describe("stageRead and realmRead", () => {
  test("2: stageRead returns the staged value of a box the stage wrote, and the realm's current value of one it did not", () => {
    using realm = testRealm();
    const $written = box(realm, 1);
    const $other = box(realm, 10);
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write($written, 2);
    });
    expect(stageRead(stage, (read) => [read($written), read($other)])).toEqual([2, 10]);
    update(realm, (_read, write) => {
      write($other, 11);
      write($written, 5);
    });
    expect(stageRead(stage, (read) => [read($written), read($other)])).toEqual([2, 11]);
    dropStage(stage);
  });

  test("3: realmRead returns the realm's value of a box the stage wrote", () => {
    using realm = testRealm();
    const $held = box(realm, 1);
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write($held, 2);
    });
    expect(realmRead(stage, (read) => read($held))).toBe(1);
    expect(stageRead(stage, (read) => read($held))).toBe(2);
    dropStage(stage);
  });

  test("realmRead reads computed values, collections, and atoms as untracked does", () => {
    using realm = testRealm();
    const $held = box(realm, 1);
    const $double = computed(realm, (read) => read($held) * 2);
    const $rows = collection<string, { readonly id: string }>(realm, { keyOf: (row) => row.id });
    update(realm, (_read, write) => {
      write.upsert($rows, { id: "a" });
    });
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write($held, 5);
    });
    expect(realmRead(stage, (read) => [read($double), read.row($rows, "a")])).toEqual([
      2,
      { id: "a" },
    ]);
    dropStage(stage);
  });

  test("a read through a stage refuses a computed value, which would return the realm's value", () => {
    using realm = testRealm();
    const $held = box(realm, 1);
    const $double = computed(realm, (read) => read($held) * 2, { name: "double" });
    const stage = openStage(realm);
    expect(() => stageRead(stage, (read) => read($double))).toThrow(
      'pinna: read("double") of a computed value does not run through a stage',
    );
    expect(() =>
      stageUpdate(stage, (read, write) => {
        write($held, read($double));
      }),
    ).toThrow('pinna: read("double") of a computed value does not run through a stage');
    dropStage(stage);
  });

  test("read.row through a stage reads the realm's row, and an atom reads as undefined", () => {
    using realm = testRealm();
    const $rows = collection<string, { readonly id: string; readonly size: number }>(realm, {
      keyOf: (row) => row.id,
    });
    const $feed = atom(realm);
    update(realm, (_read, write) => {
      write.upsert($rows, { id: "a", size: 1 });
    });
    const stage = openStage(realm);
    expect(
      stageRead(stage, (read) => [read.row($rows, "a"), read.row($rows, "b"), read($feed)]),
    ).toEqual([{ id: "a", size: 1 }, undefined, undefined]);
    dropStage(stage);
  });

  test("stageRead and realmRead inside a computed value throw", () => {
    using realm = testRealm();
    const $a = box(realm, 1);
    const stage = openStage(realm);
    const $staged = computed(realm, () => stageRead(stage, (read) => read($a)));
    const $realm = computed(realm, () => realmRead(stage, (read) => read($a)));
    expect(() => untracked(realm, (read) => read($staged))).toThrow(
      "pinna: stageRead cannot run in a computed value",
    );
    expect(() => untracked(realm, (read) => read($realm))).toThrow(
      "pinna: realmRead cannot run in a computed value",
    );
    dropStage(stage);
    expectRealmAtRest(realm);
  });
});

describe("what a stage refuses", () => {
  test("collection and atom writes throw a message naming the limit, and leave the overlay as it was", () => {
    using realm = testRealm();
    const $a = box(realm, 1);
    const $rows = collection<string, { readonly id: string }>(realm, { keyOf: (row) => row.id });
    const $feed = atom(realm);
    const stage = openStage(realm);
    const refusals: Array<[string, (write: Write) => undefined]> = [
      ["write.upsert", (write) => write.upsert($rows, { id: "a" })],
      ["write.remove", (write) => write.remove($rows, "a")],
      ["write.replaceAll", (write) => write.replaceAll($rows, [])],
      ["write.changed", (write) => write.changed($feed)],
    ];
    for (const [verb, call] of refusals) {
      expect(() =>
        stageUpdate(stage, (_read, write) => {
          write($a, 2);
          return call(write);
        }),
      ).toThrow(`pinna: ${verb} does not run in a stage, which writes boxes only`);
    }
    expect(stageRead(stage, (read) => read($a))).toBe(1);
    dropStage(stage);
  });
});

describe("applyStage", () => {
  test("5: replays the recipes in order over the realm's values at that moment", () => {
    using realm = testRealm();
    const $held = box(realm, 1);
    const stage = openStage(realm);
    stageUpdate(stage, (read, write) => {
      write($held, read($held) + 2);
    });
    expect(stageRead(stage, (read) => read($held))).toBe(3);
    update(realm, (_read, write) => {
      write($held, 5);
    });
    applyStage(stage);
    expect(untracked(realm, (read) => read($held))).toBe(7);
  });

  test("6: lands every write in one update: a watcher over two staged boxes runs once and sees both", () => {
    using realm = testRealm();
    const $a = box(realm, 1);
    const $b = box(realm, 1);
    using pairs = record(realm, (read) => [read($a), read($b)] as const, {
      equals: (left, right) => left[0] === right[0] && left[1] === right[1],
    });
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write($a, 2);
    });
    stageUpdate(stage, (_read, write) => {
      write($b, 3);
    });
    applyStage(stage);
    expect(pairs.values).toEqual([[2, 3]]);
  });

  test("7: inside an open update of the realm it joins that update", () => {
    using realm = testRealm();
    const $staged = box(realm, 1);
    const $own = box(realm, 1);
    using pairs = record(realm, (read) => [read($staged), read($own)] as const, {
      equals: (left, right) => left[0] === right[0] && left[1] === right[1],
    });
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write($staged, 2);
    });
    update(realm, (read, write) => {
      write($own, 2);
      applyStage(stage);
      // The outer recipe reads what the stage landed.
      write($own, read($staged) + read($own));
    });
    expect(pairs.values).toEqual([[2, 4]]);
  });

  test("a recipe that throws on replay rolls back the update it joined, and the stage is closed", () => {
    using realm = testRealm();
    const $staged = box(realm, 1);
    const $own = box(realm, 1);
    using values = record(realm, (read) => read($own));
    const stage = openStage(realm);
    stageUpdate(stage, (read, write) => {
      if (read($own) > 1) {
        throw new Error("changed under the stage");
      }
      write($staged, 2);
    });
    expect(() =>
      update(realm, (_read, write) => {
        write($own, 2);
        applyStage(stage);
      }),
    ).toThrow("changed under the stage");
    expect(untracked(realm, (read) => [read($staged), read($own)])).toEqual([1, 1]);
    expect(values.values).toEqual([]);
    expect(() => dropStage(stage)).toThrow(
      "pinna: dropStage runs on a stage that was already applied or dropped",
    );
    expectRealmAtRest(realm);
  });

  test("throws inside a computed value, and leaves the stage open", () => {
    using realm = testRealm();
    const $a = box(realm, 1);
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write($a, 2);
    });
    const $bad = computed(realm, (read) => {
      applyStage(stage);
      return read($a);
    });
    expect(() => untracked(realm, (read) => read($bad))).toThrow(
      "pinna: applyStage cannot run in a computed value",
    );
    applyStage(stage);
    expect(untracked(realm, (read) => read($a))).toBe(2);
  });
});

describe("dropStage and closing", () => {
  test("8: dropStage changes no box and runs no watcher", () => {
    using realm = testRealm();
    const $a = box(realm, 1);
    using values = record(realm, (read) => read($a));
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write($a, 2);
    });
    dropStage(stage);
    expect(untracked(realm, (read) => read($a))).toBe(1);
    expect(values.values).toEqual([]);
    expectRealmAtRest(realm);
  });

  test("9: after applyStage or dropStage every stage call throws, and so do a kept read and write", () => {
    for (const close of [applyStage, dropStage]) {
      using realm = testRealm();
      const $a = box(realm, 1);
      const stage = openStage(realm);
      let keptRead: Read | undefined;
      let keptWrite: Write | undefined;
      // Kept from the run in stageUpdate only: the replay hands the recipe the update's own.
      stageUpdate(stage, (read, write) => {
        keptRead ??= read;
        keptWrite ??= write;
        write($a, 2);
      });
      let keptRealmRead: Read | undefined;
      realmRead(stage, (read) => {
        keptRealmRead = read;
      });
      close(stage);
      const closed = "runs on a stage that was already applied or dropped";
      expect(() => stageUpdate(stage, () => undefined)).toThrow(`pinna: stageUpdate ${closed}`);
      expect(() => stageRead(stage, () => undefined)).toThrow(`pinna: stageRead ${closed}`);
      expect(() => realmRead(stage, () => undefined)).toThrow(`pinna: realmRead ${closed}`);
      expect(() => applyStage(stage)).toThrow(`pinna: applyStage ${closed}`);
      expect(() => dropStage(stage)).toThrow(`pinna: dropStage ${closed}`);
      const kept = "of a stage runs after its recipe returned";
      expect(() => (keptRead as Read)($a)).toThrow(`pinna: read ${kept}`);
      expect(() => (keptWrite as Write)($a, 3)).toThrow(`pinna: write ${kept}`);
      expect(() => (keptWrite as Write).modify($a, () => undefined)).toThrow(
        `pinna: write.modify ${kept}`,
      );
      expect(() => (keptRealmRead as Read)($a)).toThrow(`pinna: read ${kept}`);
    }
  });

  test("a read or write kept past its recipe throws while the stage is still open", () => {
    using realm = testRealm();
    const $a = box(realm, 1);
    const stage = openStage(realm);
    let keptRead: Read | undefined;
    let keptWrite: Write | undefined;
    stageUpdate(stage, (read, write) => {
      keptRead = read;
      keptWrite = write;
    });
    expect(() => (keptRead as Read)($a)).toThrow(
      "pinna: read of a stage runs after its recipe returned",
    );
    expect(() => (keptWrite as Write)($a, 2)).toThrow(
      "pinna: write of a stage runs after its recipe returned",
    );
    expect(stageRead(stage, (read) => read($a))).toBe(1);
    dropStage(stage);
  });

  test("a stage call on the same stage inside its own recipe throws", () => {
    using realm = testRealm();
    const $a = box(realm, 1);
    const stage = openStage(realm);
    for (const call of [
      () => applyStage(stage),
      () => dropStage(stage),
      () => stageUpdate(stage, () => undefined),
    ]) {
      expect(() =>
        stageUpdate(stage, (_read, write) => {
          write($a, 2);
          call();
        }),
      ).toThrow("runs inside a recipe of the same stage");
    }
    expect(stageRead(stage, (read) => read($a))).toBe(1);
    applyStage(stage);
    expect(untracked(realm, (read) => read($a))).toBe(1);
  });

  test("an empty stage applies and changes nothing", () => {
    using realm = testRealm();
    const $a = box(realm, 1);
    using values = record(realm, (read) => read($a));
    const stage = openStage(realm);
    applyStage(stage);
    expect(values.values).toEqual([]);
    expectRealmAtRest(realm);
  });
});

describe("a stage left open", () => {
  test("testRealm's dispose reports a stage neither applied nor dropped, and closes it", () => {
    const realm = testRealm();
    const $a = box(realm, 1);
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write($a, 2);
    });
    expect(() => realm[Symbol.dispose]()).toThrow(
      "The test realm is not at rest: stage still running.",
    );
    expect(() => stageRead(stage, () => undefined)).toThrow(
      "pinna: stageRead runs on a stage that was already applied or dropped",
    );
    expect(untracked(realm, (read) => read($a))).toBe(1);
  });

  test("a stage applied or dropped is not reported", () => {
    using realm = testRealm();
    dropStage(openStage(realm));
    applyStage(openStage(realm));
  });

  test("a realm from createRealm keeps no record of its stages", () => {
    const realm = createRealm();
    const $a = box(realm, 1);
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write($a, 2);
    });
    expect(untracked(realm, (read) => read($a))).toBe(1);
    dropStage(stage);
    expectRealmAtRest(realm);
  });
});
