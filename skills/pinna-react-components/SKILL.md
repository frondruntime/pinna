---
name: pinna-react-components
description: "Use when a React component shows or changes Pinna state: useValue, useValues, useSelect, useRealm, RealmProvider, reads in event handlers, rerendering less. For the model behind the component use pinna-state; for component tests use pinna-testing-and-errors."
---

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->

# Pinna in React components

Shows state in React and changes it from handlers, through `@frondruntime/pinna-react`.

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

9. **A realm whose screen, program, or request ends is disposed.**
   `Realm.dispose(realm)` runs every begun `Source.onObserved` cleanup, stops each
   autorun, row listener, and open stage, and then refuses `Realm.update` and
   every new observer with `pinna/realm-disposed`; reads keep the last
   values. Call it from an event handler or a teardown, never inside an
   update, a derivation, a watch's effect, an autorun, or a hook
   (`pinna/dispose-not-at-rest`). In React, make and dispose the realm in
   one effect, not in `useState` with an effect cleanup, which StrictMode
   disposes while the state still holds it. With Effect, take the realm
   from `Realm.scoped()` so the scope disposes it.

### In a component

```tsx
import { memo } from "react";
import { useValue } from "@frondruntime/pinna-react";
import type { Todo } from "./todo";

const Row = memo(function Row({ todo }: { readonly todo: Todo }) {
  const label = useValue(todo.$label);
  return <li onClick={() => todo.toggle()}>{label}</li>;
});
```

- `useValue($x)` for one observable, `useValues([$a, $b])` for several.
- `useSelect((read) => read($a) + read($b))` only for view logic over
  several observables; it runs the function on every render, and a layout
  effect on every render with a new function. A value several components
  need is a `Computed.make` on the model instead.
- In an event handler, read one value with `Source.peek($x)` and several
  inside `Realm.untracked(realm, (read) => ...)`, and write through a model
  method that calls `Realm.update`. `Source.peek` throws where reads are
  tracked and in a stage recipe, where it would read stale values.
- There is no `observer` wrapper. It works with the React Compiler as it is.
- A write renders at once, even inside `startTransition`: the hooks read
  through `useSyncExternalStore`. A slow render after a write reads
  `useDeferredValue(useValue($x))` under `memo` instead.
- There are no components like `Memo`, `Show`, `For`, or `Reactive`. To
  rerender less, move the read into a small component under `memo`; for
  control flow, use plain JSX (`&&`, `.map`).

### No lint rule for reads in render

There is no `read` outside a place, so a read in a render body does not
type-check; `useValue`, `useValues`, and `useSelect` are the only ways in.
A `read` leaked from a place into a render throws when it runs.

## References

Open a file under `references/` when its condition holds.

| File | Read when |
| --- | --- |
| [hooks.md](references/hooks.md) | Read when showing state in React. Pick between useValue, useValues, and useSelect, read in a handler, give a component its own box, render a model from pinna-effect, and defer a slow render after a write. |

## Another skill applies

- `pinna-state`: the model behind the component; a value several components need is a `Computed.make` on it, and a row by key is `read.row`.
- `pinna-testing-and-errors`: tests of the models a component reads.
- `pinna-from-mobx`: a component wrapped in MobX's `observer`.
- `pinna-stages-and-live-data`: data a screen fetches when it opens.

`node_modules/@frondruntime/pinna/AGENTS.md` is the same text at the installed version and wins where it differs.
