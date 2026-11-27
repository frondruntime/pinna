---
name: pinna-from-mobx
description: "Use when moving code from MobX to Pinna, or when MobX habits appear in Pinna code: observer, makeAutoObservable, action, computed getters, reaction, flow. Gives the Pinna call for each MobX one. For new code with no MobX in it use pinna-state."
---

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->

# Moving from MobX to Pinna

Gives the Pinna call for each MobX one, and names the MobX habits that do not carry over.

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

### MobX habits that do not carry over

| MobX | Pinna |
| --- | --- |
| `observer(Component)` | `useValue($x)` for each value the component shows |
| `makeAutoObservable`, `@observable` | `$` fields: `Box.make(this.realm, ...)` in a `Model`, or `Model.boxField(schema)` in a `Model.Schema` |
| reading `store.x` | `read(store.$x)` in a place |
| `action`, `runInAction` | `Realm.update(realm, (read, write) => { ... })` |
| `store.x = value` | `write(store.$x, value)` in an update |
| a `computed` getter | `readonly $x = Computed.make(this.realm, (read) => ...)` |
| `reaction(select, effect)` | `Realm.watch(realm, (read) => ..., effect)` |
| `autorun` | `Realm.autorun(realm, (read) => ...)` |
| `map.get(key)` in an action | `read.row($items, key)` in an update |
| pushing into an observable array | `write.modify($box, (draft) => { draft.push(item) })`, or a collection: `Collection.make(realm, { keyOf })`, or a `Model.collectionField` |
| `toJS` | not needed: values are plain data |

## References

Open a file under `references/` when its condition holds.

| File | Read when |
| --- | --- |
| [mobx.md](references/mobx.md) | Read when moving an app from MobX. Find the Pinna call for each MobX one, and the habits that do not carry over. |

## Another skill applies

- `pinna-state`: new code with no MobX in it, and `Realm.watch` and `Realm.autorun` in detail.
- `pinna-react-components`: the hooks that replace `observer`.

`node_modules/@frondruntime/pinna/AGENTS.md` is the same text at the installed version and wins where it differs.
