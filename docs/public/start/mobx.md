---
title: Coming from MobX
description: Read when moving an app from MobX. Find the Pinna call for each MobX one, and the habits that do not carry over.
---

## Example

A cart in MobX: an observable class, a getter, an action, a reaction, and an
`observer` component.

<!-- region mobx.tsx#mobx -->

The same cart in Pinna. The fields that change are boxes, named with `$`. The
getter is a computed value, the action a method that calls `update`, the
reaction a `watch`. The component reads with `useValue` and needs no wrapper.
The cart is a `Model` made from a realm, so a test or a screen can make one of
its own.

<!-- region mobx.tsx#pinna -->

## Rules

- Nothing is read by property access. `store.total` becomes
  `read(cart.$total)` in a place, or `useValue(cart.$total)` in a component.
- Nothing is written by assignment. `store.quantity += 1` becomes
  `write(cart.$quantity, ...)` in an `update`.
- There are no deep proxies. A box holds plain data, replaced whole or through
  `write.modify`. A keyed list is a collection, tracked row by row: see
  [Collections](../state/collections.md).
- An update is synchronous and atomic. An update that throws is undone: every
  write before the throw in the same update is taken back.
- There is no global state. Every observable belongs to the realm that made
  it, as with `configure({ isolateGlobalState: true })` for every store.
- `watch` runs for changes, not for the current value. Where MobX would pass
  `fireImmediately`, call the effect once by hand.
- `flow` has no counterpart: `await` outside, then one `update` per step. For
  cancellation, write the work as an Effect program.
- An `autorun` writes through `update`, whose reads do not subscribe it.
- `toJS` is not needed: values are plain data already.

## Answers

| MobX | Pinna |
| --- | --- |
| `observable.box` | `box(realm, initial)` |
| `makeAutoObservable`, `makeObservable`, `@observable` | `class X extends Model` with `$` fields made by `box(this.realm, ...)` and `computed(this.realm, ...)`; with Effect, `BoxField(schema)` in a `SchemaModel` |
| `observable` arrays and objects | a `box` of plain data, written whole or through `write.modify` |
| `ObservableMap` | `collection(realm, { keyOf })`, or a box of an array written through `reconcile`; with Effect, a `CollectionField` |
| `computed`, a getter | `computed(realm, (read) => ...)` |
| `computedFn` (mobx-utils) | `computedFunction` |
| `action`, `runInAction` | `update(realm, (read, write) => ...)` |
| `reaction(select, effect)` | `watch(realm, (read) => ..., effect)` |
| `autorun` | `autorun(realm, (read) => ...)` |
| `when`, a `reaction` with `delay` | a `watch`; with Effect, `changes($x)` and an Effect `Stream` |
| `untracked` | `untracked(realm, (read) => ...)` |
| `onBecomeObserved`, `onBecomeUnobserved` | `onObserved($x, start)`: `start` runs when `$x` gains its first observer and returns the cleanup, which runs when the last leaves; `onObserved` returns the function that removes the hook |
| `computed({ keepAlive: true })` | `observe($x)`, released when done |
| `createAtom` | `atom(realm)` |
| `fromStream`, `fromResource` (mobx-utils) | `fromStream` from `pinna-effect` |
| `trace`, `getDependencyTree` | `inspect($x)` |
| `onReactionError` | `createRealm({ onError })` |
| `observer(Component)` | `useValue($x)` for each value the component shows |
| `useLocalObservable` | `useState(() => box(realm, ...))`, with the realm from `useRealm()` |

## With Effect

An application on Effect Schema writes the store as a `SchemaModel`: its `$`
fields are `BoxField(schema)`, every write is checked, and `decode` makes it
from server data. This is the same cart, with the `watch` and the component as
above.

<!-- region models.ts#cart -->

## See also

- [Start](./index.md): a realm, a box, and a computed value.
- [Updates](../state/updates.md): drafts and atomic updates.
- [Classes](../effect/classes.md): `SchemaModel`, `BoxField`, and `decode`.
- [Live data](../guides/live-data.md): a WebSocket feed and a fetch that refetches, with and without Effect, where MobX would use `flow`.
