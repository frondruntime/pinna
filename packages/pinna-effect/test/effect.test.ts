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
import { Box, Computed, Program, Realm, RealmService, Source } from "../src/index.ts";

/**
 * The Effect programs: `Program.watchScoped` runs an effect per change, the latest value
 * winning; `Program.changes` streams an observable's values. `Program.watchScoped` reads the
 * realm from `RealmService`, and `Program.changes` from the observable. `Program.fromStream`
 * feeds a value from a stream while it is observed.
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

const run = <A>(program: Effect.Effect<A, never, RealmService>, realm = Realm.make()) =>
  Effect.runPromise(program.pipe(Effect.provideService(RealmService, realm)));

for (const kind of ["whileObserved", "fromStream"] as const) {
  for (const restart of [false, true]) {
    test(`${kind} scope closure awaits released runs${restart ? " while a new run is active" : ""}`, async () => {
      const realm = Realm.make();
      let runs = 0;
      let finished = 0;
      await run(
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const started = yield* Deferred.make<void>();
          const restarted = yield* Deferred.make<void>();
          const cleaning = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();
          const program = Effect.gen(function* () {
            const current = ++runs;
            yield* Effect.acquireRelease(
              Deferred.succeed(current === 1 ? started : restarted, undefined),
              () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(cleaning, undefined);
                  if (current === 1) {
                    yield* Deferred.await(finish);
                  }
                  finished++;
                }),
            );
            yield* Effect.never;
          });
          const observable =
            kind === "fromStream"
              ? yield* Scope.provide(scope)(
                  Program.fromStream(realm, Stream.fromEffect(program), undefined),
                )
              : Box.make(realm, 0);
          if (kind === "whileObserved") {
            yield* Scope.provide(scope)(Program.whileObserved(observable, program));
          }
          const release = Source.observe(observable);
          yield* Deferred.await(started);
          release();
          yield* Deferred.await(cleaning);
          const releaseAgain = restart ? Source.observe(observable) : () => undefined;
          if (restart) {
            yield* Deferred.await(restarted);
          }
          const closer = yield* Effect.forkChild(Scope.close(scope, Exit.void));
          yield* settle;
          const pending = closer.pollUnsafe() === undefined;
          const finishedBeforeRelease = finished;
          yield* Deferred.succeed(finish, undefined);
          yield* Fiber.join(closer);
          releaseAgain();
          const afterClose = Source.observe(observable);
          yield* settle;
          afterClose();
          expect(pending).toBe(true);
          expect(finishedBeforeRelease).toBe(restart ? 1 : 0);
          expect(runs).toBe(restart ? 2 : 1);
          expect(finished).toBe(runs);
        }),
        realm,
      );
    });
  }
}

describe("watchScoped", () => {
  test("a synchronous callback throw is logged and future delivery survives until scope closure", async () => {
    const realm = Realm.make();
    const $count = Box.make(realm, 0);
    const seen: Array<number> = [];
    const { logged, layer } = capture();
    const failure = new Error("factory");
    let interrupted = false;
    await run(
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Program.watchScoped(
              realm,
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
            Realm.update(realm, (_read, write) => write($count, 1));
            yield* settle;
            Realm.update(realm, (_read, write) => write($count, 2));
            yield* settle;
          }),
        );
        Realm.update(realm, (_read, write) => write($count, 3));
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
    const realm = Realm.make();
    const $count = Box.schema(realm, Schema.Number, 0);
    const seen: Array<number> = [];
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Program.watchScoped(
            realm,
            (read) => read($count),
            (value) =>
              Effect.sync(() => {
                seen.push(value);
              }),
          );
          yield* settle;
          expect(seen).toEqual([]);
          Realm.update(realm, (_read, write) => {
            write($count, 1);
          });
          yield* settle;
          Realm.update(realm, (_read, write) => {
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
    const realm = Realm.make();
    const $count = Box.schema(realm, Schema.Number, 0);
    const seen: Array<boolean> = [];
    let interrupted = 0;
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Program.watchScoped(
            realm,
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
          Realm.update(realm, (_read, write) => {
            write($count, 1);
          });
          yield* settle;
          Realm.update(realm, (_read, write) => {
            write($count, 3);
          });
          yield* settle;
          expect(seen).toEqual([false]);
          expect(interrupted).toBe(0);
          Realm.update(realm, (_read, write) => {
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
    const realm = Realm.make();
    const $count = Box.schema(realm, Schema.Number, 0);
    const seen = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const done = yield* Deferred.make<number>();
          yield* Program.watchScoped(
            realm,
            (read) => read($count),
            (value) => Deferred.succeed(done, value),
          );
          Realm.update(realm, (_read, write) => {
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
    const realm = Realm.make();
    const $count = Box.schema(realm, Schema.Number, 0);
    const seen: Array<readonly [number, number]> = [];
    const write = (value: number) => {
      Realm.update(realm, (_read, write) => {
        write($count, value);
      });
    };
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const runs = yield* Queue.unbounded<readonly [number, number]>();
          yield* Program.watchScoped(
            realm,
            (read) => read($count),
            (value, previous) => Queue.offer(runs, [value, previous] as const),
          );
          // The latest wins: 1 and 4 are replaced before the effect sees them.
          // Each step waits for the run it starts, not for a time: a sleep let
          // the scope close before the last run under load.
          write(1);
          write(2);
          seen.push(yield* Queue.take(runs));
          write(3);
          seen.push(yield* Queue.take(runs));
          write(4);
          write(5);
          seen.push(yield* Queue.take(runs));
          yield* settle;
          expect(yield* Queue.size(runs)).toBe(0);
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
    const realm = Realm.make();
    const $count = Box.schema(realm, Schema.Number, 0);
    const log: Array<string> = [];
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const done = yield* Deferred.make<void>();
          yield* Program.watchScoped(
            realm,
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
          Realm.update(realm, (_read, write) => {
            write($count, 1);
          });
          yield* Deferred.await(started);
          Realm.update(realm, (_read, write) => {
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
    const realm = Realm.make();
    const $count = Box.schema(realm, Schema.Number, 0);
    const log: Array<string> = [];
    await run(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Program.watchScoped(
              realm,
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
            Realm.update(realm, (_read, write) => {
              write($count, 1);
            });
            yield* Deferred.await(started);
          }),
        );
        Realm.update(realm, (_read, write) => {
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
    const realm = Realm.make({ onError: (error) => reported.push(error) });
    const $count = Box.schema(realm, Schema.Number, 0);
    const { logged, layer } = capture();
    const failure = new Error("boom");
    const seen = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const done = yield* Deferred.make<number>();
          yield* Program.watchScoped(
            realm,
            (read) => read($count),
            (value) => (value === 1 ? Effect.die(failure) : Deferred.succeed(done, value)),
          );
          Realm.update(realm, (_read, write) => {
            write($count, 1);
          });
          yield* settle;
          Realm.update(realm, (_read, write) => {
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
    const realm = Realm.make({ onError: (error) => reported.push(error) });
    const $count = Box.schema(realm, Schema.Number, 0);
    const { logged, layer } = capture();
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const done = yield* Deferred.make<void>();
          yield* Program.watchScoped(
            realm,
            (read) => read($count),
            (value) =>
              value === 1
                ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
                : Deferred.succeed(done, undefined),
          );
          Realm.update(realm, (_read, write) => {
            write($count, 1);
          });
          yield* Deferred.await(started);
          Realm.update(realm, (_read, write) => {
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
  test("runs with no RealmService provided, and streams the current value, then each change", async () => {
    const realm = Realm.make();
    const $count = Box.make(realm, 0);
    // The type says it: a stream that requires nothing.
    const stream: Stream.Stream<number> = Program.changes($count);
    const values = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* stream.pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
        yield* settle;
        Realm.update(realm, (_read, write) => {
          write($count, 1);
        });
        yield* settle;
        Realm.update(realm, (_read, write) => {
          write($count, 2);
        });
        return yield* Fiber.join(fiber);
      }),
    );
    expect([...values]).toEqual([0, 1, 2]);
  });

  test("watches the realm that made the observable, whatever RealmService holds", async () => {
    const realm = Realm.make();
    const $count = Box.make(realm, 0);
    const values = await run(
      Effect.gen(function* () {
        const fiber = yield* Program.changes($count).pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* settle;
        Realm.update(realm, (_read, write) => {
          write($count, 1);
        });
        return yield* Fiber.join(fiber);
      }),
      Realm.make(),
    );
    expect([...values]).toEqual([0, 1]);
  });

  test("emits the current value, then each change", async () => {
    const realm = Realm.make();
    const $count = Box.schema(realm, Schema.Number, 0);
    const $double = Computed.make(realm, (read) => read($count) * 2);
    const values = await run(
      Effect.gen(function* () {
        const fiber = yield* Program.changes($double).pipe(
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* settle;
        Realm.update(realm, (_read, write) => {
          write($count, 1);
        });
        yield* settle;
        Realm.update(realm, (_read, write) => {
          write($count, 2);
        });
        return yield* Fiber.join(fiber);
      }),
      realm,
    );
    expect([...values]).toEqual([0, 2, 4]);
  });

  test("a consumer that falls behind gets the newest value, never missing the last", async () => {
    const realm = Realm.make();
    const $count = Box.schema(realm, Schema.Number, 0);
    const values = await run(
      Effect.gen(function* () {
        const first = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const fiber = yield* Program.changes($count).pipe(
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
          Realm.update(realm, (_read, write) => {
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
    const realm = Realm.make();
    const $count = Box.schema(realm, Schema.Number, 0);
    let observed = 0;
    Source.onObserved($count, () => {
      observed++;
      return () => {
        observed--;
      };
    });
    const values = await run(
      Program.changes($count).pipe(Stream.take(1), Stream.runCollect),
      realm,
    );
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
    const realm = Realm.make();
    const log: Array<string> = [];
    const seen: Array<number> = [];
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<number>();
          const $value = yield* Program.fromStream(realm, logged(log, queue), 0);
          yield* settle;
          expect(log).toEqual([]);
          expect(Realm.untracked(realm, (read) => read($value))).toBe(0);
          const stop = Realm.watch(
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
    const realm = Realm.make();
    const seen: Array<{ readonly id: number }> = [];
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<{ readonly id: number }>();
          const $value = yield* Program.fromStream(
            realm,
            Stream.fromQueue(queue),
            { id: 0 },
            { equals: (previous, next) => previous.id === next.id, name: "Quote.latest" },
          );
          expect(Source.inspect($value).name).toBe("Quote.latest");
          const stop = Realm.watch(
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
    const realm = Realm.make();
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
          const $value = yield* Program.fromStream(realm, counted, 0);
          const $double = Computed.make(realm, (read) => read($value) * 2);
          const release = Source.observe($value);
          const second = Source.observe($value);
          yield* Queue.offer(queue, 10);
          yield* settle;
          expect(Realm.untracked(realm, (read) => read($value))).toBe(10);
          expect(Realm.untracked(realm, (read) => read($double))).toBe(20);
          release();
          expect(Realm.untracked(realm, (read) => read($value))).toBe(10);
          second();
          expect(Realm.untracked(realm, (read) => read($value))).toBe(0);
          expect(Realm.untracked(realm, (read) => read($double))).toBe(0);
          const tracked: Array<number> = [];
          const again = Realm.watch(
            realm,
            (read) => {
              const value = read($value);
              tracked.push(value);
              return value;
            },
            () => {},
          );
          expect(tracked).toEqual([0]);
          expect(Realm.untracked(realm, (read) => read($value))).toBe(0);
          yield* Queue.offer(queue, 20);
          yield* settle;
          expect(Realm.untracked(realm, (read) => read($value))).toBe(20);
          again();
          expect(Realm.untracked(realm, (read) => read($value))).toBe(0);
        }),
      ),
      realm,
    );
    expect(runs).toBe(2);
  });

  for (const duringUpdate of [false, true]) {
    test(`stopping a watch resets before returning${duringUpdate ? " from an update" : ""}`, async () => {
      const reported: Array<unknown> = [];
      const realm = Realm.make({ onError: (error) => reported.push(error) });
      await run(
        Effect.scoped(
          Effect.gen(function* () {
            const $value = yield* Program.fromStream(
              realm,
              Stream.concat(Stream.make(1), Stream.never),
              0,
            );
            const stop = Realm.watch(
              realm,
              (read) => read($value),
              () => {},
            );
            yield* settle;
            expect(Realm.untracked(realm, (read) => read($value))).toBe(1);
            if (duringUpdate) {
              Realm.update(realm, () => {
                stop();
              });
            } else {
              stop();
            }
            expect(Realm.untracked(realm, (read) => read($value))).toBe(0);
          }),
        ),
        realm,
      );
      expect(reported).toEqual([]);
    });
  }

  test("resets when a computed value stops reading it during settle", async () => {
    const reported: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => reported.push(error) });
    const $show = Box.make(realm, true);
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<number>();
          const $value = yield* Program.fromStream(realm, Stream.fromQueue(queue), 0);
          const $visible = Computed.make(realm, (read) => (read($show) ? read($value) : -1));
          const stop = Realm.watch(
            realm,
            (read) => read($visible),
            () => {},
          );
          yield* Queue.offer(queue, 1);
          yield* settle;
          expect(Realm.untracked(realm, (read) => read($visible))).toBe(1);
          Realm.update(realm, (_read, write) => write($show, false));
          expect(Realm.untracked(realm, (read) => read($value))).toBe(0);
          Realm.update(realm, (_read, write) => write($show, true));
          expect(Realm.untracked(realm, (read) => read($visible))).toBe(0);
          stop();
        }),
      ),
      realm,
    );
    expect(reported).toEqual([]);
  });

  test("releasing the last observer in a failed update still resets at settle", async () => {
    const realm = Realm.make();
    const $other = Box.make(realm, 0);
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const $value = yield* Program.fromStream(
            realm,
            Stream.concat(Stream.make(1), Stream.never),
            0,
          );
          const release = Source.observe($value);
          yield* settle;
          expect(Realm.untracked(realm, (read) => read($value))).toBe(1);
          expect(() =>
            Realm.update(realm, (_read, write) => {
              write($other, 1);
              release();
              throw new Error("rollback");
            }),
          ).toThrow("rollback");
          expect(Realm.untracked(realm, (read) => [read($value), read($other)])).toEqual([0, 0]);
        }),
      ),
      realm,
    );
  });

  test("a scope closed inside a failed update cannot restore the last element", async () => {
    const reported: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => reported.push(error) });
    const $other = Box.make(realm, 0);
    const seen: Array<number> = [];
    await run(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const $value = yield* Program.fromStream(realm, Stream.make(1), 0).pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        const $double = Computed.make(realm, (read) => read($value) * 2);
        const stop = Realm.watch(
          realm,
          (read) => read($double),
          (value) => {
            seen.push(value);
          },
        );
        yield* settle;
        expect(seen).toEqual([2]);
        expect(() =>
          Realm.update(realm, (read, write) => {
            write($other, 1);
            Effect.runSync(Scope.close(scope, Exit.void));
            expect(read($value)).toBe(0);
            expect(read($double)).toBe(0);
            throw new Error("rollback");
          }),
        ).toThrow("rollback");
        expect(
          Realm.untracked(realm, (read) => [read($value), read($double), read($other)]),
        ).toEqual([0, 0, 0]);
        expect(seen).toEqual([2, 0]);
        stop();
        const release = Source.observe($value);
        expect(Realm.untracked(realm, (read) => read($value))).toBe(0);
        release();
      }),
      realm,
    );
    expect(reported).toEqual([]);
  });

  test("reset restores initial itself without consulting element equality", async () => {
    const realm = Realm.make();
    const initial = { id: 0 };
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<{ readonly id: number }>();
          const $value = yield* Program.fromStream(realm, Stream.fromQueue(queue), initial, {
            equals: (previous, next) => next === initial || previous.id === next.id,
          });
          const release = Source.observe($value);
          yield* Queue.offer(queue, { id: 1 });
          yield* settle;
          expect(Realm.untracked(realm, (read) => read($value))).toEqual({ id: 1 });
          release();
          expect(Realm.untracked(realm, (read) => read($value))).toBe(initial);
          const again = Source.observe($value);
          expect(Realm.untracked(realm, (read) => read($value))).toBe(initial);
          again();
        }),
      ),
      realm,
    );
  });

  test("takes the elements a stream emits as it starts", async () => {
    const reported: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => reported.push(error) });
    const seen = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const $value = yield* Program.fromStream(realm, Stream.make(1, 2, 3), 0);
          const $double = Computed.make(realm, (read) => read($value) * 2);
          const release = Source.observe($double);
          yield* settle;
          const value = Realm.untracked(realm, (read) => read($double));
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
    const realm = Realm.make({ onError: (error) => reported.push(error) });
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
          const $value = yield* Program.fromStream(realm, stream, 0);
          const release = Source.observe($value);
          yield* Queue.offer(queue, 1);
          yield* settle;
          const value = Realm.untracked(realm, (read) => read($value));
          release();
          expect(Realm.untracked(realm, (read) => read($value))).toBe(0);
          const tracked: Array<number> = [];
          const stop = Realm.watch(
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
          expect(Realm.untracked(realm, (read) => read($value))).toBe(2);
          stop();
          expect(Realm.untracked(realm, (read) => read($value))).toBe(0);
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
    const realm = Realm.make();
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const $value = yield* Program.fromStream(realm, Stream.make(1, 2), 0);
          const release = Source.observe($value);
          yield* settle;
          expect(Realm.untracked(realm, (read) => read($value))).toBe(2);
          release();
          expect(Realm.untracked(realm, (read) => read($value))).toBe(0);
        }),
      ),
      realm,
    );
  });

  test("closing the scope stops the stream, and observing again does not restart it", async () => {
    const realm = Realm.make();
    const log: Array<string> = [];
    const seen: Array<number> = [];
    await run(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<number>();
        const held = yield* Effect.scoped(
          Effect.gen(function* () {
            const $value = yield* Program.fromStream(realm, logged(log, queue), 0);
            const release = Realm.watch(
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
        expect(Realm.untracked(realm, (read) => read(held.$value))).toBe(0);
        held.release();
        const release = Source.observe(held.$value);
        yield* settle;
        release();
        expect(log).toEqual(["start", "stop"]);
        expect(Realm.untracked(realm, (read) => read(held.$value))).toBe(0);
      }),
      realm,
    );
  });

  test("runs the stream with the services of the program that made the value", async () => {
    class Greeting extends Context.Service<Greeting, string>()("test/Greeting") {}
    const realm = Realm.make();
    const seen = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const $value = yield* Program.fromStream(
            realm,
            Stream.fromEffect(
              Effect.gen(function* () {
                return yield* Greeting;
              }),
            ),
            "",
          );
          const release = Source.observe($value);
          yield* settle;
          const value = Realm.untracked(realm, (read) => read($value));
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
    const realm = Realm.make();
    const $value = Box.make(realm, 0);
    const log: Array<string> = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Program.whileObserved($value, logged(log));
          yield* settle;
          expect(log).toEqual([]);
          const first = Source.observe($value);
          const second = Source.observe($value);
          yield* settle;
          expect(log).toEqual(["start"]);
          first();
          yield* settle;
          expect(log).toEqual(["start"]);
          second();
          yield* settle;
          expect(log).toEqual(["start", "interrupt", "release"]);
          const third = Source.observe($value);
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
    const realm = Realm.make();
    const $count = Box.make(realm, 0);
    const seen: Array<number> = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<number>();
          yield* Program.whileObserved(
            $count,
            Stream.fromQueue(queue).pipe(
              Stream.runForEach((value) =>
                Effect.sync(() => {
                  Realm.update(realm, (_read, write) => {
                    write($count, value);
                  });
                }),
              ),
            ),
          );
          const stop = Realm.watch(
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
    const realm = Realm.make();
    const $value = Box.make(realm, "");
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Program.whileObserved(
            $value,
            Effect.gen(function* () {
              const greeting = yield* Greeting;
              Realm.update(realm, (_read, write) => {
                write($value, greeting);
              });
            }),
          );
          const release = Source.observe($value);
          yield* settle;
          expect(Realm.untracked(realm, (read) => read($value))).toBe("hello");
          release();
        }),
      ).pipe(Effect.provideService(Greeting, "hello")),
    );
  });

  test("a defect is logged, and the next observation starts the program again", async () => {
    const reported: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => reported.push(error) });
    const $value = Box.make(realm, 0);
    const { logged: logs, layer } = capture();
    const failure = new Error("boom");
    let runs = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Program.whileObserved(
            $value,
            Effect.suspend(() => {
              runs++;
              return Effect.die(failure);
            }),
          );
          const first = Source.observe($value);
          yield* settle;
          first();
          const second = Source.observe($value);
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
    const realm = Realm.make();
    const $value = Box.make(realm, 0);
    const log: Array<string> = [];
    const release = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Program.whileObserved($value, logged(log));
          const release = Source.observe($value);
          yield* settle;
          return release;
        }),
      ),
    );
    expect(log).toEqual(["start", "interrupt", "release"]);
    release();
    const again = Source.observe($value);
    await Effect.runPromise(settle);
    again();
    expect(log).toEqual(["start", "interrupt", "release"]);
  });
});

describe("RealmService", () => {
  test("a realm from createRealm() provides it", async () => {
    const realm = Realm.make();
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
    const realm = Realm.make();
    const $value = Box.schema(realm, Schema.Number, 0);
    const events: Array<string> = [];
    Source.onObserved($value, () => {
      events.push("start");
      return () => events.push("stop");
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Source.observeScoped($value);
          events.push("inside");
        }),
      ).pipe(Effect.provideService(RealmService, realm)),
    );

    expect(events).toEqual(["start", "inside", "stop"]);
  });
});
