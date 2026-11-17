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
  made it, and an update that throws rolls back.
- Errors without one go to `onError`: a watch effect's, an autorun's after
  its first run, an `onObserved` hook's or cleanup's, and watchers that never
  settle. The first run of a `watch` or `autorun` throws to the caller, and
  nothing is watched.
- Name what gets debugged: `{ name }` on a box, a computed value, or an atom.
  A named computed value keeps why it last recomputed, and its errors name
  it. An unnamed one costs nothing for names.
- Pinna has no development mode. Every check runs in every build.

## Answers

Every message Pinna throws starts with `pinna: `, except the test realm's
([Testing](./testing.md)). A part in angle brackets is filled in:
`<name>` is the value's `{ name }`. Without one, a `read` or a `write` message
prints `$observable`, and a message from a computed value prints
`a derived value`. A `read` or a `write` message puts the name in quotes,
such as `read("count")`.

### Reading and writing

| Error | Answers |
| --- | --- |
| `pinna: read(<name>) runs outside a place. ...` | A `read` used outside every place of its realm, such as one kept in a closure. Pass `read` down instead. |
| `pinna: read.row($collection, key) runs outside a place. ...` | The same, for `read.row`. |
| `pinna: write inside update` | A `write` kept past its update. |
| `pinna: <verb>(<name>) is handed an observable of another realm. ...` | A `read` or a `write` of one realm given what another realm made. `<verb>` is `read`, `read.row`, `write`, `write.modify`, `write.upsert`, `write.remove`, `write.replaceAll`, or `write.changed`. A realm made with `createRealm({ name })` is named in the message, such as `(realm "quotes", not "ui")`. Build each observable from the realm that reads it. |
| `pinna: <call> needs a box, a computed value, or an atom` | `onObserved`, `observe`, or `inspect` given a value Pinna did not make. |
| `pinna: expected a box, a computed value, or an atom` | `useValues` given a value Pinna did not make. |

### Updates

| Error | Answers |
| --- | --- |
| `pinna: update cannot run in a computed value; ...` | An update inside a computed value or a computed function's value. Write from an event, a watch's effect, or an autorun. `onRowChange` called there says `onRowChange` in place of `update`. |
| `pinna: update cannot run in a watch's select or a selector; ...` | An update inside a watch's select or a `useSelect` function. Write from an event, a watch's effect, or an autorun. `onRowChange` called there says `onRowChange` in place of `update`. |
| `pinna: update recipes are synchronous; await outside, then update` | A recipe that returned a promise. The update is undone. Await outside, then update. |
| `pinna: an update recipe returns nothing` | A recipe that returned a value other than `undefined` or a promise. The update is undone. |
| `pinna: <name> cannot write while it computes` | A computed value that wrote, through a `write` kept from an update. |

### Drafts

| Error | Answers |
| --- | --- |
| `pinna: write.modify drafts arrays and plain objects; ...` | `write.modify` on a box holding another kind of value. Write it whole with `write($box, value)`. |
| `pinna: a modify recipe returns nothing; write through the draft` | A `write.modify` recipe that returned a value. |
| `pinna: a draft is used after its recipe returned` | A draft kept past its recipe. |
| `pinna: a draft does not take defineProperty; assign instead` | `Object.defineProperty` on a draft. |
| `pinna: a draft cannot change its prototype` | `Object.setPrototypeOf` on a draft. |

### Declaring

| Error | Answers |
| --- | --- |
| `pinna: a name is a non-empty string` | `{ name: "" }`. |
| `pinna: box takes a value, not a schema; ...` | `box` given an Effect schema. A box that checks a schema is `schemaBox` from `@frondruntime/pinna-effect`. |

### Computed values and watchers

| Error | Answers |
| --- | --- |
| `pinna: <name> is read while it computes (cycle)` | A computed value that reads itself, directly or through others. |
| `pinna: <name> cannot observe or release while it computes` | A `watch`, an `autorun`, an `observe`, or a release inside a computed value. |
| `pinna: watchers did not settle after 100 rounds` | Sent to `onError`: watchers kept changing what they read, such as an autorun that writes what it reads on every run. Make the write settle. |
| `pinna: onObserved hooks did not settle after 100 passes` | Sent to `onError`: hooks kept starting other hooks. The hooks still due wait for the next settle. |

### Collections

| Error | Answers |
| --- | --- |
| `pinna: the collection key <key> appears twice` | A [collection](../state/collections.md)'s `write.replaceAll` given two rows of one key. Nothing is written. |
| `pinna: reconcile: the key <key> appears twice` | `reconcile` given two items of one key in `next`. |
| `pinna: <verb> on the collection an onRowChange listener is reporting; ...` | A listener that wrote the collection it listens to. `<verb>` is `write.upsert`, `write.remove`, or `write.replaceAll`. The write fails and is put back. |
| `pinna: onRowChange on the collection an onRowChange listener is reporting` | A listener that added another listener to the collection it listens to. |
| `pinna: an onRowChange listener is synchronous and returns nothing` | A listener that returned a value, such as a promise. The write fails and is put back. |
| `pinna: onRowChange needs a collection made by Pinna` | `onRowChange` given a value Pinna did not make. |

### React

| Error | Answers |
| --- | --- |
| `pinna: useRealm and useSelect need a RealmProvider above the component` | `useRealm` or `useSelect` with no `RealmProvider` above. `useValue` and `useValues` need none. |
| `pinna: expected a realm made by createRealm()` | `useSelect` under a `RealmProvider` given something other than a realm. |
| `pinna: useValues takes observables of one realm` | `useValues` given observables of two realms; named realms are named in the message. |

### Inspecting

| Call | Answers |
| --- | --- |
| `inspect($x)` | `{ name, realm, dependencies, observers, lastReason }`. `realm` is the name of the realm that made the value, `undefined` for an unnamed realm. |

## With Effect

A schema adds errors with a caller, and a program has a place for defects.

- A write the schema of a [`schemaBox`](../effect/boxes.md) or a `BoxField` refuses
  throws from the write, and the update rolls back. The error's `cause` is the
  `Schema.SchemaError` that says what did not fit. A row a
  [collection field](../effect/collections.md) refuses throws the same error.
- `decode` throws `Schema.SchemaError` for input that does not fit the schema.
- A [program's](../effect/programs.md) defect is logged at the error level
  through Effect's logger, and the watch or stream keeps running.

| Error | Answers |
| --- | --- |
| `pinna: the box rejects this value: ...` | A write the schema refused, with the `Schema.SchemaError` as its `cause`. The update rolled back. |
| `pinna: Todo.a and Todo.b both read "key"; rename one` | Two fields under one wire key, thrown when the class is defined. The other naming errors are on [Classes](../effect/classes.md). |
| `pinna: the collection key <key> appears twice` | Also a `decode` of a [collection field](../effect/collections.md) given two rows of one key, inside the `Schema.SchemaError`. |
| `pinna: a watch effect died`, `pinna: a stream into a value died`, `pinna: a program run while observed died` | Logged at the error level, with the defect as its cause: a `watchScoped` effect, a `fromStream` stream, or a `whileObserved` program died. The watch keeps running. A stream's value keeps its last element while observed and resets to `initial` when the last observer leaves. The next observation starts a stream or a program again. |
| `Schema.SchemaError` | `decode` input that does not fit the schema. |

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
- [Testing](./testing.md): asserting on a rejected write.
- [Schema-checked boxes](../effect/boxes.md): what a box checks, and when.
