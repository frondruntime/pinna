import { expect, test } from "bun:test";
import { Box, Collection, Realm, Stage } from "../../src/index.ts";

test("failed replacements release their rows while their stage remains open", async () => {
  using realm = Realm.make();
  const rows = Collection.make<number, { id: number }>(realm, { keyOf: (row) => row.id });
  const stage = Stage.make(realm);
  const makeReferences = () => {
    const control = { id: -1 };
    const weak = Array.from({ length: 4 }, (_, id) => {
      const row = { id };
      const ref = new WeakRef(row);
      try {
        Stage.update(stage, (_read, write) => {
          write.replaceAll(rows, [row]);
          throw Error("aborted");
        });
      } catch {}
      return ref;
    });
    return { weak, control: new WeakRef(control) };
  };
  const { weak, control } = makeReferences();
  expect(Stage.inspect(stage).recipes).toBe(0);
  await Bun.sleep(0);
  Bun.gc(true);
  expect(control.deref()).toBeUndefined();
  const live = weak.filter((ref) => ref.deref() !== undefined).length;
  Stage.drop(stage);
  await Bun.sleep(0);
  Bun.gc(true);
  expect(weak.filter((ref) => ref.deref() !== undefined).length).toBe(0);
  expect(live).toBe(0);
});

test("a write by the replay error handler reaches an already checked lower guess", () => {
  let report = () => {};
  using realm = Realm.make({ onError: () => report() });
  const input = Box.make(realm, 0);
  const shown = Box.make(realm, 0);
  const fail = Box.make(realm, false);
  report = () => Realm.update(realm, (_read, write) => write(input, 9));
  const lower = Stage.make(realm, { visible: true });
  Stage.update(lower, (read, write) => write(shown, read(input) + 1));
  const upper = Stage.make(realm, { visible: true });
  Stage.update(upper, (read) => {
    if (read(fail)) throw Error("cancel");
  });
  Realm.update(realm, (_read, write) => write(fail, true));
  expect(Realm.untracked(realm, (read) => [read(input), read(shown)])).toEqual([9, 10]);
});

test("an error handler can drop a stopped stage while another stage remains above it", () => {
  let retire = () => {};
  using realm = Realm.make({ onError: () => retire() });
  const ready = Box.make(realm, true);
  const lower = Stage.make(realm, { visible: true });
  Stage.update(lower, (read) => {
    if (!read(ready)) throw Error("cancel");
  });
  const upper = Stage.make(realm, { visible: true });
  retire = () => Stage.drop(lower);
  expect(() => Realm.update(realm, (_read, write) => write(ready, false))).not.toThrow();
  expect(Stage.status(upper)).toBe("open");
  expect(Realm.untracked(realm, (read) => read(ready))).toBe(false);
});

test("three patches preserve first-write rows across replacements, removal and re-add", () => {
  using realm = Realm.make();
  const rows = Collection.make<string, { id: string; value: number }>(realm, {
    keyOf: (row) => row.id,
  });
  const root = Stage.make(realm);
  const child = Stage.make(root);
  const leaf = Stage.make(child);
  Realm.update(realm, (_read, write) => write.replaceAll(rows, [{ id: "b", value: 1 }]));
  for (const [i, stage] of [root, child, leaf].entries()) {
    Stage.update(stage, (_read, write) =>
      write.upsert(rows, { id: String(i), value: i }, { at: "end" }),
    );
  }
  Realm.update(realm, (_read, write) => write.replaceAll(rows, [{ id: "z", value: 2 }]));
  Stage.update(root, (_read, write) => {
    write.remove(rows, "b");
    write.upsert(rows, { id: "b", value: 3 });
  });
  Stage.update(child, (_read, write) => write.replaceAll(rows, [{ id: "q", value: 4 }]));
  expect(Stage.read(leaf, (read) => [read(rows.keys), read.row(rows, "b")?.value])).toEqual([
    ["b", "0", "1", "2"],
    1,
  ]);
  Stage.drop(root);
  expect(Realm.untracked(realm, (read) => read(rows.keys))).toEqual(["z"]);
});
