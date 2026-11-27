# Programs: Testing

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/effect/programs.md, its section "Testing".

## Testing

A program that polls or sleeps is tested on `TestClock`, from
`effect/testing`, so the test moves time instead of waiting for it. The
test realm is as on [Testing](testing.md).

- Provide `TestClock.layer()` around the program that makes a `Program.fromStream`
  value, not only around the one that observes it. The value keeps the
  clock of the program that made it, and a value made on the live clock
  polls on the live clock whatever the observer provides.
- Hold the value observed with `Source.observeScoped`. Its stream runs only while
  something observes the value, so an unobserved poll never runs and the
  value stays `initial`.

```ts
import { expect, test } from "bun:test";
import { testRealm } from "@frondruntime/pinna/testing";
import { Program, Realm, RealmService, Source } from "@frondruntime/pinna-effect";
import { Effect, Schedule, Stream } from "effect";
import { TestClock } from "effect/testing";

test("a poll advances with the test clock", async () => {
  using realm = testRealm();
  let polls = 0;
  const poll = Effect.sync(() => ++polls);

  const latest = await Effect.gen(function* () {
    // Made under TestClock: fromStream keeps the clock of the program that
    // makes the value, and the poll waits on it.
    const $polls = yield* Program.fromStream(
      realm,
      Stream.fromEffectSchedule(poll, Schedule.spaced("1 minute")),
      0,
    );
    // The poll runs only while something observes the value.
    yield* Source.observeScoped($polls);
    yield* TestClock.adjust("2 minutes");
    return Realm.untracked(realm, (read) => read($polls));
  }).pipe(
    Effect.scoped,
    Effect.provideService(RealmService, realm),
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );

  expect(latest).toBe(3);
});
```

`TestClock.adjust` is not a completion signal. It runs the sleeps that fall
due and waits for the fibers it woke to suspend; work that no sleep holds,
such as a load that yields between rows, can still be running when it
returns, and `TestClock.adjust(0)` wakes nothing at all. A test waits on a
value the program publishes when its work is done: a `Deferred`, or a box
read through `Program.changes`.

```ts
import { expect, test } from "bun:test";
import { testRealm } from "@frondruntime/pinna/testing";
import { Box, Program, Realm, RealmService } from "@frondruntime/pinna-effect";
import { Effect, Stream } from "effect";
import { TestClock } from "effect/testing";

test("a test waits on what the program publishes, not on the clock", async () => {
  using realm = testRealm();
  const $loadedRows = Box.make(realm, 0);
  const $loaded = Box.make(realm, false);
  // Yields between rows; no sleep holds it, so the clock has nothing to wait for.
  const load = Effect.gen(function* () {
    for (let row = 1; row <= 100; row++) {
      yield* Effect.yieldNow;
      Realm.update(realm, (_read, write) => write($loadedRows, row));
    }
    Realm.update(realm, (_read, write) => write($loaded, true));
  });

  const loaded = await Effect.gen(function* () {
    yield* Effect.forkScoped(load);
    yield* Program.changes($loaded).pipe(
      Stream.filter((done) => done),
      Stream.runHead,
    );
    return Realm.untracked(realm, (read) => read($loadedRows));
  }).pipe(
    Effect.scoped,
    Effect.provideService(RealmService, realm),
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );

  expect(loaded).toBe(100);
});
```

A helper that runs a program and declares its realm with `using` is
`async` and awaits the run before it returns. Returning the promise without
`await` disposes the realm while the program's scope is still open, and the
dispose throws `The test realm is not at rest: watch still running.`, one
entry per watch the program holds. The dispose stops each watch first, so no
watch reruns in the next test, but a fiber the program forked runs on until
its scope closes; the fix is `return await`.

```ts
import { expect, test } from "bun:test";
import { testRealm } from "@frondruntime/pinna/testing";
import { Box, Program, Realm, RealmService } from "@frondruntime/pinna-effect";
import { Deferred, Effect, Schema } from "effect";

// `async` and `return await`: the realm is disposed after the program's scope
// closes. A helper that returns the promise without awaiting it disposes the
// realm while the program's watch still runs.
const searchOnce = async (query: string): Promise<string> => {
  using realm = testRealm();
  const $query = Box.schema(realm, Schema.String, "");
  return await Effect.gen(function* () {
    const searched = yield* Deferred.make<string>();
    yield* Program.watchScoped(
      realm,
      (read) => read($query),
      (value) => Deferred.succeed(searched, value),
    );
    Realm.update(realm, (_read, write) => write($query, query));
    return yield* Deferred.await(searched);
  }).pipe(Effect.scoped, Effect.provideService(RealmService, realm), Effect.runPromise);
};

test("a helper awaits its program before its realm is disposed", async () => {
  expect(await searchOnce("pinna")).toBe("pinna");
});
```

| Call | Answers |
| --- | --- |
| `Effect.provide(TestClock.layer())` | A program whose sleeps and schedules wait on the test clock. |
| `TestClock.adjust(duration)` | Moves the test clock and runs the sleeps that fall due; not a signal that other work finished. |
