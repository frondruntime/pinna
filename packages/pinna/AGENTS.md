# Using Pinna: rules for agents

For an agent writing an application on Pinna. Import the functions from
`@frondruntime/pinna`, whose boxes and models take no schema, or from
`@frondruntime/pinna-effect`, which re-exports them and adds `schemaBox` and
`SchemaModel` to check a schema (`effect` is its peer dependency); the hooks
come from `@frondruntime/pinna-react`. The full documentation is at
<https://pinna.frondruntime.dev/docs/start>; this page is what to keep in
mind while writing code.

## The rules

1. **`$` means observable.** A name that starts with `$` is a box, a
   computed value, an atom, or a collection. Everything else is plain,
   `readonly` data: read it anywhere, never write it.
2. **Read with the `read` a place hands out.** An observable has no read
   or write methods. `computed`, `computedFunction`, `watch`'s select,
   `autorun`, `update`, `untracked`, and `useSelect` each pass their
   function a `read`: `computed(realm, (read) => read($a) + 1)`.
   Never keep a `read` past its place: outside every place of its realm
   it throws, and inside another it reads as that place's `read`. Pass it
   down instead.
3. **Write with the `write` that `update` hands out.**
   `update(realm, (read, write) => { ... })`: `write($box, value)` replaces a
   value; `write.modify($box, (draft) => { ... })` drafts arrays and plain
   objects; a collection takes `write.upsert`, `write.remove`, and
   `write.replaceAll`; an atom takes `write.changed`. An update that throws
   is rolled back, but only its writes: a request sent inside the recipe
   has gone out. Run an effect that cannot be taken back after the update,
   from a `watch`
   (<https://pinna.frondruntime.dev/docs/state/updates#effects-after-the-update>).
4. **A box with a schema checks every write.** A `schemaBox` or a
   `BoxField` throws on a value its schema rejects. A `box` checks nothing,
   from either package. A `collection` rejects `undefined` rows and checks
   nothing else. Choose per box: data
   from outside the program (the wire, user input) goes through a schema,
   and trusted data that is written often takes a plain `box` or a `Model`.
   Never weaken a schema box's check for speed.
5. **A derived value is a `$` property in the class body:**
   `readonly $total = computed(this.realm, (read) => ...)`. A plain getter has
   no `read` to call; a method that takes `read` is not cached.
6. **A model is a class with `$` fields, and writes through its methods.**
   - Without Effect, it extends `Model`:
     `class Todo extends Model { readonly $done = box(this.realm, false) }`,
     made with `new Todo(realm)`. `Model` holds the realm, so field
     initializers read `this.realm`, and it marks instances, so a draft leaves
     them read-only.
   - With Effect, it is a `SchemaModel`. A `$name` field is
     `BoxField(schema)` or `CollectionField(schema, { keyOf })`, and its wire
     key is `name`. Make instances with `decode(realm, Todo)(json)`, or with
     `Todo.make({ id, title, done: false, realm })`, which takes each `$`
     field's value under its wire key and throws on a `$` key.
   - With Effect, a class with no `$` field is a plain `Schema.Class`: a
     `SchemaModel` adds a `realm` field, which `make` then asks for.
   - A method writes with `update(this.realm, (read, write) => ...)`, so
     callers change a model only through what it allows.
   - A collection copies its key order when a key is added or removed, so
     that costs more as it grows; replacing a held row does not. Many new
     rows go in through one `write.replaceAll`, which copies once, not an
     `upsert` per row.
   - A list of models is a `collection`, a `CollectionField`, or a
     `schemaCollection`, not a box
     holding instances: every write to a box reruns every reader of it, and
     a collection tracks each key on its own, so a reader of one row reruns
     only when that row changes.
   - A value kept a row at a time over a collection (a sum, a count per
     group, an index by another key) is a box written by
     `onRowChange($items, (change, read, write) => ...)`, which runs in the
     writer's update. A `computed` that reduces `$items.rows` reruns over
     every row on each change. The listener never writes its own collection,
     keeps its state in boxes so it rolls back, and is added once: each
     call replays the held rows. It sees rows replaced, never a box written
     inside a row, so a sum over a `BoxField` is a `computed`.
   - A list written whole on each refetch stays a box written through
     `reconcile(previous, next, { keyOf, equals })`, which keeps the previous
     object of every item `equals` finds unchanged.
7. **Writes of asynchronous work that must not show early go through a
   stage.** `const stage = openStage(realm, { name })`, then
   `stageUpdate(stage, (read, write) => ...)` for each step, then
   `applyStage(stage)`, with `dropStage(stage)` in a `finally`: no box
   changes and nothing reruns until `applyStage` lands every step in one
   update, and `dropStage` does nothing once the stage is applied. With
   Effect, `withStage(realm, (stage) => program)` does the same.
   - A read through the stage sees its own writes: boxes, collections
     (`keys`, `rows`, `row`, `read.row`), and computed values. It writes
     boxes, collections, and atoms, as an update does.
   - A recipe runs twice, staged and applied. Make ids, times, models, and
     boxes outside it and close over them; inside it, making an observable,
     `update`, `untracked`, a kept `read` or `write`, and a watch throw.
   - A method that hands back a change returns a `Recipe`, so it runs in
     `update(realm, recipe)` and `stageUpdate(stage, recipe)` alike.
   - A section that may fail on its own opens a child stage,
     `openStage(stage)` or `withStage(stage, ...)`: dropped, it leaves the
     parent as it was.
   - `applyStage` replays over the realm's values when it runs. Pass
     `{ conflicts: "fail" }` to have it throw `StageConflictError` instead
     when what the stage read changed; never retry a section that sends a
     request unless the request is safe to repeat.
   - A write meant to show before the work succeeds, an optimistic one,
     stays a plain `update` that the application undoes by hand.
8. **State from outside starts when it is observed.** `onObserved($x, start)`
   runs `start` on the first observer and its cleanup after the last; an
   `atom(realm)` stands for outside state, and `write.changed($atom)` reruns
   what read it. With Effect, `whileObserved($x, program)` runs a feed while
   `$x` is observed, and `fromStream(realm, stream, initial)` makes a value
   that holds the stream's last element while observed.

## In a component

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
  several observables; it costs a layout effect per render. A value several
  components need is a `computed` on the model instead.
- In an event handler, read inside `untracked(realm, (read) => ...)`, and
  write through a model method that calls `update`.
- In a handler or an update, look a row up with `read.row($items, key)`.
  `read($items.row(key))` there makes a box for the key that the collection
  keeps until the key is removed; `read.row` makes none.
- A test reads through `untracked` and writes through `update`,
  as application code does. It makes its realm with `using realm =
  testRealm()` and records what a select changed to with `using values =
  record(realm, select)`, both from `@frondruntime/pinna/testing`; the
  realm's dispose throws if a watch, an autorun, an `observe`, an
  `onRowChange` listener, or a stage is still running. An autorun, a watch with its own
  effect, or an `observe` is held with `using _ = held(stop)`, so a failed
  assertion still stops it. `retainedKeys($items)` names the keys a
  collection still keeps something for, so a test checks that removed rows
  were let go.
- There is no `observer` wrapper. It works with the React Compiler as it is.
- A write renders at once, even inside `startTransition`: the hooks read
  through `useSyncExternalStore`. A slow render after a write reads
  `useDeferredValue(useValue($x))` under `memo` instead.
- There are no components like `Memo`, `Show`, `For`, or `Reactive`. To
  rerender less, move the read into a small component under `memo`; for
  control flow, use plain JSX (`&&`, `.map`).

## MobX habits that do not carry over

| MobX | Pinna |
| --- | --- |
| `observer(Component)` | `useValue($x)` for each value the component shows |
| `makeAutoObservable`, `@observable` | `$` fields: `box(this.realm, ...)` in a `Model`, or `BoxField(schema)` in a `SchemaModel` |
| reading `store.x` | `read(store.$x)` in a place |
| `action`, `runInAction` | `update(realm, (read, write) => { ... })` |
| `store.x = value` | `write(store.$x, value)` in an update |
| a `computed` getter | `readonly $x = computed(this.realm, (read) => ...)` |
| `reaction(select, effect)` | `watch(realm, (read) => ..., effect)` |
| `autorun` | `autorun(realm, (read) => ...)` |
| `map.get(key)` in an action | `read.row($items, key)` in an update |
| pushing into an observable array | `write.modify($box, (draft) => { draft.push(item) })`, or a collection: `collection(realm, { keyOf })`, or a `CollectionField` |
| `toJS` | not needed: values are plain data |

## When it throws

- `read(...) runs outside a place`: a `read` kept past its place, in
  a closure or a variable, then called. Read in the place itself.
- `write inside update`: a `write` kept past its update. Write
  inside the update, usually in a model method.
- `... is handed an observable of another realm`: a `read` or a
  `write` of one realm given what another realm made; a realm made
  with `createRealm({ name })` is named, as `(realm "quotes", not "ui")`.
  Build every
  observable from the realm that reads it.
- `the box rejects this value: ...`: the value does not match the field's
  schema.
- `update cannot run in a computed value` or `in a watch's select or a
  selector`: a derivation only reads. Write from an event, a watch's
  effect, or an autorun.
- `... runs on a stage after it was applied`: a stage call after it
  closed. Open a new stage; `dropStage` alone does nothing there.
- `... is made inside a stage recipe` or `a stage recipe writes the
  realm`: a recipe made something or wrote around its stage. Make it
  outside the recipe, and write through the recipe's own `write`.
- `watchers did not settle after 100 rounds`, sent to `onError`: an
  autorun or a watch effect writes what it reads on every run. Make the
  write settle, or derive the value with `computed`.

Pass `{ name }` to `computed`, `box`, or `computedFunction`
(`computed(this.realm, (read) => ..., { name: "Todos.remaining" })`) and its
errors name it. A `BoxField` takes no name, so its errors say
`$observable`. `inspect($x)` reports what a value read and
why it last recomputed.

## No lint rule for reads in render

There is no `read` outside a place, so a read in a render body does not
type-check; `useValue`, `useValues`, and `useSelect` are the only ways in.
A `read` leaked from a place into a render throws when it runs.
