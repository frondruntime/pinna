/**
 * Decoding into a realm: `Model.decode` provides the realm to the boxes and
 * `Model.Schema` instances a schema makes, as `RealmService`.
 */
import { PinnaError, type Realm } from "@frondruntime/pinna";
import { Cause, Context, Effect, Exit, Scheduler, Schema } from "effect";

/**
 * Thrown by the function `Model.decode` returns when its input does not fit the
 * schema: a condition code handles, such as a refetch that reports bad data.
 * `cause` is the `Schema.SchemaError`, and `issue` its issue, which says what
 * did not fit. An Effect program that decodes with `Schema.decodeUnknownEffect`
 * gets the `SchemaError` in its error channel instead.
 */
export class DecodeError extends PinnaError {
  readonly _tag = "DecodeError" as const;
  /** What did not fit, as Effect Schema reports it. */
  readonly issue: Schema.SchemaError["issue"];

  constructor(error: Schema.SchemaError) {
    super(`pinna: decode rejects the input: ${error.message}`, { cause: error });
    this.name = "DecodeError";
    this.issue = error.issue;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), issue: String(this.issue) };
  }
}

declare module "@frondruntime/pinna" {
  interface PinnaErrorByTag {
    DecodeError: DecodeError;
  }
}

/**
 * The realm an effect works in: `Model.decode` provides it to the boxes and
 * `Model.Schema` instances it makes, and the Effect programs read it.
 */
export class RealmService extends Context.Service<RealmService, Realm>()("pinna/Realm") {}

/** The context `Model.decode` takes for `S`: none when its schema needs no service but the realm. */
export type DecodeContext<S extends Schema.Top> = [
  Exclude<S["DecodingServices"], RealmService>,
] extends [never]
  ? readonly []
  : readonly [context: Context.Context<Exclude<S["DecodingServices"], RealmService>>];

/**
 * Decodes `input` with `schema`, putting every box and `Model.Schema`
 * instance it makes in `realm`. A schema that needs services, such as one
 * with a `Model.context` field however deep, takes a `Context` holding them:
 * `Context.make(Money, euros)`. One that needs none takes nothing. Throws
 * `DecodeError`, holding the `SchemaError`, when `input` does not fit.
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
      const failure = Cause.findErrorOption(exit.cause);
      // A defect, such as a usage error a field's constructor threw, goes through as itself.
      throw failure._tag === "Some" ? new DecodeError(failure.value) : Cause.squash(exit.cause);
    }
    return exit.value;
  };
};
