# Errors and debugging

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/guides/errors.md.

Sections: Example, Rules, Answers, With Effect, See also.

## Example

A realm takes `onError`: where an error goes when there is no caller to
throw to. `report` stands for the application's own error reporter.

```ts
import { Realm } from "@frondruntime/pinna";

// Errors with no caller to throw to: a watch effect's, an autorun's after
// its first run, an onObserved hook's. The host's reportError by default.
const realm = Realm.make({ onError: (error) => report(error) });
```

A computed value that throws keeps the error as its value. Every read
rethrows it, and it computes again only when what it read changes.

```ts
import { Box, Computed, Realm } from "@frondruntime/pinna";

const $count = Box.make(realm, 1, { name: "count" });

const $inverse = Computed.make(
  realm,
  (read) => {
    const count = read($count);
    if (count === 0) throw new Error("no inverse of zero");
    return 1 / count;
  },
  { name: "inverse" },
);

Realm.update(realm, (_read, write) => write($count, 0));
// Every read of $inverse throws "no inverse of zero" until $count changes.
```

A watch effect runs after the write has landed, so its error goes to
`onError`, not to the writer.

```ts
import { Realm } from "@frondruntime/pinna";

const stop = Realm.watch(
  realm,
  (read) => read($count),
  (count) => {
    if (count > 10) throw new Error(`too many: ${count}`);
  },
);

// The write lands; the effect's error goes to onError, and the watch keeps running.
Realm.update(realm, (_read, write) => write($count, 11));
```

`Source.inspect` reports what a value last read, how many observe it, and, for a
named computed value, why it last recomputed. It reports one level; inspect a
dependency to go further.

```ts
import { Realm, Source } from "@frondruntime/pinna";

Realm.update(realm, (_read, write) => write($count, 2));
const stopInverse = Realm.watch(
  realm,
  (read) => read($inverse),
  () => undefined,
);
Realm.update(realm, (_read, write) => write($count, 4));

Source.inspect($inverse);
// { name: "inverse", realm: undefined, dependencies: ["count"], observers: 1,
//   lastReason: "count changed" }
```

## Rules

- Errors with a caller throw to it: every misuse throws from the call that
  made it, and an update that throws rolls back. An `onError` that throws
  while a write's watchers run throws to the writer, with the writes in
  place.
- Errors without one go to `onError`: a watch effect's, an autorun's after
  its first run, a `Source.onObserved` hook's or cleanup's, and watchers that never
  settle. The first run of a `Realm.watch` or `Realm.autorun` throws to the caller, and
  nothing is watched.
- Name what gets debugged: `{ name }` on a box or a computed value.
  A named computed value keeps why it last recomputed, and its errors name
  it. An unnamed one costs nothing for names.
- Pinna has no development mode. Every check runs in every build.
- Every error Pinna throws is a `PinnaError` with a literal `_tag`. Catch a
  condition with `isPinnaError(error, "StageConflictError")`, which narrows
  to the class; a misuse is a `PinnaUsageError` whose `code` names it. Match
  by brand and `_tag`, never by `instanceof`, which fails across two copies
  of Pinna, and never by message text, which changes with the API.

## Answers

| Call | Answers |
| --- | --- |
| `Source.inspect($x)` | `{ name, realm, dependencies, observers, lastReason }`. `realm` is the name of the realm that made the value, `undefined` for an unnamed realm. |

Every message Pinna throws, with its cause and fix, is on
[Error messages](messages.md).

## With Effect

A schema adds errors with a caller, and a program has a place for defects.

- A write the schema of a [`Box.schema`](https://pinna.frondruntime.dev/docs/effect/boxes.md) or a `Model.boxField` refuses
  throws a `ValueRejectedError` from the write, and the update rolls back. Its
  `cause` is the `Schema.SchemaError` that says what did not fit. A row a
  [collection field](https://pinna.frondruntime.dev/docs/effect/collections.md) refuses throws the same error.
- `Model.decode` throws a `DecodeError` for input that does not fit the schema. Its
  `cause` is the `Schema.SchemaError`, and `issue` that error's issue.
- A [program's](https://pinna.frondruntime.dev/docs/effect/programs.md) defect is logged at the error level
  through Effect's logger. A `Program.watchScoped` watch keeps running; a
  `Program.fromStream` stream or a `Program.whileObserved` run ends, and the next
  observation starts it again.

Their messages are on [Error messages](messages.md#with-effect).

### Fields a schema refuses

A form shows each refused field beside its input, so it needs the field's
path and a message, not the error's text. A filter made with
`Schema.makeFilter` gives its own message when it returns a string in place
of `false`.

```ts
import { Schema } from "effect";

// A filter that returns a string fails with that string as its message.
const Password = Schema.String.check(
  Schema.makeFilter((password) => password.length >= 8 || "Use at least 8 characters"),
);

const Signup = Schema.Struct({ email: Schema.String, password: Password });
```

The `Schema.SchemaError` holds an `issue`, and
`SchemaIssue.makeFormatterStandardSchemaV1()` turns it into a list of
`{ path, message }`. `Model.decode` throws a `DecodeError` and a write a box
refuses a `ValueRejectedError`; each holds the `SchemaError` as its `cause`.

```ts
import { isPinnaError } from "@frondruntime/pinna-effect";
import { Schema, SchemaIssue } from "effect";

const toStandard = SchemaIssue.makeFormatterStandardSchemaV1();

// Each refused field's path and message. `Model.decode` throws a DecodeError and a
// write a box refuses a ValueRejectedError; each holds the SchemaError as its
// `cause`. Anything else is not a schema's refusal, and is thrown again.
const issuesOf = (error: unknown) => {
  const refused =
    isPinnaError(error, "DecodeError") || isPinnaError(error, "ValueRejectedError")
      ? error.cause
      : undefined;
  if (!Schema.isSchemaError(refused)) {
    throw error;
  }
  return toStandard(refused.issue).issues;
};
```

```ts
import { Box, Model, Realm } from "@frondruntime/pinna-effect";

const realm = Realm.make();
const $signup = Box.schema(realm, Signup, { email: "", password: "correct horse" });

const submit = (input: unknown) => {
  try {
    return { signup: Model.decode(realm, Signup)(input), issues: [] };
  } catch (error) {
    // [{ path: ["password"], message: "Use at least 8 characters" }]
    return { signup: undefined, issues: issuesOf(error) };
  }
};

const editPassword = (password: string) => {
  try {
    Realm.update(realm, (read, write) => {
      write($signup, { ...read($signup), password });
    });
    return [];
  } catch (error) {
    return issuesOf(error);
  }
};
```

- `Model.decode` stops at the first field it refuses, so for a struct such as
  `Signup` the list holds one issue: input with two bad fields reports the
  first. A union, or a filter that returns several issues, reports more.
- A field that is absent reads as `Missing key` at its path, and a value of
  the wrong type as `Expected` and the type, such as `Expected string`.
- A refused write leaves the box as it was, as every update that throws
  does, so the form keeps the last value that fit.
- An error that is neither is no schema's refusal, such as a failed request,
  and is thrown again rather than shown as a field's message.

## See also

- [Updates](https://pinna.frondruntime.dev/docs/state/updates.md): what an update undoes when it throws.
- [Reacting](https://pinna.frondruntime.dev/docs/state/reacting.md): watch and autorun, and their first run.
- [Programs](https://pinna.frondruntime.dev/docs/effect/programs.md): how a program reports a defect.
- [Error messages](messages.md): every message, its cause, and the fix.
- [Testing](testing.md): asserting on a rejected write.
- [Schema-checked boxes](https://pinna.frondruntime.dev/docs/effect/boxes.md): what a box checks, and when.
