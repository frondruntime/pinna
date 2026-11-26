// The site's docs print the regions of this file (docs/public/effect/programs.md), so
// `bun run typecheck` compiles what the pages show.
import {
  Box,
  Collection,
  Computed,
  Program,
  Realm,
  Source,
  type UpdateRecord,
} from "@frondruntime/pinna-effect";
import { Context, Data, Effect, Schedule, Schema, Stream } from "effect";

// #region layer
// Every program below takes the realm, or an observable that carries it,
// so none requires a service for it; a test makes a realm of its own.
const realm = Realm.make();
// #endregion

const catalog = ["Write the docs", "Ship the site", "Measure Hermes"];
const search = (query: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.succeed(catalog.filter((title) => title.includes(query)));
const fetchRate: Effect.Effect<number> = Effect.succeed(1.08);

// #region watch
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
// #endregion

// #region changes
// The query now, then each change; a slow consumer skips to the newest.
const logQueries = Program.changes($query).pipe(
  Stream.runForEach((query) => Effect.log(`query: ${query}`)),
);
// #endregion

// #region updates
// Every landed update's record, none skipped: a consumer that falls behind is buffered.
const persist = (record: UpdateRecord): Effect.Effect<void> =>
  Effect.log(`saving ${record.boxes.length} boxes`);
const saveEveryUpdate = Program.updates(realm).pipe(Stream.runForEach(persist));
// #endregion

// #region fromStream
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
// #endregion

// #region trade
class Trade extends Schema.Class<Trade>("Trade")({
  id: Schema.String,
  notional: Schema.Number.check(Schema.isGreaterThan(0)),
}) {}
// #endregion

const fetchTrades: Effect.Effect<ReadonlyArray<Trade>> = Effect.succeed([]);
const tradeUpdates: Stream.Stream<Trade> = Stream.never;

// #region whileObserved
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
// #endregion

// #region observe
const keepRateFresh = Effect.gen(function* () {
  const $euros = yield* priceInEuros;
  // Observed until the scope closes, rendered or not:
  // the poll keeps running, and $euros stays cached.
  yield* Source.observeScoped($euros);
  return $euros;
});
// #endregion

// #region run
const main = Effect.gen(function* () {
  yield* searchAsTyped;
  yield* Effect.forkScoped(logQueries);
  yield* keepRateFresh;
  yield* tradeFeed;
});

// Every watch, stream, and hold above stops when the scope
// closes: here, when the fiber is interrupted.
const start = () => Effect.runFork(main.pipe(Effect.andThen(Effect.never), Effect.scoped));

// #endregion

// #region context
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
// #endregion

// #region failures
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
// #endregion

const submit = (_amount: number): Effect.Effect<void> => Effect.sleep("1 second");

// #region command
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
// #endregion

// #region startImmediately
const sendAndRead = Effect.gen(function* () {
  // The fiber runs up to its first wait before the next line, so the read
  // sees "sending". Without startImmediately, it starts later, and the read
  // sees "idle".
  yield* Effect.forkScoped(sendOrder(10), { startImmediately: true });
  return Realm.untracked(realm, (read) => read($orderStatus));
});

// #endregion

class Settings extends Schema.Class<Settings>("Settings")({
  currency: Schema.String,
}) {}

class SettingsUnavailable extends Data.TaggedError("SettingsUnavailable") {}

const loadSettings: Effect.Effect<Settings, SettingsUnavailable> = Effect.succeed(
  new Settings({ currency: "EUR" }),
);

// #region fromEffect
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

// #endregion

export {
  $orderStatus,
  type OrderStatus,
  orders,
  type RateState,
  RateUnavailable,
  rate,
  realm,
  saveEveryUpdate,
  sendAndRead,
  sendOrder,
  settings,
  showRate,
  start,
};
