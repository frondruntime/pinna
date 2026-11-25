import { describe, expect, test } from "bun:test";
import * as Pinna from "../../src/index.ts";
import { type BoxCell, type Check, makeBox, openParts } from "../../src/internal/index.ts";
import { held, record, testRealm } from "../../src/testing/index.ts";

/** Accepts numbers only, as pinna-effect's `Box.schema` over `Schema.Number` does. */
const numbersOnly: Check = (value) =>
  typeof value === "number"
    ? undefined
    : { message: `Expected number, got ${typeof value}`, cause: undefined };

const message = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
};
const forbidden = [
  "update",
  "untracked",
  "kept read",
  "kept read.row",
  "kept write",
  "kept modify",
  "kept upsert",
  "kept remove",
  "kept replaceAll",
  "kept changed",
  "watch",
  "autorun",
  "observe",
  "onObserved",
  "onRowChange",
  "openStage",
  "stageUpdate",
  "stageRead",
  "realmRead",
  "applyStage",
  "dropStage",
  "box",
  "computed",
  "computedFunction",
  "atom",
  "collection",
  "Model with box",
  "Model plain",
  "stageStatus",
  "inspectStage",
] as const;

describe("documented stage boundaries", () => {
  test("child recipes and row listeners run at staging and at each apply", () => {
    using realm = testRealm();
    const rows = Pinna.Collection.make(realm, { keyOf: (value: number) => value });
    let recipes = 0;
    let listeners = 0;
    using _listener = held(
      Pinna.Collection.onRowChange(rows, () => {
        listeners++;
      }),
    );
    const parent = Pinna.Stage.make(realm);
    const child = Pinna.Stage.make(parent);
    Pinna.Stage.update(child, (_read, write) => {
      recipes++;
      write.upsert(rows, 1);
    });
    expect([recipes, listeners]).toEqual([1, 1]);
    Pinna.Stage.apply(child);
    expect([recipes, listeners]).toEqual([2, 2]);
    Pinna.Stage.apply(parent);
    expect([recipes, listeners]).toEqual([3, 3]);
  });

  test("the recipe guard covers computed evaluation but only its own realm", () => {
    using realm = testRealm();
    using other = testRealm();
    const value = Pinna.Box.make(realm, 1);
    const count = Pinna.Box.make(other, 0);
    const untracked = Pinna.Computed.make(realm, () =>
      Pinna.Realm.untracked(realm, (read) => read(value)),
    );
    const makesComputed = Pinna.Computed.make(realm, (read) =>
      read(Pinna.Computed.make(realm, (innerRead) => innerRead(value))),
    );
    expect(Pinna.Realm.untracked(realm, (read) => [read(untracked), read(makesComputed)])).toEqual([
      1, 1,
    ]);
    const stage = Pinna.Stage.make(realm);
    expect(() => Pinna.Stage.read(stage, (read) => read(untracked))).toThrow("stage recipe");
    expect(() => Pinna.Stage.read(stage, (read) => read(makesComputed))).toThrow("stage recipe");
    Pinna.Stage.update(stage, () => {
      Pinna.Realm.update(other, (read, write) => write(count, read(count) + 1));
    });
    Pinna.Stage.apply(stage);
    expect(Pinna.Realm.untracked(other, (read) => read(count))).toBe(2);
  });

  test("realmRead does not record reads for conflicts", () => {
    using realm = testRealm();
    const value = Pinna.Box.make(realm, 0);
    const stage = Pinna.Stage.make(realm, { conflicts: "fail" });
    expect(Pinna.Stage.realmRead(stage, (read) => read(value))).toBe(0);
    expect(Pinna.Stage.inspect(stage).read).toEqual([]);
    Pinna.Realm.update(realm, (_read, write) => write(value, 1));
    Pinna.Stage.apply(stage);
    expect(Pinna.Stage.status(stage)).toBe("applied");
  });
});

describe("root replay guards", () => {
  for (const depth of [0, 1, 2]) {
    for (const name of forbidden) {
      test(`${name} on a replay-only branch through ${depth} computed values`, () => {
        const realm = Pinna.Realm.make();
        const target = Pinna.Box.make(realm, 0);
        const branch = Pinna.Box.make(realm, false);
        const own = Pinna.Box.make(realm, 0);
        const draft = Pinna.Box.make(realm, { value: 0 });
        const atom = Pinna.Atom.make(realm);
        const rows = Pinna.Collection.make(realm, { keyOf: (value: number) => value });
        Pinna.Realm.update(realm, (_read, write) => write.upsert(rows, 1));
        let keptRead!: Pinna.Read;
        let keptWrite!: Pinna.Write;
        Pinna.Realm.update(realm, (read, write) => {
          keptRead = read;
          keptWrite = write;
        });
        let callbacks = 0;
        const called = (): undefined => {
          callbacks++;
        };
        class Item extends Pinna.Model.Class {
          readonly value = called();
          readonly $value = Pinna.Box.make(this.realm, 0);
        }
        class Plain extends Pinna.Model.Class {
          readonly value = called();
        }
        const other = Pinna.Stage.make(realm);
        const stops: Array<() => void> = [];
        const calls: Record<(typeof forbidden)[number], () => unknown> = {
          update: () => Pinna.Realm.update(realm, called),
          untracked: () => Pinna.Realm.untracked(realm, called),
          "kept read": () => keptRead(target),
          "kept read.row": () => keptRead.row(rows, 1),
          "kept write": () => keptWrite(target, 4),
          "kept modify": () => keptWrite.modify(draft, called),
          "kept upsert": () => keptWrite.upsert(rows, 2),
          "kept remove": () => keptWrite.remove(rows, 1),
          "kept replaceAll": () => keptWrite.replaceAll(rows, [2]),
          "kept changed": () => keptWrite.changed(atom),
          watch: () =>
            stops.push(
              Pinna.Realm.watch(
                realm,
                (read) => {
                  called();
                  return read(target);
                },
                called,
              ),
            ),
          autorun: () =>
            stops.push(
              Pinna.Realm.autorun(realm, (read) => {
                read(target);
                called();
              }),
            ),
          observe: () => stops.push(Pinna.Source.observe(target)),
          onObserved: () => stops.push(Pinna.Source.onObserved(target, called)),
          onRowChange: () => stops.push(Pinna.Collection.onRowChange(rows, called)),
          openStage: () => Pinna.Stage.drop(Pinna.Stage.make(other)),
          stageUpdate: () => Pinna.Stage.update(other, called),
          stageRead: () => Pinna.Stage.read(other, called),
          realmRead: () => Pinna.Stage.realmRead(other, called),
          applyStage: () => Pinna.Stage.apply(other),
          dropStage: () => Pinna.Stage.drop(other),
          box: () => Pinna.Box.make(realm, 0),
          computed: () => Pinna.Computed.make(realm, called),
          computedFunction: () => Pinna.Computed.fn(realm, called),
          atom: () => Pinna.Atom.make(realm),
          collection: () => Pinna.Collection.make(realm, { keyOf: (value: number) => value }),
          "Model with box": () => new Item(realm),
          "Model plain": () => new Plain(realm),
          stageStatus: () => Pinna.Stage.status(other),
          inspectStage: () => Pinna.Stage.inspect(other),
        };
        let invoke = (_read: Pinna.Read): undefined => {
          calls[name]();
        };
        for (let level = 0; level < depth; level++) {
          const previous = invoke;
          const derived = Pinna.Computed.make(realm, (read) => {
            previous(read);
            return 0;
          });
          invoke = (read) => {
            read(derived);
          };
        }
        const staged = Pinna.Stage.make(realm);
        const expected = message(() => Pinna.Stage.update(staged, invoke));
        Pinna.Stage.drop(staged);
        const stage = Pinna.Stage.make(realm);
        Pinna.Stage.update(stage, (read, write) => {
          write(target, 1);
          if (read(branch)) invoke(read);
        });
        let actual: string | undefined;
        Pinna.Realm.update(realm, (_read, write) => {
          write(branch, true);
          write(own, 7);
          actual = message(() => Pinna.Stage.apply(stage));
        });
        const observers = Pinna.Source.inspect(target).observers;
        const callbacksAfterApply = callbacks;
        const targetAfterApply = Pinna.Realm.untracked(realm, (read) => read(target));
        Pinna.Realm.update(realm, (_read, write) => write(target, 2));
        const callbacksAfterUpdate = callbacks;
        for (const stop of stops) stop();
        Pinna.Stage.drop(other);
        expect(expected).toContain("stage recipe");
        expect(actual).toBe(expected);
        expect(Pinna.Stage.status(stage)).toBe("dropped");
        expect(targetAfterApply).toBe(0);
        expect(callbacksAfterApply).toBe(0);
        expect(callbacksAfterUpdate).toBe(0);
        expect(observers).toBe(0);
        expect(Pinna.Realm.untracked(realm, (read) => read(own))).toBe(7);
        expect(openParts(realm)).toEqual([]);
      });
    }
  }
});

interface Fixture {
  readonly first: Pinna.Box<number>;
  readonly second: Pinna.Box<number>;
  readonly object: Pinna.Box<{ count: number }>;
  readonly rows: Pinna.Collection<number, { id: number; value: number }>;
  readonly total: Pinna.Box<number>;
  readonly atom: Pinna.Atom;
  readonly derived: Pinna.Computed<number>;
}
const cases: ReadonlyArray<
  readonly [string, (state: Fixture) => ReadonlyArray<Pinna.UpdateRecipe>]
> = [
  [
    "boxes and computed reads",
    (state) => [
      (_read, write) => write(state.first, 3),
      (read, write) => write(state.second, read(state.derived)),
    ],
  ],
  [
    "schema boxes",
    (state) => [
      (_read, write) => write(state.second, 4),
      (read, write) => write(state.first, read(state.second) + 1),
    ],
  ],
  [
    "modify",
    (state) => [
      (_read, write) =>
        write.modify(state.object, (draft) => {
          draft.count++;
        }),
      (_read, write) =>
        write.modify(state.object, (draft) => {
          draft.count *= 3;
        }),
    ],
  ],
  [
    "collection upsert and remove with listeners",
    (state) => [
      (_read, write) => write.upsert(state.rows, { id: 1, value: 4 }),
      (_read, write) => write.remove(state.rows, 2),
      (_read, write) => write.upsert(state.rows, { id: 3, value: 9 }, { at: "end" }),
    ],
  ],
  [
    "collection replaceAll and order with listeners",
    (state) => [
      (_read, write) =>
        write.replaceAll(state.rows, [
          { id: 3, value: 3 },
          { id: 1, value: 7 },
        ]),
      (read, write) => write.replaceAll(state.rows, [...read(state.rows.rows)].reverse()),
    ],
  ],
  [
    "atoms",
    (state) => [
      (_read, write) => write.changed(state.atom),
      (_read, write) => write.changed(state.atom),
    ],
  ],
];

describe("root replay differential", () => {
  test("landing equality runs after the last recipe's handles close", () => {
    using realm = testRealm();
    const target = Pinna.Box.make(realm, 0);
    let keptRead: Pinna.Read | undefined;
    let keptWrite: Pinna.Write | undefined;
    let running = false;
    const errors: Array<string | undefined> = [];
    const value = Pinna.Box.make(realm, 0, {
      equals: (left, right) => {
        if (!running && keptRead !== undefined && keptWrite !== undefined) {
          const read = keptRead;
          const write = keptWrite;
          errors.push(
            message(() => read(target)),
            message(() => write(target, 1)),
          );
        }
        return left === right;
      },
    });
    const stage = Pinna.Stage.make(realm);
    Pinna.Stage.update(stage, (read, write) => {
      keptRead = read;
      keptWrite = write;
      running = true;
      try {
        write(value, 1);
      } finally {
        running = false;
      }
    });
    Pinna.Stage.apply(stage);
    expect(errors).toEqual(
      ["read", "write"].map(
        (handle) =>
          `pinna: ${handle} of a stage runs after its recipe returned; read and write inside the recipe`,
      ),
    );
    expect(Pinna.Realm.untracked(realm, (read) => read(target))).toBe(0);
  });

  for (const existingCell of [false, true]) {
    test(`row equality uses no old cell after ${existingCell ? "removal" : "an unread row"}`, () => {
      const run = (staged: boolean) => {
        using realm = testRealm();
        const original = { id: 1, count: 0 };
        const rows = Pinna.Collection.make(realm, {
          keyOf: (row: typeof original) => row.id,
          equals: (left, right) => left.count === right.count,
        });
        Pinna.Realm.update(realm, (_read, write) => write.upsert(rows, original));
        if (existingCell) Pinna.Realm.untracked(realm, (read) => read(rows.row(1)));
        const decision = Pinna.Box.make(realm, true);
        const recipe: Pinna.UpdateRecipe = (read, write) => {
          if (existingCell) write.remove(rows, 1);
          write.upsert(rows, { id: 1, count: 1 });
          write.upsert(rows, { id: 1, count: 0 });
          write(decision, read.row(rows, 1) === original);
        };
        if (staged) {
          const stage = Pinna.Stage.make(realm);
          Pinna.Stage.update(stage, recipe);
          Pinna.Stage.apply(stage);
        } else Pinna.Realm.update(realm, recipe);
        return Pinna.Realm.untracked(realm, (read) => read(decision));
      };
      expect(run(false)).toBe(false);
      expect(run(true)).toBe(false);
    });
  }

  test("write-back equality precedes current equality and skips an already restored version", () => {
    const run = (staged: boolean) => {
      using realm = testRealm();
      const original = { count: 0 };
      const comparisons: Array<readonly [number, number]> = [];
      const value = Pinna.Box.make(realm, original, {
        equals: (left, right) => {
          comparisons.push([left.count, right.count]);
          return left.count === right.count || right.count === 2;
        },
      });
      const decisions: boolean[] = [];
      const recipe: Pinna.UpdateRecipe = (read, write) => {
        write(value, { count: 1 });
        write(value, { count: 2 });
        decisions.push(read(value) === original);
        write(value, { count: 3 });
      };
      if (staged) {
        const stage = Pinna.Stage.make(realm);
        Pinna.Stage.update(stage, recipe);
        comparisons.length = 0;
        decisions.length = 0;
        Pinna.Stage.apply(stage);
      } else Pinna.Realm.update(realm, recipe);
      expect(decisions).toEqual([true]);
      expect(comparisons.slice(0, 3)).toEqual([
        [0, 1],
        [0, 2],
        [0, 3],
      ]);
    };
    run(false);
    run(true);
  });

  for (const child of [false, true]) {
    for (const handle of ["read", "write"] as const) {
      test(`expired ${handle} stays expired during ${child ? "child and root" : "root"} replay`, () => {
        using realm = testRealm();
        const target = Pinna.Box.make(realm, 0);
        const root = Pinna.Stage.make(realm);
        const stage = child ? Pinna.Stage.make(root) : root;
        let keptRead!: Pinna.Read;
        let keptWrite!: Pinna.Write;
        const errors: Array<string | undefined> = [];
        Pinna.Stage.update(stage, (read, write) => {
          keptRead = read;
          keptWrite = write;
        });
        Pinna.Stage.update(stage, (_read, write) => {
          errors.push(
            message(() => {
              if (handle === "write") keptWrite(target, 1);
              else write(target, keptRead(target) + 1);
            }),
          );
        });
        if (child) Pinna.Stage.apply(stage);
        Pinna.Stage.apply(root);
        expect(errors).toEqual(
          Array(child ? 3 : 2).fill(
            `pinna: ${handle} of a stage runs after its recipe returned; read and write inside the recipe`,
          ),
        );
        expect(Pinna.Realm.untracked(realm, (read) => read(target))).toBe(0);
      });
    }
  }

  for (const enclosingWrite of [false, true]) {
    test(`write-back identity agrees with update (${enclosingWrite ? "enclosing write" : "replay writes first"})`, () => {
      const run = (staged: boolean) => {
        using realm = testRealm();
        const original = { count: 0 };
        const value = Pinna.Box.make(realm, original, {
          equals: (left, right) => left.count === right.count,
        });
        const decision = Pinna.Box.make(realm, false);
        const isOriginal = Pinna.Computed.make(realm, (read) => read(value) === original);
        const version = (value as BoxCell<typeof original>).source.version;
        const recipe: Pinna.UpdateRecipe = (read, write) => {
          if (!enclosingWrite) write(value, { count: 1 });
          write(value, { count: 0 });
          write(decision, read(isOriginal));
        };
        const stage = Pinna.Stage.make(realm);
        if (staged) Pinna.Stage.update(stage, recipe);
        Pinna.Realm.update(realm, (_read, write) => {
          if (enclosingWrite) write(value, { count: 1 });
          if (staged) Pinna.Stage.apply(stage);
          else Pinna.Realm.update(realm, recipe);
        });
        Pinna.Stage.drop(stage);
        expect((value as BoxCell<typeof original>).source.version).toBe(version);
        return Pinna.Realm.untracked(realm, (read) => [read(value) === original, read(decision)]);
      };
      expect(run(false)).toEqual([true, true]);
      expect(run(true)).toEqual([true, true]);
    });
  }

  for (const verb of ["upsert", "replaceAll"] as const) {
    for (const enclosingWrite of [false, true]) {
      test(`${verb} restores a row cell's identity before replay reads (${enclosingWrite ? "enclosing write" : "replay writes first"})`, () => {
        const run = (staged: boolean) => {
          using realm = testRealm();
          const original = { id: 1, count: 0 };
          const rows = Pinna.Collection.make(realm, {
            keyOf: (row: typeof original) => row.id,
            equals: (left, right) => left.count === right.count,
          });
          Pinna.Realm.update(realm, (_read, write) => write.upsert(rows, original));
          Pinna.Realm.untracked(realm, (read) => read(rows.row(1)));
          const decision = Pinna.Box.make(realm, false);
          const writeRow = (write: Pinna.Write, count: number) => {
            if (verb === "upsert") write.upsert(rows, { id: 1, count });
            else write.replaceAll(rows, [{ id: 1, count }]);
          };
          const recipe: Pinna.UpdateRecipe = (read, write) => {
            if (!enclosingWrite) writeRow(write, 1);
            writeRow(write, 0);
            write(decision, read.row(rows, 1) === original);
          };
          const stage = Pinna.Stage.make(realm);
          if (staged) Pinna.Stage.update(stage, recipe);
          Pinna.Realm.update(realm, (_read, write) => {
            if (enclosingWrite) writeRow(write, 1);
            if (staged) Pinna.Stage.apply(stage);
            else Pinna.Realm.update(realm, recipe);
          });
          Pinna.Stage.drop(stage);
          return Pinna.Realm.untracked(realm, (read) => [
            read.row(rows, 1) === original,
            read(decision),
          ]);
        };
        expect(run(false)).toEqual([true, true]);
        expect(run(true)).toEqual([true, true]);
      });
    }
  }

  for (const [name, recipesFor] of cases) {
    test(`${name}: ordinary updates and stage apply agree`, () => {
      const run = (staged: boolean) => {
        using realm = testRealm();
        const first = Pinna.Box.make(realm, 1);
        const second = makeBox<number>(realm, numbersOnly, Object.is, 2, undefined);
        const object = Pinna.Box.make(realm, { count: 1 });
        const rows = Pinna.Collection.make(realm, {
          keyOf: (row: { id: number; value: number }) => row.id,
        });
        const total = Pinna.Box.make(realm, 0);
        const atom = Pinna.Atom.make(realm);
        const derived = Pinna.Computed.make(realm, (read) => read(first) * 2);
        Pinna.Realm.update(realm, (_read, write) =>
          write.replaceAll(rows, [
            { id: 1, value: 1 },
            { id: 2, value: 2 },
          ]),
        );
        const log: unknown[] = [];
        using _listener = held(
          Pinna.Collection.onRowChange(rows, (change, read, write) => {
            log.push([change, read(rows.keys), read(rows.rows)]);
            write(total, read(total) - (change.before?.value ?? 0) + (change.after?.value ?? 0));
          }),
        );
        const row = rows.row(1);
        const removed = rows.row(2);
        const added = rows.row(3);
        const snapshot = (read: Pinna.Read) => [
          read(first),
          read(second),
          read(object),
          read(rows.keys),
          read(rows.rows),
          read(row),
          read(removed),
          read(added),
          read(total),
          read(derived),
        ];
        using values = record(realm, snapshot);
        let atomRuns = 0;
        using _observer = held(
          Pinna.Realm.autorun(realm, (read) => {
            read(atom);
            atomRuns++;
          }),
        );
        const conflict = Pinna.Stage.make(realm, { conflicts: "fail" });
        Pinna.Stage.read(conflict, snapshot);
        const recipes = recipesFor({ first, second, object, rows, total, atom, derived });
        log.length = 0;
        if (staged) {
          const stage = Pinna.Stage.make(realm);
          for (const recipe of recipes) Pinna.Stage.update(stage, recipe);
          const stagedLog = [...log];
          log.length = 0;
          Pinna.Stage.apply(stage);
          expect(log).toEqual(stagedLog);
        } else {
          // One settling boundary, with one ordinary update per recipe, as applyStage promises.
          Pinna.Realm.update(realm, () => {
            for (const recipe of recipes) Pinna.Realm.update(realm, recipe);
          });
        }
        const outcome = message(() => Pinna.Stage.apply(conflict));
        return {
          state: Pinna.Realm.untracked(realm, snapshot),
          watchers: values.values,
          atomRuns,
          log,
          conflicted: outcome !== undefined,
          status: Pinna.Stage.status(conflict),
        };
      };
      expect(run(true)).toEqual(run(false));
    });
  }

  test("rebase lands both boxes once, using the current realm value", () => {
    using realm = testRealm();
    const first = Pinna.Box.make(realm, 1);
    const second = Pinna.Box.make(realm, 0);
    const stage = Pinna.Stage.make(realm);
    Pinna.Stage.update(stage, (read, write) => write(first, read(first) + 2));
    Pinna.Stage.update(stage, (read, write) => write(second, read(first) * 2));
    Pinna.Realm.update(realm, (_read, write) => write(first, 5));
    using values = record(realm, (read) => [read(first), read(second)]);
    Pinna.Stage.apply(stage);
    expect(values.values).toEqual([[7, 14]]);
  });

  for (const kind of ["box", "row"] as const) {
    test(`${kind} written back lands no version change or watcher run`, () => {
      using realm = testRealm();
      const value = Pinna.Box.make(realm, 0);
      const rows = Pinna.Collection.make(realm, { keyOf: (row: number) => row });
      const conflict = Pinna.Stage.make(realm, { conflicts: "fail" });
      Pinna.Stage.read(conflict, (read) => [read(value), read(rows.rows)]);
      using values = record(realm, (read) => [read(value), read(rows.rows)]);
      const version = (value as BoxCell<number>).source.version;
      const stage = Pinna.Stage.make(realm);
      Pinna.Stage.update(stage, (_read, write) => {
        if (kind === "box") {
          write(value, 1);
          write(value, 0);
        } else {
          write.upsert(rows, 1);
          write.remove(rows, 1);
        }
      });
      Pinna.Stage.apply(stage);
      expect(message(() => Pinna.Stage.apply(conflict))).toBeUndefined();
      expect((value as BoxCell<number>).source.version).toBe(version);
      expect(values.values).toEqual([]);
    });
  }

  test("ordinary update restores a box version but advances collection change tracking after add/remove", () => {
    using realm = testRealm();
    const value = Pinna.Box.make(realm, 0);
    const rows = Pinna.Collection.make(realm, { keyOf: (row: number) => row });
    const boxStage = Pinna.Stage.make(realm, { conflicts: "fail" });
    const rowStage = Pinna.Stage.make(realm, { conflicts: "fail" });
    Pinna.Stage.read(boxStage, (read) => read(value));
    Pinna.Stage.read(rowStage, (read) => read(rows.rows));
    using values = record(realm, (read) => read(rows.rows));
    Pinna.Realm.update(realm, (_read, write) => {
      write(value, 1);
      write(value, 0);
      write.upsert(rows, 1);
      write.remove(rows, 1);
    });
    expect(message(() => Pinna.Stage.apply(boxStage))).toBeUndefined();
    expect(() => Pinna.Stage.apply(rowStage)).toThrow(Pinna.StageConflictError);
    expect(values.values).toEqual([]);
  });

  test("settling watch and autorun errors go to onError and leave the stage applied", () => {
    const errors: unknown[] = [];
    const realm = Pinna.Realm.make({
      onError: (error) => {
        errors.push(error);
      },
    });
    const value = Pinna.Box.make(realm, 0);
    const failure = new Error("settle failed");
    const stopWatch = Pinna.Realm.watch(
      realm,
      (read) => read(value),
      () => {
        throw failure;
      },
    );
    const stopAutorun = Pinna.Realm.autorun(realm, (read) => {
      if (read(value) > 0) throw failure;
    });
    const stage = Pinna.Stage.make(realm);
    Pinna.Stage.update(stage, (_read, write) => write(value, 1));
    Pinna.Stage.apply(stage);
    expect(errors).toEqual([failure, failure]);
    expect(Pinna.Stage.status(stage)).toBe("applied");
    stopWatch();
    stopAutorun();
  });
});

describe("callbacks during root replay", () => {
  for (const site of ["box equality", "row equality", "row key", "listener"] as const) {
    test(`${site} holds the replay guard`, () => {
      const realm = Pinna.Realm.make();
      let replay = false;
      let callbacks = 0;
      const guarded = () => {
        if (replay)
          Pinna.Realm.update(realm, () => {
            callbacks++;
          });
      };
      const value = Pinna.Box.make(realm, 0, {
        equals: (left, right) => {
          if (site === "box equality") guarded();
          return left === right;
        },
      });
      const rows = Pinna.Collection.make(realm, {
        keyOf: (row: { id: number; value: number }) => {
          if (site === "row key") guarded();
          return row.id;
        },
        equals: (left, right) => {
          if (site === "row equality") guarded();
          return left.value === right.value;
        },
      });
      Pinna.Realm.update(realm, (_read, write) => write.upsert(rows, { id: 1, value: 0 }));
      const stop = Pinna.Collection.onRowChange(rows, () => {
        if (site === "listener") guarded();
      });
      const stage = Pinna.Stage.make(realm);
      Pinna.Stage.update(stage, (_read, write) => {
        write(value, 1);
        write.upsert(rows, { id: 1, value: 1 });
      });
      replay = true;
      const error = message(() => Pinna.Stage.apply(stage));
      stop();
      expect(error).toContain("stage recipe writes the realm");
      expect(callbacks).toBe(0);
      expect(Pinna.Stage.status(stage)).toBe("dropped");
      expect(Pinna.Realm.untracked(realm, (read) => [read(value), read(rows.rows)])).toEqual([
        0,
        [{ id: 1, value: 0 }],
      ]);
    });
  }
});

describe("landing invariants", () => {
  test("a rolled-back landing drops the stage and refuses a later apply", () => {
    using realm = testRealm();
    const value = Pinna.Box.make(realm, 0);
    const stage = Pinna.Stage.make(realm, { name: "landing" });
    Pinna.Stage.update(stage, (_read, write) => write(value, 1));
    expect(() =>
      Pinna.Realm.update(realm, () => {
        Pinna.Stage.apply(stage);
        expect(Pinna.Stage.status(stage)).toBe("applied");
        throw new Error("host rollback");
      }),
    ).toThrow("host rollback");
    expect(Pinna.Realm.untracked(realm, (read) => read(value))).toBe(0);
    expect(Pinna.Stage.status(stage)).toBe("dropped");
    expect(Pinna.Stage.inspect(stage).recipes).toBe(0);
    expect(() => Pinna.Stage.apply(stage)).toThrow(Pinna.StageClosedError);
    expect(message(() => Pinna.Stage.apply(stage))).toContain("after it was dropped");
    Pinna.Stage.drop(stage);
  });

  test("an empty journal stays applied when its enclosing update rolls back", () => {
    using realm = testRealm();
    const stage = Pinna.Stage.make(realm);
    expect(() =>
      Pinna.Realm.update(realm, () => {
        Pinna.Stage.apply(stage);
        throw new Error("host rollback");
      }),
    ).toThrow("host rollback");
    expect(Pinna.Stage.status(stage)).toBe("applied");
  });

  test("row readers track only their own changes, including removal and later reinsertion", () => {
    using realm = testRealm();
    const rows = Pinna.Collection.make(realm, {
      keyOf: (row: { id: number; value: number }) => row.id,
    });
    Pinna.Realm.update(realm, (_read, write) =>
      write.replaceAll(rows, [
        { id: 1, value: 1 },
        { id: 2, value: 2 },
      ]),
    );
    const first = rows.row(1);
    const second = rows.row(2);
    const added = rows.row(3);
    using firstValues = record(realm, (read) => read(first));
    using secondValues = record(realm, (read) => read(second));
    using addedValues = record(realm, (read) => read(added));
    using keys = record(realm, (read) => read(rows.keys));
    const stage = Pinna.Stage.make(realm);
    Pinna.Stage.update(stage, (_read, write) => write.upsert(rows, { id: 1, value: 10 }));
    Pinna.Stage.apply(stage);
    expect(firstValues.values).toEqual([{ id: 1, value: 10 }]);
    expect(secondValues.values).toEqual([]);
    expect(addedValues.values).toEqual([]);
    expect(keys.values).toEqual([]);
    const replacement = Pinna.Stage.make(realm);
    Pinna.Stage.update(replacement, (read, write) => {
      const kept = read.row(rows, 2);
      if (kept === undefined) throw new Error("the second row is missing");
      write.replaceAll(rows, [kept, { id: 3, value: 3 }]);
    });
    Pinna.Stage.apply(replacement);
    expect(firstValues.values).toEqual([{ id: 1, value: 10 }, undefined]);
    expect(secondValues.values).toEqual([]);
    expect(addedValues.values).toEqual([{ id: 3, value: 3 }]);
    Pinna.Realm.update(realm, (_read, write) => write.upsert(rows, { id: 1, value: 100 }));
    expect(firstValues.values).toEqual([{ id: 1, value: 10 }, undefined, { id: 1, value: 100 }]);
  });

  for (const verb of ["upsert", "remove", "replaceAll"] as const) {
    test(`${verb} landing rolls back with an enclosing update, including cells made after landing`, () => {
      using realm = testRealm();
      const rows = Pinna.Collection.make(realm, {
        keyOf: (row: { id: number; value: number }) => row.id,
      });
      const value = Pinna.Box.make(realm, 0);
      Pinna.Realm.update(realm, (_read, write) =>
        write.replaceAll(rows, [
          { id: 1, value: 1 },
          { id: 2, value: 2 },
        ]),
      );
      const first = rows.row(1);
      using values = record(realm, (read) =>
        JSON.stringify([read(value), read(rows.rows), read(first)]),
      );
      let added: Pinna.Computed<{ id: number; value: number } | undefined> | undefined;
      const stage = Pinna.Stage.make(realm);
      Pinna.Stage.update(stage, (_read, write) => {
        write(value, 1);
        if (verb === "upsert") {
          write.upsert(rows, { id: 1, value: 10 });
          write.upsert(rows, { id: 3, value: 3 });
        }
        if (verb === "remove") write.remove(rows, 1);
        if (verb === "replaceAll")
          write.replaceAll(rows, [
            { id: 2, value: 20 },
            { id: 3, value: 3 },
          ]);
      });
      expect(() =>
        Pinna.Realm.update(realm, (read) => {
          Pinna.Stage.apply(stage);
          added = rows.row(3);
          read(added);
          read(rows.rows);
          throw new Error("outer refused");
        }),
      ).toThrow("outer refused");
      const inserted = added;
      if (inserted === undefined) throw new Error("the added row was not read");
      expect(
        Pinna.Realm.untracked(realm, (read) => [
          read(value),
          read(rows.keys),
          read(rows.rows),
          read(first),
          read(inserted),
        ]),
      ).toEqual([
        0,
        [1, 2],
        [
          { id: 1, value: 1 },
          { id: 2, value: 2 },
        ],
        { id: 1, value: 1 },
        undefined,
      ]);
      expect(values.values).toEqual([]);
      Pinna.Realm.update(realm, (_read, write) => write.upsert(rows, { id: 3, value: 30 }));
      expect(Pinna.Realm.untracked(realm, (read) => read(inserted))).toEqual({ id: 3, value: 30 });
    });
  }

  test("landing restores an enclosing update's original box version", () => {
    using realm = testRealm();
    const value = Pinna.Box.make(
      realm,
      { count: 0 },
      { equals: (left, right) => left.count === right.count },
    );
    const original = Pinna.Realm.untracked(realm, (read) => read(value));
    const version = (value as BoxCell<{ count: number }>).source.version;
    const conflict = Pinna.Stage.make(realm, { conflicts: "fail" });
    Pinna.Stage.read(conflict, (read) => read(value));
    using values = record(realm, (read) => read(value));
    const stage = Pinna.Stage.make(realm);
    Pinna.Stage.update(stage, (_read, write) => write(value, { count: 0 }));
    Pinna.Realm.update(realm, (_read, write) => {
      write(value, { count: 1 });
      Pinna.Stage.apply(stage);
    });
    expect((value as BoxCell<{ count: number }>).source.version).toBe(version);
    expect(Pinna.Realm.untracked(realm, (read) => read(value))).toBe(original);
    expect(values.values).toEqual([]);
    Pinna.Stage.apply(conflict);
  });

  test("a caught listener failure discards its atom mark before landing", () => {
    using realm = testRealm();
    const atom = Pinna.Atom.make(realm);
    const rows = Pinna.Collection.make(realm, { keyOf: (value: number) => value });
    let runs = 0;
    using _observer = held(
      Pinna.Realm.autorun(realm, (read) => {
        read(atom);
        runs++;
      }),
    );
    using _listener = held(
      Pinna.Collection.onRowChange(rows, (_change, _read, write) => {
        write.changed(atom);
        throw new Error("refused");
      }),
    );
    const stage = Pinna.Stage.make(realm);
    Pinna.Stage.update(stage, (_read, write) => {
      expect(() => write.upsert(rows, 1)).toThrow("refused");
    });
    Pinna.Stage.apply(stage);
    expect(runs).toBe(1);
    expect(Pinna.Realm.untracked(realm, (read) => read(rows.rows))).toEqual([]);
  });

  test("precondition failures leave a stage open; closed inspection remains callable", () => {
    using realm = testRealm();
    const stage = Pinna.Stage.make(realm);
    const child = Pinna.Stage.make(stage);
    expect(() => Pinna.Stage.apply(stage)).toThrow("while a child stage of it is open");
    expect(Pinna.Stage.status(stage)).toBe("open");
    Pinna.Stage.drop(child);
    const computed = Pinna.Computed.make(realm, () => Pinna.Stage.apply(stage));
    expect(() => Pinna.Realm.untracked(realm, (read) => read(computed))).toThrow(
      "cannot run in a computed value",
    );
    expect(Pinna.Stage.status(stage)).toBe("open");
    const other = Pinna.Stage.make(realm);
    expect(() =>
      Pinna.Stage.update(other, () => {
        Pinna.Stage.apply(stage);
      }),
    ).toThrow("inside a stage recipe");
    expect(Pinna.Stage.status(stage)).toBe("open");
    Pinna.Stage.drop(other);
    Pinna.Stage.apply(stage);
    expect(Pinna.Stage.inspect(stage).status).toBe("applied");
    expect(Pinna.Stage.status(stage)).toBe("applied");
    Pinna.Stage.drop(stage);
    expect(() => Pinna.Stage.read(stage, () => undefined)).toThrow(Pinna.StageClosedError);
  });
});
