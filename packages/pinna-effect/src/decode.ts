/**
 * Decoding into a realm: `decode` provides the realm to the boxes and
 * `SchemaModel` instances a schema makes, as `RealmService`.
 */
import type { Realm } from "@frondruntime/pinna";
import { Cause, Context, Effect, Exit, Scheduler, Schema } from "effect";

/**
 * The realm an effect works in: `decode` provides it to the boxes and
 * `SchemaModel` instances it makes, and the Effect programs read it.
 */
export class RealmService extends Context.Service<RealmService, Realm>()("pinna/Realm") {}

/** The context `decode` takes for `S`: none when its schema needs no service but the realm. */
export type DecodeContext<S extends Schema.Top> = [
  Exclude<S["DecodingServices"], RealmService>,
] extends [never]
  ? readonly []
  : readonly [context: Context.Context<Exclude<S["DecodingServices"], RealmService>>];

/**
 * Decodes `input` with `schema`, putting every box and `SchemaModel`
 * instance it makes in `realm`. A schema that needs services, such as one
 * with a `FromContext` field however deep, takes a `Context` holding them:
 * `Context.make(Money, euros)`. One that needs none takes nothing. Throws
 * the `SchemaError` when `input` does not fit.
 */
export const decode = <S extends Schema.Top>(
  realm: Realm,
  schema: S,
  ...context: DecodeContext<S>
): ((input: unknown) => S["Type"]) => {
  const decodeEffect = Schema.decodeUnknownEffect(schema);
  const services = context[0] as Context.Context<never> | undefined;
  // A decode runs synchronously to the end, so yielding to the scheduler
  // every 2,048 operations buys nothing and allocates on each yield. The
  // realm goes last, so it is this realm even if `services` holds another.
  const own = Context.make(RealmService, realm).pipe(
    Context.add(Scheduler.PreventSchedulerYield, true),
  );
  const run = Effect.runSyncExitWith(services === undefined ? own : Context.merge(services, own));
  return (input) => {
    const exit = run(
      decodeEffect(input) as Effect.Effect<S["Type"], Schema.SchemaError, RealmService>,
    );
    if (Exit.isFailure(exit)) {
      throw Cause.squash(exit.cause);
    }
    return exit.value;
  };
};
