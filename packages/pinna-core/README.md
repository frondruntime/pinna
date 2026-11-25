# @frondruntime/pinna-core

Pinna's reactive graph, with no runtime dependencies: cells, derived values,
atoms, watchers, and reactions.
`@frondruntime/pinna` builds its boxes on it, and `@frondruntime/pinna-react`
its hooks. An application imports `@frondruntime/pinna`; this package is for
code that builds on the graph itself.

0.2.0 is a pre-1.0 release: any version may change the API.

## Install

```bash
bun add @frondruntime/pinna-core
```

## Example

```ts
import { Graph, readCell, readDerived, writeCell } from "@frondruntime/pinna-core";

const graph = new Graph();
const $count = graph.cell(1);
const $double = graph.derived(() => readCell($count) * 2);
const seen: Array<number> = [];
const stop = graph.watch(
  () => readDerived($double),
  (value) => {
    seen.push(value);
  },
);

writeCell($count, 2); // seen is [4]
stop();
```

## Exports

| Kind | Exports |
| --- | --- |
| Classes | `Graph`, `Reaction` |
| Reads and writes | `readCell`, `readDerived`, `readAtom`, `peekCell`, `peekDerived`, `writeCell`, `restoreCell`, `touchSource` |
| Memory | `forgetValue` |
| Inspection | `dependenciesOf`, `observerCount`, `lastReason`, `hasRun`, `isAtom`, `isDerived` |
| Errors | `reportUncaught` |
| Types | `AtomNode`, `CellNode`, `DerivedNode`, `Source`, `Equals` |

## Documentation

<https://pinna.frondruntime.dev/docs/start>
