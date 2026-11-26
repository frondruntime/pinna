import { expect, test } from "bun:test";
import { Schema } from "effect";
import { Collection, isPinnaError, Model, Realm, Source } from "../../src/index.ts";

class Item extends Model.Schema<Item>("Item")({
  id: Schema.String,
  $quantity: Model.boxField(Schema.Number),
}) {}

for (const operation of ["Model.restore", "Collection.reconcile"]) {
  // Edge (ruling 67), recorded in principles.md. D3-3: a write requested from a select nested in an
  // update is not refused; it lands.
  test(`${operation} from a select nested in an update is not refused`, () => {
    const realm = Realm.make();
    const item = Model.decode(realm, Item)({ id: "item", quantity: 1 });
    const fresh = Model.decode(realm, Item)({ id: "item", quantity: 9 });
    let refusal: string | undefined;
    Realm.update(realm, () => {
      const stop = Realm.watch(
        realm,
        (read) => {
          try {
            if (operation === "Model.restore") {
              Model.restore(realm, Item)(item, { id: "item", quantity: 9 });
            } else {
              Collection.reconcile([item], [fresh], { keyOf: (row) => row.id });
            }
          } catch (error) {
            if (!isPinnaError(error, "PinnaUsageError")) throw error;
            refusal = error.code;
          }
          return read(item.$quantity);
        },
        () => undefined,
      );
      stop();
    });
    expect({ refusal, quantity: Source.peek(item.$quantity) }).toEqual({
      refusal: undefined,
      quantity: 9,
    });
  });
}
