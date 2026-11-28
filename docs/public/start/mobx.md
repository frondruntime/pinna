---
title: Coming from MobX
description: Read when moving an app from MobX. Find the Pinna call for each MobX one, and the habits that do not carry over.
---

## Example

A cart in MobX: an observable class, a getter, an action, a reaction, and an
`observer` component.

<!-- region mobx.tsx#mobx -->

The same cart in Pinna. The fields that change are boxes, named with `$`. The
getter is a computed value, the action a method that calls `Realm.update`, the
reaction a `Realm.watch`. The component reads with `useValue` and needs no wrapper.
The cart is a `Model` made from a realm, so a test or a screen can make one of
its own.

<!-- region mobx.tsx#pinna -->

## Rules

- Nothing is read by property access. `store.total` becomes
  `read(cart.$total)` in a place, or `useValue(cart.$total)` in a component.
- Nothing is written by assignment. `store.quantity += 1` becomes
  `write(cart.$quantity, ...)` in a `Realm.update`.
- There are no deep proxies. A box holds plain data, replaced whole or through
  `write.modify`. A keyed list is a collection, tracked row by row: see
  [Collections](../state/collections.md).
- An update is synchronous and atomic. An update that throws is undone: every
  write before the throw in the same update is taken back.
- There is no global state. Every observable belongs to the realm that made
  it, as with `configure({ isolateGlobalState: true })` for every store.
- `Realm.watch` runs for changes, not for the current value. Where MobX passes
  `fireImmediately: true` to `reaction`, pass `{ immediate: true }`: the
  effect also runs at the call, with `previous` `undefined`.
- `flow` has no counterpart: `await` outside, then one `Realm.update` per step. For
  cancellation, write the work as an Effect program.
- A `Realm.autorun` writes through `Realm.update`, whose reads do not subscribe it.
- `toJS` is not needed: values are plain data already.

## Answers

| MobX | Pinna |
| --- | --- |
| `observable.box` | `Box.make(realm, initial)` |
| `makeAutoObservable`, `makeObservable`, `@observable` | `class X extends Model` with `$` fields made by `Box.make(this.realm, ...)` and `Computed.make(this.realm, ...)`; with Effect, `Model.boxField(schema)` in a `Model.Schema` |
| `observable` arrays and objects | a `Box.make` of plain data, written whole or through `write.modify` |
| `ObservableMap` | `Collection.make(realm, { keyOf })`, or a box of an array written through `Collection.reconcile`; with Effect, a `Model.collectionField` |
| `computed`, a getter | `Computed.make(realm, (read) => ...)` |
| `computedFn` (mobx-utils) | `Computed.fn` |
| `action`, `runInAction` | `Realm.update(realm, (read, write) => ...)` |
| `reaction(select, effect)` | `Realm.watch(realm, (read) => ..., effect)` |
| `autorun` | `Realm.autorun(realm, (read) => ...)` |
| `when`, a `reaction` with `delay` | a `Realm.watch`; with Effect, `Program.changes($x)` and an Effect `Stream` |
| `untracked` | `Realm.untracked(realm, (read) => ...)` |
| `onBecomeObserved`, `onBecomeUnobserved` | `Source.onObserved($x, start)`: `start` runs when `$x` gains its first observer and returns the cleanup, which runs when the last leaves; `Source.onObserved` returns the function that removes the hook |
| `computed({ keepAlive: true })` | `Source.observe($x)`, released when done |
| `createAtom` | `Atom.make(realm)` |
| `fromPromise` (mobx-utils) | `Computed.fromPromise(realm, () => promise, initial)`, with a status union of the application's own in place of `state` and `case` ([Async state](../guides/async-state.md)) |
| `fromStream`, `fromResource` (mobx-utils) | `Program.fromStream` from `pinna-effect` |
| `trace`, `getDependencyTree` | `Source.inspect($x)` |
| `onReactionError` | `Realm.make({ onError })` |
| `observer(Component)` | `useValue($x)` for each value the component shows |
| `useLocalObservable` | `useState(() => Box.make(realm, ...))`, with the realm from `useRealm()` |

## With Effect

An application on Effect Schema writes the store as a `Model.Schema`: its `$`
fields are `Model.boxField(schema)`, every write is checked, and `Model.decode` makes it
from server data. This is the same cart, with the `Realm.watch` and the component as
above.

<!-- region models.ts#cart -->

## See also

- [Start](./index.md): a realm, a box, and a computed value.
- [Updates](../state/updates.md): drafts and atomic updates.
- [Classes](../effect/classes.md): `Model.Schema`, `Model.boxField`, and `Model.decode`.
- [Live data](../guides/live-data.md): a WebSocket feed and a fetch that refetches, with and without Effect, where MobX would use `flow`.
