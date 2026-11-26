import { expect, test } from "bun:test";
import { Box, Computed, Realm } from "../../src/index.ts";

// D2-1, closed by a named limit (0.2.0 review, slice 0): a chain rebuilt past
// depth 256 inside its own computed root throws pinna/depth-rebuilt after 64
// restarts in one read and leaves the realm usable, instead of retrying
// without end.
test("a finite, acyclic chain rebuilt inside a computed read throws pinna/depth-rebuilt and leaves the realm usable", () => {
  const realm = Realm.make();
  const length = Box.make(realm, 260);
  let rootAttempts = 0;
  const total = Computed.make(realm, (read) => {
    // A watchdog only, above the 64 restarts the driver allows.
    if (++rootAttempts > 70) throw new Error("same root restarted 70 times");
    let step = Computed.make(realm, () => 0);
    const count = read(length);
    for (let index = 0; index < count; index++) {
      const below = step;
      step = Computed.make(realm, (readStep) => readStep(below) + 1);
    }
    return read(step);
  });
  let caught: unknown;
  try {
    Realm.untracked(realm, (read) => read(total));
  } catch (error) {
    caught = error;
  }
  expect((caught as { code?: string } | undefined)?.code).toBe("pinna/depth-rebuilt");
  Realm.update(realm, (_, write) => {
    write(length, 3);
  });
  rootAttempts = 0;
  expect(Realm.untracked(realm, (read) => read(total))).toBe(3);
});

// Review of the depth budget: a root that makes and keeps
// a deep branch per run finishes in branches + 1 runs, within the 64
// restarts the driver allows in one read.
const keptBranches = (branches: number): void => {
  const realm = Realm.make();
  const chain = (length: number): Computed<number> => {
    let step = Computed.make(realm, () => 0);
    for (let index = 0; index < length; index++) {
      const below = step;
      step = Computed.make(realm, (read) => read(below) + 1);
    }
    return step;
  };
  const kept: Array<Computed<number> | undefined> = [];
  let rootAttempts = 0;
  const root = Computed.make(realm, (read) => {
    // A watchdog only.
    if (++rootAttempts > 70) throw new Error("same root restarted 70 times");
    let sum = 0;
    for (let index = 0; index < branches; index++) {
      kept[index] ??= chain(300);
      sum += read(kept[index] as Computed<number>);
    }
    return sum;
  });
  expect(Realm.untracked(realm, (read) => read(root))).toBe(300 * branches);
  expect(rootAttempts).toBe(branches + 1);
};

test("a root that makes and keeps two deep branches, one per run, finishes", () => {
  keptBranches(2);
});

test("a root that makes and keeps ten deep branches, one per run, finishes", () => {
  keptBranches(10);
});
