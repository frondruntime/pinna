---
title: Error messages
description: Read when Pinna throws or logs a message. Every message Pinna and pinna-effect throw or log, what caused it, and the fix.
---

This page lists every message Pinna and `@frondruntime/pinna-effect` throw or
log, grouped by the call that causes it, with the cause and the fix.
[Errors and debugging](../guides/errors.md) covers where an error goes and
how to find why a value recomputed.

## Rules

- Every message starts with `pinna: `, except the test realm's
  ([Testing](../guides/testing.md)).
- A part in angle brackets is filled in. `<name>` is the value's `{ name }`.
  Without one, a `read` or a `write` message prints `$observable`, and a
  message from a computed value prints `a derived value`.
- A `read` or a `write` message puts the name in quotes, such as
  `read("count")`.

## Answers

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

### Stages

| Error | Answers |
| --- | --- |
| `pinna: <call> runs on a stage that was already applied or dropped; ...` | A stage call after `applyStage` or `dropStage`, which close it once. `<call>` is `stageUpdate`, `stageRead`, `realmRead`, `applyStage`, or `dropStage`. A `dropStage` in the `catch` around `applyStage` throws this over the first error: call `applyStage` after the `try`. |
| `pinna: <verb> of a stage runs after its recipe returned; ...` | A `read` or a `write` a stage handed out, kept past its recipe. `<verb>` is `read`, `read.row`, `write`, `write.modify`, `write.upsert`, `write.remove`, `write.replaceAll`, or `write.changed`. |
| `pinna: <verb> does not run in a stage, which writes boxes only; ...` | `write.upsert`, `write.remove`, `write.replaceAll`, or `write.changed` in a `stageUpdate` recipe. The recipe's writes to the stage are put back. Write it in `update`, or in a watch after `applyStage`. |
| `pinna: read(<name>) of a computed value does not run through a stage, ...` | A computed value read through a stage, which would return the realm's value and not one over the staged boxes. Read the boxes, or the realm's value with `realmRead`. |
| `pinna: <call> runs inside a recipe of the same stage` | `stageUpdate`, `applyStage`, or `dropStage` on a stage inside one of its own recipes. |
| `pinna: stageUpdate cannot run in a computed value; ...` | As for `update`, with `stageUpdate` or `applyStage` in its place, and the same for a watch's select or a selector. |
| `pinna: stageRead cannot run in a computed value; ...` | `stageRead` or `realmRead` in a computed value, a watch's select, or a selector: a stage's reads are not tracked, so the derivation would go stale. |
| `pinna: stageUpdate recipes are synchronous; await outside, then stageUpdate` | A `stageUpdate` recipe that returned a promise. Its writes to the stage are put back. |
| `pinna: a stageUpdate recipe returns nothing` | A `stageUpdate` recipe that returned a value other than `undefined` or a promise. |

### Drafts

| Error | Answers |
| --- | --- |
| `pinna: write.modify drafts arrays and plain objects; ...` | `write.modify` on a box holding another kind of value. Write it whole with `write($box, value)`. |
| `pinna: a modify recipe returns nothing; write through the draft` | A `write.modify` recipe that returned a value. |
| `pinna: a draft is used after its recipe returned` | A draft kept past its recipe. |
| `pinna: write.modify left an object it wrote under two keys; ...` | A recipe wrote a draft and left it at a second key, inside itself, or inside an object the recipe placed at two keys, such as `draft.history.push(draft.present)` followed by a write to `draft.present`. The update is undone. Refer to the object by a key, or read a snapshot with `read($box)` before the write. |
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

## With Effect

| Error | Answers |
| --- | --- |
| `pinna: the box rejects this value: ...` | A write the schema refused, with the `Schema.SchemaError` as its `cause`. The update rolled back. |
| `pinna: Todo.a and Todo.b both read "key"; rename one` | Two fields under one wire key, thrown when the class is defined. The other naming errors are on [Classes](../effect/classes.md). |
| `pinna: the collection key <key> appears twice` | Also a `decode` of a [collection field](../effect/collections.md) given two rows of one key, inside the `Schema.SchemaError`. |
| `pinna: a watch effect died`, `pinna: a stream into a value died`, `pinna: a program run while observed died` | Logged at the error level, with the defect as its cause: a `watchScoped` effect, a `fromStream` stream, or a `whileObserved` program died. The watch keeps running. A stream's value keeps its last element while observed and resets to `initial` when the last observer leaves. The next observation starts a stream or a program again. |
| `Schema.SchemaError` | `decode` input that does not fit the schema. |

## See also

- [Errors and debugging](../guides/errors.md): which errors reach the caller, which go to `onError`, and `inspect`.
- [Updates](../state/updates.md): what an update undoes when it throws.
- [Collections](../state/collections.md): the writes that report a repeated key.
- [Classes](../effect/classes.md): the naming errors a `SchemaModel` throws when it is defined.
