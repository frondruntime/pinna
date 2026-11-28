# Programs: Example, Rules, Answers, Lifetimes, Failures as values

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/effect/programs.md, its sections "(introduction)", "Example", "Rules", "Answers", "Lifetimes", "Failures as values", "See also".

Sections: Example, Rules, Answers, Lifetimes, Failures as values, See also.

The Effect pages are for applications that already use Effect: see
[Schema-checked boxes](boxes.md). The functions on this page are for apps
written as Effect programs, and `@frondruntime/pinna-effect` exports them next
to the rest. Models and components need none of them. `Program.watchScoped` and
`Source.observeScoped` end in `Scoped`, Effect's suffix for a call that lives for the
caller's scope, because the plain `Realm.watch` and `Source.observe` keep their names and
return a stop function instead.

## Example

No program requires a service for the realm. `Program.watchScoped` and `Program.fromStream`
take it first, as `Realm.watch` does, and `Program.changes`, `Source.observeScoped`, and
`Program.whileObserved` take it from the observable, so a program that refuses every
requirement but `Scope` runs each of them.

```ts
import { Realm } from "@frondruntime/pinna-effect";

// Every program below takes the realm, or an observable that carries it,
// so none requires a service for it; a test makes a realm of its own.
const realm = Realm.make();
```

`Program.watchScoped` runs an effect for each change of what the select reads, in the
caller's scope. A new value interrupts the running effect: the latest value
wins. `search` stands for the application's own effect.

```ts
import { Box, Program, Realm } from "@frondruntime/pinna-effect";
import { Effect, Schema } from "effect";

const $query = Box.schema(realm, Schema.String, "");
const $results = Box.schema(realm, Schema.Array(Schema.String), []);

const searchAsTyped = Program.watchScoped(
  realm,
  (read) => read($query),
  (query) =>
    Effect.gen(function* () {
      // A newer query interrupts this effect, here or in the search.
      yield* Effect.sleep("200 millis");
      const results = yield* search(query);
      Realm.update(realm, (_read, write) => write($results, results));
    }),
);
```

`Program.changes` is a stream of the current value, then each change.

```ts
import { Program } from "@frondruntime/pinna-effect";
import { Effect, Stream } from "effect";

// The query now, then each change; a slow consumer skips to the newest.
const logQueries = Program.changes($query).pipe(
  Stream.runForEach((query) => Effect.log(`query: ${query}`)),
);
```

`Program.updates` is a stream of the realm's update records, every one of
them, for persistence or a log.

```ts
import { Program, type UpdateRecord } from "@frondruntime/pinna-effect";
import { Effect, Stream } from "effect";

// Every landed update's record, none skipped: a consumer that falls behind is buffered.
const persist = (record: UpdateRecord): Effect.Effect<void> =>
  Effect.log(`saving ${record.boxes.length} boxes`);
const saveEveryUpdate = Program.updates(realm).pipe(Stream.runForEach(persist));
```

`Program.fromStream` is a read-only value fed by a stream. The stream runs only while
the value is observed. When the last observer leaves, the value resets to
`initial` synchronously. Each run starts from `initial` until its first
element arrives. `fetchRate` stands for the application's own effect.

```ts
import { Box, Computed, Program } from "@frondruntime/pinna-effect";
import { Effect, Schedule, Schema, Stream } from "effect";

const $price = Box.schema(realm, Schema.Number, 10);

const priceInEuros = Effect.gen(function* () {
  // No rate until the stream emits, then its latest rate. The poll runs
  // only while $rate is observed. Losing the last observer resets $rate
  // to undefined, so a stale rate never shows as current.
  const $rate = yield* Program.fromStream<number | undefined>(
    realm,
    Stream.fromEffectSchedule(fetchRate, Schedule.spaced("1 minute")),
    undefined,
  );
  return Computed.make(realm, (read) => {
    const rate = read($rate);
    return rate === undefined ? undefined : read($price) * rate;
  });
});
```

`Program.fromEffect` is `Program.fromStream` over one Effect: one answer,
requested again for each observation. A failure the screen shows is mapped
into the value, as for a stream.

```ts
import { Program } from "@frondruntime/pinna-effect";
import { Effect } from "effect";

// One answer, not a stream: the effect runs while $settings is observed, and
// again for the next observation. A failure the screen shows is mapped into
// the value; the defaults stand in until the settings arrive, or when they
// cannot be read.
const defaults = new Settings({ currency: "USD" });

const settings = Program.fromEffect(
  realm,
  loadSettings.pipe(Effect.catchTag("SettingsUnavailable", () => Effect.succeed(defaults))),
  defaults,
  { name: "settings" },
);
```

`Program.whileObserved` runs a program while an observable is observed: from the
start when the first observer arrives, interrupted when the last one leaves.
It is how a feed writes the rows of a collection only while a list shows
them: a list reads `keys`, and a reader of one present row does not. `Program.fromStream` is the same lifetime around a single value. A row checked
against a schema lands in a `Collection.schema`
([Collection fields](collections.md)). `fetchTrades` and `tradeUpdates`
stand for the application's own snapshot and updates.

```ts
import { Schema } from "effect";

class Trade extends Schema.Class<Trade>("Trade")({
  id: Schema.String,
  notional: Schema.Number.check(Schema.isGreaterThan(0)),
}) {}
```

```ts
import { Box, Collection, Program, Realm } from "@frondruntime/pinna-effect";
import { Effect, Stream } from "effect";

const $trades = Collection.schema(realm, Trade, { keyOf: (trade) => trade.id });
// Only the app knows when its snapshot is complete, so the flag is its own.
const $loaded = Box.make(realm, false);

// A list observes the keys; a reader of one present row does not, so this
// feed runs while a list shows the trades.
const tradeFeed = Program.whileObserved(
  $trades.keys,
  Effect.gen(function* () {
    const trades = yield* fetchTrades;
    Realm.update(realm, (_read, write) => {
      write.replaceAll($trades, trades);
      write($loaded, true);
    });
    // The run ends when the last reader leaves, so it must not end before:
    // it runs the updates for as long as it is observed.
    yield* tradeUpdates.pipe(
      Stream.runForEach((trade) =>
        Effect.sync(() => Realm.update(realm, (_read, write) => write.upsert($trades, trade))),
      ),
    );
  }).pipe(
    // Not loaded once nobody reads it: the next reader waits for a new snapshot.
    Effect.ensuring(
      Effect.sync(() => Realm.update(realm, (_read, write) => write($loaded, false))),
    ),
  ),
);
```

`Source.observeScoped` holds a value observed until the scope closes, so the stream behind
it keeps running with nothing rendered.

```ts
import { Source } from "@frondruntime/pinna-effect";
import { Effect } from "effect";

const keepRateFresh = Effect.gen(function* () {
  const $euros = yield* priceInEuros;
  // Observed until the scope closes, rendered or not:
  // the poll keeps running, and $euros stays cached.
  yield* Source.observeScoped($euros);
  return $euros;
});
```

Each of them stops when its scope closes.

```ts
import { Effect } from "effect";

const main = Effect.gen(function* () {
  yield* searchAsTyped;
  yield* Effect.forkScoped(logQueries);
  yield* keepRateFresh;
  yield* tradeFeed;
});

// Every watch, stream, and hold above stops when the scope
// closes: here, when the fiber is interrupted.
const start = () => Effect.runFork(main.pipe(Effect.andThen(Effect.never), Effect.scoped));
```

## Rules

- Pass the realm, as `Realm.watch` takes it. A test makes a realm of its own.
  `RealmService` is for a `Model.Schema` decoded inside an Effect program
  ([Classes](classes.md)).
- A watch's effect has no error channel. A defect is a bug: it is logged at
  the error level, and the watch keeps running. A stream behind `Program.fromStream`
  logs a defect too.
- While observed, a `Program.fromStream` value is the last element of the current
  run, or `initial` before the first; while unobserved, it is `initial`. A
  stream that completes or dies leaves the value as it is until the last
  observer leaves. A failure the screen must show is an element the stream
  gives, such as a status beside the rate: see
  [Failures as values](programs.md#failures-as-values).
- A watch's select is tracked and must not write. Its effect writes through
  `Realm.update`.
- `Program.watchScoped` runs for changes, not for the current value, unless
  `{ immediate: true }` is passed: then its effect is also forked for the
  current value, with `previous` `undefined`, and inside `Realm.update` it
  throws `pinna/watch-immediate-in-update`, as `Realm.watch` does.
  `Program.changes` starts with the current value.
- `Program.changes`, `Source.observeScoped`, and `Program.whileObserved` take the realm from the
  observable. A host whose programs require nothing but `Scope` watches a
  box with `Program.changes` while its work awaits.
- A `Program.whileObserved` program runs in a scope of its own, closed when the run
  ends, so a fiber it forks into that scope stops with it. A program that
  returns ends its run while the value is still observed, and the next run
  starts only after the last observer leaves and another arrives: a feed
  ends on the stream it runs.
- `Program.whileObserved` and `Program.fromStream` keep the services of the program that
  called them, not of the code that observes later. Provide a service before
  the call.
- A program that writes more than one value per element runs on
  `Program.whileObserved` and writes them in one update. `Program.fromStream` publishes each
  element in an update of its own, so a box written from inside its stream
  lands one update earlier, and a reader of both sees them disagree.
- Whether a feed has loaded is the application's own box. Pinna cannot tell
  when a snapshot is complete. The program writes the flag in the same
  update as the rows, so no reader sees it loaded with the rows missing.
- `Program.watchScoped` and `Program.fromStream` compare with `Object.is` unless given
  `{ equals }`, as the core's `Realm.watch` and `Box.make` do: a value from a stream or
  a select has no schema to compare by, unlike a `Box.schema`. `Program.changes`
  takes no options and compares with `Object.is`.
- Stop a program by closing its scope, not by keeping stop functions.

## Answers

| Call | Answers |
| --- | --- |
| `Program.watchScoped(realm, (read) => ..., (value, previous) => effect, { equals?, name? })` | An effect that starts the watch in the caller's scope. A result equal under `equals`, `Object.is` by default, is no change, so it neither runs nor interrupts the effect. `previous` is the value the last effect that began ran with: an effect interrupted before it began is skipped, and moves nothing. `name` names the watch in its errors. Disposing the realm interrupts the effect it is running. |
| `Program.changes($x)` | A stream of `$x`'s current value, then each change; a slow consumer skips to the newest. Takes a box or a computed value, not an atom. It ends when its realm is disposed. |
| `Program.updates(realm)` | A stream of each record `Realm.onUpdate` hands out, from the next update on; a slow consumer gets every record, since the buffer is unbounded. It ends when the realm is disposed ([Change stream](https://pinna.frondruntime.dev/docs/state/changes.md)). |
| `Source.observeScoped($x)` | An effect that holds `$x`, a box, a computed value, or an atom, observed until the scope closes. |
| `Program.whileObserved($x, program)` | An effect that runs `program` while `$x`, a box, a computed value, or an atom, is observed, each run in a scope of its own. A defect is logged at the error level, and the next observation starts the program again. Closing the caller's scope interrupts a run and waits for it; later observation does not start it again. |
| `Program.fromStream(realm, stream, initial, { equals?, name? })` | A read-only value: `initial`, then the stream's latest element; needs the stream's services. The stream runs with the services of the program that made the value, and restarts each time the value is observed again. The value resets to `initial` when the last observer leaves or the scope closes; closing the scope stops the stream for good. An element equal under `equals`, `Object.is` by default, notifies nobody; `name` names the value for `Source.inspect`. |
| `Program.fromEffect(realm, effect, initial, { equals?, name? })` | `Program.fromStream(realm, Stream.fromEffect(effect), initial, options)`: a read-only value, `initial` until the effect succeeds, while observed. The effect runs from the start on each first observer and is interrupted when the last leaves, which resets the value; its error type is `never`, and a defect is logged at the error level. |
| `Realm.scoped(options?)` | An effect that makes a realm and disposes it with `Realm.dispose` when the scope closes. Programs started after it in the same scope close first, each awaiting its own release, so the realm disposes last. A `Layer` is `Layer.effect(RealmService, Realm.scoped())`. |
| `Stage.scoped(realm, (stage) => section, { name?, conflicts? })` | The section's value, with its stage applied; a section failure, defect, or interruption drops the stage and the outcome stands. A conflict fails with pinna's `StageConflictError`; a recipe that throws on replay is a defect. An interruption once landing began leaves the stage applied; the exit still contains `Interrupt`. |
| `Stage.scoped(stage, (child) => section, { name? })` | A savepoint over `stage`, with the same success and failure behavior. The child inherits its root's conflict mode, takes no `conflicts` option, and never fails with `StageConflictError`: its root checks what the child read. |
| `StageConflictError` | The error `Stage.scoped` fails with when a stage opened with `{ conflicts: "fail" }` finds that what it read changed: the one `Stage.apply` throws, moved from a throw to a failure so `Effect.catchTag("StageConflictError", ...)` and `Effect.retry` take it. It is matched by brand and `_tag`, so a conflict from another copy of Pinna fails the same way. |

## Lifetimes

Three owners run an effect, and the owner decides what stops it.

- Observation owns the stream of a `Program.fromStream` value and a `Program.whileObserved`
  program: each runs from the first observer to the last, and starts again with the next. This fits
  data that matters only while something shows it, such as a rate or a
  search result: the last observer leaving stops the work, and the value
  resets to `initial`, so a stale rate never shows as current.
- A fiber owns a feed whose data is kept whether shown or not, such as the
  quotes of a board that several screens and watches read from one
  collection. The feed runs until the fiber is interrupted, with nothing
  observing it ([Live data](live-data-with-effect.md#with-effect)).
- A scope owns a command, such as an order sent or a file saved. It runs
  to its end whatever the screen does, and only closing the scope
  interrupts it. This fits work a person started and expects finished.

A `Program.fromStream` value keeps the context of the program that made it, and its
stream runs with that context on every observation. A service the stream
needs is provided where the value is made, not where it is observed. The
stream's type lists the services it needs but not the clock, so a stream
that polls or sleeps keeps the clock of the program that made the value: a
test on `TestClock` provides it before the value is made
([Testing](https://pinna.frondruntime.dev/docs/effect/programs#testing)).

```ts
import { Program } from "@frondruntime/pinna-effect";
import { Context, Effect, Schedule, Stream } from "effect";

class Rates extends Context.Service<Rates, { readonly latest: Effect.Effect<number> }>()("Rates") {}

// The stream needs Rates, so making the value needs it: fromStream keeps the
// context of the program that makes the value, and the stream runs with it
// on every observation, whatever program observes the value later.
const makeRate = Program.fromStream<number | undefined, Rates>(
  realm,
  Stream.fromEffectSchedule(
    Effect.gen(function* () {
      const rates = yield* Rates;
      return yield* rates.latest;
    }),
    Schedule.spaced("1 minute"),
  ),
  undefined,
);

const rate = makeRate.pipe(Effect.provideService(Rates, { latest: fetchRate }));
```

A command that an event handler starts runs in a scope made once for the
application. `Effect.forkIn` runs it in that scope, and
`Effect.runForkWith(context)` gives it the application's services, the
clock among them, so a test's `TestClock` reaches the command too.

```ts
import { Box, Realm } from "@frondruntime/pinna-effect";
import { Effect } from "effect";

type OrderStatus = "idle" | "sending" | "sent";
const $orderStatus = Box.make<OrderStatus>(realm, "idle");

const sendOrder = (amount: number) =>
  Effect.gen(function* () {
    Realm.update(realm, (_read, write) => write($orderStatus, "sending"));
    yield* submit(amount);
    Realm.update(realm, (_read, write) => write($orderStatus, "sent"));
  });

// Made once, in the application's scope. An event handler calls `send`; the
// order runs in that scope, so unmounting the component that sent it, or the
// last observer of $orderStatus leaving, interrupts nothing. Closing the
// application's scope interrupts it. The order runs with the services the
// application was given, its clock among them.
const orders = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const context = yield* Effect.context<never>();
  const send = (amount: number): void => {
    Effect.runForkWith(context)(Effect.forkIn(sendOrder(amount), scope));
  };
  return { send };
});
```

`Effect.forkScoped` schedules its fiber and returns before the fiber runs,
so the next line cannot count on what the fiber writes.
`{ startImmediately: true }` runs the fiber up to its first wait at once.

```ts
import { Realm } from "@frondruntime/pinna-effect";
import { Effect } from "effect";

const sendAndRead = Effect.gen(function* () {
  // The fiber runs up to its first wait before the next line, so the read
  // sees "sending". Without startImmediately, it starts later, and the read
  // sees "idle".
  yield* Effect.forkScoped(sendOrder(10), { startImmediately: true });
  return Realm.untracked(realm, (read) => read($orderStatus));
});
```

## Failures as values

`Program.fromStream` takes a stream whose error type is `never`, because a value
has no channel for a failure. A typed failure the screen shows is mapped
into the value's own type: the good elements and the failure become members
of one union, and `Stream.catch` turns the failure into the last element.

```ts
import { Program } from "@frondruntime/pinna-effect";
import { Data, Stream } from "effect";

// The transport's typed failure.
class RateUnavailable extends Data.TaggedError("RateUnavailable")<{ readonly reason: string }> {}

// What the screen shows: a rate, or why there is none.
type RateState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Rate"; readonly rate: number }
  | { readonly _tag: "Unavailable"; readonly reason: string };

const showRate = (rates: Stream.Stream<number, RateUnavailable>) =>
  Program.fromStream<RateState>(
    realm,
    rates.pipe(
      Stream.map((rate): RateState => ({ _tag: "Rate", rate })),
      // The failure becomes the last element: the stream ends on it, and the
      // value shows it until the last observer leaves.
      Stream.catch((error) =>
        Stream.succeed<RateState>({ _tag: "Unavailable", reason: error.reason }),
      ),
    ),
    { _tag: "Loading" },
  );
```

The stream ends on the failure, and the value shows it until the last
observer leaves. The next observer starts the stream again, from `initial`.

## See also

- [Reacting](https://pinna.frondruntime.dev/docs/state/reacting.md): `Realm.watch` and `Realm.autorun` without Effect.
- [Classes](classes.md): `Model.decode`, JSON in and a checked model out.
- [Live data](https://pinna.frondruntime.dev/docs/guides/live-data.md): a WebSocket feed and a refetch as Effect programs.
- [Testing](https://pinna.frondruntime.dev/docs/guides/testing.md): a test realm, and a program run in it.
