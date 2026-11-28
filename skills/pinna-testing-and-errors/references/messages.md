# Error messages

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/reference/errors.md.

Sections: Rules, Answers, With Effect, See also.

This page lists every message Pinna and `@frondruntime/pinna-effect` throw or
log, grouped by the call that causes it, with its `_tag` or `code`, the
cause, and the fix.
[Errors and debugging](errors.md) covers where an error goes and
how to find why a value recomputed.

## Rules

- Every error Pinna throws is a `PinnaError`, branded with the key
  `"~pinna/Error"`, and carries a literal `_tag` equal to its class name.
  Match it with `isPinnaError(error)` or `isPinnaError(error, tag)`, which
  narrows to the class, never with `instanceof`: two copies of Pinna in one
  application each have their own classes, and `instanceof` fails across
  them.
- A condition code handles has its own class: `StageConflictError`,
  `StageClosedError`, `ValueRejectedError`, and pinna-effect's
  `DecodeError`. Misuse, a bug in the caller, is one `PinnaUsageError`
  whose `code` names it, in the Code column below. A minor version may add
  a code, so `code` is typed open: a `switch` over it keeps a `default`.
- Match on `_tag` and `code`, never on the message: messages name the calls
  of the current API and change with it.
- `toJSON` gives `_tag`, `name`, `message`, and the class's own fields, so a
  structured logger records them. `StageConflictError` leaves out
  `observables`, which hold realms.
- Every message starts with `pinna: `, except the test realm's
  ([Testing](testing.md)).
- A part in angle brackets is filled in. `<name>` is the value's `{ name }`.
  Without one, a `read` or a `write` message prints `$observable`, and a
  message from a computed value prints `a derived value`.
- A `read` or a `write` message puts the name in quotes, such as
  `read("count")`.

## Answers

### Reading and writing

| Error | Code | Answers |
| --- | --- | --- |
| `pinna: read(<name>) runs outside a place. ...` | `pinna/read-outside-place` | A `read` used outside every place of its realm, such as one kept in a closure. Pass `read` down instead. |
| `pinna: read.row($collection, key) runs outside a place. ...` | `pinna/read-outside-place` | The same, for `read.row`. |
| `pinna: write inside Realm.update` | `pinna/write-outside-update` | A `write` kept past its update. |
| `pinna: Source.peek runs where reads are tracked, ...` | `pinna/peek-while-tracking` | `Source.peek` inside a computed value, a watch's select, or an autorun, where the result would go stale. Read with that place's `read`. |
| `pinna: Source.peek runs inside a stage recipe, ...` | `pinna/peek-in-recipe` | `Source.peek` inside a stage recipe, where it would read the value from before the stage. Read through the recipe's own `read`. |
| `pinna: <verb>(<name>) is handed an observable of another realm. ...` | `pinna/foreign-realm` | A `read` or a `write` of one realm given what another realm made. `<verb>` is `read`, `read.row`, `write`, `write.modify`, `write.upsert`, `write.remove`, `write.replaceAll`, or `write.changed`. A realm made with `Realm.make({ name })` is named in the message, such as `(realm "quotes", not "ui")`. Build each observable from the realm that reads it. |
| `pinna: <call> needs a box, a computed value, or an atom` | `pinna/not-made-by-pinna` | `Source.onObserved`, `Source.observe`, or `Source.inspect` given a value Pinna did not make. |
| `pinna: expected a box, a computed value, or an atom` | `pinna/not-made-by-pinna` | `useValues` given a value Pinna did not make. |

### Updates

| Error | Code | Answers |
| --- | --- | --- |
| `pinna: Realm.update cannot run in a computed value; ...` | `pinna/update-in-derivation` | An update inside a computed value or a computed function's value. Write from an event, a watch's effect, or an autorun. `Collection.onRowChange` or `Realm.onUpdate` called there says its own name in place of `Realm.update`. |
| `pinna: Realm.update cannot run in a watch's select or a selector; ...` | `pinna/update-in-derivation` | An update inside a watch's select or a `useSelect` function. Write from an event, a watch's effect, or an autorun. `Collection.onRowChange` or `Realm.onUpdate` called there says its own name in place of `Realm.update`. |
| `pinna: Realm.update recipes are synchronous; await outside, then Realm.update` | `pinna/async-recipe` | A recipe that returned a promise. The update is undone. Await outside, then update. |
| `pinna: a Realm.update recipe returns nothing` | `pinna/recipe-returns-value` | A recipe that returned a value other than `undefined` or a promise. The update is undone. |
| `pinna: <name> cannot write while it computes` | `pinna/write-while-computing` | A computed value that wrote, through a `write` kept from an update. |

### Stages

| Error | Code | Answers |
| --- | --- | --- |
| `pinna: <call> runs on a stage after it was <status>; ...` | `_tag` `StageClosedError` | A `StageClosedError`: a stage call after `Stage.apply` or `Stage.drop` closed it. `<call>` is `Stage.update`, `Stage.read`, `Stage.realmRead`, `Stage.apply`, or `Stage.make` of a child; a named stage reads `the stage "<name>"`. `Stage.status` and `Stage.inspect` remain callable outside a recipe after closing. `Stage.drop` on a closed stage does nothing. |
| `pinna: <names> changed since <stage> read <it or them>; nothing lands` | `_tag` `StageConflictError` | A `StageConflictError`: a stage opened with `{ conflicts: "fail" }` read or wrote a box or a collection that changed in the realm before it landed. `<stage>` is `the stage` or `the stage "<name>"`. `Stage.apply` throws it; on a visible stage it stops the stage at the update that moved the value, and `Stage.update` and `Stage.read` throw it too. `<names>` names each by its `{ name }`: an unnamed box is `<anonymous>`, an unnamed collection `a Collection.make`. The stage is dropped. Retry the work over the new values, or open the stage without the option to replay over them. |
| `pinna: <verb> of a stage runs after its recipe returned; ...` | `pinna/stage-handle-kept` | A `read` or a `write` a stage handed out, kept past its recipe. `<verb>` is `read`, `read.row`, `write`, `write.modify`, `write.upsert`, `write.remove`, `write.replaceAll`, or `write.changed`. |
| `pinna: <call> runs inside a stage recipe, ...` | `pinna/call-in-recipe` | A stage call, `Source.onObserved`, `Collection.onRowChange`, or `Realm.onUpdate` on the stage's realm inside a recipe, a `Stage.read` function, or a computed value the stage evaluates. Call it outside the recipe or evaluation. |
| `pinna: a stage recipe writes the realm, through Realm.update or a write kept from one; ...` | `pinna/realm-write-in-recipe` | A realm write inside a stage recipe, which would show at once and survive a drop. Write through the recipe's own `write`. Also a box's `equals` that updates while visible stages settle what they show; the stack reports it to `onError` and counts the values unequal. |
| `pinna: read(<name>) of the realm runs inside a stage recipe, ...` | `pinna/realm-read-in-recipe` | A `read` of the stage's realm, kept from another place, inside a recipe, a `Stage.read` function, or a computed value the stage evaluates, where it would skip the stage's values. `read.row` and `Realm.untracked` say so in its place. Read through the stage's `read`. |
| `pinna: <what> is made inside a stage recipe, ...` | `pinna/made-in-recipe` | A box, a computed value, a computed function, an atom, a collection, or a model made on the stage's realm inside a recipe, a `Stage.read` function, or a computed value the stage evaluates; replay would make it again. Make it outside and close over it. |
| `pinna: a stage recipe cannot observe or release while it computes` | `pinna/observe-while-computing` | A `Realm.watch`, a `Realm.autorun`, or a `Source.observe` started inside a stage recipe. |
| `pinna: <verb> runs in Stage.read, which writes nothing; write in Stage.update` | `pinna/stage-read-writes` | A write inside a `Stage.read` function, such as a `Collection.reconcile` merge. |
| `pinna: Stage.apply runs on a stage while a child stage of it is open; ...` | `pinna/stage-child-open` | A precondition failure: the stage stays open. Apply or drop the child first. |
| `pinna: conflicts is "replay" or "fail", not <value>` | `pinna/stage-conflicts-option` | `Stage.make` given another `conflicts` value, from code the types did not check. |
| `pinna: a child stage takes no conflicts option; ...` | `pinna/stage-conflicts-option` | `Stage.make(stage, { conflicts })`. The root stage's option covers what its children read. |
| `pinna: visible is true or false, not <value>` | `pinna/stage-visible-option` | `Stage.make` given another `visible` value, from code the types did not check. |
| `pinna: a child stage takes no visible option; ...` | `pinna/stage-visible-option` | `Stage.make(stage, { visible })`. A child is a savepoint that shows through its parent once applied; a second guess that must show at once is a second stage over the realm. |
| `pinna: Stage.scoped takes a guess or visible, not both: a stage is the guess or the answer` | `pinna/stage-visible-option` | `Stage.scoped` given both `guess` and `visible`, from code the types did not check: a stage is the guess or the answer. |
| `pinna: Stage.scoped takes a guess over a realm alone: a child stage is a savepoint and shows nothing` | `pinna/stage-visible-option` | `Stage.scoped(stage, section, { guess })`, from code the types did not check: a child stage is a savepoint and shows nothing. |
| A visible stage's kept error | as thrown | `Stage.update`, `Stage.read`, or `Stage.apply` on a visible stage that stopped: the error that stopped it, a `StageConflictError` or its recipe's own throw. `Stage.apply` also drops it. `Stage.inspect(stage).failure` holds it. |
| `pinna: <name> is read while a stage evaluates it (cycle)` | `pinna/cycle` | A computed value that reads itself, read through a stage. |
| `pinna: Stage.update cannot run in a computed value; ...` | `pinna/update-in-derivation` | As for `Realm.update`, with `Stage.update` or `Stage.apply` in its place, and the same for a watch's select or a selector. This precondition failure leaves the stage open. |
| `pinna: Stage.read cannot run in a computed value; ...` | `pinna/update-in-derivation` | `Stage.read` or `Stage.realmRead` in a computed value, a watch's select, or a selector: a stage's reads are not tracked, so the derivation would go stale. |
| `pinna: Stage.update recipes are synchronous; await outside, then Stage.update` | `pinna/async-recipe` | A `Stage.update` recipe that returned a promise. Its writes to the stage are put back. |
| `pinna: a Stage.update recipe returns nothing` | `pinna/recipe-returns-value` | A `Stage.update` recipe that returned a value other than `undefined` or a promise. |

### Drafts

| Error | Code | Answers |
| --- | --- | --- |
| `pinna: write.modify drafts arrays and plain objects; ...` | `pinna/modify-not-draftable` | `write.modify` on a box holding another kind of value. Write it whole with `write($box, value)`. |
| `pinna: a modify recipe returns nothing; write through the draft` | `pinna/recipe-returns-value` | A `write.modify` recipe that returned a value. |
| `pinna: a draft is used after its recipe returned` | `pinna/draft-kept` | A draft kept past its recipe. |
| `pinna: write.modify left an object it wrote under two keys; ...` | `pinna/draft-at-two-keys` | A recipe wrote a draft and left it at a second key, inside itself, or inside an object the recipe placed at two keys, such as `draft.history.push(draft.present)` followed by a write to `draft.present`. The update is undone. Refer to the object by a key, or read a snapshot with `read($box)` before the write. |
| `pinna: write.modify was given a draft another recipe wrote; ...` | `pinna/draft-of-another-recipe` | An outer `write.modify`'s draft, written, assigned inside an inner `write.modify`. The outer recipe can still change it after the inner box's check, so a copy would hide that write. The update is undone. Read the value with `read($box)`, or write the inner box from the outer recipe. |
| `pinna: a checked box was given a draft of an open write.modify; ...` | `pinna/draft-in-write` | A `Box.schema` or `Model.boxField` written with a draft of a `write.modify` still running, or a value holding one, such as `write($checked, draft.child)` inside another box's recipe. The recipe can change the draft after the check accepts it. The update is undone. Write the box inside the recipe with `write.modify`, or pass a value read with `read($box)`. |
| `pinna: a draft does not take defineProperty; assign instead` | `pinna/draft-unsupported` | `Object.defineProperty` on a draft. |
| `pinna: a draft cannot change its prototype` | `pinna/draft-unsupported` | `Object.setPrototypeOf` on a draft. |

### Declaring

| Error | Code | Answers |
| --- | --- | --- |
| `pinna: a name is a non-empty string` | `pinna/empty-name` | `{ name: "" }`, `Realm.update`'s included. |
| `pinna: Box.make takes a value, not a schema; ...` | `pinna/box-takes-schema` | `Box.make` given an Effect schema. A box that checks a schema is `Box.schema` from `@frondruntime/pinna-effect`. |

### Computed values and watchers

| Error | Code | Answers |
| --- | --- | --- |
| `pinna: <name> is read while it computes (cycle)` | `pinna/cycle` | A computed value that reads itself, directly or through others. |
| `pinna: <name> stopped past depth 256 and ran again more than 64 times in one read, as one that makes a new chain of computed values each time it computes does; ...` | `pinna/depth-rebuilt` | A computed value whose read stopped past depth 256 and ran again more than 64 times in one read. A read past depth 256 waits while the value it stopped at computes, then the outer compute runs again; one that makes a new chain on every run never reaches the value computed for it. A compute that makes and keeps one deep chain per run finishes in chains + 1 runs, so up to 63 kept chains read. Make the chain outside the computed value, or keep it between runs. |
| `pinna: <name> cannot observe or release while it computes` | `pinna/observe-while-computing` | A `Realm.watch`, a `Realm.autorun`, a `Source.observe`, or a release inside a computed value. |
| `pinna: watchers did not settle after 100 rounds` | `pinna/watchers-unsettled` | Sent to `onError`: watchers kept changing what they read, such as an autorun that writes what it reads on every run. Make the write settle. |
| `pinna: <name> ran 100 times in a row for its own writes; ...` | `pinna/watchers-unsettled` | Sent to `onError`: a scheduled watch or autorun whose every run writes what it read. It runs again at the next change from outside its own runs. Make the write settle. |
| `pinna: <name>'s scheduler called run inside an update, ...` | `pinna/scheduled-run-not-at-rest` | A scheduler's `run` called inside an update, a computed value, a watch's select, an autorun, or a stage recipe, where values are not settled. Call it from a frame, a timer, an event handler, or a watch's effect. |
| `pinna: <name> with { immediate: true } is made inside Realm.update, ...` | `pinna/watch-immediate-in-update` | A `Realm.watch` or `Program.watchScoped` with `{ immediate: true }` made inside an update, where its first effect would run before the update lands. Nothing is watched. Make the watch outside the update. |
| `pinna: Source.onObserved hooks did not settle after 100 passes` | `pinna/hooks-unsettled` | Sent to `onError`: hooks kept starting other hooks. The hooks still due wait for the next settle. |

### Collections

| Error | Code | Answers |
| --- | --- | --- |
| `pinna: the collection key <key> appears twice` | `pinna/repeated-key` | A [collection](https://pinna.frondruntime.dev/docs/state/collections.md)'s `write.replaceAll` given two rows of one key. Nothing is written. |
| `pinna: a collection row cannot be undefined` | `pinna/undefined-row` | A collection made, or a `write.upsert` or `write.replaceAll`, given an `undefined` row, even where the row schema accepts `undefined`: `row(key)` and `read.row` return `undefined` for a missing key, so an `undefined` row would read as no row. Nothing is written. |
| `pinna: reconcile: the key <key> appears twice` | `pinna/repeated-key` | `Collection.reconcile` given two items of one key in `next`. |
| `pinna: <verb> on the collection a Collection.onRowChange listener is reporting; ...` | `pinna/row-listener-reentrant` | A listener that wrote the collection it listens to. `<verb>` is `write.upsert`, `write.remove`, or `write.replaceAll`. The write fails and is put back. |
| `pinna: Collection.onRowChange on the collection a Collection.onRowChange listener is reporting` | `pinna/row-listener-reentrant` | A listener that added another listener to the collection it listens to. |
| `pinna: a Collection.onRowChange listener is synchronous and returns nothing` | `pinna/row-listener-returns-value` | A listener that returned a value, such as a promise. The write fails and is put back. |
| `pinna: Collection.onRowChange needs a collection made by Pinna` | `pinna/not-made-by-pinna` | `Collection.onRowChange` given a value Pinna did not make. |
| `pinna: retainedKeys takes a collection Pinna made` | `pinna/not-made-by-pinna` | `retainedKeys` from the testing entry given a value Pinna did not make. |

### Views

`<view>` is the call that made the [view](https://pinna.frondruntime.dev/docs/state/views.md), with its name when it has one: `View.ordered "byAmount"`, or `View.ordered`.

| Error | Code | Answers |
| --- | --- | --- |
| `pinna: <view> is disposed, so its <read> is no longer kept up to date` | `pinna/view-disposed` | A read through a view after `View.dispose` or `Realm.dispose`: `size`, `totalSize`, `keys`, `range`, `group`, or `groups`. Make a new view, or read the collection. |
| `pinna: <view>'s compare finds the rows of keys <a> and <b> equal, and keys that are not both strings, numbers, or bigints cannot break the tie; break it in compare` | `pinna/view-tie` | `View.ordered`'s comparator returned 0 for two rows whose keys have no order. The write fails and is put back. |
| `pinna: <view>'s compare returned <value>; it returns a negative number, zero, or a positive number` | `pinna/view-compare-result` | `View.ordered`'s comparator returned `NaN` or a non-number. The write fails and is put back. |
| `pinna: <view> did not find the row of key <key> where <callbacks> placed it; ...` | `pinna/view-out-of-step` | A view's callbacks answered differently for a row than when it was placed, or the row was changed after it was written. `<callbacks>` names `compare`, `filter`, `compare and filter`, or `groupOf`. The write fails and is put back. Make the callbacks a function of the row alone, and write a new row instead of changing one. |
| `pinna: <call> cannot start while <stage> holds writes to its collection; ...` | `pinna/view-staged-rows` | `View.ordered`, `View.grouped`, or `View.totals` made while an open hidden stage has written the collection; a visible stage does not count. `<stage>` is `a stage` or `the stage "<name>"`. Make the view before the stage writes the collection, or after it is applied or dropped. |
| `pinna: <view>.range takes whole numbers from 0, not <start> and <end>` | `pinna/view-range` | `range` given a negative, fractional, or non-finite rank. |
| `pinna: View.ordered needs a collection made by Pinna` | `pinna/not-made-by-pinna` | `View.ordered`, `View.grouped`, or `View.totals` given a value Pinna did not make; the message names the call. |
| `pinna: View.dispose needs a view made by Pinna` | `pinna/not-made-by-pinna` | `View.dispose` or `View.status` given a value Pinna did not make. |

A view is made where `Collection.onRowChange` can be called, and its creation throws what `Collection.onRowChange` throws there, naming the view's call: `pinna/update-in-derivation`, `pinna/call-in-recipe`, `pinna/row-listener-reentrant`, and `pinna/realm-disposed`.

### Snapshots

| Error | Code | Answers |
| --- | --- | --- |
| `pinna: read.snapshot at <path> finds <what>; a shape holds boxes, collections, Model.Schema instances, ...` | `pinna/snapshot-not-state` | A [snapshot](https://pinna.frondruntime.dev/docs/state/snapshots.md)'s shape holds a computed value, an atom, a `Model.Class` instance, or a plain value at `<path>`, or a collection holds a `Model.Class` row. Put the boxes a computed value reads in the shape, and a `Model.Class` instance's boxes by name. `write.restore` throws the same for its shape. |
| `pinna: read.snapshot at <path> reaches an object that holds it; a shape is a tree` | `pinna/snapshot-cycle` | A shape that holds itself. `write.restore` throws the same. |
| `pinna: write.restore at <path> takes <expected>, and the data holds <what>` | `pinna/restore-shape` | The data at `<path>` is not the shape's form: an object for an object, an array of the same length for an array, an array of rows for a collection, a model's data or an instance of its class for a `Model.Schema`. The restore's writes are put back. |
| `pinna: write.restore at <path> takes the shape's keys exactly; the data lacks "<key>", and the data adds "<key>"` | `pinna/restore-shape` | The data at `<path>` misses a key of the shape or adds one. Restore a smaller shape for a partial restore. |
| `pinna: write.restore at <path> cannot key a data row: the collection's keyOf throws on it; ...` | `pinna/restore-shape` | A collection whose `keyOf` calls a method of a `Model.Schema` row, which the row's data lacks. Key rows by a plain field, which the data holds under the same name. |
| `pinna: write.restore at <path> finds "<key>" of the <Class> held there different in the data; ...` | `pinna/restore-plain-field` | A plain field of a `Model.Schema` that the data, or an instance standing in for it, holds differently, or holds where the other leaves an optional field out. A plain field is never written after the model is made: restore into a model whose plain fields match, or make a new one with `Model.decode`. Also `Model.restore` for a decoded input whose plain field differs from the held instance's. |
| `pinna: write.restore at <path>[key <key>] adds a model row from plain data; a restore never makes a model. ...` | `pinna/restore-cannot-make-row` | A collection of `Model.Schema` rows that lacks `<key>`, given plain data for it. Pass the instance in the data, made with `Model.decode` or `make`, or decode the whole input with `Model.restore`. |

### Change stream

| Error | Code | Answers |
| --- | --- | --- |
| `pinna: write.revert takes a record Realm.onUpdate handed out, and this is not one: ...` | `pinna/record-not-applicable` | `write.revert` or `write.replay` of an object `Realm.onUpdate` did not hand out: a copy such as `{ ...record, name: "undo" }`, or a record made by hand. The realm keeps beside each record which listeners its update had, and a copy loses it. Pass the record itself. Nothing is written. |
| `pinna: write.revert needs <box> to hold the record's after, and it changed since; ...` | `pinna/record-not-applicable` | `write.revert` of a record a box no longer holds the `after` of, by `Object.is`; `write.replay` reads `before`. The state moved since the record landed: a later update applied, or records reverted or replayed out of order. The check runs before the first write, so nothing is written. Apply records in the order they landed, and revert them newest first. `<box>` reads `the box "<name>"` for a named box, else `a box`. |
| `pinna: write.revert needs the row under <key> of <collection> to be the record's after, and it changed since; ...` | `pinna/record-not-applicable` | The same for a row the record changed: the row held under `<key>` is not the record's `after` (`before` for `write.replay`), by `Object.is`, absent counted as `undefined`. Nothing is written. |
| `pinna: write.revert needs the key order of <collection> to be the record's after, and it changed since; ...` | `pinna/record-not-applicable` | The same for a key order the record moved, compared key by key. Nothing is written. |
| `pinna: write.revert cannot apply a record whose update added a Collection.onRowChange listener to <collection>: ...` | `pinna/record-not-applicable` | A record of a `Realm.update` inside which `Collection.onRowChange` added a listener, whether or not the update changed rows. The record holds what the new listener wrote as it heard the rows held, and its `before` holds that state from before the listener existed, so restoring it leaves a running listener with state that does not match the rows. Add listeners at rest, outside an update: the record of that registration restores. A view is in no record and is never refused. `write.replay` throws the same. |
| `pinna: write.revert wrote the row under <key> of <collection>, and a Collection.onRowChange listener added after the record changed it as it heard the restore of another collection; ...` | `pinna/record-not-applicable` | `write.revert` or `write.replay` of a record that lists two or more collections, where a `Collection.onRowChange` listener added after the record, hearing a later collection's restore, wrote a row the record lists, or a key order it moved, in a collection restored before. Each collection is compared, by `Object.is`, with what its own restore left once all are written; writing it again would run its later listeners again, so the restore throws rather than land a value the record does not hold. Reads `the key order` for a moved order. Every write the call made is put back. Stop that listener before the restore, or apply the change with `Realm.update`. |
| `pinna: write.replay needs <collection> to hold the rows its Collection.onRowChange listener heard when it was added, and they changed since; ...` | `pinna/record-not-applicable` | `write.replay` or `write.revert` of the record a listener added at rest made, while the collection holds other rows or another key order than the ones that listener first heard. Apply records in the order they landed. Nothing is written. |
| `pinna: write.replay needs the row under <key> of <collection>, which neither the record nor the collection holds; ...` | `pinna/record-not-applicable` | A key the record's order needs that neither its rows nor the collection hold. The check above runs first, so a record applied in order never meets it. Every write the call made is put back. |

### Disposal

| Error | Code | Answers |
| --- | --- | --- |
| `pinna: <call> cannot start in the disposed realm; make a new realm` | `pinna/realm-disposed` | `Realm.update`, `Realm.watch`, `Realm.autorun`, `Source.observe`, `Source.onObserved`, `Computed.fromPromise`, `Collection.onRowChange`, `Realm.onUpdate`, `View.ordered`, `View.grouped`, `View.totals`, `Stage.make`, or a hook mounting, in a realm `Realm.dispose` disposed. `<call>` names the call, such as `Realm.update`, `a Realm.watch`, or `useValue`; a named realm reads `the disposed realm "<name>"`. Every call but `Realm.update` throws from the moment disposal begins, so a cleanup cannot start what would outlive it. Make a new realm; reads of the disposed one still return its last values. |
| `pinna: Realm.dispose runs while the realm is running ...` | `pinna/dispose-not-at-rest` | `Realm.dispose` inside an update, a computed value, a watch's select or effect, an autorun, `Realm.untracked`, a hook, a stage recipe, a row listener, or a `Realm.onUpdate` listener (the error goes to `onError`, as every listener error does). Nothing is stopped. Dispose from an event handler or a teardown, once the realm is at rest. |
| `pinna: <call> needs a realm made by Realm.make()` | `pinna/not-made-by-pinna` | `Realm.dispose`, `Realm.status`, or `Realm.onUpdate` given a value `Realm.make` did not make. |

### Testing

| Error | Code | Answers |
| --- | --- | --- |
| `The test realm is not at rest: <problems>.` | `pinna/test-realm-not-at-rest` | A `testRealm` disposed with a watch, an autorun, an observer, or a hook still running. The realm is disposed anyway, so the next use of it throws `pinna/realm-disposed`. Stop each in the test. |

### Internal

These guard Pinna's own packages; application code reaches them only
through a bug in Pinna. Report one with its stack.

| Error | Code | Answers |
| --- | --- | --- |
| `pinna: <name> cannot track inside its own run`, `... cannot adopt inside its own run` | `pinna/reentrant-run` | A reaction that tracks inside its own run. |
| `pinna: endBatch needs a beginBatch before it` | `pinna/unbalanced-batch` | A batch ended twice. |
| `pinna: Source.onObserved needs a source from this graph`, `pinna: onObservedNow needs a source from this graph, inside a batch` | `pinna/foreign-source` | A hook on another graph's source. |
| `pinna: Schema.Class no longer exposes its ast as a getter`, `pinna: Schema.Class no longer builds its instance in one transformation` | `pinna-effect/schema-class-changed` | An Effect version whose `Schema.Class` pinna-effect does not support. Effect is pinned at 4.1.0. |

### React

| Error | Code | Answers |
| --- | --- | --- |
| `pinna: useRealm and useSelect need a RealmProvider above the component` | `pinna-react/no-provider` | `useRealm` or `useSelect` with no `RealmProvider` above. `useValue` and `useValues` need none. |
| `pinna: expected a realm made by Realm.make()` | `pinna-react/not-a-realm` | `useSelect` under a `RealmProvider` given something other than a realm. |
| `pinna: useValues takes observables of one realm` | `pinna-react/mixed-realms` | `useValues` given observables of two realms; named realms are named in the message. |

## With Effect

| Error | Code | Answers |
| --- | --- | --- |
| `pinna: the box rejects this value: ...` | `_tag` `ValueRejectedError` | A write the schema refused: `reason` says why, and `cause` is the `Schema.SchemaError`. The update rolled back. |
| `pinna: Todo.a and Todo.b both read "key"; rename one` | `pinna-effect/wire-key-twice` | Two fields under one wire key, thrown when the class is defined. |
| `pinna: Todo.realm reads "realm", ...` | `pinna-effect/field-named-realm` | A field whose wire key is `realm`, which the instance holds. Rename the field. |
| `pinna: Todo.__proto__ cannot hold a plain field, ...` | `pinna-effect/reserved-field-name` | A plain field named `__proto__`, whose value would be lost on decode because assignment sets the prototype. Rename the field, or declare it `$__proto__` as a box field. |
| `pinna: Todo.$done is named as a box; ...` | `pinna-effect/box-field-undeclared` | A `$` field that is not a `Model.boxField` or a `Model.collectionField`. |
| `pinna: Todo.done holds a box; name it $done` | `pinna-effect/box-field-unprefixed` | A `Model.boxField` or `Model.collectionField` without the `$`. |
| `pinna: Todo.<static> is not supported; ...` | `pinna-effect/unsupported-static` | A `Schema.Class` static a `Model.Schema` refuses, `extend`, `mapFields`, `makeOption`, or `makeEffect`. |
| `pinna: Todo.make takes the value of $done under "done", never a box under "$done"` | `pinna-effect/make-takes-wire-key` | `make` given a box. Pass the value under its wire key. |
| `pinna: a Todo field of another schema takes an instance; ...` | `pinna-effect/make-takes-instance` | Another schema's `make` given a plain object where a `Model.Schema` instance belongs. Build it with `Todo.make` or `Model.decode`. |
| `pinna: expected a realm made by Realm.make()` | `pinna-effect/not-a-realm` | `RealmService` provided with something other than a realm. |
| `pinna: the collection key <key> appears twice` | none: inside the `DecodeError` | Also a `Model.decode` of a [collection field](https://pinna.frondruntime.dev/docs/effect/collections.md) given two rows of one key, inside the `Schema.SchemaError`. |
| `pinna: a watch effect died`, `pinna: a stream into a value died`, `pinna: a program run while observed died` | none: logged | Logged at the error level, with the defect as its cause: a `Program.watchScoped` effect, a `Program.fromStream` stream, or a `Program.whileObserved` program died. The watch keeps running. A stream's value keeps its last element while observed and resets to `initial` when the last observer leaves. The next observation starts a stream or a program again. |
| `pinna: decode rejects the input: ...` | `_tag` `DecodeError` | `Model.decode` or `Model.restore` input that does not fit the schema; `Model.restore` writes nothing. `cause` is the `Schema.SchemaError`, and `issue` its issue. An Effect program that decodes with `Schema.decodeUnknownEffect` gets the `SchemaError` in its error channel instead. |

## See also

- [Errors and debugging](errors.md): which errors reach the caller, which go to `onError`, and `Source.inspect`.
- [Updates](https://pinna.frondruntime.dev/docs/state/updates.md): what an update undoes when it throws.
- [Collections](https://pinna.frondruntime.dev/docs/state/collections.md): the writes that report a repeated key.
- [Classes](https://pinna.frondruntime.dev/docs/effect/classes.md): the naming errors a `Model.Schema` throws when it is defined.
