/**
 * The errors every Pinna package throws, each branded with `pinnaErrorKey`. A condition that code handles has
 * its own class with a literal `_tag` equal to its exported name, such as
 * `StageConflictError`; misuse, a bug in the caller, is one
 * `PinnaUsageError` with a `code`. Both are `PinnaError`s, plain `Error`
 * subclasses with no Effect dependency, so an Effect program matches them by
 * `_tag` and plain code by `isPinnaError` and `_tag`.
 *
 * Match by brand, never by `instanceof`: two copies of Pinna in one
 * application, from two versions or an add-on bundling its own, each have
 * their own classes, and `instanceof` fails across them.
 */

/** The string key that brands every `PinnaError`, kept the same in every copy of Pinna. */
export const pinnaErrorKey = "~pinna/Error";

/**
 * Each `_tag` a Pinna package throws, with its class. A package that adds an
 * error class adds its tag here through module augmentation, so
 * `isPinnaError(value, tag)` narrows to that class:
 *
 * ```ts
 * declare module "@frondruntime/pinna-core" {
 *   interface PinnaErrorByTag {
 *     StageConflictError: StageConflictError;
 *   }
 * }
 * ```
 */
export interface PinnaErrorByTag {
  PinnaUsageError: PinnaUsageError;
}

/** A `_tag` some Pinna package throws. */
export type PinnaErrorTag = keyof PinnaErrorByTag;

/**
 * The base of every error Pinna throws. Abstract: each concrete class writes
 * its `_tag` out, never derived from `constructor.name`, because minifiers
 * rename classes. `toJSON` gives `_tag`, `name`, `message`, and each class's
 * own fields, so a structured logger records more than `{}`.
 */
export abstract class PinnaError extends Error {
  readonly [pinnaErrorKey] = true as const;
  /** The exported name of the concrete class, such as `"StageConflictError"`. */
  abstract readonly _tag: string;

  toJSON(): Record<string, unknown> {
    return { _tag: this._tag, name: this.name, message: this.message };
  }
}

/**
 * Whether `value` is an error Pinna threw, from this copy of Pinna or any
 * other, by its brand. With `tag`, whether it is that error, narrowed to its
 * class.
 */
export function isPinnaError(value: unknown): value is PinnaError;
export function isPinnaError<Tag extends PinnaErrorTag>(
  value: unknown,
  tag: Tag,
): value is PinnaErrorByTag[Tag];
export function isPinnaError(value: unknown, tag?: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly [pinnaErrorKey]?: unknown })[pinnaErrorKey] === true &&
    (tag === undefined || (value as { readonly _tag?: unknown })._tag === tag)
  );
}

/**
 * The codes Pinna documents for a `PinnaUsageError`, each prefixed by the
 * package whose call the caller made. `docs/public/reference/errors.md`
 * lists each with its message, cause, and fix. A minor version may add a
 * code, so `PinnaUsageError.code` is typed open.
 */
export type PinnaUsageCode =
  // Reading and writing
  | "pinna/read-outside-place"
  | "pinna/write-outside-update"
  | "pinna/foreign-realm"
  | "pinna/not-made-by-pinna"
  | "pinna/peek-in-recipe"
  | "pinna/peek-while-tracking"
  // Updates and derivations
  | "pinna/update-in-derivation"
  | "pinna/async-recipe"
  | "pinna/recipe-returns-value"
  | "pinna/write-while-computing"
  | "pinna/observe-while-computing"
  | "pinna/cycle"
  | "pinna/depth-rebuilt"
  | "pinna/watchers-unsettled"
  | "pinna/hooks-unsettled"
  | "pinna/reentrant-run"
  | "pinna/scheduled-run-not-at-rest"
  | "pinna/unbalanced-batch"
  | "pinna/foreign-source"
  // Disposal
  | "pinna/realm-disposed"
  | "pinna/dispose-not-at-rest"
  // Stages
  | "pinna/stage-handle-kept"
  | "pinna/stage-read-writes"
  | "pinna/stage-child-open"
  | "pinna/stage-conflicts-option"
  | "pinna/stage-visible-option"
  | "pinna/realm-read-in-recipe"
  | "pinna/realm-write-in-recipe"
  | "pinna/made-in-recipe"
  | "pinna/call-in-recipe"
  // Drafts
  | "pinna/modify-not-draftable"
  | "pinna/draft-kept"
  | "pinna/draft-unsupported"
  | "pinna/draft-at-two-keys"
  | "pinna/draft-of-another-recipe"
  | "pinna/draft-in-write"
  // Declaring and values
  | "pinna/empty-name"
  | "pinna/box-takes-schema"
  // Collections
  | "pinna/undefined-row"
  | "pinna/repeated-key"
  | "pinna/row-listener-reentrant"
  | "pinna/row-listener-returns-value"
  // Views
  | "pinna/view-disposed"
  | "pinna/view-tie"
  | "pinna/view-compare-result"
  | "pinna/view-out-of-step"
  | "pinna/view-range"
  | "pinna/view-staged-rows"
  // Snapshots
  | "pinna/snapshot-not-state"
  | "pinna/snapshot-cycle"
  | "pinna/restore-shape"
  | "pinna/restore-plain-field"
  | "pinna/restore-cannot-make-row"
  // Change stream
  | "pinna/record-not-applicable"
  // Testing
  | "pinna/test-realm-not-at-rest"
  // pinna-effect
  | "pinna-effect/not-a-realm"
  | "pinna-effect/field-named-realm"
  | "pinna-effect/wire-key-twice"
  | "pinna-effect/box-field-undeclared"
  | "pinna-effect/box-field-unprefixed"
  | "pinna-effect/unsupported-static"
  | "pinna-effect/make-takes-instance"
  | "pinna-effect/make-takes-wire-key"
  | "pinna-effect/schema-class-changed"
  // pinna-react
  | "pinna-react/no-provider"
  | "pinna-react/not-a-realm"
  | "pinna-react/mixed-realms";

/**
 * Misuse: a bug in the caller, never a condition to recover from, so it
 * stays out of every Effect error channel as a defect. `code` names the
 * misuse; tests and handlers match on it, never on the message, whose
 * wording may change.
 */
export class PinnaUsageError extends PinnaError {
  readonly _tag = "PinnaUsageError" as const;
  /** Which misuse, from the documented list; a minor version may add one. */
  readonly code: PinnaUsageCode | (string & {});

  constructor(code: PinnaUsageCode | (string & {}), message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PinnaUsageError";
    this.code = code;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), code: this.code };
  }
}
