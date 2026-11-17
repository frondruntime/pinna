# @frondruntime/pinna-react

React hooks for Pinna. A component reads observables through `useValue`,
`useValues`, or `useSelect`, and rerenders when what it read changes. There
is no `observer` wrapper, and the hooks work with the React Compiler.

0.0.1 is a pre-1.0 release: any version may change the API.

## Install

```bash
bun add @frondruntime/pinna @frondruntime/pinna-react
```

React 19 or later is a peer dependency.

## Example

```tsx
import { box, computed, createRealm, update } from "@frondruntime/pinna";
import { useValue } from "@frondruntime/pinna-react";

const realm = createRealm();
const $count = box(realm, 0, { name: "count" });
const $double = computed(realm, (read) => read($count) * 2, { name: "double" });

const increment = () => {
  update(realm, (read, write) => {
    write($count, read($count) + 1);
  });
};

function CounterButton() {
  const double = useValue($double);
  return (
    <button type="button" onClick={increment}>
      {double}
    </button>
  );
}
```

## Exports

| Export | Does |
| --- | --- |
| `useValue($x)` | The value of one observable. Needs no provider. |
| `useValues([$a, $b])` | The values of several, as a typed array that keeps its identity until one changes. Needs no provider. |
| `useSelect((read) => ...)` | The result of view logic over observables, in the realm of the nearest `RealmProvider`. |
| `RealmProvider`, `useRealm` | Give the components below a realm, and read it. |

## Documentation

<https://pinna.frondruntime.dev/docs/react/hooks>
