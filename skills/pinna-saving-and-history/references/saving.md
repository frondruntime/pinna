# Saving state

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/guides/saving.md.

Sections: Example, Rules, With Effect, See also.

## Example

A workspace keeps a theme and whether the sidebar is open across reloads,
in `localStorage`. The storage is passed in, so a test hands the model one
that keeps the saves in memory, or one that refuses them.

```ts
interface SettingsStorage {
  readonly load: () => string | undefined;
  // Throws when the storage refuses the write, as a full localStorage does.
  readonly save: (text: string) => void;
}

const browserStorage: SettingsStorage = {
  load: () => localStorage.getItem("workspace") ?? undefined,
  save: (text) => localStorage.setItem("workspace", text),
};
```

The model saves a computed projection: `$saved` is the text to store, built
from the boxes that are saved and from nothing else. `$hovered` is shown on
screen and never saved: `$saved` does not read it, so a write to it neither
recomputes `$saved` nor runs the watch.

The constructor and `flush` read `$saved` through `Realm.untracked`, which reads
without subscribing.

```ts
import { Box, Computed, Model, Realm } from "@frondruntime/pinna";

type Theme = "light" | "dark";

class Workspace extends Model.Class implements Disposable {
  readonly $theme = Box.make<Theme>(this.realm, "light");
  readonly $sidebarOpen = Box.make(this.realm, true);
  // Shown, never saved: a restart begins with nothing hovered.
  readonly $hovered = Box.make<string | undefined>(this.realm, undefined);
  readonly $storageError = Box.make<string | undefined>(this.realm, undefined);

  // The text to save, and nothing else: it never reads $hovered, so a write
  // to $hovered leaves it, and the watch below, untouched.
  private readonly $saved = Computed.make(this.realm, (read) =>
    JSON.stringify({ theme: read(this.$theme), sidebarOpen: read(this.$sidebarOpen) }),
  );

  private readonly storage: SettingsStorage;
  private readonly stopSaving: () => void;
  private queued = false;
  private lastSaved: string;

  constructor(realm: Realm, storage: SettingsStorage) {
    super(realm);
    this.storage = storage;
    // Restored before the watch starts, so restoring saves nothing back.
    this.restore();
    this.lastSaved = Realm.untracked(realm, (read) => read(this.$saved));
    this.stopSaving = Realm.watch(
      realm,
      (read) => read(this.$saved),
      () => {
        this.queue();
      },
    );
  }

  private restore() {
    const text = this.storage.load();
    if (text === undefined) return;
    let saved: { readonly theme?: unknown; readonly sidebarOpen?: unknown } | null;
    try {
      saved = JSON.parse(text);
    } catch {
      return; // a damaged save starts from the defaults
    }
    // Each field is taken only when it is valid, so one bad field keeps the rest.
    Realm.update(this.realm, (_read, write) => {
      if (saved?.theme === "light" || saved?.theme === "dark") write(this.$theme, saved.theme);
      if (typeof saved?.sidebarOpen === "boolean") write(this.$sidebarOpen, saved.sidebarOpen);
    });
  }

  // A burst of updates in one task queues one save, which reads the end state.
  private queue() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => this.flush());
  }

  flush() {
    if (!this.queued) return;
    this.queued = false;
    const text = Realm.untracked(this.realm, (read) => read(this.$saved));
    if (text === this.lastSaved) return; // the burst ended where it began
    try {
      this.storage.save(text);
      this.lastSaved = text;
      Realm.update(this.realm, (_read, write) => write(this.$storageError, undefined));
    } catch (error) {
      // Kept as state for the screen to show; the next change tries again.
      const message = error instanceof Error ? error.message : String(error);
      Realm.update(this.realm, (_read, write) => write(this.$storageError, message));
    }
  }

  [Symbol.dispose]() {
    this.stopSaving();
    this.flush(); // a save still queued is written now, not lost
  }
}
```

The workspace is made once, in module code.

```ts
import { Realm } from "@frondruntime/pinna";

const realm = Realm.make();
const workspace = new Workspace(realm, browserStorage);
```

## Rules

- Save a `Computed.make` that builds the stored text, not the boxes one by one.
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
- Queue the save with `queueMicrotask`, read the text when it runs, and skip
  it when the text equals the last one written. A watch runs once per
  outermost update, so an event handler that makes several updates runs it
  several times; the queued save runs once, after the handler returns, and
  a burst that ends where it began, such as a toggle clicked twice, writes
  nothing.
- Catch a storage error in `flush` and write it to a box. `flush` runs from a
  microtask, where a throw reaches no caller; as state, the screen shows it.
  The last saved text stays as it was, so the next change saves again.
- Save state a visible stage writes from the records of `Realm.onUpdate`,
  or from a value a `Realm.update` recipe read and the code stores after
  that update returns. `$saved` is a tracked place, and a tracked place
  reads the shown values, so while a stage shows a guess the stored text
  holds the guess; a recipe's `read` and a record hold the confirmed
  values alone. A stored guess that later drops is a value nothing
  confirmed. The storage write itself runs after the update, never inside
  its recipe: an update that throws undoes its writes, not the save
  ([Updates](https://pinna.frondruntime.dev/docs/state/updates.md)).
- Dispose with `using` or `[Symbol.dispose]()`: it stops the watch, then
  writes a save still queued, at once. A workspace made right after the
  dispose loads what it saved, and a test realm's dispose finds no watch
  still running.

## With Effect

Stored text comes from outside the program: an older version wrote it, or
a person edited it. With Effect, `restore` decodes it through a schema
instead of checking each field by hand, so the check and the type come from
one declaration and cannot drift apart. Each field recovers from a refusal with
`Schema.catchDecoding` and decodes to no field at all, so one bad field
keeps its default and the others still restore.

```ts
import { Effect, Option, Schema } from "effect";

// A field the schema refuses decodes to no field at all, so it keeps its
// default and the other fields still restore.
const SavedSettings = Schema.fromJsonString(
  Schema.Struct({
    theme: Schema.optionalKey(
      Schema.Literals(["light", "dark"]).pipe(Schema.catchDecoding(() => Effect.succeedNone)),
    ),
    sidebarOpen: Schema.optionalKey(
      Schema.Boolean.pipe(Schema.catchDecoding(() => Effect.succeedNone)),
    ),
  }),
);

// Text that does not parse decodes to no fields, so the workspace keeps its defaults.
const readSaved = (text: string): typeof SavedSettings.Type =>
  Schema.decodeUnknownOption(SavedSettings)(text).pipe(Option.getOrElse(() => ({})));
```

`restore` writes each field `readSaved` returns, in one update. The boxes
stay plain: the workspace writes them itself, so only the restore needs the
check.

## See also

- [Reacting](https://pinna.frondruntime.dev/docs/state/reacting.md): `Realm.watch` and when its effect runs.
- [Updates](https://pinna.frondruntime.dev/docs/state/updates.md): an effect that cannot be taken back runs after the update.
- [Boxes and computed](https://pinna.frondruntime.dev/docs/state/boxes.md): a `Model` and its `$` fields.
- [Testing](https://pinna.frondruntime.dev/docs/guides/testing.md): `testRealm`, and the dispose that finds a watch still running.
- [Errors](https://pinna.frondruntime.dev/docs/guides/errors#fields-a-schema-refuses): what a schema reports for a field it refuses.
