import { describe, expect, test } from "bun:test";
import { schemaBox } from "@frondruntime/pinna-effect";
import { Schema } from "effect";
import * as Pinna from "../src/index.ts";
import { type BoxCell, openParts } from "../src/internal/index.ts";
import { held, record, testRealm } from "../src/testing/index.ts";

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

describe("root replay guards", () => {
  for (const depth of [0, 1, 2]) {
    for (const name of forbidden) {
      test(`${name} on a replay-only branch through ${depth} computed values`, () => {
        const realm = Pinna.createRealm();
        const target = Pinna.box(realm, 0);
        const branch = Pinna.box(realm, false);
        const own = Pinna.box(realm, 0);
        const draft = Pinna.box(realm, { value: 0 });
        const atom = Pinna.atom(realm);
        const rows = Pinna.collection(realm, { keyOf: (value: number) => value });
        Pinna.update(realm, (_read, write) => write.upsert(rows, 1));
        let keptRead!: Pinna.Read;
        let keptWrite!: Pinna.Write;
        Pinna.update(realm, (read, write) => {
          keptRead = read;
          keptWrite = write;
        });
        let callbacks = 0;
        const called = (): undefined => {
          callbacks++;
        };
        class Item extends Pinna.Model {
          readonly value = called();
          readonly $value = Pinna.box(this.realm, 0);
        }
        class Plain extends Pinna.Model {
          readonly value = called();
        }
        const other = Pinna.openStage(realm);
        const stops: Array<() => void> = [];
        const calls: Record<(typeof forbidden)[number], () => unknown> = {
          update: () => Pinna.update(realm, called),
          untracked: () => Pinna.untracked(realm, called),
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
              Pinna.watch(
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
              Pinna.autorun(realm, (read) => {
                read(target);
                called();
              }),
            ),
          observe: () => stops.push(Pinna.observe(target)),
          onObserved: () => stops.push(Pinna.onObserved(target, called)),
          onRowChange: () => stops.push(Pinna.onRowChange(rows, called)),
          openStage: () => Pinna.dropStage(Pinna.openStage(other)),
          stageUpdate: () => Pinna.stageUpdate(other, called),
          stageRead: () => Pinna.stageRead(other, called),
          realmRead: () => Pinna.realmRead(other, called),
          applyStage: () => Pinna.applyStage(other),
          dropStage: () => Pinna.dropStage(other),
          box: () => Pinna.box(realm, 0),
          computed: () => Pinna.computed(realm, called),
          computedFunction: () => Pinna.computedFunction(realm, called),
          atom: () => Pinna.atom(realm),
          collection: () => Pinna.collection(realm, { keyOf: (value: number) => value }),
          "Model with box": () => new Item(realm),
          "Model plain": () => new Plain(realm),
          stageStatus: () => Pinna.stageStatus(other),
          inspectStage: () => Pinna.inspectStage(other),
        };
        let invoke = (_read: Pinna.Read): undefined => {
          calls[name]();
        };
        for (let level = 0; level < depth; level++) {
          const previous = invoke;
          const derived = Pinna.computed(realm, (read) => {
            previous(read);
            return 0;
          });
          invoke = (read) => {
            read(derived);
          };
        }
        const staged = Pinna.openStage(realm);
        const expected = message(() => Pinna.stageUpdate(staged, invoke));
        Pinna.dropStage(staged);
        const stage = Pinna.openStage(realm);
        Pinna.stageUpdate(stage, (read, write) => {
          write(target, 1);
          if (read(branch)) invoke(read);
        });
        let actual: string | undefined;
        Pinna.update(realm, (_read, write) => {
          write(branch, true);
          write(own, 7);
          actual = message(() => Pinna.applyStage(stage));
        });
        const observers = Pinna.inspect(target).observers;
        const callbacksAfterApply = callbacks;
        const targetAfterApply = Pinna.untracked(realm, (read) => read(target));
        Pinna.update(realm, (_read, write) => write(target, 2));
        const callbacksAfterUpdate = callbacks;
        for (const stop of stops) stop();
        Pinna.dropStage(other);
        expect(expected).toContain("stage recipe");
        expect(actual).toBe(expected);
        expect(Pinna.stageStatus(stage)).toBe("dropped");
        expect(targetAfterApply).toBe(0);
        expect(callbacksAfterApply).toBe(0);
        expect(callbacksAfterUpdate).toBe(0);
        expect(observers).toBe(0);
        expect(Pinna.untracked(realm, (read) => read(own))).toBe(7);
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
const cases: ReadonlyArray<readonly [string, (state: Fixture) => ReadonlyArray<Pinna.Recipe>]> = [
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
  for (const [name, recipesFor] of cases) {
    test(`${name}: ordinary updates and stage apply agree`, () => {
      const run = (staged: boolean) => {
        using realm = testRealm();
        const first = Pinna.box(realm, 1);
        const second = schemaBox(realm, Schema.Number, 2);
        const object = Pinna.box(realm, { count: 1 });
        const rows = Pinna.collection(realm, {
          keyOf: (row: { id: number; value: number }) => row.id,
        });
        const total = Pinna.box(realm, 0);
        const atom = Pinna.atom(realm);
        const derived = Pinna.computed(realm, (read) => read(first) * 2);
        Pinna.update(realm, (_read, write) =>
          write.replaceAll(rows, [
            { id: 1, value: 1 },
            { id: 2, value: 2 },
          ]),
        );
        const log: unknown[] = [];
        using _listener = held(
          Pinna.onRowChange(rows, (change, read, write) => {
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
          Pinna.autorun(realm, (read) => {
            read(atom);
            atomRuns++;
          }),
        );
        const conflict = Pinna.openStage(realm, { conflicts: "fail" });
        Pinna.stageRead(conflict, snapshot);
        const recipes = recipesFor({ first, second, object, rows, total, atom, derived });
        log.length = 0;
        if (staged) {
          const stage = Pinna.openStage(realm);
          for (const recipe of recipes) Pinna.stageUpdate(stage, recipe);
          const stagedLog = [...log];
          log.length = 0;
          Pinna.applyStage(stage);
          expect(log).toEqual(stagedLog);
        } else {
          // One settling boundary, with one ordinary update per recipe, as applyStage promises.
          Pinna.update(realm, () => {
            for (const recipe of recipes) Pinna.update(realm, recipe);
          });
        }
        const outcome = message(() => Pinna.applyStage(conflict));
        return {
          state: Pinna.untracked(realm, snapshot),
          watchers: values.values,
          atomRuns,
          log,
          conflicted: outcome !== undefined,
          status: Pinna.stageStatus(conflict),
        };
      };
      expect(run(true)).toEqual(run(false));
    });
  }

  test("rebase lands both boxes once, using the current realm value", () => {
    using realm = testRealm();
    const first = Pinna.box(realm, 1);
    const second = Pinna.box(realm, 0);
    const stage = Pinna.openStage(realm);
    Pinna.stageUpdate(stage, (read, write) => write(first, read(first) + 2));
    Pinna.stageUpdate(stage, (read, write) => write(second, read(first) * 2));
    Pinna.update(realm, (_read, write) => write(first, 5));
    using values = record(realm, (read) => [read(first), read(second)]);
    Pinna.applyStage(stage);
    expect(values.values).toEqual([[7, 14]]);
  });

  for (const kind of ["box", "row"] as const) {
    test(`${kind} written back lands no version change or watcher run`, () => {
      using realm = testRealm();
      const value = Pinna.box(realm, 0);
      const rows = Pinna.collection(realm, { keyOf: (row: number) => row });
      const conflict = Pinna.openStage(realm, { conflicts: "fail" });
      Pinna.stageRead(conflict, (read) => [read(value), read(rows.rows)]);
      using values = record(realm, (read) => [read(value), read(rows.rows)]);
      const version = (value as BoxCell<number>).source.version;
      const stage = Pinna.openStage(realm);
      Pinna.stageUpdate(stage, (_read, write) => {
        if (kind === "box") {
          write(value, 1);
          write(value, 0);
        } else {
          write.upsert(rows, 1);
          write.remove(rows, 1);
        }
      });
      Pinna.applyStage(stage);
      expect(message(() => Pinna.applyStage(conflict))).toBeUndefined();
      expect((value as BoxCell<number>).source.version).toBe(version);
      expect(values.values).toEqual([]);
    });
  }

  test("ordinary update restores a box version but advances collection change tracking after add/remove", () => {
    using realm = testRealm();
    const value = Pinna.box(realm, 0);
    const rows = Pinna.collection(realm, { keyOf: (row: number) => row });
    const boxStage = Pinna.openStage(realm, { conflicts: "fail" });
    const rowStage = Pinna.openStage(realm, { conflicts: "fail" });
    Pinna.stageRead(boxStage, (read) => read(value));
    Pinna.stageRead(rowStage, (read) => read(rows.rows));
    using values = record(realm, (read) => read(rows.rows));
    Pinna.update(realm, (_read, write) => {
      write(value, 1);
      write(value, 0);
      write.upsert(rows, 1);
      write.remove(rows, 1);
    });
    expect(message(() => Pinna.applyStage(boxStage))).toBeUndefined();
    expect(() => Pinna.applyStage(rowStage)).toThrow(Pinna.StageConflictError);
    expect(values.values).toEqual([]);
  });

  test("settling watch and autorun errors go to onError and leave the stage applied", () => {
    const errors: unknown[] = [];
    const realm = Pinna.createRealm({
      onError: (error) => {
        errors.push(error);
      },
    });
    const value = Pinna.box(realm, 0);
    const failure = new Error("settle failed");
    const stopWatch = Pinna.watch(
      realm,
      (read) => read(value),
      () => {
        throw failure;
      },
    );
    const stopAutorun = Pinna.autorun(realm, (read) => {
      if (read(value) > 0) throw failure;
    });
    const stage = Pinna.openStage(realm);
    Pinna.stageUpdate(stage, (_read, write) => write(value, 1));
    Pinna.applyStage(stage);
    expect(errors).toEqual([failure, failure]);
    expect(Pinna.stageStatus(stage)).toBe("applied");
    stopWatch();
    stopAutorun();
  });
});

describe("callbacks during root replay", () => {
  for (const site of ["box equality", "row equality", "row key", "listener"] as const) {
    test(`${site} holds the replay guard`, () => {
      const realm = Pinna.createRealm();
      let replay = false;
      let callbacks = 0;
      const guarded = () => {
        if (replay)
          Pinna.update(realm, () => {
            callbacks++;
          });
      };
      const value = Pinna.box(realm, 0, {
        equals: (left, right) => {
          if (site === "box equality") guarded();
          return left === right;
        },
      });
      const rows = Pinna.collection(realm, {
        keyOf: (row: { id: number; value: number }) => {
          if (site === "row key") guarded();
          return row.id;
        },
        equals: (left, right) => {
          if (site === "row equality") guarded();
          return left.value === right.value;
        },
      });
      Pinna.update(realm, (_read, write) => write.upsert(rows, { id: 1, value: 0 }));
      const stop = Pinna.onRowChange(rows, () => {
        if (site === "listener") guarded();
      });
      const stage = Pinna.openStage(realm);
      Pinna.stageUpdate(stage, (_read, write) => {
        write(value, 1);
        write.upsert(rows, { id: 1, value: 1 });
      });
      replay = true;
      const error = message(() => Pinna.applyStage(stage));
      stop();
      expect(error).toContain("stage recipe writes the realm");
      expect(callbacks).toBe(0);
      expect(Pinna.stageStatus(stage)).toBe("dropped");
      expect(Pinna.untracked(realm, (read) => [read(value), read(rows.rows)])).toEqual([
        0,
        [{ id: 1, value: 0 }],
      ]);
    });
  }
});

describe("landing invariants", () => {
  test("row readers track only their own changes, including removal and later reinsertion", () => {
    using realm = testRealm();
    const rows = Pinna.collection(realm, { keyOf: (row: { id: number; value: number }) => row.id });
    Pinna.update(realm, (_read, write) =>
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
    const stage = Pinna.openStage(realm);
    Pinna.stageUpdate(stage, (_read, write) => write.upsert(rows, { id: 1, value: 10 }));
    Pinna.applyStage(stage);
    expect(firstValues.values).toEqual([{ id: 1, value: 10 }]);
    expect(secondValues.values).toEqual([]);
    expect(addedValues.values).toEqual([]);
    expect(keys.values).toEqual([]);
    const replacement = Pinna.openStage(realm);
    Pinna.stageUpdate(replacement, (read, write) => {
      const kept = read.row(rows, 2);
      if (kept === undefined) throw new Error("the second row is missing");
      write.replaceAll(rows, [kept, { id: 3, value: 3 }]);
    });
    Pinna.applyStage(replacement);
    expect(firstValues.values).toEqual([{ id: 1, value: 10 }, undefined]);
    expect(secondValues.values).toEqual([]);
    expect(addedValues.values).toEqual([{ id: 3, value: 3 }]);
    Pinna.update(realm, (_read, write) => write.upsert(rows, { id: 1, value: 100 }));
    expect(firstValues.values).toEqual([{ id: 1, value: 10 }, undefined, { id: 1, value: 100 }]);
  });

  for (const verb of ["upsert", "remove", "replaceAll"] as const) {
    test(`${verb} landing rolls back with an enclosing update, including cells made after landing`, () => {
      using realm = testRealm();
      const rows = Pinna.collection(realm, {
        keyOf: (row: { id: number; value: number }) => row.id,
      });
      const value = Pinna.box(realm, 0);
      Pinna.update(realm, (_read, write) =>
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
      const stage = Pinna.openStage(realm);
      Pinna.stageUpdate(stage, (_read, write) => {
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
        Pinna.update(realm, (read) => {
          Pinna.applyStage(stage);
          added = rows.row(3);
          read(added);
          read(rows.rows);
          throw new Error("outer refused");
        }),
      ).toThrow("outer refused");
      const inserted = added;
      if (inserted === undefined) throw new Error("the added row was not read");
      expect(
        Pinna.untracked(realm, (read) => [
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
      Pinna.update(realm, (_read, write) => write.upsert(rows, { id: 3, value: 30 }));
      expect(Pinna.untracked(realm, (read) => read(inserted))).toEqual({ id: 3, value: 30 });
    });
  }

  test("landing restores an enclosing update's original box version", () => {
    using realm = testRealm();
    const value = Pinna.box(
      realm,
      { count: 0 },
      { equals: (left, right) => left.count === right.count },
    );
    const original = Pinna.untracked(realm, (read) => read(value));
    const version = (value as BoxCell<{ count: number }>).source.version;
    const conflict = Pinna.openStage(realm, { conflicts: "fail" });
    Pinna.stageRead(conflict, (read) => read(value));
    using values = record(realm, (read) => read(value));
    const stage = Pinna.openStage(realm);
    Pinna.stageUpdate(stage, (_read, write) => write(value, { count: 0 }));
    Pinna.update(realm, (_read, write) => {
      write(value, { count: 1 });
      Pinna.applyStage(stage);
    });
    expect((value as BoxCell<{ count: number }>).source.version).toBe(version);
    expect(Pinna.untracked(realm, (read) => read(value))).toBe(original);
    expect(values.values).toEqual([]);
    Pinna.applyStage(conflict);
  });

  test("a caught listener failure discards its atom mark before landing", () => {
    using realm = testRealm();
    const atom = Pinna.atom(realm);
    const rows = Pinna.collection(realm, { keyOf: (value: number) => value });
    let runs = 0;
    using _observer = held(
      Pinna.autorun(realm, (read) => {
        read(atom);
        runs++;
      }),
    );
    using _listener = held(
      Pinna.onRowChange(rows, (_change, _read, write) => {
        write.changed(atom);
        throw new Error("refused");
      }),
    );
    const stage = Pinna.openStage(realm);
    Pinna.stageUpdate(stage, (_read, write) => {
      expect(() => write.upsert(rows, 1)).toThrow("refused");
    });
    Pinna.applyStage(stage);
    expect(runs).toBe(1);
    expect(Pinna.untracked(realm, (read) => read(rows.rows))).toEqual([]);
  });

  test("precondition failures leave a stage open; closed inspection remains callable", () => {
    using realm = testRealm();
    const stage = Pinna.openStage(realm);
    const child = Pinna.openStage(stage);
    expect(() => Pinna.applyStage(stage)).toThrow("while a child stage of it is open");
    expect(Pinna.stageStatus(stage)).toBe("open");
    Pinna.dropStage(child);
    const computed = Pinna.computed(realm, () => Pinna.applyStage(stage));
    expect(() => Pinna.untracked(realm, (read) => read(computed))).toThrow(
      "cannot run in a computed value",
    );
    expect(Pinna.stageStatus(stage)).toBe("open");
    const other = Pinna.openStage(realm);
    expect(() =>
      Pinna.stageUpdate(other, () => {
        Pinna.applyStage(stage);
      }),
    ).toThrow("inside a stage recipe");
    expect(Pinna.stageStatus(stage)).toBe("open");
    Pinna.dropStage(other);
    Pinna.applyStage(stage);
    expect(Pinna.inspectStage(stage).status).toBe("applied");
    expect(Pinna.stageStatus(stage)).toBe("applied");
    Pinna.dropStage(stage);
    expect(() => Pinna.stageRead(stage, () => undefined)).toThrow(Pinna.StageClosedError);
  });
});
