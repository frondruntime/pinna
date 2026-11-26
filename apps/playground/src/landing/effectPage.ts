// The site's /effect page prints the regions of this file (apps/site/src/pages/effect.astro), so
// `bun run typecheck` compiles what the page shows: models on Effect Schema, then the programs
// that react to them.
import { Computed, Model, Program, Realm, RealmService, Source } from "@frondruntime/pinna-effect";
import { Data, Effect, Layer, Schema, Stream } from "effect";

// #region model
// A line holds a plain field, and a box field whose schema checks every write.
class Line extends Model.Schema<Line>("Line")({
  sku: Schema.String,
  $quantity: Model.boxField(Schema.Int.check(Schema.isGreaterThan(0))),
}) {}

// An order holds its lines by key, and derives the units from them.
class Order extends Model.Schema<Order>("Order")({
  id: Schema.String,
  $lines: Model.collectionField(Line, { keyOf: (line) => line.sku }),
}) {
  readonly $units = Computed.make(this.realm, (read) =>
    read(this.$lines.rows).reduce((units, line) => units + read(line.$quantity), 0),
  );

  // A quantity the schema refuses, such as 0, throws to the caller with the
  // Schema.SchemaError as its cause, and the update is undone.
  setQuantity(sku: string, quantity: number): void {
    Realm.update(this.realm, (read, write) => {
      const line = read.row(this.$lines, sku);
      if (line !== undefined) write(line.$quantity, quantity);
    });
  }
}

const realm = Realm.make();

// JSON in, a checked Order out; input that does not fit throws a DecodeError.
const order = Model.decode(realm, Order)({ id: "7", lines: [{ sku: "pen", quantity: 2 }] });
Schema.encodeSync(Order)(order); // { id: "7", lines: [{ sku: "pen", quantity: 2 }] }
// #endregion

class RateUnavailable extends Data.TaggedError("RateUnavailable")<{ readonly reason: string }> {}
const rates: Stream.Stream<number, RateUnavailable> = Stream.never;
const saveUnits = (id: string, units: number) => Effect.log(`save ${id}: ${units}`);

// #region programs
// The realm is a service: one layer provides it, and a test provides its own.
const RealmLive = Layer.succeed(RealmService, realm);

// Saves on each change of the units; a newer change interrupts the save still running.
const save = Program.watchScoped(
  realm,
  (read) => read(order.$units),
  (units) => saveUnits(order.id, units),
);

// A value fed by a stream while something reads it. It has no error channel,
// so the failure becomes the last element, and the screen shows it.
type Rate =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Rate"; readonly rate: number }
  | { readonly _tag: "Unavailable"; readonly reason: string };

const rate = Program.fromStream<Rate>(
  realm,
  rates.pipe(
    Stream.map((rate): Rate => ({ _tag: "Rate", rate })),
    Stream.catch((error) => Stream.succeed<Rate>({ _tag: "Unavailable", reason: error.reason })),
  ),
  { _tag: "Loading" },
);

// The watch, the stream, and the hold stop when the scope closes.
const main = Effect.gen(function* () {
  yield* save;
  const $rate = yield* rate;
  yield* Source.observeScoped($rate); // the stream runs, rendered or not
});
const fiber = Effect.runFork(
  main.pipe(Effect.andThen(Effect.never), Effect.scoped, Effect.provide(RealmLive)),
);

// #endregion

export { fiber, order };
