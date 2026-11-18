/**
 * Effect programs over a realm. A service reacts to state in three ways:
 *
 * - `watchScoped(select, effect)` runs `effect` for each change of what `select`
 *   reads, in the caller's scope. A new value interrupts a running effect and
 *   starts one for the new value: the latest value wins.
 * - `changes($x)` streams an observable's current value, then each change.
 * - `observeScoped($x)` holds an observable observed until the scope closes.
 *
 * And state reacts to a service: `fromStream(stream, initial)` is a value fed
 * by a stream while something observes it, and `whileObserved($x, program)`
 * runs a program while something observes `$x`, such as a feed that writes
 * the rows of a collection.
 *
 * `watchScoped`, `changes`, and `fromStream` read the realm from
 * `RealmService`; `observeScoped` and `whileObserved` take it from the
 * observable.
 */

import {
  type Atom,
  atom,
  type Box,
  type Computed,
  computed,
  type Options,
  observe,
  onObserved,
  type Read,
  update,
  watch,
} from "@frondruntime/pinna";
import { peek } from "@frondruntime/pinna/internal";
import { Cause, type Context, Effect, Fiber, Queue, type Scope, Stream } from "effect";
import { RealmService } from "./decode.ts";

/**
 * Runs `effect` whenever `select`'s result changes, not for the current
 * value. `select` is tracked and must not write. A new value interrupts the
 * running effect. `previous` is the value the effect last ran with, or, before
 * its first run, the value the watch started from; a value replaced before the
 * effect saw it is never `previous`. The effect's error type is `never`, so a
 * defect is a bug: it is logged at the error level, through the program's
 * logger, and the watch keeps running. Closing the scope stops the watch and
 * interrupts the running effect. `options` are `watch`'s: `equals` decides
 * whether a result is a change, so an equal one neither runs the effect nor
 * interrupts it, and `name` names the watch in its error messages.
 */
export const watchScoped = <Value>(
  select: (read: Read) => Value,
  effect: (value: Value, previous: Value) => Effect.Effect<void>,
  options?: Options<Value>,
): Effect.Effect<void, never, Scope.Scope | RealmService> =>
  Effect.gen(function* () {
    const realm = yield* RealmService;
    // Subscribed before this returns, so a write right after it is seen.
    const values = yield* Queue.sliding<Value>(1);
    // What the effect last ran with; the value the watch started from until then.
    let ranWith: { readonly value: Value } | undefined;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        watch(
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
    yield* Stream.fromQueue(values).pipe(
      Stream.switchMap((value) => {
        const previous = (ranWith as { readonly value: Value }).value;
        ranWith = { value };
        return Stream.fromEffect(
          Effect.suspend(() => effect(value, previous)).pipe(
            Effect.catchDefect((defect) =>
              Effect.logError("pinna: a watch effect died", Cause.die(defect)),
            ),
          ),
        );
      }),
      Stream.runDrain,
      Effect.forkScoped,
    );
  });

/**
 * The current value of `observable`, then each change. A consumer that falls
 * behind gets the newest value and skips the ones between; it never misses
 * the last. The stream watches only while it runs.
 */
export const changes = <Value>(
  observable: Box<Value> | Computed<Value>,
): Stream.Stream<Value, never, RealmService> =>
  Stream.callback<Value, never, RealmService>(
    (queue) =>
      Effect.gen(function* () {
        const realm = yield* RealmService;
        Queue.offerUnsafe(queue, peek(observable));
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            watch(
              realm,
              (read) => read(observable),
              (value) => {
                Queue.offerUnsafe(queue, value);
              },
            ),
          ),
          (stop) => Effect.sync(stop),
        );
      }),
    { bufferSize: 1, strategy: "sliding" },
  );

/**
 * Holds `observable` observed, as pinna's `observe` does, until the caller's
 * scope closes.
 */
export const observeScoped = (
  observable: Box<unknown> | Computed<unknown> | Atom,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() => observe(observable)),
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
      onObserved(observable, () => {
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
 * with the services of the program that called `whileObserved`. Its error
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
 * the value for `inspect`.
 */
export const fromStream = <Value, Requirements = never>(
  stream: Stream.Stream<Value, never, Requirements>,
  initial: Value,
  options?: Options<Value>,
): Effect.Effect<Computed<Value>, never, Scope.Scope | RealmService | Requirements> =>
  Effect.gen(function* () {
    const realm = yield* RealmService;
    const context = yield* Effect.context<RealmService | Requirements>();
    // Lifecycle state cannot belong to an update's rollback journal: closing
    // the scope inside an update that throws must not restore a stale value.
    // An atom tracks the closure, and its invalidation survives rollback too.
    const $changed = atom(realm);
    let latest = initial;
    const equals = options?.equals ?? Object.is;
    const name = options?.name;
    const $value = computed<Value>(
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
                update(realm, (_read, write) => {
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
            update(realm, (_read, write) => write.changed($changed));
          },
        };
      },
      context,
      "pinna: a stream into a value died",
    );
    return $value;
  });
