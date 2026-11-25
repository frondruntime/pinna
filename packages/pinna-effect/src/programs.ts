/**
 * Effect programs over a realm. A service reacts to state in three ways:
 *
 * - `Program.watchScoped(select, effect)` runs `effect` for each change of what `select`
 *   reads, in the caller's scope. A new value interrupts a running effect and
 *   starts one for the new value: the latest value wins.
 * - `Program.changes($x)` streams an observable's current value, then each change.
 * - `Source.observeScoped($x)` holds an observable observed until the scope closes.
 *
 * And state reacts to a service: `Program.fromStream(stream, initial)` is a value fed
 * by a stream while something observes it, and `Program.whileObserved($x, program)`
 * runs a program while something observes `$x`, such as a feed that writes
 * the rows of a collection.
 *
 * None requires `RealmService`: `Program.watchScoped` and `Program.fromStream` take the
 * realm first, as `Realm.watch` does, and `Program.changes`, `Source.observeScoped`, and
 * `Program.whileObserved` take it from the observable. A program that refuses every
 * requirement but `Scope` runs each of them.
 */

import {
  Atom,
  type Box,
  Computed,
  type Read,
  Realm,
  type RealmOptions,
  Source,
  type UpdateRecord,
  type ValueOptions,
  type WatchOptions,
} from "@frondruntime/pinna";
import { peek, realmOf, onDispose as whenDisposed } from "@frondruntime/pinna/internal";
import { Cause, type Context, Effect, Fiber, Queue, type Scope, Stream } from "effect";

/**
 * Runs `onDispose` when `realm` is disposed, until the scope closes. It runs
 * before the realm stops anything, so a program ends before its watch is
 * stopped under it. A realm that began disposing after the program's watch
 * started, while the fiber yielded, runs `onDispose` at once: its listeners
 * have already run.
 */
const untilDisposed = (
  realm: Realm,
  onDispose: () => void,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => whenDisposed(realm, onDispose)),
    (remove) => Effect.sync(remove),
  );

/**
 * A realm that lives as long as the caller's scope: closing the scope runs
 * `Realm.dispose`. Programs started after it in the same scope stop first,
 * since a scope closes in reverse order, so each awaits its own release
 * before the realm disposes. A `Layer` is
 * `Layer.effect(RealmService, Realm.scoped())`.
 */
export const createRealmScoped = (
  options?: RealmOptions,
): Effect.Effect<Realm, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => Realm.make(options)),
    (realm) => Effect.sync(() => Realm.dispose(realm)),
  );

/**
 * Runs `effect` whenever `select`'s result changes, not for the current
 * value. `select` is tracked and must not write. A new value interrupts the
 * running effect. `previous` is the value the effect last ran with, or, before
 * its first run, the value the watch started from; a value replaced before the
 * effect saw it is never `previous`. The effect's error type is `never`, so a
 * defect is a bug: it is logged at the error level, through the program's
 * logger, and the watch keeps running. Closing the scope stops the watch and
 * interrupts the running effect. `options` are `Realm.watch`'s: `equals` decides
 * whether a result is a change, so an equal one neither runs the effect nor
 * interrupts it, `name` names the watch in its error messages, and
 * `scheduler` runs the select when the scheduler calls `run`, once for every
 * write before it, rather than before `Realm.update` returns.
 */
export const watchScoped = <Value>(
  realm: Realm,
  select: (read: Read) => Value,
  effect: (value: Value, previous: Value) => Effect.Effect<void>,
  options?: WatchOptions<Value>,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    // Subscribed before this returns, so a write right after it is seen.
    const values = yield* Queue.sliding<Value>(1);
    // What the effect last ran with; the value the watch started from until then.
    let ranWith: { readonly value: Value } | undefined;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        Realm.watch(
          realm,
          select,
          (value, previous) => {
            if (ranWith === undefined) {
              ranWith = { value: previous };
            }
            Queue.offerUnsafe(values, value);
          },
          options,
        ),
      ),
      (stop) => Effect.sync(stop),
    );
    // A new value interrupts the running effect, and waits for it to stop,
    // before the next runs. A queue and a child fiber, not a `Stream`, so
    // `Realm.make` does not keep Effect's streams in a bundle.
    const fiber = yield* Effect.forkScoped(
      Effect.gen(function* () {
        let running: Fiber.Fiber<void> | undefined;
        while (true) {
          const value = yield* Queue.take(values);
          if (running !== undefined) {
            yield* Fiber.interrupt(running);
          }
          const previous = (ranWith as { readonly value: Value }).value;
          ranWith = { value };
          running = yield* Effect.forkChild(
            Effect.suspend(() => effect(value, previous)).pipe(
              Effect.catchDefect((defect) =>
                Effect.logError("pinna: a watch effect died", Cause.die(defect)),
              ),
            ),
          );
        }
      }),
    );
    // Disposing the realm stops the watch; this ends the effect it may be running.
    yield* untilDisposed(realm, () => fiber.interruptUnsafe());
  });

/**
 * The current value of `observable`, then each change. A consumer that falls
 * behind gets the newest value and skips the ones between; it never misses
 * the last. The stream watches only while it runs, in the realm that made
 * `observable`, and requires no `RealmService`.
 */
export const changes = <Value>(observable: Box<Value> | Computed<Value>): Stream.Stream<Value> =>
  Stream.callback<Value>(
    (queue) =>
      Effect.gen(function* () {
        const realm = realmOf(observable);
        Queue.offerUnsafe(queue, peek(observable));
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            Realm.watch(
              realm,
              (read) => read(observable),
              (value) => {
                Queue.offerUnsafe(queue, value);
              },
            ),
          ),
          (stop) => Effect.sync(stop),
        );
        // Disposing the realm stops the watch; this ends the stream.
        yield* untilDisposed(realm, () => {
          Queue.endUnsafe(queue);
        });
      }),
    { bufferSize: 1, strategy: "sliding" },
  );

/**
 * Each record of `realm`'s landed updates, as `Realm.onUpdate` hands them
 * out, from the update after the stream starts. The buffer is unbounded: a
 * consumer that falls behind gets every record, since persistence that
 * skips one loses data. Ends when the realm is disposed, and requires no
 * `RealmService`.
 */
export const updates = (realm: Realm): Stream.Stream<UpdateRecord> =>
  Stream.callback<UpdateRecord>((queue) =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          Realm.onUpdate(realm, (record) => {
            Queue.offerUnsafe(queue, record);
          }),
        ),
        (stop) => Effect.sync(stop),
      );
      // Disposing the realm stops the listener; this ends the stream.
      yield* untilDisposed(realm, () => {
        Queue.endUnsafe(queue);
      });
    }),
  );

/**
 * Holds `observable` observed, as pinna's `Source.observe` does, until the caller's
 * scope closes.
 */
export const observeScoped = (
  observable: Box<unknown> | Computed<unknown> | Atom,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() => Source.observe(observable)),
      (release) => Effect.sync(release),
    );
  });

/**
 * Starts the run `start` gives when `observable` gains its first observer,
 * with the services in `context`, and stops it when the last observer leaves:
 * first `stop`, synchronously, then the program's interruption. Closing the
 * caller's scope removes the hook, stops a run, and waits for it to end.
 */
const runWhileObserved = <Requirements>(
  observable: Box<unknown> | Computed<unknown> | Atom,
  start: () => {
    readonly program: Effect.Effect<void, never, Requirements>;
    readonly stop: () => void;
  },
  context: Context.Context<Exclude<Requirements, Scope.Scope>>,
  died: string,
): Effect.Effect<void, never, Scope.Scope> => {
  // An interrupted run still owns its resources until its finalizers finish.
  const running = new Set<Fiber.Fiber<void>>();
  return Effect.acquireRelease(
    Effect.sync(() =>
      Source.onObserved(observable, () => {
        const { program, stop } = start();
        const fiber = Effect.runForkWith(context)(
          Effect.scoped(program).pipe(
            Effect.catchDefect((defect) => Effect.logError(died, Cause.die(defect))),
          ),
        );
        running.add(fiber);
        fiber.addObserver(() => running.delete(fiber));
        return () => {
          try {
            stop();
          } finally {
            fiber.interruptUnsafe();
          }
        };
      }),
    ),
    (remove) =>
      Effect.suspend(() => {
        // Ends the hook, which stops a running program.
        remove();
        return Effect.asVoid(Fiber.awaitAll(running));
      }),
  ).pipe(Effect.asVoid);
};

/**
 * Runs `program` while `observable` is observed: it starts when the first
 * observer arrives, from the beginning each time, and is interrupted when the
 * last one leaves. Each run has a scope of its own, closed when the run ends,
 * so what the program acquires is released between runs. The program runs
 * with the services of the program that called `Program.whileObserved`. Its error
 * type is `never`, so a defect is a bug: it is logged at the error level, and
 * the next observation starts it again. Closing the caller's scope interrupts
 * a run and waits for it to end; observing the value later does not start it
 * again.
 */
export const whileObserved = <Requirements = never>(
  observable: Box<unknown> | Computed<unknown> | Atom,
  program: Effect.Effect<void, never, Requirements>,
): Effect.Effect<void, never, Scope.Scope | Exclude<Requirements, Scope.Scope>> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Exclude<Requirements, Scope.Scope>>();
    yield* runWhileObserved(
      observable,
      () => ({ program, stop: () => undefined }),
      context,
      "pinna: a program run while observed died",
    );
  });

/**
 * A read-only value: while observed, the last element its stream gave in
 * this run, or `initial` before the first; while unobserved, `initial`. How
 * the stream ends, completing or dying, does not change the value. The stream
 * runs only while something observes the value: it starts with the first
 * observer, from the beginning each time, and is interrupted when the last
 * one leaves, which resets the value to `initial` synchronously. Each element
 * is written in its own update. The stream runs with the services of the
 * program that made the value. Its error type is `never`, so a defect is a
 * bug: it is logged at the error level. Closing the scope interrupts the
 * stream and resets the value to `initial`; observing the value later does
 * not start it again. `options.equals` compares an element
 * with the value held, so an equal one notifies nobody; `options.name` names
 * the value for `Source.inspect`.
 */
export const fromStream = <Value, Requirements = never>(
  realm: Realm,
  stream: Stream.Stream<Value, never, Requirements>,
  initial: Value,
  options?: ValueOptions<Value>,
): Effect.Effect<Computed<Value>, never, Scope.Scope | Requirements> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Requirements>();
    // Lifecycle state cannot belong to an update's rollback journal: closing
    // the scope inside an update that throws must not restore a stale value.
    // An atom tracks the closure, and its invalidation survives rollback too.
    const $changed = Atom.make(realm);
    let latest = initial;
    const equals = options?.equals ?? Object.is;
    const name = options?.name;
    const $value = Computed.make<Value>(
      realm,
      (read) => {
        read($changed);
        return latest;
      },
      name === undefined ? undefined : { name },
    );
    yield* runWhileObserved(
      $value,
      () => {
        let active = true;
        return {
          program: Stream.runForEach(stream, (value) =>
            Effect.sync(() => {
              if (active && !Object.is(latest, value) && !equals(latest, value)) {
                Realm.update(realm, (_read, write) => {
                  latest = value;
                  write.changed($changed);
                });
              }
            }),
          ),
          stop: () => {
            active = false;
            // Reset before interruption can run stream finalizers. The reset
            // bypasses element equality: it must restore `initial` itself.
            latest = initial;
            Realm.update(realm, (_read, write) => write.changed($changed));
          },
        };
      },
      context,
      "pinna: a stream into a value died",
    );
    return $value;
  });

/**
 * `Program.fromStream` over one Effect: a read-only value that is, while
 * observed, what `effect` succeeded with in this observation, or `initial`
 * before it succeeds; while unobserved, `initial`. The effect runs when the
 * first observer arrives, from the start each time, and is interrupted when
 * the last one leaves, which resets the value to `initial`. Its error type is
 * `never`, so a failure is mapped into the value first, with `Effect.catch`,
 * and a defect is a bug, logged at the error level. A promise enters through
 * `Effect.tryPromise`, whose signal aborts on the interruption. Scope,
 * services, `options`, and disposal are `Program.fromStream`'s.
 */
export const fromEffect = <Value, Requirements = never>(
  realm: Realm,
  effect: Effect.Effect<Value, never, Requirements>,
  initial: Value,
  options?: ValueOptions<Value>,
): Effect.Effect<Computed<Value>, never, Scope.Scope | Requirements> =>
  fromStream(realm, Stream.fromEffect(effect), initial, options);
