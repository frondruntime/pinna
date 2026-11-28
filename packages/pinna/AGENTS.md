# Using Pinna: rules for agents

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

The same rules, split by task, install as agent skills with
`npx skills add frondruntime/pinna`.

## Where each call lives

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
| Show state in React | `useValue`, `useValues`, `useSelect` | `pinna-react-components` |
| Check data against a schema, or decode it | `Box.schema`, `Model.Schema`, `Model.decode` | `pinna-with-effect` |
| Run state as an Effect program | `Program.watchScoped`, `Program.changes`, `Realm.scoped` | `pinna-with-effect` |
| Hold writes until asynchronous work ends, or show them early | `Stage.make`, `Stage.apply`, `{ visible: true }` | `pinna-stages-and-live-data` |
| Load a request's answer, or a feed while it is observed | `Computed.fromPromise`, `Source.onObserved`, `Program.fromStream` | `pinna-stages-and-live-data` |
| Save, restore, undo, or log every write | `read.snapshot`, `write.restore`, `Realm.onUpdate`, `write.revert` | `pinna-saving-and-history` |
| Test code on Pinna, or trace an error | `testRealm`, `record`, `isPinnaError` | `pinna-testing-and-errors` |
| Move code from MobX | the table under "MobX habits that do not carry over" | `pinna-from-mobx` |

## The rules

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
4. **A box with a schema checks every write.** A `Box.schema` or a
   `Model.boxField` throws on a value its schema rejects. A `Box.make` checks nothing,
   from either package. A `Collection.make` rejects `undefined` rows and checks
   nothing else. Choose per box: data
   from outside the program (the wire, user input) goes through a schema,
   and trusted data that is written often takes a plain `Box.make` or a `Model`.
   Never weaken a schema box's check for speed.
5. **A derived value is a `$` property in the class body:**
   `readonly $total = Computed.make(this.realm, (read) => ...)`. A plain getter has
   no `read` to call; a method that takes `read` is not cached.
6. **A model is a class with `$` fields, and writes through its methods.**
   - Without Effect, it extends `Model`:
     `class Todo extends Model { readonly $done = Box.make(this.realm, false) }`,
     made with `new Todo(realm)`. `Model` holds the realm, so field
     initializers read `this.realm`, and it marks instances, so a draft leaves
     them read-only.
   - With Effect, it is a `Model.Schema`. A `$name` field is
     `Model.boxField(schema)` or `Model.collectionField(schema, { keyOf })`, and its wire
     key is `name`. Make instances with `Model.decode(realm, Todo)(json)`, or with
     `Todo.make({ id, title, done: false, realm })`, which takes each `$`
     field's value under its wire key and throws on a `$` key.
   - With Effect, a class with no `$` field is a plain `Schema.Class`: a
     `Model.Schema` adds a `realm` field, which `make` then asks for.
   - A method writes with `Realm.update(this.realm, (read, write) => ...)`, so
     callers change a model only through what it allows.
   - A collection changes its key order in place when a key is added or
     removed, while nothing holds the order. A read of `keys` (an autorun, a
     computed value, a view), an open visible stage, or a `Realm.onUpdate`
     listener holds it: the first add or remove after the read copies the
     order, so that costs more as the collection grows. Replacing a held row
     does not. Many new rows go in through one `write.replaceAll`, which
     copies once, not an `upsert` per row.
   - A list of models is a `Collection.make`, a `Model.collectionField`, or a
     `Collection.schema`, not a box
     holding instances: every write to a box reruns every reader of it, and
     a collection tracks each key on its own, so a reader of one row reruns
     only when that row changes.
   - A list sorted or filtered over a collection is a
     `View.ordered($items, { compare: (read) => comparator, filter })`, read
     through `view.range(start, end)` for what a list shows; the keys of each
     group are a `View.grouped`, and a count and total per group a
     `View.totals` with integer or bigint arithmetic. A `Computed.make` that
     sorts `$items.rows` sorts every row on each change. Callbacks are a
     function of the row, which is never changed after it is written; the
     view is made once on its owner and disposed with `View.dispose` where
     the owner ends.
   - Any other value kept a row at a time over a collection is a box written by
     `Collection.onRowChange($items, (change, read, write) => ...)`, which runs in the
     writer's update. A `Computed.make` that reduces `$items.rows` reruns over
     every row on each change. The listener never writes its own collection,
     keeps its state in boxes so it rolls back, and is added once: each
     call replays the held rows. It sees rows replaced, never a box written
     inside a row, so a sum over a `Model.boxField` is a `Computed.make`.
   - A list written whole on each refetch stays a box written through
     `Collection.reconcile(previous, next, { keyOf, equals })`, which keeps the previous
     object of every item `equals` finds unchanged.
7. **Writes of asynchronous work that must not show early go through a
   stage.** `const stage = Stage.make(realm, { name })`, then
   `Stage.update(stage, (read, write) => ...)` for each step, then
   `Stage.apply(stage)`, with `Stage.drop(stage)` in a `finally`: no box
   changes and nothing reruns until `Stage.apply` lands every step in one
   update, and `Stage.drop` does nothing once the stage is applied. With
   Effect, `Stage.scoped(realm, (stage) => program)` does the same.
   - A read through the stage sees its own writes: boxes, collections
     (`keys`, `rows`, `row`, `read.row`), and computed values. It writes
     boxes, collections, and atoms, as an update does.
   - A recipe runs once when staged and once per `Stage.apply` through its
     parents to the realm; row listeners run for each change on each run.
     Make ids, times, models, and boxes outside it and close over them;
     inside it, making an observable, `Realm.update`, `Realm.untracked`, a kept `read` or
     `write`, and a watch throw.
   - A method that hands back a change returns a `UpdateRecipe`, so it runs in
     `Realm.update(realm, recipe)` and `Stage.update(stage, recipe)` alike.
   - A section that may fail on its own opens a child stage,
     `Stage.make(stage)` or `Stage.scoped(stage, ...)`: dropped, it leaves the
     parent as it was.
   - `Stage.apply` replays over the realm's values when it runs. Pass
     `{ conflicts: "fail" }` to have it throw `StageConflictError` instead
     when what the stage read or wrote changed; never retry a section that sends a
     request unless the request is safe to repeat.
   - A write meant to show before the work succeeds, an optimistic one,
     goes in `Stage.make(realm, { visible: true })`: it shows at once over
     the realm's confirmed values, and a failure drops it with nothing to
     undo. When the guess is the answer, apply the visible stage on success
     and drop it in a `finally`. When the server's answer wins, show the
     guess in a visible stage, write the answer in a hidden one, and in one
     `Realm.update` apply the answer and drop the guess, so watchers see the
     settled value once. With Effect, `Stage.scoped(realm, section,
     { visible: true })` and `{ guess: recipe }` are the two flows.
   - A `Realm.update` recipe reads the confirmed values, not the screen,
     while a guess shows: change a guessed value through a stage made above
     the guess. Read a value inside the recipe that writes it: one read at
     rest with `Source.peek` and written later writes the shown guess into
     the confirmed values. Pinna checks neither.
   - A pending marker is a box the guess writes (`write($saving, true)`):
     it shows exactly while the guess shows. A guess that can no longer
     apply stops showing; `Stage.inspect(stage).failure` says why.
8. **State from outside starts when it is observed.** `Source.onObserved($x, start)`
   runs `start` on the first observer and its cleanup after the last; an
   `Atom.make(realm)` stands for outside state, and `write.changed($atom)` reruns
   what read it. With Effect, `Program.whileObserved($x, program)` runs a feed while
   `$x` is observed, and `Program.fromStream(realm, stream, initial)` makes a value
   that holds the stream's last element while observed.
   - A request's answer is `Computed.fromPromise(realm, (signal) => request,
     initial)`, or `Program.fromEffect(realm, effect, initial)` with Effect.
     Pass `signal` to the request, so the last observer leaving aborts it.
     Map a failure the screen shows into the value's own union inside
     `load`; an unmapped rejection goes to `onError`. Pinna has no loading
     type: write the union, or take it from the request library.
   - Do not `await` a request and then call `Realm.update` by hand for a
     value a screen reads: the answer of an earlier request can land after
     a newer one, and after `Realm.dispose` the update throws
     `pinna/realm-disposed`. The bridge drops both.
   - Hold a value that must keep its answer with `Source.observe`;
     unobserved, it resets to `initial` and requests again when observed.
   - A query from another library, such as TanStack Query's
     `QueryObserver`, is copied into a `Box.make` by a `Source.onObserved`
     hook that syncs on start and subscribes until the cleanup.
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

10. **A watch or an autorun that should run at most once a frame takes a
    `scheduler`.** `Realm.watch(realm, select, effect, { scheduler })` and
    `Realm.autorun(realm, effect, { scheduler })` run when the scheduler calls the
    `run` it is handed, once for every write before it, with the values
    current then; a computed value they read recomputes once per run.
    Write the scheduler for the host, with a fallback where it has no frame:
    `(run) => requestAnimationFrame(() => run())`. Call `run` from the
    frame, a timer, an event handler, or a watch's effect, never inside an
    update or a tracked read (`pinna/scheduled-run-not-at-rest`). Keep
    the default for anything that must hold before `Realm.update` returns, such
    as a write that keeps two boxes consistent, and for React, whose hooks
    take no scheduler.

11. **State goes out and comes back through a declared shape.** Declare a
    plain object of the boxes and collections to keep, under the names the
    data should carry: `const saved = { theme: $theme, tabs }`.
    `read.snapshot(saved)` reads it as plain data, in any place a `read` is
    handed out; `write.restore(saved, data)` writes it back inside
    `Realm.update`, whole or not at all.
    - Never put a computed value, an atom, or a `Model.Class` instance in a
      shape (`pinna/snapshot-not-state`): put the boxes they read, or the
      instance's boxes by name. A `Model.Schema` instance stands in the
      shape under its wire keys.
    - The data matches the shape exactly (`pinna/restore-shape`); restore a
      smaller shape for a part.
    - A restore never makes a model: a new `Model.Schema` row comes in as an
      instance, from `Model.decode` or `make`, or the whole input goes
      through `Model.restore(realm, Schema)(held, input)`.
    - A restore writes boxes and runs no method of the model. Work that must
      follow a change, such as cancelling a request, belongs in a
      `Realm.watch`, so a restore triggers it too.
    - A live snapshot, for a save or a devtools view, is
      `Computed.make(realm, (read) => read.snapshot(saved))`: it recomputes on a
      write under the shape and on no other.

12. **Tools read writes as data through `Realm.onUpdate`, never by wrapping
    `Realm.update`.** A listener gets one record per landed update, after
    its watchers ran: each box, row, key order, and atom it changed, before
    and after, in confirmed values (a visible stage's guess is never in
    one). Name an update with `Realm.update(realm, recipe, { name })` for
    logs and devtools.
    - A listener reads the record; it updates only for its own state, such
      as a log or an undo stack, and never on every record, which loops.
    - Undo is `write.revert(record)` inside `Realm.update`, newest first;
      replay is `write.replay(record)`, oldest first. An undo stack skips the
      records its own reverts make. A record applied to another state than
      the one it left throws `pinna/record-not-applicable` and writes
      nothing.
    - A `Collection.onRowChange` listener registered before the record's
      update ended does not run on undo or redo: the record holds what it
      wrote. Keep its state in
      boxes, since a plain `Map` it fills is not restored. Add a listener at
      rest, never inside `Realm.update`: a record whose update added one
      throws on undo. A view runs on every undo and redo and is in no
      record. A listener added after a record that, as it hears one
      collection's undo or redo, changes a row the record lists in another
      collection makes that undo or redo throw and write nothing.
    - A record names boxes, never paths. Code that saves across a reload or
      syncs maps each box to a path from the shape it declared (rule 11);
      Pinna keeps no path index.
    - In Effect, `Program.updates(realm)` streams every record, unbounded.

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
  several observables; it runs the function on every render, and a layout
  effect on every render with a new function. A value several components
  need is a `Computed.make` on the model instead.
- In an event handler, read one value with `Source.peek($x)` and several
  inside `Realm.untracked(realm, (read) => ...)`, and write through a model
  method that calls `Realm.update`. `Source.peek` throws where reads are
  tracked and in a stage recipe, where it would read stale values.
- In a handler or an update, look a row up with `read.row($items, key)`.
  `read($items.row(key))` there makes a box for the key that the collection
  keeps until the key is removed; `read.row` makes none.
- There is no `observer` wrapper. It works with the React Compiler as it is.
- A write renders at once, even inside `startTransition`: the hooks read
  through `useSyncExternalStore`. A slow render after a write reads
  `useDeferredValue(useValue($x))` under `memo` instead.
- There are no components like `Memo`, `Show`, `For`, or `Reactive`. To
  rerender less, move the read into a small component under `memo`; for
  control flow, use plain JSX (`&&`, `.map`).

## In a test

- A test reads through `Source.peek` or `Realm.untracked` and writes
  through `Realm.update`, as application code does. It makes its realm
  with `using realm = testRealm()` and records what a select changed to
  with `using values = record(realm, select)`, both from
  `@frondruntime/pinna/testing`; the realm's dispose throws if a watch, an
  autorun, a `Source.observe`, a `Collection.onRowChange` listener, or a
  stage is still running, and disposes the realm either way. An autorun,
  a watch with its own effect, or a `Source.observe` is held with
  `using _ = held(stop)`, so a failed assertion still stops it.
  `retainedKeys($items)` names the keys a collection still keeps something
  for, so a test checks that removed rows were let go.
- Assert on `_tag` and `code`, not on the message.

## MobX habits that do not carry over

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

## When it throws

Every error is a `PinnaError` with a literal `_tag`; a misuse is a
`PinnaUsageError` whose `code` names it
(<https://pinna.frondruntime.dev/docs/reference/errors> lists each).

- Catch a condition with `isPinnaError(error, "StageConflictError")`, which
  narrows to the class. Never `instanceof`: two copies of Pinna in one app
  each have their own classes. Never the message text: it changes with the
  API.
- `read(...) runs outside a place`: a `read` kept past its place, in
  a closure or a variable, then called. Read in the place itself.
- `write inside Realm.update`: a `write` kept past its update. Write
  inside the update, usually in a model method.
- `... is handed an observable of another realm`: a `read` or a
  `write` of one realm given what another realm made; a realm made
  with `Realm.make({ name })` is named, as `(realm "quotes", not "ui")`.
  Build every observable from the realm that reads it.
- `the box rejects this value: ...`: a `ValueRejectedError`; the value
  does not match the field's schema, and `cause` is the `SchemaError`.
- `decode rejects the input: ...`: a `DecodeError` from `Model.decode`; `cause`
  is the `SchemaError`, and `issue` says what did not fit.
- `Realm.update cannot run in a computed value` or `in a watch's select or a
  selector`: a derivation only reads. Write from an event, a watch's
  effect, or an autorun.
- `... runs on a stage after it was applied`: a stage call after it
  closed. Open a new stage; `Stage.drop` alone does nothing there.
- `... changed since the stage read ...; nothing lands`: a
  `StageConflictError` from a stage opened with `{ conflicts: "fail" }`;
  nothing landed. A visible stage stopped by one throws it from
  `Stage.update`, `Stage.read`, and `Stage.apply`. Rerun the work over
  the new values, if its requests are safe to repeat. Name boxes and collections (`{ name }`) so the error names
  them.
- `... is made inside a stage recipe` or `a stage recipe writes the
  realm`: a recipe made something or wrote around its stage. Make it
  outside the recipe, and write through the recipe's own `write`.
- `watchers did not settle after 100 rounds`, sent to `onError`: an
  autorun or a watch effect writes what it reads on every run. Make the
  write settle, or derive the value with `Computed.make`.

Pass `{ name }` to `Computed.make`, `Box.make`, `Computed.fn`,
`Collection.make`, or `Model.collectionField`
(`Computed.make(this.realm, (read) => ..., { name: "Todos.remaining" })`)
and its errors name it. A `Model.boxField` takes no name, so its errors say
`$observable`. `Source.inspect($x)` reports what a value read and
why it last recomputed.

## No lint rule for reads in render

There is no `read` outside a place, so a read in a render body does not
type-check; `useValue`, `useValues`, and `useSelect` are the only ways in.
A `read` leaked from a place into a render throws when it runs.
