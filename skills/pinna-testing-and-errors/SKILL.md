---
name: pinna-testing-and-errors
description: "Use when testing code on Pinna or when Pinna throws: testRealm, record, held, retainedKeys from @frondruntime/pinna/testing, a PinnaError, a pinna/ code, ValueRejectedError, DecodeError, a message starting 'pinna: ', onError, Source.inspect. For new features use pinna-state."
---

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->

# Testing Pinna code and tracing its errors

Tests code on Pinna with a realm per test that reports what it left running, and traces a Pinna error from its message or code to its cause and fix.

## Every skill assumes

For an agent writing an application on Pinna. Pinna is not Pinia, Vue's
store; it shares no API with it. Import the modules from
`@frondruntime/pinna`, whose boxes and models take no schema, or from
`@frondruntime/pinna-effect`, whose modules hold the same members and add
`Box.schema` and `Model.Schema` to check a schema (`effect` is its peer
dependency); the hooks come from `@frondruntime/pinna-react`. Every call is
a member of its type's module, and the module's name is also the type:
`const $count: Box<number> = Box.make(realm, 0)`, `Realm.update`,
`Stage.apply`, `Model.Class`. Import from one of the two packages in a
file, never both: each exports its own `Box`. The full documentation is at
<https://pinna.frondruntime.dev/docs/start>; this page is what to keep in
mind while writing code.

1. **`$` means observable.** A name that starts with `$` is a box, a
   computed value, an atom, or a collection. Everything else is plain,
   `readonly` data: read it anywhere, never write it.

2. **Read with the `read` a place hands out.** An observable has no read
   or write methods. `Computed.make`, `Computed.fn`, `Realm.watch`'s select,
   `Realm.autorun`, `Realm.update`, `Realm.untracked`, and `useSelect` each pass their
   function a `read`: `Computed.make(realm, (read) => read($a) + 1)`.
   Never keep a `read` past its place: outside every place of its realm
   it throws, and inside another it reads as that place's `read`. Pass it
   down instead.

3. **Write with the `write` that `Realm.update` hands out.**
   `Realm.update(realm, (read, write) => { ... })`: `write($box, value)` replaces a
   value; `write.modify($box, (draft) => { ... })` drafts arrays and plain
   objects; a collection takes `write.upsert`, `write.remove`, and
   `write.replaceAll`; an atom takes `write.changed`. An update that throws
   is rolled back, but only its writes: a request sent inside the recipe
   has gone out. Run an effect that cannot be taken back after the update,
   from a `Realm.watch`
   (<https://pinna.frondruntime.dev/docs/state/updates#effects-after-the-update>).

## Rules

### In a test

- A test reads through `Source.peek` or `Realm.untracked` and writes
  through `Realm.update`, as application code does. It makes its realm
  with `using realm = testRealm()` and records what a select changed to
  with `using values = record(realm, select)`, both from
  `@frondruntime/pinna/testing`; the realm's dispose throws if a watch, an
  autorun, a `Source.observe`, a `Collection.onRowChange` listener, or a
  stage is still running, and disposes the realm either way. An autorun,
  a watch with its own effect, or a `Source.observe` is held with
  `using _ = held(stop)`, so a failed assertion still stops it.
  `retainedKeys($items)` names the keys a collection still keeps something
  for, so a test checks that removed rows were let go.
- Assert on `_tag` and `code`, not on the message.

### When it throws

Every error is a `PinnaError` with a literal `_tag`; a misuse is a
`PinnaUsageError` whose `code` names it
(<https://pinna.frondruntime.dev/docs/reference/errors> lists each).

- Catch a condition with `isPinnaError(error, "StageConflictError")`, which
  narrows to the class. Never `instanceof`: two copies of Pinna in one app
  each have their own classes. Never the message text: it changes with the
  API.
- `read(...) runs outside a place`: a `read` kept past its place, in
  a closure or a variable, then called. Read in the place itself.
- `write inside Realm.update`: a `write` kept past its update. Write
  inside the update, usually in a model method.
- `... is handed an observable of another realm`: a `read` or a
  `write` of one realm given what another realm made; a realm made
  with `Realm.make({ name })` is named, as `(realm "quotes", not "ui")`.
  Build every observable from the realm that reads it.
- `the box rejects this value: ...`: a `ValueRejectedError`; the value
  does not match the field's schema, and `cause` is the `SchemaError`.
- `decode rejects the input: ...`: a `DecodeError` from `Model.decode`; `cause`
  is the `SchemaError`, and `issue` says what did not fit.
- `Realm.update cannot run in a computed value` or `in a watch's select or a
  selector`: a derivation only reads. Write from an event, a watch's
  effect, or an autorun.
- `... runs on a stage after it was applied`: a stage call after it
  closed. Open a new stage; `Stage.drop` alone does nothing there.
- `... changed since the stage read ...; nothing lands`: a
  `StageConflictError` from a stage opened with `{ conflicts: "fail" }`;
  nothing landed. A visible stage stopped by one throws it from
  `Stage.update`, `Stage.read`, and `Stage.apply`. Rerun the work over
  the new values, if its requests are safe to repeat. Name boxes and collections (`{ name }`) so the error names
  them.
- `... is made inside a stage recipe` or `a stage recipe writes the
  realm`: a recipe made something or wrote around its stage. Make it
  outside the recipe, and write through the recipe's own `write`.
- `watchers did not settle after 100 rounds`, sent to `onError`: an
  autorun or a watch effect writes what it reads on every run. Make the
  write settle, or derive the value with `Computed.make`.

Pass `{ name }` to `Computed.make`, `Box.make`, `Computed.fn`,
`Collection.make`, or `Model.collectionField`
(`Computed.make(this.realm, (read) => ..., { name: "Todos.remaining" })`)
and its errors name it. A `Model.boxField` takes no name, so its errors say
`$observable`. `Source.inspect($x)` reports what a value read and
why it last recomputed.

## References

Open a file under `references/` when its condition holds.

| File | Read when |
| --- | --- |
| [testing.md](references/testing.md) | Read when writing tests. Make a test realm per test, read and write as application code does, record what a select changed to, check what a collection still holds, and test models and programs with Effect. |
| [testing-programs.md](references/testing-programs.md) | Read when testing an Effect program on Pinna: the test realm in a scope, and what it reports left running. |
| [messages.md](references/messages.md) | Read when Pinna throws or logs a message. Every message Pinna and pinna-effect throw or log, its _tag or code, what caused it, and the fix. |
| [errors.md](references/errors.md) | Read when something throws or reruns unexpectedly. Know which errors reach the caller and which go to onError, how a computed value keeps its error, find why a value recomputed with inspect and names, and know the errors Effect adds. |

## Another skill applies

- `pinna-state`: the reads and writes a test makes, and the fix for a read or write kept past its place.
- `pinna-stages-and-live-data`: the fix for a stage message.
- `pinna-saving-and-history`: the fix for a snapshot, restore, or record message.
- `pinna-with-effect`: the program under test.

`node_modules/@frondruntime/pinna/AGENTS.md` is the same text at the installed version and wins where it differs.
