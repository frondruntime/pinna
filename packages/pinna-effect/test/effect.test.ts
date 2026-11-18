import { afterEach, describe, expect, test } from "bun:test";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Logger,
  Queue,
  Schema,
  Scope,
  Stream,
} from "effect";
import {
  box,
  changes,
  computed,
  createRealm,
  fromStream,
  inspect,
  observe,
  observeScoped,
  onObserved,
  RealmService,
  schemaBox,
  untracked,
  update,
  watch,
  watchScoped,
  whileObserved,
} from "../src/index.ts";

/**
 * The Effect programs: `watchScoped` runs an effect per change, the latest value
 * winning; `changes` streams an observable's values. Both read the realm from
 * `RealmService`. `fromStream` feeds a value from a stream while it is
 * observed.
 */

const original = globalThis.reportError;

afterEach(() => {
  globalThis.reportError = original;
});

interface Logged {
  readonly level: string;
  readonly message: unknown;
  readonly cause: Cause.Cause<unknown>;
}

/** A logger that keeps what it is handed, and the list it keeps it in. */
const capture = () => {
  const logged: Array<Logged> = [];
  const layer = Logger.layer([
    Logger.make((options) => {
      logged.push({ level: options.logLevel, message: options.message, cause: options.cause });
    }),
  ]);
  return { logged, layer };
};

/** Long enough for forked fibers to run what they were handed. */
const settle = Effect.sleep("5 millis");

const run = <A>(program: Effect.Effect<A, never, RealmService>, realm = createRealm()) =>
  Effect.runPromise(program.pipe(Effect.provideService(RealmService, realm)));

describe("watchScoped", () => {
  test("a synchronous callback throw is logged and future delivery survives until scope closure", async () => {
    const realm = createRealm();
    const $count = box(realm, 0);
    const seen: Array<number> = [];
    const { logged, layer } = capture();
    const failure = new Error("factory");
    let interrupted = false;
    await run(
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* watchScoped(
              (read) => read($count),
              (value) => {
                seen.push(value);
                if (value === 1) {
                  throw failure;
                }
                return Effect.never.pipe(
                  Effect.onInterrupt(() =>
                    Effect.sync(() => {
                      interrupted = true;
                    }),
                  ),
                );
              },
            );
            update(realm, (_read, write) => write($count, 1));
            yield* settle;
            update(realm, (_read, write) => write($count, 2));
            yield* settle;
          }),
        );
        update(realm, (_read, write) => write($count, 3));
        yield* settle;
      }).pipe(Effect.provide(layer)),
      realm,
    );
    expect(seen).toEqual([1, 2]);
    expect(interrupted).toBe(true);
    expect(logged.map(({ level, message }) => ({ level, message }))).toEqual([
      { level: "Error", message: ["pinna: a watch effect died"] },
    ]);
    expect(Cause.squash((logged[0] as Logged).cause)).toBe(failure);
  });

  test("runs the effect for each change, not for the current value", async () => {
    const realm = createRealm();
    const $count = schemaBox(realm, Schema.Number, 0);
    const seen: Array<number> = [];
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          yield* watchScoped(
            (read) => read($count),
            (value) =>
              Effect.sync(() => {
                seen.push(value);
              }),
          );
          yield* settle;
          expect(seen).toEqual([]);
          update(realm, (_read, write) => {
            write($count, 1);
          });
          yield* settle;
          update(realm, (_read, write) => {
            write($count, 2);
          });
          yield* settle;
        }),
      ),
      realm,
    );
    expect(seen).toEqual([1, 2]);
  });

  test("a result equal under options.equals neither runs the effect nor interrupts it", async () => {
    const realm = createRealm();
    const $count = schemaBox(realm, Schema.Number, 0);
    const seen: Array<boolean> = [];
    let interrupted = 0;
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          yield* watchScoped(
            (read) => ({ even: read($count) % 2 === 0 }),
            (value) =>
              Effect.sync(() => {
                seen.push(value.even);
              }).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    interrupted++;
                  }),
                ),
              ),
            { equals: (previous, next) => previous.even === next.even },
          );
          update(realm, (_read, write) => {
            write($count, 1);
          });
          yield* settle;
          update(realm, (_read, write) => {
            write($count, 3);
          });
          yield* settle;
          expect(seen).toEqual([false]);
          expect(interrupted).toBe(0);
          update(realm, (_read, write) => {
            write($count, 4);
          });
          yield* settle;
        }),
      ),
      realm,
    );
    expect(seen).toEqual([false, true]);
    expect(interrupted).toBe(2);
  });

  test("sees a change made as soon as it returns", async () => {
    const realm = createRealm();
    const $count = schemaBox(realm, Schema.Number, 0);
    const seen = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const done = yield* Deferred.make<number>();
          yield* watchScoped(
            (read) => read($count),
            (value) => Deferred.succeed(done, value),
          );
          update(realm, (_read, write) => {
            write($count, 7);
          });
          return yield* Deferred.await(done);
        }),
      ),
      realm,
    );
    expect(seen).toBe(7);
  });

  test("previous is the value the effect last ran with, skipping values it never saw", async () => {
    const realm = createRealm();
    const $count = schemaBox(realm, Schema.Number, 0);
    const seen: Array<readonly [number, number]> = [];
    const write = (value: number) => {
      update(realm, (_read, write) => {
        write($count, value);
      });
    };
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          yield* watchScoped(
            (read) => read($count),
            (value, previous) =>
              Effect.sync(() => {
                seen.push([value, previous]);
              }),
          );
          // The latest wins: 1 and 4 are replaced before the effect sees them.
          write(1);
          write(2);
          yield* settle;
          write(3);
          yield* settle;
          write(4);
          write(5);
          yield* settle;
        }),
      ),
      realm,
    );
    expect(seen).toEqual([
      [2, 0],
      [3, 2],
      [5, 3],
    ]);
  });

  test("a new value interrupts the running effect, and the latest wins", async () => {
    const realm = createRealm();
    const $count = schemaBox(realm, Schema.Number, 0);
    const log: Array<string> = [];
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const done = yield* Deferred.make<void>();
          yield* watchScoped(
            (read) => read($count),
            (value) =>
              value === 1
                ? Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() =>
                      Effect.sync(() => {
                        log.push("interrupted 1");
                      }),
                    ),
                  )
                : Effect.sync(() => {
                    log.push(`ran ${value}`);
                  }).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
          );
          update(realm, (_read, write) => {
            write($count, 1);
          });
          yield* Deferred.await(started);
          update(realm, (_read, write) => {
            write($count, 2);
          });
          yield* Deferred.await(done);
        }),
      ),
      realm,
    );
    expect(log).toEqual(["interrupted 1", "ran 2"]);
  });

  test("closing the scope interrupts the running effect and stops watching", async () => {
    const realm = createRealm();
    const $count = schemaBox(realm, Schema.Number, 0);
    const log: Array<string> = [];
    await run(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* watchScoped(
              (read) => read($count),
              (value) =>
                Effect.sync(() => {
                  log.push(`ran ${value}`);
                }).pipe(
                  Effect.andThen(Deferred.succeed(started, undefined)),
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() =>
                    Effect.sync(() => {
                      log.push(`interrupted ${value}`);
                    }),
                  ),
                ),
            );
            update(realm, (_read, write) => {
              write($count, 1);
            });
            yield* Deferred.await(started);
          }),
        );
        update(realm, (_read, write) => {
          write($count, 2);
        });
        yield* settle;
      }),
      realm,
    );
    expect(log).toEqual(["ran 1", "interrupted 1"]);
  });

  test("a defect is logged at the error level and the watch keeps running", async () => {
    const reported: Array<unknown> = [];
    globalThis.reportError = (error) => {
      reported.push(error);
    };
    const realm = createRealm({ onError: (error) => reported.push(error) });
    const $count = schemaBox(realm, Schema.Number, 0);
    const { logged, layer } = capture();
    const failure = new Error("boom");
    const seen = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const done = yield* Deferred.make<number>();
          yield* watchScoped(
            (read) => read($count),
            (value) => (value === 1 ? Effect.die(failure) : Deferred.succeed(done, value)),
          );
          update(realm, (_read, write) => {
            write($count, 1);
          });
          yield* settle;
          update(realm, (_read, write) => {
            write($count, 2);
          });
          return yield* Deferred.await(done);
        }),
      ).pipe(Effect.provide(layer)),
      realm,
    );
    expect(seen).toBe(2);
    expect(reported).toEqual([]);
    expect(logged.map(({ level, message }) => ({ level, message }))).toEqual([
      { level: "Error", message: ["pinna: a watch effect died"] },
    ]);
    expect(Cause.squash((logged[0] as Logged).cause)).toBe(failure);
  });

  test("an interrupted effect is not reported", async () => {
    const reported: Array<unknown> = [];
    globalThis.reportError = (error) => {
      reported.push(error);
    };
    const realm = createRealm({ onError: (error) => reported.push(error) });
    const $count = schemaBox(realm, Schema.Number, 0);
    const { logged, layer } = capture();
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const done = yield* Deferred.make<void>();
          yield* watchScoped(
            (read) => read($count),
            (value) =>
              value === 1
                ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
                : Deferred.succeed(done, undefined),
          );
          update(realm, (_read, write) => {
            write($count, 1);
          });
          yield* Deferred.await(started);
          update(realm, (_read, write) => {
            write($count, 2);
          });
          yield* Deferred.await(done);
        }),
      ).pipe(Effect.provide(layer)),
      realm,
    );
    expect(reported).toEqual([]);
    expect(logged).toEqual([]);
  });
});

describe("changes", () => {
  test("emits the current value, then each change", async () => {
    const realm = createRealm();
    const $count = schemaBox(realm, Schema.Number, 0);
    const $double = computed(realm, (read) => read($count) * 2);
    const values = await run(
      Effect.gen(function* () {
        const fiber = yield* changes($double).pipe(
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* settle;
        update(realm, (_read, write) => {
          write($count, 1);
        });
        yield* settle;
        update(realm, (_read, write) => {
          write($count, 2);
        });
        return yield* Fiber.join(fiber);
      }),
      realm,
    );
    expect([...values]).toEqual([0, 2, 4]);
  });

  test("a consumer that falls behind gets the newest value, never missing the last", async () => {
    const realm = createRealm();
    const $count = schemaBox(realm, Schema.Number, 0);
    const values = await run(
      Effect.gen(function* () {
        const first = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const fiber = yield* changes($count).pipe(
          Stream.mapEffect((value) =>
            value === 0
              ? Deferred.succeed(first, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.as(value),
                )
              : Effect.succeed(value),
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(first);
        for (const next of [1, 2, 3]) {
          update(realm, (_read, write) => {
            write($count, next);
          });
        }
        yield* Deferred.succeed(gate, undefined);
        return yield* Fiber.join(fiber);
      }),
      realm,
    );
    expect([...values]).toEqual([0, 3]);
  });

  test("stops watching when the stream ends", async () => {
    const realm = createRealm();
    const $count = schemaBox(realm, Schema.Number, 0);
    let observed = 0;
    onObserved($count, () => {
      observed++;
      return () => {
        observed--;
      };
    });
    const values = await run(changes($count).pipe(Stream.take(1), Stream.runCollect), realm);
    expect([...values]).toEqual([0]);
    expect(observed).toBe(0);
  });
});

describe("fromStream", () => {
  /** A stream that logs each start and stop, and emits what `queue` is given. */
  const logged = (log: Array<string>, queue: Queue.Queue<number>) =>
    Stream.unwrap(
      Effect.sync(() => {
        log.push("start");
        return Stream.fromQueue(queue);
      }),
    ).pipe(
      Stream.ensuring(
        Effect.sync(() => {
          log.push("stop");
        }),
      ),
    );

  test("runs the stream only while the value is observed, writing each element", async () => {
    const realm = createRealm();
    const log: Array<string> = [];
    const seen: Array<number> = [];
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<number>();
          const $value = yield* fromStream(logged(log, queue), 0);
          yield* settle;
          expect(log).toEqual([]);
          expect(untracked(realm, (read) => read($value))).toBe(0);
          const stop = watch(
            realm,
            (read) => read($value),
            (value) => {
              seen.push(value);
            },
          );
          yield* settle;
          expect(log).toEqual(["start"]);
          yield* Queue.offer(queue, 1);
          yield* settle;
          yield* Queue.offer(queue, 2);
          yield* settle;
          stop();
          yield* settle;
          expect(log).toEqual(["start", "stop"]);
        }),
      ),
      realm,
    );
    expect(seen).toEqual([1, 2]);
  });

  test("an element equal under options.equals notifies nobody, and options.name names the value", async () => {
    const realm = createRealm();
    const seen: Array<{ readonly id: number }> = [];
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<{ readonly id: number }>();
          const $value = yield* fromStream(
            Stream.fromQueue(queue),
            { id: 0 },
            { equals: (previous, next) => previous.id === next.id, name: "Quote.latest" },
          );
          expect(inspect($value).name).toBe("Quote.latest");
          const stop = watch(
            realm,
            (read) => read($value),
            (value) => {
              seen.push(value);
            },
          );
          yield* settle;
          yield* Queue.offer(queue, { id: 1 });
          yield* settle;
          yield* Queue.offer(queue, { id: 1 });
          yield* settle;
          stop();
        }),
      ),
      realm,
    );
    expect(seen).toEqual([{ id: 1 }]);
  });

  test("resets synchronously after the last observer and starts each run from initial", async () => {
    const realm = createRealm();
    let runs = 0;
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<number>();
          const counted = Stream.unwrap(
            Effect.sync(() => {
              runs++;
              return Stream.fromQueue(queue);
            }),
          );
          const $value = yield* fromStream(counted, 0);
          const $double = computed(realm, (read) => read($value) * 2);
          const release = observe($value);
          const second = observe($value);
          yield* Queue.offer(queue, 10);
          yield* settle;
          expect(untracked(realm, (read) => read($value))).toBe(10);
          expect(untracked(realm, (read) => read($double))).toBe(20);
          release();
          expect(untracked(realm, (read) => read($value))).toBe(10);
          second();
          expect(untracked(realm, (read) => read($value))).toBe(0);
          expect(untracked(realm, (read) => read($double))).toBe(0);
          const tracked: Array<number> = [];
          const again = watch(
            realm,
            (read) => {
              const value = read($value);
              tracked.push(value);
              return value;
            },
            () => {},
          );
          expect(tracked).toEqual([0]);
          expect(untracked(realm, (read) => read($value))).toBe(0);
          yield* Queue.offer(queue, 20);
          yield* settle;
          expect(untracked(realm, (read) => read($value))).toBe(20);
          again();
          expect(untracked(realm, (read) => read($value))).toBe(0);
        }),
      ),
      realm,
    );
    expect(runs).toBe(2);
  });

  for (const duringUpdate of [false, true]) {
    test(`stopping a watch resets before returning${duringUpdate ? " from an update" : ""}`, async () => {
      const reported: Array<unknown> = [];
      const realm = createRealm({ onError: (error) => reported.push(error) });
      await run(
        Effect.scoped(
          Effect.gen(function* () {
            const $value = yield* fromStream(Stream.concat(Stream.make(1), Stream.never), 0);
            const stop = watch(
              realm,
              (read) => read($value),
              () => {},
            );
            yield* settle;
            expect(untracked(realm, (read) => read($value))).toBe(1);
            if (duringUpdate) {
              update(realm, () => {
                stop();
              });
            } else {
              stop();
            }
            expect(untracked(realm, (read) => read($value))).toBe(0);
          }),
        ),
        realm,
      );
      expect(reported).toEqual([]);
    });
  }

  test("resets when a computed value stops reading it during settle", async () => {
    const reported: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => reported.push(error) });
    const $show = box(realm, true);
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<number>();
          const $value = yield* fromStream(Stream.fromQueue(queue), 0);
          const $visible = computed(realm, (read) => (read($show) ? read($value) : -1));
          const stop = watch(
            realm,
            (read) => read($visible),
            () => {},
          );
          yield* Queue.offer(queue, 1);
          yield* settle;
          expect(untracked(realm, (read) => read($visible))).toBe(1);
          update(realm, (_read, write) => write($show, false));
          expect(untracked(realm, (read) => read($value))).toBe(0);
          update(realm, (_read, write) => write($show, true));
          expect(untracked(realm, (read) => read($visible))).toBe(0);
          stop();
        }),
      ),
      realm,
    );
    expect(reported).toEqual([]);
  });

  test("releasing the last observer in a failed update still resets at settle", async () => {
    const realm = createRealm();
    const $other = box(realm, 0);
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const $value = yield* fromStream(Stream.concat(Stream.make(1), Stream.never), 0);
          const release = observe($value);
          yield* settle;
          expect(untracked(realm, (read) => read($value))).toBe(1);
          expect(() =>
            update(realm, (_read, write) => {
              write($other, 1);
              release();
              throw new Error("rollback");
            }),
          ).toThrow("rollback");
          expect(untracked(realm, (read) => [read($value), read($other)])).toEqual([0, 0]);
        }),
      ),
      realm,
    );
  });

  test("a scope closed inside a failed update cannot restore the last element", async () => {
    const reported: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => reported.push(error) });
    const $other = box(realm, 0);
    const seen: Array<number> = [];
    await run(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const $value = yield* fromStream(Stream.make(1), 0).pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        const $double = computed(realm, (read) => read($value) * 2);
        const stop = watch(
          realm,
          (read) => read($double),
          (value) => {
            seen.push(value);
          },
        );
        yield* settle;
        expect(seen).toEqual([2]);
        expect(() =>
          update(realm, (read, write) => {
            write($other, 1);
            Effect.runSync(Scope.close(scope, Exit.void));
            expect(read($value)).toBe(0);
            expect(read($double)).toBe(0);
            throw new Error("rollback");
          }),
        ).toThrow("rollback");
        expect(untracked(realm, (read) => [read($value), read($double), read($other)])).toEqual([
          0, 0, 0,
        ]);
        expect(seen).toEqual([2, 0]);
        stop();
        const release = observe($value);
        expect(untracked(realm, (read) => read($value))).toBe(0);
        release();
      }),
      realm,
    );
    expect(reported).toEqual([]);
  });

  test("reset restores initial itself without consulting element equality", async () => {
    const realm = createRealm();
    const initial = { id: 0 };
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<{ readonly id: number }>();
          const $value = yield* fromStream(Stream.fromQueue(queue), initial, {
            equals: (previous, next) => next === initial || previous.id === next.id,
          });
          const release = observe($value);
          yield* Queue.offer(queue, { id: 1 });
          yield* settle;
          expect(untracked(realm, (read) => read($value))).toEqual({ id: 1 });
          release();
          expect(untracked(realm, (read) => read($value))).toBe(initial);
          const again = observe($value);
          expect(untracked(realm, (read) => read($value))).toBe(initial);
          again();
        }),
      ),
      realm,
    );
  });

  test("takes the elements a stream emits as it starts", async () => {
    const reported: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => reported.push(error) });
    const seen = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const $value = yield* fromStream(Stream.make(1, 2, 3), 0);
          const $double = computed(realm, (read) => read($value) * 2);
          const release = observe($double);
          yield* settle;
          const value = untracked(realm, (read) => read($double));
          release();
          return value;
        }),
      ),
      realm,
    );
    expect(seen).toBe(6);
    expect(reported).toEqual([]);
  });

  test("a defect keeps its last element while observed, then resets for the next run", async () => {
    const reported: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => reported.push(error) });
    const { logged: logs, layer } = capture();
    const failure = new Error("boom");
    const seen = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<number>();
          const stream = Stream.concat(
            Stream.fromQueue(queue).pipe(Stream.take(1)),
            Stream.die(failure),
          );
          const $value = yield* fromStream(stream, 0);
          const release = observe($value);
          yield* Queue.offer(queue, 1);
          yield* settle;
          const value = untracked(realm, (read) => read($value));
          release();
          expect(untracked(realm, (read) => read($value))).toBe(0);
          const tracked: Array<number> = [];
          const stop = watch(
            realm,
            (read) => {
              const value = read($value);
              tracked.push(value);
              return value;
            },
            () => {},
          );
          expect(tracked).toEqual([0]);
          yield* Queue.offer(queue, 2);
          yield* settle;
          expect(untracked(realm, (read) => read($value))).toBe(2);
          stop();
          expect(untracked(realm, (read) => read($value))).toBe(0);
          return value;
        }),
      ).pipe(Effect.provide(layer)),
      realm,
    );
    expect(seen).toBe(1);
    expect(reported).toEqual([]);
    expect(logs.map(({ level, message }) => ({ level, message }))).toEqual([
      { level: "Error", message: ["pinna: a stream into a value died"] },
      { level: "Error", message: ["pinna: a stream into a value died"] },
    ]);
    expect(Cause.squash((logs[0] as Logged).cause)).toBe(failure);
  });

  test("a stream that completes keeps its last element while observed, as one that dies does", async () => {
    const realm = createRealm();
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const $value = yield* fromStream(Stream.make(1, 2), 0);
          const release = observe($value);
          yield* settle;
          expect(untracked(realm, (read) => read($value))).toBe(2);
          release();
          expect(untracked(realm, (read) => read($value))).toBe(0);
        }),
      ),
      realm,
    );
  });

  test("closing the scope stops the stream, and observing again does not restart it", async () => {
    const realm = createRealm();
    const log: Array<string> = [];
    const seen: Array<number> = [];
    await run(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<number>();
        const held = yield* Effect.scoped(
          Effect.gen(function* () {
            const $value = yield* fromStream(logged(log, queue), 0);
            const release = watch(
              realm,
              (read) => read($value),
              (value) => {
                seen.push(value);
              },
            );
            yield* settle;
            yield* Queue.offer(queue, 1);
            yield* settle;
            return { $value, release };
          }),
        );
        expect(log).toEqual(["start", "stop"]);
        expect(seen).toEqual([1, 0]);
        expect(untracked(realm, (read) => read(held.$value))).toBe(0);
        held.release();
        const release = observe(held.$value);
        yield* settle;
        release();
        expect(log).toEqual(["start", "stop"]);
        expect(untracked(realm, (read) => read(held.$value))).toBe(0);
      }),
      realm,
    );
  });

  test("runs the stream with the services of the program that made the value", async () => {
    class Greeting extends Context.Service<Greeting, string>()("test/Greeting") {}
    const realm = createRealm();
    const seen = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const $value = yield* fromStream(
            Stream.fromEffect(
              Effect.gen(function* () {
                return yield* Greeting;
              }),
            ),
            "",
          );
          const release = observe($value);
          yield* settle;
          const value = untracked(realm, (read) => read($value));
          release();
          return value;
        }),
      ).pipe(Effect.provideService(Greeting, "hello")),
      realm,
    );
    expect(seen).toBe("hello");
  });
});

describe("whileObserved", () => {
  /** A program that logs each run's start, its scope's release, and its interruption. */
  const logged = (log: Array<string>) =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          log.push("start");
        }),
        () =>
          Effect.sync(() => {
            log.push("release");
          }),
      );
      yield* Effect.never;
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          log.push("interrupt");
        }),
      ),
    );

  test("runs the program from the start for each observation, releasing its scope between runs", async () => {
    const realm = createRealm();
    const $value = box(realm, 0);
    const log: Array<string> = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* whileObserved($value, logged(log));
          yield* settle;
          expect(log).toEqual([]);
          const first = observe($value);
          const second = observe($value);
          yield* settle;
          expect(log).toEqual(["start"]);
          first();
          yield* settle;
          expect(log).toEqual(["start"]);
          second();
          yield* settle;
          expect(log).toEqual(["start", "interrupt", "release"]);
          const third = observe($value);
          yield* settle;
          expect(log).toEqual(["start", "interrupt", "release", "start"]);
          third();
          yield* settle;
        }),
      ),
    );
    expect(log).toEqual(["start", "interrupt", "release", "start", "interrupt", "release"]);
  });

  test("a program writes what an observer reads, in updates of its own", async () => {
    const realm = createRealm();
    const $count = box(realm, 0);
    const seen: Array<number> = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<number>();
          yield* whileObserved(
            $count,
            Stream.fromQueue(queue).pipe(
              Stream.runForEach((value) =>
                Effect.sync(() => {
                  update(realm, (_read, write) => {
                    write($count, value);
                  });
                }),
              ),
            ),
          );
          const stop = watch(
            realm,
            (read) => read($count),
            (value) => {
              seen.push(value);
            },
          );
          yield* settle;
          yield* Queue.offer(queue, 1);
          yield* settle;
          yield* Queue.offer(queue, 2);
          yield* settle;
          stop();
        }),
      ),
    );
    expect(seen).toEqual([1, 2]);
  });

  test("runs the program with the services of the program that called it", async () => {
    class Greeting extends Context.Service<Greeting, string>()("test/Greeting") {}
    const realm = createRealm();
    const $value = box(realm, "");
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* whileObserved(
            $value,
            Effect.gen(function* () {
              const greeting = yield* Greeting;
              update(realm, (_read, write) => {
                write($value, greeting);
              });
            }),
          );
          const release = observe($value);
          yield* settle;
          expect(untracked(realm, (read) => read($value))).toBe("hello");
          release();
        }),
      ).pipe(Effect.provideService(Greeting, "hello")),
    );
  });

  test("a defect is logged, and the next observation starts the program again", async () => {
    const reported: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => reported.push(error) });
    const $value = box(realm, 0);
    const { logged: logs, layer } = capture();
    const failure = new Error("boom");
    let runs = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* whileObserved(
            $value,
            Effect.suspend(() => {
              runs++;
              return Effect.die(failure);
            }),
          );
          const first = observe($value);
          yield* settle;
          first();
          const second = observe($value);
          yield* settle;
          second();
        }),
      ).pipe(Effect.provide(layer)),
    );
    expect(runs).toBe(2);
    expect(reported).toEqual([]);
    expect(logs.map(({ level, message }) => ({ level, message }))).toEqual([
      { level: "Error", message: ["pinna: a program run while observed died"] },
      { level: "Error", message: ["pinna: a program run while observed died"] },
    ]);
    expect(Cause.squash((logs[0] as Logged).cause)).toBe(failure);
  });

  test("closing the scope stops a run and waits for it, and observing again does not restart it", async () => {
    const realm = createRealm();
    const $value = box(realm, 0);
    const log: Array<string> = [];
    const release = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* whileObserved($value, logged(log));
          const release = observe($value);
          yield* settle;
          return release;
        }),
      ),
    );
    expect(log).toEqual(["start", "interrupt", "release"]);
    release();
    const again = observe($value);
    await Effect.runPromise(settle);
    again();
    expect(log).toEqual(["start", "interrupt", "release"]);
  });
});

describe("RealmService", () => {
  test("a realm from createRealm() provides it", async () => {
    const realm = createRealm();
    const provided = await run(
      Effect.gen(function* () {
        return yield* RealmService;
      }),
      realm,
    );
    expect(provided).toBe(realm);
  });
});

describe("observeScoped", () => {
  test("holds an observable while its scope is open", async () => {
    const realm = createRealm();
    const $value = schemaBox(realm, Schema.Number, 0);
    const events: Array<string> = [];
    onObserved($value, () => {
      events.push("start");
      return () => events.push("stop");
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* observeScoped($value);
          events.push("inside");
        }),
      ).pipe(Effect.provideService(RealmService, realm)),
    );

    expect(events).toEqual(["start", "inside", "stop"]);
  });
});
