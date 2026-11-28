import { describe, expect, test } from "bun:test";
import { Effect, Queue, Schema } from "effect";
import { Box, Program, Realm } from "../src/index.ts";

/**
 * `{ immediate: true }` with Effect: `Program.watchScoped` runs its effect for
 * the current value with `previous` `undefined`, and `Realm.watch` over a
 * schema box sees the value the schema accepted (ruling 78).
 */

describe("Program.watchScoped with { immediate: true }", () => {
  test("runs the effect for the current value, then for each change", async () => {
    const realm = Realm.make();
    const $count = Box.make(realm, 1);
    const seen = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ran = yield* Queue.unbounded<[number, number | undefined]>();
          yield* Program.watchScoped(
            realm,
            (read) => read($count),
            (value, previous) => Queue.offer(ran, [value, previous]).pipe(Effect.asVoid),
            { immediate: true },
          );
          const first = yield* Queue.take(ran);
          Realm.update(realm, (_read, write) => write($count, 2));
          const second = yield* Queue.take(ran);
          return [first, second];
        }),
      ),
    );
    expect(seen).toEqual([
      [1, undefined],
      [2, 1],
    ]);
  });

  test("without the option, the current value runs nothing", async () => {
    const realm = Realm.make();
    const $count = Box.make(realm, 1);
    const seen = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ran = yield* Queue.unbounded<number>();
          yield* Program.watchScoped(
            realm,
            (read) => read($count),
            (value) => Queue.offer(ran, value).pipe(Effect.asVoid),
          );
          yield* Effect.yieldNow;
          const before = yield* Queue.size(ran);
          Realm.update(realm, (_read, write) => write($count, 2));
          const value = yield* Queue.take(ran);
          return [before, value];
        }),
      ),
    );
    expect(seen).toEqual([0, 2]);
  });

  test("is refused inside an update, as Realm.watch is", async () => {
    const realm = Realm.make();
    const $count = Box.make(realm, 1);
    let code: unknown;
    try {
      Realm.update(realm, () => {
        Effect.runSync(
          Effect.scoped(
            Program.watchScoped(
              realm,
              (read) => read($count),
              () => Effect.void,
              { immediate: true },
            ),
          ),
        );
      });
    } catch (error) {
      code = (error as { readonly code?: string }).code ?? String(error);
    }
    expect(String(code)).toContain("pinna/watch-immediate-in-update");
  });
});

describe("an immediate watch over a schema box", () => {
  test("sees the accepted value first, and a rejected write changes nothing", () => {
    const realm = Realm.make();
    const $price = Box.schema(realm, Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)), 5);
    const seen: Array<[number, number | undefined]> = [];
    const stop = Realm.watch(
      realm,
      (read) => read($price),
      (value, previous) => {
        seen.push([value, previous]);
      },
      { immediate: true },
    );
    expect(() => Realm.update(realm, (_read, write) => write($price, -1))).toThrow();
    Realm.update(realm, (_read, write) => write($price, 7));
    expect(seen).toEqual([
      [5, undefined],
      [7, 5],
    ]);
    stop();
  });
});
