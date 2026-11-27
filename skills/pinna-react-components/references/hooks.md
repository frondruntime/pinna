# Hooks

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/react/hooks.md.

Sections: Example, Rules, Answers, Transitions, A render and its commit, Render scopes, With Effect, See also.

## Example

The samples on this page share one realm and these boxes.

```tsx
import { Box, Realm } from "@frondruntime/pinna";

const realm = Realm.make();
const $first = Box.make(realm, "Ada");
const $last = Box.make(realm, "Lovelace");
const $starred = Box.make<ReadonlyArray<string>>(realm, []);
const $query = Box.make(realm, "");
const names: ReadonlyArray<string> = ["Ada", "Grace", "Barbara"];
```

`useValue` reads one observable. Under `memo`, the component rerenders only
when that value changes.

```tsx
import { useValue } from "@frondruntime/pinna-react";
import { memo } from "react";

const FirstName = memo(function FirstName() {
  const first = useValue($first);
  return <span>{first}</span>;
});
```

`useValues` reads several, as a typed array.

```tsx
import { useValues } from "@frondruntime/pinna-react";

function FullName() {
  const [first, last] = useValues([$first, $last]);
  return (
    <span>
      {first} {last}
    </span>
  );
}
```

`useSelect` runs view logic over observables, in the realm of the nearest
`RealmProvider`.

```tsx
import { useSelect } from "@frondruntime/pinna-react";

function Star({ id }: { readonly id: string }) {
  const starred = useSelect((read) => read($starred).includes(id));
  return <span>{starred ? "★" : "☆"}</span>;
}
```

A component's own state is a box in the provider's realm.

```tsx
import { Box, Realm } from "@frondruntime/pinna";
import { useRealm, useValue } from "@frondruntime/pinna-react";
import { useState } from "react";

function Draft() {
  const local = useRealm();
  const [$text] = useState(() => Box.make(local, ""));
  const text = useValue($text);
  const onChange = (value: string) => {
    Realm.update(local, (_read, write) => {
      write($text, value);
    });
  };
  return <input value={text} onChange={(event) => onChange(event.target.value)} />;
}
```

An event handler reads through `Realm.untracked` and writes through `Realm.update`.

```tsx
import { Realm } from "@frondruntime/pinna";

function SaveButton() {
  // A handler reads without subscribing; the component does not rerender for it.
  const onClick = () => {
    const first = Realm.untracked(realm, (read) => read($first));
    console.log("saving", first);
  };
  return (
    <button type="button" onClick={onClick}>
      Save
    </button>
  );
}
```

`RealmProvider` gives the components under it a realm. Only `useSelect` and
`useRealm` need it: `useValue` and `useValues` read the realm of the
observables they are handed.

```tsx
import { RealmProvider } from "@frondruntime/pinna-react";

function App() {
  return (
    <RealmProvider realm={realm}>
      <FullName />
      <Star id="pinna" />
      <Draft />
      <SaveButton />
    </RealmProvider>
  );
}
```

## Rules

- There is no `observer` wrapper. The hooks work with the React Compiler as
  they are.
- A read in a render body does not type-check: render has no `read`. The
  hooks are the only way in.
- Prefer `useValue` and `useValues`. `useSelect` runs its function on every
  render and a layout effect on every render with a new function; a value
  several components need is a computed value on the model.
- `useValues` compares the input array's elements on each render and keeps
  its own copy when they change. Replacing or removing an observable in the
  same input array takes effect on the next render, so reads and the
  subscription follow the same observables. The array keeps its identity
  when equal values move to other observables.
- To rerender less, move the read into a small component under `memo`. For
  control flow, use plain JSX. `memo` skips a render only when every prop
  is the same as before, so the parent passes values it does not rebuild
  each render. See [Render scopes](hooks.md#render-scopes).
- A list of a collection reads `keys` and hands each row its key. Reading
  `rows` rerenders the whole list when any row changes.
- In an event handler, read inside `Realm.untracked` and write through a method
  that calls `Realm.update`.
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

```tsx
import { Realm } from "@frondruntime/pinna";
import { useValue } from "@frondruntime/pinna-react";
import { memo, useDeferredValue } from "react";

// Under `memo`, the results skip the urgent render, which still passes them the old `query`.
const Results = memo(function Results({ query }: { readonly query: string }) {
  const found = names.filter((name) => name.includes(query));
  return (
    <ul>
      {found.map((name) => (
        <li key={name}>{name}</li>
      ))}
    </ul>
  );
});

function Search() {
  const query = useValue($query);
  const deferred = useDeferredValue(query);
  const onChange = (value: string) => {
    Realm.update(realm, (_read, write) => {
      write($query, value);
    });
  };
  return (
    <>
      <input value={query} onChange={(event) => onChange(event.target.value)} />
      <Results query={deferred} />
    </>
  );
}
```

The same holds under `Suspense`. A write that makes a component suspend shows
the nearest fallback in place of the content on screen. A component that
suspends on a deferred value keeps the content on screen until the next one
loads.

Under `<Activity mode="hidden">`, the hooks unsubscribe: a `Source.onObserved` hook
stops, and a write renders nothing there. Shown again, the component
subscribes and renders the current value.

## A render and its commit

A render reads; only a render React commits changes what the component
follows. React may render a component and throw the render away: a
transition that suspends and is then replaced, or a render that a write
interrupted.

- A hook returns what React's `useSyncExternalStore` returns, and React
  compares that value before it commits a concurrent render. A write during
  the render makes React render again, so one commit never shows one source
  at two values.
- Each render captures its result and what it read, with nothing observed
  and no `Source.onObserved` hook started. A render React throws away leaves
  the mounted component's subscriptions as they were: a source it observes
  stays observed, so a `Computed.fromPromise` value keeps its loaded value
  and starts no second request.
- The commit moves the subscriptions to what the committed render read:
  `useValue` when React subscribes, `useValues` and `useSelect` in a layout
  effect. A source both renders read stays observed, and its hook
  neither stops nor starts.
- With nothing written, React's two reads of a snapshot return the same
  reference, also for a computed value that builds a new object on each run.
- When what a `useSelect` function reads changes and its result stays equal
  (`Object.is`), the component does not render, and the subscriptions move
  to what the function read last.

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

```tsx
import { Box } from "@frondruntime/pinna";
import { useValue } from "@frondruntime/pinna-react";
import { memo } from "react";

const $saving = Box.make(realm, false);

// Reads $saving alone: a change of status rerenders this line, not the list.
const SavingStatus = memo(function SavingStatus() {
  const saving = useValue($saving);
  return <p>{saving ? "Saving…" : "Saved"}</p>;
});

const NameList = memo(function NameList({ names }: { readonly names: ReadonlyArray<string> }) {
  return (
    <ul>
      {names.map((name) => (
        <li key={name}>{name}</li>
      ))}
    </ul>
  );
});

// `names` is made once, in module code, so NameList gets the same array on
// every render and `memo` skips it. `names.filter(...)` here would hand it a
// new array each time.
function Panel() {
  return (
    <>
      <SavingStatus />
      <NameList names={names} />
    </>
  );
}
```

- A computed value that builds the object a component shows returns a new
  object on each recompute, and `useValue` compares with `Object.is`, so a
  change to any field the computed value reads renders the component, shown
  or not.
  Its `equals` compares the fields the screen shows and leaves out the rest,
  such as the time a quote arrived; a recompute that `equals` finds
  unchanged keeps the previous object, and nothing renders.

```tsx
import { Box, Computed } from "@frondruntime/pinna";
import { useValue } from "@frondruntime/pinna-react";
import { memo } from "react";

interface Quote {
  readonly symbol: string;
  readonly price: number;
  readonly receivedAt: number;
}

const $quote = Box.make<Quote>(realm, { symbol: "ACME", price: 10, receivedAt: 0 });

// What the card shows. Each recompute builds a new object, so `equals`
// compares the shown fields: a tick that changes only `receivedAt` keeps the
// previous object, and the card does not rerender.
const $quoteCard = Computed.make(
  realm,
  (read) => {
    const quote = read($quote);
    return { symbol: quote.symbol, price: quote.price.toFixed(2) };
  },
  { equals: (previous, next) => previous.symbol === next.symbol && previous.price === next.price },
);

const QuoteCard = memo(function QuoteCard() {
  const card = useValue($quoteCard);
  return (
    <p>
      {card.symbol} {card.price}
    </p>
  );
});
```

## With Effect

A model from `pinna-effect` is read the same way, with the same hooks. A list
reads a collection's `keys`, and each row reads its own `row(key)`. Toggling
one todo rerenders one `TodoLabel`. The `TodoList` is the one from
[Collection fields](https://pinna.frondruntime.dev/docs/effect/collections.md).

```tsx
import { useValue } from "@frondruntime/pinna-react";
import { memo } from "react";
import type { Todo, TodoList } from "./models.ts";

// Rerenders when a key is added, removed, or moved; never for a row's own change.
function TodoRows({ list }: { readonly list: TodoList }) {
  const ids = useValue(list.$items.keys);
  return (
    <ul>
      {ids.map((id) => (
        <TodoRow key={id} list={list} id={id} />
      ))}
    </ul>
  );
}

// Rerenders when the row under its key is replaced.
const TodoRow = memo(function TodoRow({
  list,
  id,
}: {
  readonly list: TodoList;
  readonly id: string;
}) {
  const todo = useValue(list.$items.row(id));
  return todo === undefined ? null : <TodoLabel todo={todo} />;
});

// Rerenders when its own label changes.
const TodoLabel = memo(function TodoLabel({ todo }: { readonly todo: Todo }) {
  const label = useValue(todo.$label);
  return (
    <li>
      <button type="button" onClick={() => todo.toggle()}>
        {label}
      </button>
    </li>
  );
});
```

## See also

- [Start](https://pinna.frondruntime.dev/docs/start/index.md): a counter from box to button.
- [Classes](https://pinna.frondruntime.dev/docs/effect/classes.md): the models these components read.
- [Collections](https://pinna.frondruntime.dev/docs/state/collections.md): `keys` and `row(key)`, and a list that rerenders one row.
- [Testing](https://pinna.frondruntime.dev/docs/guides/testing.md): a realm per test, for the models a component reads.
