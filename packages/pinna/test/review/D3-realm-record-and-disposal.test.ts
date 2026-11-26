import { expect, test } from "bun:test";
import { Box, Collection, Realm, Source, type UpdateRecord } from "../../src/index.ts";

test("undo and replay keep an index maintained by a row listener", () => {
  const realm = Realm.make();
  const rows = Collection.make(realm, { keyOf: (row: string) => row });
  const count = Box.make(realm, 0);
  Collection.onRowChange(rows, (change, read, write) =>
    write(
      count,
      read(count) + Number(change.after !== undefined) - Number(change.before !== undefined),
    ),
  );
  const records: UpdateRecord[] = [];
  const stop = Realm.onUpdate(realm, (record) => {
    records.push(record);
  });
  Realm.update(realm, (_read, write) => write.upsert(rows, "one"));
  stop();
  const [record] = records;
  if (!record) throw new Error("missing record");
  expect(Source.peek(count)).toBe(1);
  Realm.update(realm, (_read, write) => write.revert(record));
  const undone = [Source.peek(rows.keys).length, Source.peek(count)];
  Realm.update(realm, (_read, write) => write.replay(record));
  const redone = [Source.peek(rows.keys).length, Source.peek(count)];
  expect([undone, redone]).toEqual([
    [0, 0],
    [1, 1],
  ]);
});

test("a deferred watch effect refuses disposal and leaves the realm open", () => {
  const errors: unknown[] = [];
  const realm = Realm.make({
    onError: (error) => {
      errors.push(error);
    },
  });
  const value = Box.make(realm, 0);
  const frame: Array<() => void> = [];
  Realm.watch(
    realm,
    (read) => read(value),
    () => {
      Realm.dispose(realm);
    },
    {
      scheduler: (run) => {
        frame.push(run);
      },
    },
  );
  Realm.update(realm, (_read, write) => write(value, 1));
  const run = frame.shift();
  if (!run) throw new Error("missing schedule");
  run();
  expect({ status: Realm.status(realm), errors }).toMatchObject({
    status: "open",
    errors: [{ code: "pinna/dispose-not-at-rest" }],
  });
});
