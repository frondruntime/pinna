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

// #region effect
// One class decodes server data, checks every write to its box fields, and encodes back.
class Order extends SchemaModel<Order>("Order")({
  id: Schema.String,
  $quantity: BoxField(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
}) {}

const realm = createRealm();

// JSON from the server in: a checked Order with a live box. A field that does not fit throws.
const order = decode(realm, Order)({ id: "7", quantity: 2 });
Schema.encodeSync(Order)(order); // { id: "7", quantity: 2 }

// Every write to a box field is checked. A value the schema refuses throws to the caller of
// update, and the update is undone.
try {
  update(realm, (read, write) => {
    write(order.$quantity, read(order.$quantity) - 3); // 2 - 3: the schema refuses it
  });
} catch (error) {
  // "pinna: the box rejects this value: ...", and its cause is the SchemaError with the issue.
  if (error instanceof Error && Schema.isSchemaError(error.cause)) {
    console.error(error.cause.issue);
  }
}

// The realm is a service, and a program stops with its scope: this one saves each change
// until the fiber is interrupted. saveQuantity stands for the app's own request.
const saveQuantity = (id: string, quantity: number) => Effect.log(`save ${id}: ${quantity}`);
const RealmLive = Layer.succeed(RealmService, realm);
const save = watchScoped(
  (read) => read(order.$quantity),
  (quantity) => saveQuantity(order.id, quantity),
);
const fiber = Effect.runFork(
  save.pipe(Effect.andThen(Effect.never), Effect.scoped, Effect.provide(RealmLive)),
);

// #endregion

export { fiber };
