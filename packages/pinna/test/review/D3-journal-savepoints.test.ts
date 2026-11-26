import { expect, test } from "bun:test";
import { Box, Collection, Realm, Stage, type UpdateRecord } from "../../src/index.ts";

test("long inner saves, caught failures and a landed stage roll back to the outer start", () => {
  const realm = Realm.make();
  const box = Box.make(realm, "start");
  const rows = Collection.make(realm, { keyOf: (value: number) => value });
  const original = [0, 1, 2];
  Realm.update(realm, (_read, write) => write.replaceAll(rows, original));
  const observations: string[] = [];
  const stopWatching = Realm.autorun(realm, (read) => {
    observations.push(`${read(box)}:${read(rows.keys).join(",")}`);
  });
  const records: UpdateRecord[] = [];
  const stopRecording = Realm.onUpdate(realm, (entry) => {
    records.push(entry);
  });
  const stage = Stage.make(realm, { name: "large landing" });
  const staged = Array.from({ length: 96 }, (_, i) => 100 + i);
  Stage.update(stage, (_read, write) => {
    for (const row of staged) write.upsert(rows, row, { at: "end" });
    write(box, "staged");
  });
  expect(() =>
    Realm.update(realm, (read, write) => {
      write(box, "outer");
      write.remove(rows, 0);
      expect(() =>
        Realm.update(realm, (_innerRead, innerWrite) => {
          for (let row = 5; row <= 100; row++) innerWrite.upsert(rows, row);
          innerWrite(box, "inner");
          throw new Error("inner failure");
        }),
      ).toThrow("inner failure");
      expect([read(box), read(rows.keys)]).toEqual(["outer", [1, 2]]);
      Stage.apply(stage);
      expect([read(box), read(rows.keys)]).toEqual(["staged", [1, 2, ...staged]]);
      throw new Error("outer failure");
    }),
  ).toThrow("outer failure");
  expect(Realm.untracked(realm, (read) => [read(box), read(rows.rows)])).toEqual([
    "start",
    original,
  ]);
  expect([observations, records, Stage.status(stage)]).toEqual([["start:0,1,2"], [], "dropped"]);
  Realm.update(realm, (_read, write) => write(box, "next"));
  expect(records[0]?.boxes.map((change) => [change.before, change.after])).toEqual([
    ["start", "next"],
  ]);
  expect(observations).toEqual(["start:0,1,2", "next:0,1,2"]);
  stopRecording();
  stopWatching();
  Realm.dispose(realm);
});
