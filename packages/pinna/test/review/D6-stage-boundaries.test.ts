import { expect, test } from "bun:test";
import { Atom, Box, Collection, Realm, Stage, StageConflictError } from "../../src/index.ts";

test("adding and removing a NaN key leaves no row or key in the realm", () => {
  using realm = Realm.make();
  const rows = Collection.make<number, number>(realm, { keyOf: (value) => value });
  const stage = Stage.make(realm);
  Stage.update(stage, (_read, write) => {
    write.upsert(rows, Number.NaN);
    write.remove(rows, Number.NaN);
  });
  Stage.apply(stage);
  expect(Realm.untracked(realm, (read) => [read(rows.keys), read(rows.rows)])).toEqual([[], []]);
});

test("a fail-stage replay records newly read and written base boxes", () => {
  using realm = Realm.make();
  const route = Box.make(realm, false);
  const value = Box.make(realm, 3, { name: "answer" });
  const lower = Stage.make(realm, { visible: true });
  const upper = Stage.make(realm, { visible: true, conflicts: "fail" });
  Stage.update(upper, (read, write) => {
    if (read(route)) write(value, 4);
  });
  Stage.update(lower, (_read, write) => write(route, true));
  expect(Realm.untracked(realm, (read) => read(value))).toBe(4);
  Realm.update(realm, (_read, write) => write(value, 7));
  expect(Stage.inspect(upper).showing).toBe(false);
  expect(Stage.inspect(upper).failure).toBeInstanceOf(StageConflictError);
});

test("a visible atom mark conflicts at confirmation and not before", () => {
  using realm = Realm.make();
  const atom = Atom.make(realm);
  const result = Box.make(realm, 0);
  const visible = Stage.make(realm, { visible: true });
  Stage.update(visible, (_read, write) => write.changed(atom));
  const hidden = Stage.make(realm, { conflicts: "fail" });
  Stage.update(hidden, (read, write) => {
    read(atom);
    write(result, 1);
  });
  Stage.apply(visible);
  expect(() => Stage.apply(hidden)).toThrow(StageConflictError);
});

test("dropping an unconfirmed atom mark cannot conflict with a hidden stage", () => {
  using realm = Realm.make();
  const atom = Atom.make(realm);
  const hidden = Stage.make(realm, { conflicts: "fail" });
  Stage.read(hidden, (read) => read(atom));
  const visible = Stage.make(realm, { visible: true });
  Stage.update(visible, (_read, write) => write.changed(atom));
  Stage.drop(visible);
  expect(() => Stage.apply(hidden)).not.toThrow();
});

test("a failed visible apply marks the withdrawal of an atom guess", () => {
  using realm = Realm.make();
  const allowed = Box.make(realm, false);
  const atom = Atom.make(realm);
  const lower = Stage.make(realm, { visible: true });
  Stage.update(lower, (_read, write) => write(allowed, true));
  const upper = Stage.make(realm, { visible: true });
  let runs = 0;
  const stop = Realm.autorun(realm, (read) => {
    read(atom);
    runs++;
  });
  Stage.update(upper, (read, write) => {
    if (!read(allowed)) throw Error("must be allowed");
    write.changed(atom);
  });
  expect(runs).toBe(2);
  expect(() => Stage.apply(upper)).toThrow("must be allowed");
  expect(Stage.status(upper)).toBe("dropped");
  expect(runs).toBe(3);
  stop();
});

test("confirming a bottom stage preserves a box's equal shown value", () => {
  using realm = Realm.make();
  const amount = Box.make(
    realm,
    { amount: 0 },
    { equals: (left, right) => left.amount === right.amount },
  );
  let runs = 0;
  const stop = Realm.autorun(realm, (read) => {
    read(amount);
    runs++;
  });
  const visible = Stage.make(realm, { visible: true });
  Stage.update(visible, (_read, write) =>
    write.modify(amount, (draft) => {
      draft.amount++;
    }),
  );
  const shown = Realm.untracked(realm, (read) => read(amount));
  expect(runs).toBe(2);
  Stage.apply(visible);
  expect({ same: Realm.untracked(realm, (read) => read(amount)) === shown, runs }).toEqual({
    same: true,
    runs: 2,
  });
  stop();
});
