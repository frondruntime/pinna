// The site's landing page prints the region of this file (apps/site/src/pages/index.astro), so
// `bun run typecheck` compiles what the page shows: Pinna on Effect Schema, in one sample.
import {
  BoxField,
  createRealm,
  decode,
  RealmService,
  SchemaModel,
  update,
  watchScoped,
} from "@frondruntime/pinna-effect";
import { Effect, Layer, Schema } from "effect";

// saveQuantity stands for the application's own request.
const saveQuantity = (id: string, quantity: number) => Effect.log(`save ${id}: ${quantity}`);

// #region effect
// One class decodes server data, checks every write to its box fields, and encodes back.
class Order extends SchemaModel<Order>("Order")({
  id: Schema.String,
  $quantity: BoxField(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
}) {}

const realm = createRealm();
const order = decode(realm, Order)({ id: "7", quantity: 2 });
Schema.encodeSync(Order)(order); // { id: "7", quantity: 2 }

// A value the schema refuses throws to the caller, with the Schema.SchemaError as its
// cause, and the update is undone.
try {
  update(realm, (_read, write) => {
    write(order.$quantity, -1);
  });
} catch (error) {
  console.error(error);
}

// A program stops with its scope: this one saves each change until the fiber is interrupted.
const save = watchScoped(
  realm,
  (read) => read(order.$quantity),
  (quantity) => saveQuantity(order.id, quantity),
);
const fiber = Effect.runFork(
  save.pipe(
    Effect.andThen(Effect.never),
    Effect.scoped,
    Effect.provide(Layer.succeed(RealmService, realm)),
  ),
);

// #endregion

export { fiber };
