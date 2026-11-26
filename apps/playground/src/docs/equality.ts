// The site's docs print the regions of this file (docs/public/effect/equality.md), so
// `bun run typecheck` compiles what the page shows.
import { Box, Collection, Model, Realm } from "@frondruntime/pinna-effect";
import { Equal, Hash, Schema } from "effect";

// #region box
const realm = Realm.make();

const Reading = Schema.Struct({ at: Schema.Date, value: Schema.Number });
type Reading = typeof Reading.Type;

const $reading = Box.schema(realm, Reading, { at: new Date(0), value: 1 });

const record = (reading: Reading) => {
  Realm.update(realm, (_read, write) => {
    // A Date compares by its time: an equal reading keeps the object
    // the box holds, and nobody reruns.
    write($reading, reading);
  });
};
// #endregion

// #region models
class Position extends Model.Schema<Position>("Position")({
  id: Schema.String,
  $size: Model.boxField(Schema.Number),
}) {}

const samePosition = Schema.toEquivalence(Position);
const first = Model.decode(realm, Position)({ id: "a", size: 1 });
const again = Model.decode(realm, Position)({ id: "a", size: 1 });

// false: each decode makes its own $size box, and boxes compare by identity.
const positionsEqual = samePosition(first, again);
// #endregion

// #region refetch
// No `$` field, so a plain Schema.Class.
class Quote extends Schema.Class<Quote>("Quote")({
  symbol: Schema.String,
  price: Schema.Number,
}) {}

class Market extends Model.Schema<Market>("Market")({
  $quotes: Model.collectionField(Quote, { keyOf: (quote) => quote.symbol }),
}) {}

const market = Model.decode(realm, Market)({ quotes: [] });

const receiveQuotes = (json: unknown) => {
  const quotes = Model.decode(realm, Schema.Array(Quote))(json);
  Realm.update(realm, (_read, write) => {
    // A quote equal under Quote's schema is kept, and what read its row does not rerun.
    write.replaceAll(market.$quotes, quotes);
  });
};
// #endregion

// #region contents
const $positions = Box.schema(realm, Schema.Array(Position), []);

const receivePositions = (json: unknown) => {
  const fresh = Model.decode(realm, Schema.Array(Position))(json);
  Realm.update(realm, (read, write) => {
    // A held id keeps its Position, and the new size goes into its $size box.
    write(
      $positions,
      Collection.reconcile(read($positions), fresh, { keyOf: (position) => position.id }),
    );
  });
};
// #endregion

// #region ownEqual
class Rate extends Model.Schema<Rate>("Rate")({
  pair: Schema.String,
  $bid: Model.boxField(Schema.Number),
}) {
  // One rate per pair. Plain fields only: Effect caches what Equal.equals answers.
  [Equal.symbol](that: unknown): boolean {
    return that instanceof Rate && that.realm === this.realm && this.pair === that.pair;
  }

  [Hash.symbol](): number {
    return Hash.string(this.pair);
  }
}

const $rates = Box.schema(realm, Schema.Array(Rate), []);

const receiveRates = (json: unknown) => {
  const fresh = Model.decode(realm, Schema.Array(Rate))(json);
  Realm.update(realm, (read, write) => {
    // A pair already held keeps its rate, and the new bid goes into that rate's box.
    write($rates, Collection.reconcile(read($rates), fresh, { keyOf: (rate) => rate.pair }));
  });
};
// #endregion

// #region choosing
const Row = Schema.Struct({ id: Schema.String, price: Schema.Number });

// Every new array is a change, even one equal part by part.
const $log = Box.schema(realm, Schema.Array(Schema.String), [], { equals: Object.is });

// The same row while the id is the same, whatever the price.
const $selected = Box.schema(
  realm,
  Row,
  { id: "a", price: 1 },
  { equals: (held, next) => held.id === next.id },
);

// #endregion

export {
  $log,
  $reading,
  $selected,
  positionsEqual,
  receivePositions,
  receiveQuotes,
  receiveRates,
  record,
};
