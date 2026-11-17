/// <reference types="bun" />
// The site's docs print the regions of this file (docs/public/guides/testing.md), so
// `bun run typecheck` compiles what the page shows. The core samples are `testing.test.ts`.
import { expect, test } from "bun:test";
import { record, testRealm } from "@frondruntime/pinna/testing";
import {
  box,
  changes,
  decode,
  fromStream,
  observeScoped,
  RealmService,
  schemaBox,
  untracked,
  update,
  watchScoped,
} from "@frondruntime/pinna-effect";
import { Deferred, Effect, Schedule, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { TodoList } from "./models.ts";

const items = [
  { id: "1", title: "Write the docs", done: false },
  { id: "2", title: "Read them", done: true },
];

// #region model
test("toggling a todo closes it", () => {
  // A realm per test: nothing one test made is seen by the next.
  using realm = testRealm();
  const list = decode(realm, TodoList)({ items });

  const first = untracked(realm, (read) => read(list.$items.row("1")));
  first?.toggle();

  expect(untracked(realm, (read) => read(list.$open))).toBe(0);
});
// #endregion

// #region watch
test("removing a todo reruns the open count once", () => {
  using realm = testRealm();
  const list = decode(realm, TodoList)({ items });
  using open = record(realm, (read) => read(list.$open));

  list.remove("1");
  list.remove("2");

  expect(open.values).toEqual([0]);
});
// #endregion

// #region rollback
test("a rejected write leaves the realm as it was", () => {
  using realm = testRealm();
  const $count = schemaBox(realm, Schema.Int, 1);

  expect(() =>
    update(realm, (_read, write) => {
      write($count, 2);
      write($count, 2.5);
    }),
  ).toThrow("pinna: the box rejects this value");
  expect(untracked(realm, (read) => read($count))).toBe(1);
});
// #endregion

// #region program
test("a program reads the test's realm", async () => {
  using realm = testRealm();
  const $query = schemaBox(realm, Schema.String, "");

  const program = Effect.gen(function* () {
    const searched = yield* Deferred.make<string>();
    yield* watchScoped(
      (read) => read($query),
      (query) => Deferred.succeed(searched, query),
    );
    update(realm, (_read, write) => write($query, "pinna"));
    return yield* Deferred.await(searched);
  });

  const query = await Effect.runPromise(
    program.pipe(Effect.scoped, Effect.provideService(RealmService, realm)),
  );
  expect(query).toBe("pinna");
});
// #endregion

// #region clock
test("a poll advances with the test clock", async () => {
  using realm = testRealm();
  let polls = 0;
  const poll = Effect.sync(() => ++polls);

  const latest = await Effect.gen(function* () {
    // Made under TestClock: fromStream keeps the clock of the program that
    // makes the value, and the poll waits on it.
    const $polls = yield* fromStream(
      Stream.fromEffectSchedule(poll, Schedule.spaced("1 minute")),
      0,
    );
    // The poll runs only while something observes the value.
    yield* observeScoped($polls);
    yield* TestClock.adjust("2 minutes");
    return untracked(realm, (read) => read($polls));
  }).pipe(
    Effect.scoped,
    Effect.provideService(RealmService, realm),
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );

  expect(latest).toBe(3);
});
// #endregion

// #region barrier
test("a test waits on what the program publishes, not on the clock", async () => {
  using realm = testRealm();
  const $loadedRows = box(realm, 0);
  const $loaded = box(realm, false);
  // Yields between rows; no sleep holds it, so the clock has nothing to wait for.
  const load = Effect.gen(function* () {
    for (let row = 1; row <= 100; row++) {
      yield* Effect.yieldNow;
      update(realm, (_read, write) => write($loadedRows, row));
    }
    update(realm, (_read, write) => write($loaded, true));
  });

  const loaded = await Effect.gen(function* () {
    yield* Effect.forkScoped(load);
    yield* changes($loaded).pipe(
      Stream.filter((done) => done),
      Stream.runHead,
    );
    return untracked(realm, (read) => read($loadedRows));
  }).pipe(
    Effect.scoped,
    Effect.provideService(RealmService, realm),
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );

  expect(loaded).toBe(100);
});
// #endregion

// #region awaited
// `async` and `return await`: the realm is disposed after the program's scope
// closes. A helper that returns the promise without awaiting it disposes the
// realm while the program's watch still runs.
const searchOnce = async (query: string): Promise<string> => {
  using realm = testRealm();
  const $query = schemaBox(realm, Schema.String, "");
  return await Effect.gen(function* () {
    const searched = yield* Deferred.make<string>();
    yield* watchScoped(
      (read) => read($query),
      (value) => Deferred.succeed(searched, value),
    );
    update(realm, (_read, write) => write($query, query));
    return yield* Deferred.await(searched);
  }).pipe(Effect.scoped, Effect.provideService(RealmService, realm), Effect.runPromise);
};

test("a helper awaits its program before its realm is disposed", async () => {
  expect(await searchOnce("pinna")).toBe("pinna");
});
// #endregion

// Back the page's claims about the samples above, outside any region.
test("TestClock.adjust returns before work that no sleep holds is done", async () => {
  using realm = testRealm();
  const $loadedRows = box(realm, 0);
  const load = Effect.gen(function* () {
    for (let row = 1; row <= 100; row++) {
      yield* Effect.yieldNow;
      update(realm, (_read, write) => write($loadedRows, row));
    }
  });
  const afterAdjust = await Effect.gen(function* () {
    yield* Effect.forkScoped(load);
    yield* TestClock.adjust(0);
    return untracked(realm, (read) => read($loadedRows));
  }).pipe(
    Effect.scoped,
    Effect.provideService(RealmService, realm),
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
  expect(afterAdjust).toBeLessThan(100);
});

test("a value made before TestClock is provided polls on the live clock", async () => {
  using realm = testRealm();
  let polls = 0;
  const poll = Effect.sync(() => ++polls);
  const latest = await Effect.gen(function* () {
    const $polls = yield* fromStream(
      Stream.fromEffectSchedule(poll, Schedule.spaced("1 minute")),
      0,
    );
    // TestClock reaches the observation, not the value's stream.
    return yield* Effect.gen(function* () {
      yield* observeScoped($polls);
      yield* TestClock.adjust("2 minutes");
      return untracked(realm, (read) => read($polls));
    }).pipe(Effect.provide(TestClock.layer()));
  }).pipe(Effect.scoped, Effect.provideService(RealmService, realm), Effect.runPromise);
  expect(latest).toBeLessThan(3);
});

test("a helper that returns its program unawaited leaves the realm not at rest", () => {
  const searchLeaving = (query: string): Promise<string> => {
    using realm = testRealm();
    const $query = schemaBox(realm, Schema.String, "");
    return Effect.gen(function* () {
      const searched = yield* Deferred.make<string>();
      yield* watchScoped(
        (read) => read($query),
        (value) => Deferred.succeed(searched, value),
      );
      update(realm, (_read, write) => write($query, query));
      return yield* Deferred.await(searched);
    }).pipe(Effect.scoped, Effect.provideService(RealmService, realm), Effect.runPromise);
  };
  expect(() => searchLeaving("pinna")).toThrow(
    "The test realm is not at rest: watch still running.",
  );
});
