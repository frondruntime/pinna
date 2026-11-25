import { describe, expect, test } from "bun:test";
import {
  Atom,
  Box,
  Collection,
  Computed,
  type Read,
  Realm,
  Stage,
  StageClosedError,
  type Write,
} from "../src/index.ts";
import { held, record, testRealm } from "../src/testing/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * A stage collects the writes of asynchronous work and lands them in one
 * update, or drops them. The numbered tests are the ones the plan owes
 * (`docs/api.md`, ruling 53).
 */

describe("stageUpdate", () => {
  test("1: a staged write leaves the realm's value, and nothing reruns, until applyStage", () => {
    using realm = testRealm();
    const $held = Box.make(realm, 1);
    using values = record(realm, (read) => read($held));
    let derivedRuns = 0;
    const $double = Computed.make(realm, (read) => {
      derivedRuns++;
      return read($held) * 2;
    });
    using doubled = record(realm, (read) => read($double));
    const runsBefore = derivedRuns;
    const stage = Stage.make(realm);
    Stage.update(stage, (read, write) => {
      write($held, read($held) + 2);
    });
    expect(Realm.untracked(realm, (read) => read($held))).toBe(1);
    expect(values.values).toEqual([]);
    expect(doubled.values).toEqual([]);
    expect(derivedRuns).toBe(runsBefore);
    Stage.apply(stage);
    expect(Realm.untracked(realm, (read) => read($held))).toBe(3);
    expect(values.values).toEqual([3]);
    expect(doubled.values).toEqual([6]);
    expectRealmAtRest(realm);
  });

  test("4: a second recipe reads the first's value of the same box", () => {
    using realm = testRealm();
    const $held = Box.make(realm, 1);
    const stage = Stage.make(realm);
    Stage.update(stage, (read, write) => {
      write($held, read($held) + 2);
    });
    Stage.update(stage, (read, write) => {
      write($held, read($held) * 10);
    });
    expect(Stage.read(stage, (read) => read($held))).toBe(30);
    Stage.apply(stage);
    expect(Realm.untracked(realm, (read) => read($held))).toBe(30);
  });

  test("write.modify drafts the staged value and leaves the realm's array alone", () => {
    using realm = testRealm();
    const initial: ReadonlyArray<string> = ["a"];
    const $tags = Box.make(realm, initial);
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write.modify($tags, (tags) => {
        tags.push("b");
      });
    });
    Stage.update(stage, (_read, write) => {
      write.modify($tags, (tags) => {
        tags.push("c");
      });
    });
    expect(Stage.read(stage, (read) => read($tags))).toEqual(["a", "b", "c"]);
    expect(Realm.untracked(realm, (read) => read($tags))).toBe(initial);
    expect(initial).toEqual(["a"]);
    Stage.apply(stage);
    expect(Realm.untracked(realm, (read) => read($tags))).toEqual(["a", "b", "c"]);
  });

  test("10: a recipe that throws leaves the overlay as it was, is not kept, and its error reaches the caller", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $b = Box.make(realm, 1);
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write($a, 2);
    });
    const failure = new Error("refused");
    expect(() =>
      Stage.update(stage, (_read, write) => {
        write($a, 3);
        write($b, 3);
        write($a, 4);
        throw failure;
      }),
    ).toThrow(failure);
    expect(Stage.read(stage, (read) => [read($a), read($b)])).toEqual([2, 1]);
    Stage.apply(stage);
    expect(Realm.untracked(realm, (read) => [read($a), read($b)])).toEqual([2, 1]);
  });

  test("a recipe that returns a promise throws at once, as update's does, and is not kept", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const stage = Stage.make(realm);
    expect(() =>
      Stage.update(stage, (async (_read: Read, write: Write) => {
        write($a, 2);
      }) as unknown as (read: Read, write: Write) => undefined),
    ).toThrow("pinna: Stage.update recipes are synchronous; await outside, then Stage.update");
    expect(Stage.read(stage, (read) => read($a))).toBe(1);
    expect(() =>
      Stage.update(stage, (() => 1) as unknown as (read: Read, write: Write) => undefined),
    ).toThrow("pinna: a Stage.update recipe returns nothing");
    Stage.drop(stage);
  });

  test("11: stageUpdate inside a computed value throws, as update does", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const stage = Stage.make(realm);
    const $bad = Computed.make(realm, (read) => {
      Stage.update(stage, (_read, write) => {
        write($a, 2);
      });
      return read($a);
    });
    expect(() => Realm.untracked(realm, (read) => read($bad))).toThrow(
      "pinna: Stage.update cannot run in a computed value",
    );
    expect(() =>
      Realm.watch(
        realm,
        (read) => {
          Stage.update(stage, () => undefined);
          return read($a);
        },
        () => undefined,
      ),
    ).toThrow("pinna: Stage.update cannot run in a watch's select or a selector");
    expect(Stage.read(stage, (read) => read($a))).toBe(1);
    Stage.drop(stage);
    expectRealmAtRest(realm);
  });

  test("runs in an autorun's body, untracked, as update does", () => {
    using realm = testRealm();
    const $trigger = Box.make(realm, 0);
    const $a = Box.make(realm, 1);
    const stage = Stage.make(realm);
    let runs = 0;
    using _ = held(
      Realm.autorun(realm, (read) => {
        runs++;
        read($trigger);
        Stage.update(stage, (stagedRead, write) => {
          write($a, stagedRead($a) + 1);
        });
        return undefined;
      }),
    );
    expect(runs).toBe(1);
    // The recipe read $a through the stage: the autorun does not observe it.
    Realm.update(realm, (_read, write) => {
      write($a, 100);
    });
    expect(runs).toBe(1);
    expect(Stage.read(stage, (read) => read($a))).toBe(2);
    Stage.apply(stage);
    expect(Realm.untracked(realm, (read) => read($a))).toBe(101);
    expect(runs).toBe(1);
  });

  test("a box of another realm throws, naming both realms", () => {
    using ui = testRealm({ name: "ui" });
    using quotes = testRealm({ name: "quotes" });
    const $theirs = Box.make(quotes, 1, { name: "price" });
    const stage = Stage.make(ui);
    expect(() =>
      Stage.update(stage, (_read, write) => {
        write($theirs, 2);
      }),
    ).toThrow(
      'pinna: write("price") is handed an observable of another realm (realm "quotes", not "ui")',
    );
    expect(() => Stage.read(stage, (read) => read($theirs))).toThrow(
      'pinna: read("price") is handed an observable of another realm (realm "quotes", not "ui")',
    );
    Stage.drop(stage);
  });
});

describe("stageRead and realmRead", () => {
  test("2: stageRead returns the staged value of a box the stage wrote, and the realm's current value of one it did not", () => {
    using realm = testRealm();
    const $written = Box.make(realm, 1);
    const $other = Box.make(realm, 10);
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write($written, 2);
    });
    expect(Stage.read(stage, (read) => [read($written), read($other)])).toEqual([2, 10]);
    Realm.update(realm, (_read, write) => {
      write($other, 11);
      write($written, 5);
    });
    expect(Stage.read(stage, (read) => [read($written), read($other)])).toEqual([2, 11]);
    Stage.drop(stage);
  });

  test("3: realmRead returns the realm's value of a box the stage wrote", () => {
    using realm = testRealm();
    const $held = Box.make(realm, 1);
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write($held, 2);
    });
    expect(Stage.realmRead(stage, (read) => read($held))).toBe(1);
    expect(Stage.read(stage, (read) => read($held))).toBe(2);
    Stage.drop(stage);
  });

  test("realmRead reads computed values, collections, and atoms as untracked does", () => {
    using realm = testRealm();
    const $held = Box.make(realm, 1);
    const $double = Computed.make(realm, (read) => read($held) * 2);
    const $rows = Collection.make<string, { readonly id: string }>(realm, {
      keyOf: (row) => row.id,
    });
    Realm.update(realm, (_read, write) => {
      write.upsert($rows, { id: "a" });
    });
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write($held, 5);
    });
    expect(Stage.realmRead(stage, (read) => [read($double), read.row($rows, "a")])).toEqual([
      2,
      { id: "a" },
    ]);
    Stage.drop(stage);
  });

  test("read.row through a stage reads the realm's row, and an atom reads as undefined", () => {
    using realm = testRealm();
    const $rows = Collection.make<string, { readonly id: string; readonly size: number }>(realm, {
      keyOf: (row) => row.id,
    });
    const $feed = Atom.make(realm);
    Realm.update(realm, (_read, write) => {
      write.upsert($rows, { id: "a", size: 1 });
    });
    const stage = Stage.make(realm);
    expect(
      Stage.read(stage, (read) => [read.row($rows, "a"), read.row($rows, "b"), read($feed)]),
    ).toEqual([{ id: "a", size: 1 }, undefined, undefined]);
    Stage.drop(stage);
  });

  test("stageRead inside an untracked call in a computed value throws, as update does there", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const stage = Stage.make(realm);
    const $staged = Computed.make(realm, () =>
      Realm.untracked(realm, () => Stage.read(stage, (read) => read($a))),
    );
    expect(() => Realm.untracked(realm, (read) => read($staged))).toThrow(
      "pinna: Stage.read cannot run in a computed value",
    );
    Stage.drop(stage);
    expectRealmAtRest(realm);
  });

  test("stageRead and realmRead inside a computed value throw", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const stage = Stage.make(realm);
    const $staged = Computed.make(realm, () => Stage.read(stage, (read) => read($a)));
    const $realm = Computed.make(realm, () => Stage.realmRead(stage, (read) => read($a)));
    expect(() => Realm.untracked(realm, (read) => read($staged))).toThrow(
      "pinna: Stage.read cannot run in a computed value",
    );
    expect(() => Realm.untracked(realm, (read) => read($realm))).toThrow(
      "pinna: Stage.realmRead cannot run in a computed value",
    );
    Stage.drop(stage);
    expectRealmAtRest(realm);
  });
});

describe("applyStage", () => {
  test("5: replays the recipes in order over the realm's values at that moment", () => {
    using realm = testRealm();
    const $held = Box.make(realm, 1);
    const stage = Stage.make(realm);
    Stage.update(stage, (read, write) => {
      write($held, read($held) + 2);
    });
    expect(Stage.read(stage, (read) => read($held))).toBe(3);
    Realm.update(realm, (_read, write) => {
      write($held, 5);
    });
    Stage.apply(stage);
    expect(Realm.untracked(realm, (read) => read($held))).toBe(7);
  });

  test("6: lands every write in one update: a watcher over two staged boxes runs once and sees both", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const $b = Box.make(realm, 1);
    using pairs = record(realm, (read) => [read($a), read($b)] as const, {
      equals: (left, right) => left[0] === right[0] && left[1] === right[1],
    });
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write($a, 2);
    });
    Stage.update(stage, (_read, write) => {
      write($b, 3);
    });
    Stage.apply(stage);
    expect(pairs.values).toEqual([[2, 3]]);
  });

  test("7: inside an open update of the realm it joins that update", () => {
    using realm = testRealm();
    const $staged = Box.make(realm, 1);
    const $own = Box.make(realm, 1);
    using pairs = record(realm, (read) => [read($staged), read($own)] as const, {
      equals: (left, right) => left[0] === right[0] && left[1] === right[1],
    });
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write($staged, 2);
    });
    Realm.update(realm, (read, write) => {
      write($own, 2);
      Stage.apply(stage);
      // The outer recipe reads what the stage landed.
      write($own, read($staged) + read($own));
    });
    expect(pairs.values).toEqual([[2, 4]]);
  });

  test("a recipe that throws on replay rolls back the stage's writes alone: an outer update that catches keeps its own", () => {
    using realm = testRealm();
    const $staged = Box.make(realm, 1);
    const $own = Box.make(realm, 1);
    using values = record(realm, (read) => read($own));
    const stage = Stage.make(realm);
    Stage.update(stage, (read, write) => {
      if (read($own) > 1) {
        throw new Error("changed under the stage");
      }
      write($staged, 2);
    });
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write($own, 2);
        Stage.apply(stage);
      }),
    ).toThrow("changed under the stage");
    expect(Realm.untracked(realm, (read) => [read($staged), read($own)])).toEqual([1, 1]);
    expect(values.values).toEqual([]);
    expect(Stage.status(stage)).toBe("dropped");

    // The host catches inside its own update and records the failure there.
    const second = Stage.make(realm);
    Stage.update(second, (read, write) => {
      if (read($own) > 1) {
        throw new Error("changed under the stage");
      }
      write($staged, 3);
    });
    const $failed = Box.make(realm, false);
    Realm.update(realm, (_read, write) => {
      write($own, 2);
      try {
        Stage.apply(second);
      } catch {
        write($failed, true);
      }
    });
    expect(Realm.untracked(realm, (read) => [read($staged), read($own), read($failed)])).toEqual([
      1,
      2,
      true,
    ]);
    expect(values.values).toEqual([2]);
    expect(Stage.status(second)).toBe("dropped");
    expectRealmAtRest(realm);
  });

  test("throws inside a computed value, and leaves the stage open", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write($a, 2);
    });
    const $bad = Computed.make(realm, (read) => {
      Stage.apply(stage);
      return read($a);
    });
    expect(() => Realm.untracked(realm, (read) => read($bad))).toThrow(
      "pinna: Stage.apply cannot run in a computed value",
    );
    Stage.apply(stage);
    expect(Realm.untracked(realm, (read) => read($a))).toBe(2);
  });
});

describe("dropStage and closing", () => {
  test("8: dropStage changes no box and runs no watcher", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    using values = record(realm, (read) => read($a));
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write($a, 2);
    });
    Stage.drop(stage);
    expect(Realm.untracked(realm, (read) => read($a))).toBe(1);
    expect(values.values).toEqual([]);
    expectRealmAtRest(realm);
  });

  test("9: after applyStage or dropStage every stage call throws a StageClosedError, dropStage does nothing, and a kept read and write throw", () => {
    for (const [close, status] of [
      [Stage.apply, "applied"],
      [Stage.drop, "dropped"],
    ] as const) {
      using realm = testRealm();
      const $a = Box.make(realm, 1);
      const stage = Stage.make(realm);
      let keptRead: Read | undefined;
      let keptWrite: Write | undefined;
      // Kept from the run in stageUpdate only: the replay hands the recipe the update's own.
      Stage.update(stage, (read, write) => {
        keptRead ??= read;
        keptWrite ??= write;
        write($a, 2);
      });
      let keptRealmRead: Read | undefined;
      Stage.realmRead(stage, (read) => {
        keptRealmRead = read;
      });
      close(stage);
      expect(Stage.status(stage)).toBe(status);
      const closed = `runs on a stage after it was ${status}`;
      expect(() => Stage.update(stage, () => undefined)).toThrow(`pinna: Stage.update ${closed}`);
      expect(() => Stage.read(stage, () => undefined)).toThrow(`pinna: Stage.read ${closed}`);
      expect(() => Stage.realmRead(stage, () => undefined)).toThrow(
        `pinna: Stage.realmRead ${closed}`,
      );
      expect(() => Stage.apply(stage)).toThrow(`pinna: Stage.apply ${closed}`);
      expect(() => Stage.make(stage)).toThrow(`pinna: Stage.make ${closed}`);
      expect(() => Stage.apply(stage)).toThrow(StageClosedError);
      Stage.drop(stage);
      expect(Stage.status(stage)).toBe(status);
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
    const $a = Box.make(realm, 1);
    const stage = Stage.make(realm);
    let keptRead: Read | undefined;
    let keptWrite: Write | undefined;
    Stage.update(stage, (read, write) => {
      keptRead = read;
      keptWrite = write;
    });
    expect(() => (keptRead as Read)($a)).toThrow(
      "pinna: read of a stage runs after its recipe returned",
    );
    expect(() => (keptWrite as Write)($a, 2)).toThrow(
      "pinna: write of a stage runs after its recipe returned",
    );
    expect(Stage.read(stage, (read) => read($a))).toBe(1);
    Stage.drop(stage);
  });

  test("a stage call inside a stage recipe throws, on its own stage or another", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    const stage = Stage.make(realm);
    const other = Stage.make(realm);
    for (const [name, call] of [
      ["Stage.apply", () => Stage.apply(stage)],
      ["Stage.drop", () => Stage.drop(stage)],
      ["Stage.update", () => Stage.update(other, () => undefined)],
      ["Stage.read", () => Stage.read(other, () => undefined)],
      ["Stage.realmRead", () => Stage.realmRead(other, () => undefined)],
      ["Stage.make", () => Stage.make(realm)],
    ] as const) {
      expect(() =>
        Stage.update(stage, (_read, write) => {
          write($a, 2);
          call();
        }),
      ).toThrow(`pinna: ${name} runs inside a stage recipe`);
    }
    Stage.drop(other);
    expect(Stage.read(stage, (read) => read($a))).toBe(1);
    Stage.apply(stage);
    expect(Realm.untracked(realm, (read) => read($a))).toBe(1);
  });

  test("an empty stage applies and changes nothing", () => {
    using realm = testRealm();
    const $a = Box.make(realm, 1);
    using values = record(realm, (read) => read($a));
    const stage = Stage.make(realm);
    Stage.apply(stage);
    expect(values.values).toEqual([]);
    expectRealmAtRest(realm);
  });
});

describe("a stage left open", () => {
  test("testRealm's dispose reports a stage neither applied nor dropped, and closes it", () => {
    const realm = testRealm();
    const $a = Box.make(realm, 1);
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write($a, 2);
    });
    expect(() => realm[Symbol.dispose]()).toThrow(
      "The test realm is not at rest: stage still running.",
    );
    expect(Stage.status(stage)).toBe("dropped");
    expect(Realm.untracked(realm, (read) => read($a))).toBe(1);
  });

  test("a named stage is reported by its name", () => {
    const realm = testRealm();
    Stage.make(realm, { name: "save" });
    expect(() => realm[Symbol.dispose]()).toThrow(
      'The test realm is not at rest: stage "save" still running.',
    );
  });

  test("a stage applied or dropped is not reported", () => {
    using realm = testRealm();
    Stage.drop(Stage.make(realm));
    Stage.apply(Stage.make(realm));
  });

  test("a realm from createRealm keeps no record of its stages", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 1);
    const stage = Stage.make(realm);
    Stage.update(stage, (_read, write) => {
      write($a, 2);
    });
    expect(Realm.untracked(realm, (read) => read($a))).toBe(1);
    Stage.drop(stage);
    expectRealmAtRest(realm);
  });
});
