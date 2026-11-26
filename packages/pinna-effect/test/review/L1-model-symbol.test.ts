import { expect, test } from "bun:test";
import { Schema } from "effect";
import { Collection, Model, Realm } from "../../src/index.ts";

const reference = Symbol("reference");
class Quote extends Model.Schema<Quote>("Quote")({
  id: Schema.String,
  [reference]: Schema.Number,
}) {}

test("Model.decode retains a declared symbol-keyed field", () => {
  const realm = Realm.make();
  const quote = Model.decode(realm, Quote)({ id: "q", [reference]: 7 });
  expect(quote[reference]).toBe(7);
});

test("reconcile replaces a model whose plain symbol-keyed field changed", () => {
  const realm = Realm.make();
  const previous = Quote.make({ realm, id: "q", [reference]: 1 });
  const incoming = Quote.make({ realm, id: "q", [reference]: 2 });
  expect(previous[reference]).toBe(1);
  expect(incoming[reference]).toBe(2);
  const result = Collection.reconcile([previous], [incoming], { keyOf: (quote) => quote.id });
  expect(result[0]?.[reference]).toBe(2);
});
