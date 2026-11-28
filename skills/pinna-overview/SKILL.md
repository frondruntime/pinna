---
name: pinna-overview
description: "Use first for any work with Pinna (@frondruntime/pinna, not Pinia): every module and its calls, what read and write hand out, the hooks, the testing entry, and which skill covers each task. Then load the task's skill, such as pinna-state or pinna-react-components."
---

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->

# Pinna overview: where each call lives

Maps the whole library: each module and its members, what each package adds, and the call and the skill for each kind of task.

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
   down instead. Outside every place, such as an event handler or a test,
   `Source.peek($x)` reads one value and `Realm.untracked(realm, (read) =>
   ...)` several. `Realm` has no read or peek member: each member of
   `Realm` takes a realm, and `Source.peek` takes the realm from `$x`.

3. **Write with the `write` that `Realm.update` hands out.**
   `Realm.update(realm, (read, write) => { ... })`: `write($box, value)` replaces a
   value, and is the only write for a number, a string, a boolean, or any
   value but an array or a plain object: `write($count, read($count) + 1)`;
   `write.modify($box, (draft) => { ... })` drafts arrays and plain
   objects, takes no updater function, and throws
   `pinna/modify-not-draftable` on any other value; a collection takes
   `write.upsert`, `write.remove`, and `write.replaceAll`; an atom takes `write.changed`. An update that throws
   is rolled back, but only its writes: a request sent inside the recipe
   has gone out. Run an effect that cannot be taken back after the update,
   from a `Realm.watch`
   (<https://pinna.frondruntime.dev/docs/state/updates#effects-after-the-update>).

## Rules

### Where each call lives

Every call is a member of one of the modules below, a property of the
`read` or `write` a place hands out, a hook, or a testing helper; there is
no other entry. `@frondruntime/pinna-effect` holds every member of
`@frondruntime/pinna` and adds the ones under "Effect adds". Pages are under
<https://pinna.frondruntime.dev/docs/>.

| Module | Members | Effect adds | Page |
| --- | --- | --- | --- |
| `Realm` | `Realm.make`, `Realm.update`, `Realm.untracked`, `Realm.watch`, `Realm.autorun`, `Realm.onUpdate`, `Realm.isTracking`, `Realm.dispose`, `Realm.status` | `Realm.scoped` | `state/updates`, `state/reacting`, `state/changes`, `state/lifecycles` |
| `Box` | `Box.make` | `Box.schema` | `state/boxes`, `effect/boxes` |
| `Atom` | `Atom.make` | | `state/lifecycles` |
| `Computed` | `Computed.make`, `Computed.fn`, `Computed.fromPromise` | | `state/boxes`, `guides/async-state` |
| `Collection` | `Collection.make`, `Collection.onRowChange`, `Collection.reconcile` | `Collection.schema` | `state/collections`, `effect/collections` |
| `View` | `View.ordered`, `View.grouped`, `View.totals`, `View.dispose`, `View.status` | `View.orderedScoped`, `View.groupedScoped`, `View.totalsScoped` | `state/views` |
| `Stage` | `Stage.make`, `Stage.update`, `Stage.read`, `Stage.realmRead`, `Stage.apply`, `Stage.drop`, `Stage.status`, `Stage.inspect` | `Stage.scoped` | `state/updates` |
| `Model` | `Model.Class` | `Model.Schema`, `Model.boxField`, `Model.collectionField`, `Model.context`, `Model.decode`, `Model.restore` | `start`, `effect/classes` |
| `Source` | `Source.peek`, `Source.observe`, `Source.onObserved`, `Source.inspect` | `Source.observeScoped` | `state/boxes`, `state/lifecycles` |
| `Program` | | `Program.watchScoped`, `Program.changes`, `Program.updates`, `Program.fromStream`, `Program.fromEffect`, `Program.whileObserved` | `effect/programs` |

| Handed out | Calls | Page |
| --- | --- | --- |
| `read`, by every place (rule 2) | `read($x)`, `read.row`, `read.snapshot` | `state/boxes`, `state/collections`, `state/snapshots` |
| `write`, by `Realm.update` and `Stage.update` (rule 3) | `write($box, value)`, `write.modify`, `write.upsert`, `write.remove`, `write.replaceAll`, `write.changed`, `write.restore`, `write.revert`, `write.replay` | `state/updates`, `state/snapshots`, `state/changes` |
| `@frondruntime/pinna-react` | `useValue`, `useValues`, `useSelect`, `useRealm`, `RealmProvider` | `react/hooks` |
| `@frondruntime/pinna/testing` | `testRealm`, `record`, `held`, `retainedKeys` | `guides/testing` |
| Errors | `isPinnaError`, `PinnaError`, `PinnaUsageError`, `StageConflictError` | `reference/errors`, `guides/errors` |

| Task | Call | Skill |
| --- | --- | --- |
| Declare state, a derived value, or a model | `Box.make`, `Computed.make`, `Model` | `pinna-state` |
| Read one value in a handler or a test | `Source.peek($x)`; several: `Realm.untracked` | `pinna-state` |
| Write a number, a string, or any whole value | `write($box, value)` in `Realm.update` | `pinna-state` |
| Change an array or a plain object in place | `write.modify` | `pinna-state` |
| Keep rows by key, or a sorted list over them | `Collection.make`, `View.ordered` | `pinna-state` |
| Run code now and after each change | `Realm.autorun` | `pinna-state` |
| Run code after a change to a selected value | `Realm.watch` | `pinna-state` |
| Run it for the current value too, with `previous` | `Realm.watch` with `{ immediate: true }` | `pinna-state` |
| Show state in React | `useValue`, `useValues`, `useSelect` | `pinna-react-components` |
| Check data against a schema, or decode it | `Box.schema`, `Model.Schema`, `Model.decode` | `pinna-with-effect` |
| Run state as an Effect program | `Program.watchScoped`, `Program.changes`, `Realm.scoped` | `pinna-with-effect` |
| Hold writes until asynchronous work ends, or show them early | `Stage.make`, `Stage.apply`, `{ visible: true }` | `pinna-stages-and-live-data` |
| Load a request's answer, or a feed while it is observed | `Computed.fromPromise`, `Source.onObserved`, `Program.fromStream` | `pinna-stages-and-live-data` |
| Save, restore, undo, or log every write | `read.snapshot`, `write.restore`, `Realm.onUpdate`, `write.revert` | `pinna-saving-and-history` |
| Test code on Pinna, or trace an error | `testRealm`, `record`, `isPinnaError` | `pinna-testing-and-errors` |
| Move code from MobX | the table under "MobX habits that do not carry over" | `pinna-from-mobx` |

## Another skill applies

- `pinna-state`: declaring, writing, or reacting to state: boxes, computed values, models, collections, views, watches, and autoruns.
- `pinna-react-components`: a React component that shows or changes state.
- `pinna-with-effect`: a value checked by Effect Schema, decoded from the wire, or run by an Effect program.
- `pinna-stages-and-live-data`: writes that wait for asynchronous work or show optimistically, and state from a request or a socket.
- `pinna-saving-and-history`: saving and restoring state, undo, redo, or a log of every write.
- `pinna-testing-and-errors`: a test of code on Pinna, or an error to trace.
- `pinna-from-mobx`: code moving from MobX.

`node_modules/@frondruntime/pinna/AGENTS.md` is the same text at the installed version and wins where it differs.
