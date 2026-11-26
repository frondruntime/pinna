import { expect, test } from "bun:test";
import { Deferred, Effect } from "effect";
import { Box, Program, Realm } from "../../src/index.ts";

test("a watch uses the last callback that ran as previous across a slow interruption", async () => {
  const realm = Realm.make();
  const count = Box.make(realm, 0);
  const seen: Array<[number, number]> = [];
  const change = (value: number) => Realm.update(realm, (_read, write) => write(count, value));
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const cleaning = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<void>();
        yield* Program.watchScoped(
          realm,
          (read) => read(count),
          (value, previous) => {
            seen.push([value, previous]);
            if (value === 1) {
              return Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() =>
                  Deferred.succeed(cleaning, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                  ),
                ),
              );
            }
            return value === 3
              ? Deferred.succeed(finished, undefined).pipe(Effect.asVoid)
              : Effect.succeed(undefined);
          },
        );
        change(1);
        yield* Deferred.await(started);
        change(2);
        yield* Deferred.await(cleaning);
        change(3);
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(finished);
      }),
    ),
  );
  const previous = seen.at(-2);
  if (previous === undefined) throw new Error("missing preceding callback");
  expect(seen.at(-1)).toEqual([3, previous[0]]);
});
