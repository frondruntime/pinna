// The site's docs print the regions of this file (docs/public/effect/equality.md), so
// `bun run typecheck` compiles what the page shows.
import {
  BoxField,
  CollectionField,
  createRealm,
  decode,
  reconcileSchema,
  SchemaModel,
  schemaBox,
  update,
} from "@frondruntime/pinna-effect";
import { Equal, Hash, Schema } from "effect";

// #region box
const realm = createRealm();

const Reading = Schema.Struct({ at: Schema.Date, value: Schema.Number });
type Reading = typeof Reading.Type;

const $reading = schemaBox(realm, Reading, { at: new Date(0), value: 1 });

const record = (reading: Reading) => {
  update(realm, (_read, write) => {
    // A Date compares by its time: an equal reading keeps the object
    // the box holds, and nobody reruns.
    write($reading, reading);
  });
};
// #endregion

// #region models
class Position extends SchemaModel<Position>("Position")({
  id: Schema.String,
  $size: BoxField(Schema.Number),
}) {}

const samePosition = Schema.toEquivalence(Position);
const first = decode(realm, Position)({ id: "a", size: 1 });
const again = decode(realm, Position)({ id: "a", size: 1 });

// false: each decode makes its own $size box, and boxes compare by identity.
const positionsEqual = samePosition(first, again);
// #endregion

// #region refetch
// No `$` field, so a plain Schema.Class.
class Quote extends Schema.Class<Quote>("Quote")({
  symbol: Schema.String,
  price: Schema.Number,
}) {}

class Market extends SchemaModel<Market>("Market")({
  $quotes: CollectionField(Quote, { keyOf: (quote) => quote.symbol }),
}) {}

const market = decode(realm, Market)({ quotes: [] });

const receiveQuotes = (json: unknown) => {
  const quotes = decode(realm, Schema.Array(Quote))(json);
  update(realm, (_read, write) => {
    // A quote equal under Quote's schema is kept, and what read its row does not rerun.
    write.replaceAll(market.$quotes, quotes);
  });
};
// #endregion

// #region contents
const $positions = schemaBox(realm, Schema.Array(Position), []);

const receivePositions = (json: unknown) => {
  const fresh = decode(realm, Schema.Array(Position))(json);
  update(realm, (read, write) => {
    // A held id keeps its Position, and the new size goes into its $size box.
    write(
      $positions,
      reconcileSchema(read($positions), fresh, { keyOf: (position) => position.id }),
    );
  });
};
// #endregion

// #region ownEqual
class Rate extends SchemaModel<Rate>("Rate")({
  pair: Schema.String,
  $bid: BoxField(Schema.Number),
}) {
  // One rate per pair. Plain fields only: Effect caches what Equal.equals answers.
  [Equal.symbol](that: unknown): boolean {
    return that instanceof Rate && that.realm === this.realm && this.pair === that.pair;
  }

  [Hash.symbol](): number {
    return Hash.string(this.pair);
  }
}

const $rates = schemaBox(realm, Schema.Array(Rate), []);

const receiveRates = (json: unknown) => {
  const fresh = decode(realm, Schema.Array(Rate))(json);
  update(realm, (read, write) => {
    // A pair already held keeps its rate, and the new bid goes into that rate's box.
    write($rates, reconcileSchema(read($rates), fresh, { keyOf: (rate) => rate.pair }));
  });
};
// #endregion

// #region choosing
const Row = Schema.Struct({ id: Schema.String, price: Schema.Number });

// Every write is a change, even of an equal array.
const $log = schemaBox(realm, Schema.Array(Schema.String), [], { equals: Object.is });

// The same row while the id is the same, whatever the price.
const $selected = schemaBox(
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
