---
name: pinna-with-effect
description: "Use when Pinna meets Effect: state checked by Effect Schema or decoded from the wire (Box.schema, Model.Schema, Model.decode), or Effect programs on state (Program.*, Source.observeScoped, Realm.scoped, Stage.scoped). For plain state with no schema use pinna-state."
---

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->

# Pinna with Effect

Declares state that a schema checks, decodes wire data into it, and runs Effect programs over state for the length of a scope, through `@frondruntime/pinna-effect`.

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

4. **A box with a schema checks every write.** A `Box.schema` or a
   `Model.boxField` throws on a value its schema rejects. A `Box.make` checks nothing,
   from either package. A `Collection.make` rejects `undefined` rows and checks
   nothing else. Choose per box: data
   from outside the program (the wire, user input) goes through a schema,
   and trusted data that is written often takes a plain `Box.make` or a `Model`.
   Never weaken a schema box's check for speed.

6. **A model is a class with `$` fields, and writes through its methods.**
   - With Effect, it is a `Model.Schema`. A `$name` field is
     `Model.boxField(schema)` or `Model.collectionField(schema, { keyOf })`, and its wire
     key is `name`. Make instances with `Model.decode(realm, Todo)(json)`, or with
     `Todo.make({ id, title, done: false, realm })`, which takes each `$`
     field's value under its wire key and throws on a `$` key.
   - With Effect, a class with no `$` field is a plain `Schema.Class`: a
     `Model.Schema` adds a `realm` field, which `make` then asks for.
   - A method writes with `Realm.update(this.realm, (read, write) => ...)`, so
     callers change a model only through what it allows.

7. **Writes of asynchronous work that must not show early go through a
   stage.** `const stage = Stage.make(realm, { name })`, then
   `Stage.update(stage, (read, write) => ...)` for each step, then
   `Stage.apply(stage)`, with `Stage.drop(stage)` in a `finally`: no box
   changes and nothing reruns until `Stage.apply` lands every step in one
   update, and `Stage.drop` does nothing once the stage is applied. With
   Effect, `Stage.scoped(realm, (stage) => program)` does the same.
   - A write meant to show before the work succeeds, an optimistic one,
     goes in `Stage.make(realm, { visible: true })`: it shows at once over
     the realm's confirmed values, and a failure drops it with nothing to
     undo. When the guess is the answer, apply the visible stage on success
     and drop it in a `finally`. When the server's answer wins, show the
     guess in a visible stage, write the answer in a hidden one, and in one
     `Realm.update` apply the answer and drop the guess, so watchers see the
     settled value once. With Effect, `Stage.scoped(realm, section,
     { visible: true })` and `{ guess: recipe }` are the two flows.

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

12. **Tools read writes as data through `Realm.onUpdate`, never by wrapping
    `Realm.update`.** A listener gets one record per landed update, after
    its watchers ran: each box, row, key order, and atom it changed, before
    and after, in confirmed values (a visible stage's guess is never in
    one). Name an update with `Realm.update(realm, recipe, { name })` for
    logs and devtools.
    - In Effect, `Program.updates(realm)` streams every record, unbounded.

## References

Open a file under `references/` when its condition holds.

| File | Read when |
| --- | --- |
| [boxes.md](references/boxes.md) | Read when an app already uses Effect. Import the core's calls from pinna-effect, make a box that checks an Effect Schema on every write, and know what a schema adds to a write. |
| [classes.md](references/classes.md) | Read when modeling domain data. Declare a Model.Schema with box fields, derive values on it, write from its methods, decode it from the wire, and hand it the caller's own values, in a decode or an Effect program. |
| [collections.md](references/collections.md) | Read when a model holds rows by key. Declare a Model.collectionField, decode it from a plain array, write a refetch that keeps rows equal under the schema, and reconcile a schema-checked box of an array. |
| [equality.md](references/equality.md) | Read when a write, a refetch, or a reconcile keeps or replaces a value. Know what each box, collection, and reconcile compares with by default, why two decodes of a model with a box are not equal unless the class defines its own Equal, what Effect's Equal.equals and HashSet see, and how a class defines its own Equal and Hash. |
| [programs.md](references/programs.md) | Read when an Effect program watches, streams, or feeds Pinna state: the `Scoped` forms, lifetimes, and failures as values. |
| [programs-stages.md](references/programs-stages.md) | Read when an Effect section holds its writes in a stage: `Stage.scoped`, a visible section, `{ guess }`, conflicts. |
| [live-data-with-effect.md](references/live-data-with-effect.md) | Read when a socket or a request is an Effect or a `Stream`: `Program.whileObserved`, `Program.fromStream`, `Program.fromEffect`. |

## Another skill applies

- `pinna-state`: a plain box or model that checks nothing.
- `pinna-stages-and-live-data`: the plain `Stage.make`, `Source.onObserved`, and `Computed.fromPromise` the `Scoped` forms stand for; load it with this one.
- `pinna-saving-and-history`: `Model.restore` and restoring a saved shape.
- `pinna-testing-and-errors`: tests of an Effect program, and a `ValueRejectedError` or `DecodeError` to trace.

`node_modules/@frondruntime/pinna/AGENTS.md` is the same text at the installed version and wins where it differs.
