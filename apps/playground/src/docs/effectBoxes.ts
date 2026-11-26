// The site's docs print the regions of this file (docs/public/effect/boxes.md), so
// `bun run typecheck` compiles what the page shows.
import { Box, Computed, Model, Realm } from "@frondruntime/pinna-effect";
import { Schema } from "effect";

// #region box
const realm = Realm.make();

const $price = Box.schema(realm, Schema.Number, 10, { name: "price" });
const $tags = Box.schema(realm, Schema.Array(Schema.String), [], { name: "tags" });
// #endregion

// #region equivalence
const tagSale = () => {
  Realm.update(realm, (_read, write) => {
    // A new array each time, equal under the schema after the first:
    // the second call notifies nobody.
    write($tags, ["sale"]);
  });
};
// #endregion

// #region rejected
const $quantity = Box.schema(realm, Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), 1);
const $note = Box.schema(realm, Schema.String, "");

const take = (amount: number) => {
  Realm.update(realm, (read, write) => {
    write($note, `took ${amount}`);
    write($quantity, read($quantity) - amount); // throws below zero, and $note is undone too
  });
};
// #endregion

// #region modify
const addTag = (tag: string) => {
  Realm.update(realm, (_read, write) => {
    // The drafted array is checked against the schema once, when the recipe ends.
    write.modify($tags, (tags) => {
      tags.push(tag);
    });
  });
};

// #endregion

// #region related
// Both dates are one value, so one check sees them together.
const Stay = Schema.Struct({ checkIn: Schema.String, checkOut: Schema.String }).check(
  Schema.makeFilter((stay) => stay.checkIn < stay.checkOut || "Check out after checking in"),
);

class Booking extends Model.Schema<Booking>("Booking")({
  id: Schema.String,
  // As two fields, $checkIn and $checkOut, each check would see its own
  // date alone, and a write to one would never see the other.
  $stay: Model.boxField(Stay),
}) {}

const booking = Model.decode(
  realm,
  Booking,
)({
  id: "b1",
  stay: { checkIn: "2026-05-01", checkOut: "2026-05-03" },
});
// #endregion

// #region eligibility
// Today changes with no write to the stay, so no check on the stay sees it.
const $today = Box.make(realm, "2026-04-20");

// Checked once, as the input arrives.
const changeStay = (stay: typeof Stay.Type) => {
  Realm.update(realm, (read, write) => {
    if (stay.checkIn <= read($today)) {
      throw new Error("Check in after today");
    }
    write(booking.$stay, stay);
  });
};

// Whether the stay can still change is derived, so it follows today.
const $changeable = Computed.make(realm, (read) => read($today) < read(booking.$stay).checkIn);

// #endregion

export { $changeable, $price, $today, addTag, Booking, booking, changeStay, realm, tagSale, take };
