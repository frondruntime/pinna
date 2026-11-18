---
title: Hooks
description: Read when showing state in React. Pick between useValue, useValues, and useSelect, read in a handler, give a component its own box, render a model from pinna-effect, and defer a slow render after a write.
---

## Example

The samples on this page share one realm and these boxes.

<!-- region react.tsx#setup -->

`useValue` reads one observable. Under `memo`, the component rerenders only
when that value changes.

<!-- region react.tsx#useValue -->

`useValues` reads several, as a typed array.

<!-- region react.tsx#useValues -->

`useSelect` runs view logic over observables, in the realm of the nearest
`RealmProvider`.

<!-- region react.tsx#useSelect -->

A component's own state is a box in the provider's realm.

<!-- region react.tsx#local -->

An event handler reads through `untracked` and writes through `update`.

<!-- region react.tsx#handler -->

`RealmProvider` gives the components under it a realm. Only `useSelect` and
`useRealm` need it: `useValue` and `useValues` read the realm of the
observables they are handed.

<!-- region react.tsx#provider -->

## Rules

- There is no `observer` wrapper. The hooks work with the React Compiler as
  they are.
- A read in a render body does not type-check: render has no `read`. The
  hooks are the only way in.
- Prefer `useValue` and `useValues`. `useSelect` costs a layout effect per
  render; a value several components need is a computed value on the model.
- `useValues` compares the input array's elements on each render and keeps
  its own copy when they change. Replacing or removing an observable in the
  same input array takes effect on the next render, so reads and the
  subscription follow the same observables.
- To rerender less, move the read into a small component under `memo`. For
  control flow, use plain JSX. `memo` skips a render only when every prop
  is the same as before, so the parent passes values it does not rebuild
  each render. See [Render scopes](#render-scopes).
- A list of a collection reads `keys` and hands each row its key. Reading
  `rows` rerenders the whole list when any row changes.
- In an event handler, read inside `untracked` and write through a method
  that calls `update`.
- A slow render after a write reads a deferred value:
  `useDeferredValue(useValue($x))`. A `startTransition` around the write
  changes nothing, since React renders a change of an outside store as a
  blocking update.

## Answers

| Call | Answers |
| --- | --- |
| `useValue($x)` | The value of `$x`. Needs no provider. |
| `useValues([$a, $b])` | The values as a typed array, which keeps its identity until one changes. Needs no provider; observables of two realms throw. |
| `useSelect((read) => ...)` | The function's result, rerendering when it changes under `Object.is`. Throws without a provider. |
| `<RealmProvider realm={realm}>` | Gives the components under it a realm. |
| `useRealm()` | The nearest provider's realm. Throws without a provider. |

## Transitions

A write renders at once, at full priority, even inside `startTransition`. The
hooks read through `useSyncExternalStore`, and React renders a change of an
outside store as a blocking update. A slow part of the page reads the value
through `useDeferredValue` instead: the input renders the new value first, and
the results render it after, in a render React can interrupt. Under `memo`, the
results skip the first render, which still passes them the old value.

<!-- region react.tsx#deferred -->

The same holds under `Suspense`. A write that makes a component suspend shows
the nearest fallback in place of the content on screen. A component that
suspends on a deferred value keeps the content on screen until the next one
loads.

Under `<Activity mode="hidden">`, the hooks unsubscribe: an `onObserved` hook
stops, and a write renders nothing there. Shown again, the component
subscribes and renders the current value.

## Render scopes

A component rerenders when a value it reads through a hook changes, and,
under `memo`, when a prop is not `Object.is` the one it had.

- A value that changes often, such as a status line, is read by a small
  component of its own. Read in the list's component, it rerenders the list
  on every change of status.
- The props a parent passes are the same values from render to render: an
  observable, a key, or data made once. An array built in the render, such
  as `names.filter(...)`, or an object or function written inline, is new
  each time, and `memo` renders the child anyway.

<!-- region react.tsx#status -->

- A computed value that builds the object a component shows returns a new
  object on each recompute, and `useValue` compares with `Object.is`, so a
  change to any field the computed value reads renders the component, shown
  or not.
  Its `equals` compares the fields the screen shows and leaves out the rest,
  such as the time a quote arrived; a recompute that `equals` finds
  unchanged keeps the previous object, and nothing renders.

<!-- region react.tsx#display -->

## With Effect

A model from `pinna-effect` is read the same way, with the same hooks. A list
reads a collection's `keys`, and each row reads its own `row(key)`. Toggling
one todo rerenders one `TodoLabel`. The `TodoList` is the one from
[Collection fields](../effect/collections.md).

<!-- region reactEffect.tsx#rows -->

## See also

- [Start](../start/index.md): a counter from box to button.
- [Classes](../effect/classes.md): the models these components read.
- [Collections](../state/collections.md): `keys` and `row(key)`, and a list that rerenders one row.
- [Testing](../guides/testing.md): a realm per test, for the models a component reads.
