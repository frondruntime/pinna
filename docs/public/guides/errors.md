---
title: Errors and debugging
description: Read when something throws or reruns unexpectedly. Know which errors reach the caller and which go to onError, how a computed value keeps its error, find why a value recomputed with inspect and names, and know the errors Effect adds.
---

## Example

A realm takes `onError`: where an error goes when there is no caller to
throw to. `report` stands for the application's own error reporter.

<!-- region errors.ts#onError -->

A computed value that throws keeps the error as its value. Every read
rethrows it, and it computes again only when what it read changes.

<!-- region errors.ts#computed -->

A watch effect runs after the write has landed, so its error goes to
`onError`, not to the writer.

<!-- region errors.ts#effect -->

`inspect` reports what a value last read, how many observe it, and, for a
named computed value, why it last recomputed. It reports one level; inspect a
dependency to go further.

<!-- region errors.ts#inspect -->

## Rules

- Errors with a caller throw to it: every misuse throws from the call that
  made it, and an update that throws rolls back. An `onError` that throws
  while a write's watchers run throws to the writer, with the writes in
  place.
- Errors without one go to `onError`: a watch effect's, an autorun's after
  its first run, an `onObserved` hook's or cleanup's, and watchers that never
  settle. The first run of a `watch` or `autorun` throws to the caller, and
  nothing is watched.
- Name what gets debugged: `{ name }` on a box, a computed value, or an atom.
  A named computed value keeps why it last recomputed, and its errors name
  it. An unnamed one costs nothing for names.
- Pinna has no development mode. Every check runs in every build.

## Answers

| Call | Answers |
| --- | --- |
| `inspect($x)` | `{ name, realm, dependencies, observers, lastReason }`. `realm` is the name of the realm that made the value, `undefined` for an unnamed realm. |

Every message Pinna throws, with its cause and fix, is on
[Error messages](../reference/errors.md).

## With Effect

A schema adds errors with a caller, and a program has a place for defects.

- A write the schema of a [`schemaBox`](../effect/boxes.md) or a `BoxField` refuses
  throws from the write, and the update rolls back. The error's `cause` is the
  `Schema.SchemaError` that says what did not fit. A row a
  [collection field](../effect/collections.md) refuses throws the same error.
- `decode` throws `Schema.SchemaError` for input that does not fit the schema.
- A [program's](../effect/programs.md) defect is logged at the error level
  through Effect's logger. A `watchScoped` watch keeps running; a
  `fromStream` stream or a `whileObserved` run ends, and the next
  observation starts it again.

Their messages are on [Error messages](../reference/errors.md#with-effect).

### Fields a schema refuses

A form shows each refused field beside its input, so it needs the field's
path and a message, not the error's text. A filter made with
`Schema.makeFilter` gives its own message when it returns a string in place
of `false`.

<!-- region effectErrors.ts#message -->

The `Schema.SchemaError` holds an `issue`, and
`SchemaIssue.makeFormatterStandardSchemaV1()` turns it into a list of
`{ path, message }`. `decode` throws the `SchemaError` itself; a write a box
refuses throws an `Error` whose `cause` is the `SchemaError`.

<!-- region effectErrors.ts#issues -->

<!-- region effectErrors.ts#read -->

- `decode` stops at the first field it refuses, so for a struct such as
  `Signup` the list holds one issue: input with two bad fields reports the
  first. A union, or a filter that returns several issues, reports more.
- A field that is absent reads as `Missing key` at its path, and a value of
  the wrong type as `Expected` and the type, such as `Expected string`.
- A refused write leaves the box as it was, as every update that throws
  does, so the form keeps the last value that fit.
- An error that is neither is no schema's refusal, such as a failed request,
  and is thrown again rather than shown as a field's message.

## See also

- [Updates](../state/updates.md): what an update undoes when it throws.
- [Reacting](../state/reacting.md): watch and autorun, and their first run.
- [Programs](../effect/programs.md): how a program reports a defect.
- [Error messages](../reference/errors.md): every message, its cause, and the fix.
- [Testing](./testing.md): asserting on a rejected write.
- [Schema-checked boxes](../effect/boxes.md): what a box checks, and when.
