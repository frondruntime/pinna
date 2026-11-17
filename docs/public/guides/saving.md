---
title: Saving state
description: Read when state outlives a reload. Save a computed projection of what to keep, restore before the watch starts, write a burst of changes once, skip a save that changes nothing, keep a storage error as state, and write a pending save on dispose.
---

## Example

A workspace keeps a theme and whether the sidebar is open across reloads,
in `localStorage`. The storage is passed in, so a test hands the model one
that keeps the saves in memory, or one that refuses them.

<!-- region saving.ts#storage -->

The model saves a computed projection: `$saved` is the text to store, built
from the boxes that are saved and from nothing else. `$hovered` is shown on
screen and never saved: `$saved` does not read it, so a write to it neither
recomputes `$saved` nor runs the watch.

The constructor restores before it starts the watch, and takes the restored
text as the last one saved, so restoring writes nothing back. The watch
queues one save for a burst of updates, `flush` skips a save whose text equals the last
one written, and a storage error goes into `$storageError` for the screen to
show. The dispose stops the watch, then writes a save still queued.

<!-- region saving.ts#model -->

The workspace is made once, in module code.

<!-- region saving.ts#start -->

## Rules

- Save a `computed` that builds the stored text, not the boxes one by one.
  The watch runs only when that text changes, so state the screen shows
  but the save leaves out, such as a hover or a selection, writes nothing to
  the storage.
- Restore before starting the watch, and set the last saved text from the
  restored state. A restore after the watch starts writes boxes the watch
  reads, which queues a save of what the restore loaded.
- Take each restored field only when it is valid, and keep the default for
  the rest. A save written by an older version, or edited by hand, then
  loses one field, not the whole workspace; text that does not parse starts
  from the defaults.
- Queue the save with `queueMicrotask` and read the text when it runs. A
  watch runs once per outermost update, so an event handler that makes
  several updates runs it several times; the queued save runs once, after
  the handler returns, and writes the end state.
- Compare with the last text written before saving. A burst that ends where
  it began, such as a toggle clicked twice, writes nothing.
- Catch a storage error in `flush` and write it to a box. `flush` runs from a
  microtask, where a throw reaches no caller; as state, the screen shows it.
  The last saved text stays as it was, so the next change saves again.
- Dispose with `using` or `[Symbol.dispose]()`: it stops the watch, then
  writes a save still queued, at once. A workspace made right after the
  dispose loads what it saved, and a test realm's dispose finds no watch
  still running.

## Answers

| Call | Answers |
| --- | --- |
| `computed(realm, (read) => JSON.stringify(...))` | The text to save; it reads only the saved boxes, so a write to any other box leaves it as it is. |
| `untracked(realm, (read) => read($saved))` | The text now, read in the constructor and in `flush` without subscribing. |
| `watch(realm, (read) => read($saved), effect)` | A stop function; `effect` runs after each outermost update that changed the text. |
| `queueMicrotask(callback)` | Runs `callback` once the code running now returns, after the updates it made. |

## With Effect

Stored text comes from outside the program: an older version wrote it, or
a person edited it. With Effect, `restore` decodes it through a schema
instead of checking each field by hand, so the check and the type come from
one declaration and cannot drift apart. Each field recovers from a refusal
with `Schema.catchDecoding` and decodes to no field at all, so one bad field
keeps its default and the others still restore, as the checks by hand do.

<!-- region savingEffect.ts#restore -->

`restore` writes each field `readSaved` returns, in one update, and leaves
the rest at their defaults. The boxes stay plain: the workspace writes them
itself, so only the restore needs the check.

## See also

- [Reacting](../state/reacting.md): `watch` and when its effect runs.
- [Updates](../state/updates.md): an effect that cannot be taken back runs after the update.
- [Boxes and computed](../state/boxes.md): a `Model` and its `$` fields.
- [Testing](./testing.md): `testRealm`, and the dispose that finds a watch still running.
- [Errors](./errors.md#fields-a-schema-refuses): what a schema reports for a field it refuses.
