/**
 * Decode context: values a schema takes from its caller, never from the
 * wire, like serializr's `withContext`. A field made with `Model.context(tag)`
 * holds the service of an Effect `Context.Service` tag, and puts the tag in
 * the schema's decoding services, so anything that provides a service gives
 * the field its value: `Effect.provideService`, a `Layer`, or the `Context`
 * passed to `Model.decode`.
 *
 * A field reads the tag from the Effect context only, so the innermost
 * provider wins, as for any service. A module variable read first would be
 * faster (1.5 ms against 6.8 ms on 10,000 plain struct rows with one
 * context field each, on Bun), but Effect Schema reads a field when it
 * builds the decode, so an Effect decode nested inside `Model.decode` that
 * provides the same tag would get the outer value with no error.
 */
import { type Context, Effect, Option, Schema, SchemaGetter, SchemaTransformation } from "effect";

/** A field whose value is the service of the tag with `Identifier` and `Shape`. */
export type FromContext<Identifier, Shape> = Schema.decodeTo<
  Schema.declare<Shape>,
  Schema.optionalKey<Schema.Never>,
  Identifier
>;

/**
 * A field filled from the decode context: the service of `tag`, the caller's
 * own value, never on the wire and never encoded. A schema with such a
 * field, however deep, requires `tag` in its decoding services, so `Model.decode`
 * takes a `Context` holding it and an Effect decode does not run until
 * something provides it.
 */
export const FromContext = <Identifier, Shape>(
  tag: Context.Key<Identifier, Shape>,
): FromContext<Identifier, Shape> => {
  const field = Schema.optionalKey(Schema.Never).pipe(
    Schema.decodeTo(
      Schema.declare((_input: unknown): _input is Shape => true),
      new SchemaTransformation.Transformation<Shape, never, Identifier>(
        SchemaGetter.transformOptionalEffect(() => Effect.map(tag, Option.some)),
        SchemaGetter.transformOptional(() => Option.none()),
      ),
    ),
  );
  contextFields.add(field);
  return field as unknown as FromContext<Identifier, Shape>;
};

/**
 * The fields `Model.context` made: a snapshot leaves them out, because a
 * service is the caller's, never data, as encoding leaves them off the wire.
 */
export const contextFields = new WeakSet<object>();
