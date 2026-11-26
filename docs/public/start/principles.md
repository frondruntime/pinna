---
title: Design principles
description: Read when deciding whether Pinna fits, or when one of its rules looks arbitrary. What Pinna is designed for, the mechanism behind each principle, and what each one costs.
---

Pinna is written to be used by agents as much as by people. A read or a write
in the wrong place fails with a type error or a named error instead of
half-working; the mistakes that still pass silently are listed under
[Misuse is loud](#misuse-is-loud). That takes more code than a library that
tracks reads implicitly, and it takes speed. Pinna pays both on purpose.

## Reads are explicit

With implicit tracking, a person or an agent reading `position.value` cannot
tell whether it is a plain value or a tracked read, so cannot tell where
tracking is needed. Forgetting it produces no error — only a value that stops
updating.

In Pinna an observable is not its value. It is a box, a computed value, an
atom, or a collection, named with a leading `$`, and it has no read or write
methods. Every place that reads hands its function a `read`, and `read($x)`
both returns the value and subscribes that place. An observable used as its
value without `read` does not type-check wherever the value's type matters:
arithmetic, a comparison, a property or a method of the value, a variable or
an argument typed as the value. A truthiness check and a string conversion
accept any object, so they still compile; see [Misuse is loud](#misuse-is-loud).

<!-- region principles.ts#read -->

A component's render body has no `read` at all, so a call to `read` there
does not compile, and an observable used there as its value meets the same
type errors. `useValue`, `useValues`, and `useSelect` are the only ways in,
which is why there is no `observer` wrapper and no lint rule for reads in
render.

The cost is code. Every read is a call, a derived value is a `$` field built
with `Computed.make` instead of a getter, and `read` is passed down as an argument
to whatever needs it.

## A write has one place

A box changes only inside `Realm.update`, through the `write` it hands out. A box
field has no setter, and a `write` kept past its update throws. So every write in an application sits inside a
`Realm.update`.

An update is atomic. An error thrown from the recipe, such as the
`not enough in stock` below, undoes every write before it in the same update,
and watchers run once, after the update ends. A write the schema of a
`Box.schema` rejects throws in the recipe the same way, and is undone the same
way: see [Schema-checked boxes](../effect/boxes.md).

<!-- region state.ts#atomic -->

The cost is that some familiar patterns are errors. An update in a computed
value or a watch's select throws, so a derived value never writes. An update
is synchronous, so a write after an `await` opens a new update. One case of
[reactive-framework-test-suite](https://github.com/johnsoncodehk/reactive-framework-test-suite)
expects a batch that throws to keep its writes, and Pinna fails it by design.

## Misuse is loud

Checks at supported boundaries fail loudly: `read(...) runs outside a place`,
`write inside Realm.update`, and `the box rejects this value` identify the
correction. Detection does not extend to the limits below. An observable
made with `{ name }` is named in its errors, and `Source.inspect($x)` reports
what a value read and why it last recomputed. Every error carries a literal
`_tag`, and a misuse a `code`, so code matches what went wrong without
parsing the message.

Some mistakes are not caught:

- **An observable used where any value passes.** TypeScript accepts any
  object in a condition and in a string conversion, so a forgotten `read`
  there compiles and runs. `if ($done)`, `$done && ...`, `!$done`, and
  `$name ?? ""` test the observable, which is always truthy. A template
  literal, `String($x)`, and `"total: " + $x` give `[object Object]`, and
  `JSON.stringify($x)` writes the observable's internals, its realm included.
- **A kept `read` called inside another place.** It acts as that place's own
  `read` and tracks there. Binding each `read` to its place would cost a
  closure per run.
- **A kept `write` called inside another realm.** Each realm's `read` and
  `write` throw for an observable of another realm, but a `write` kept from
  one realm's `Realm.update` still writes that realm while the update is open,
  even from a computed value of another realm.
- **A value of another realm, stored.** A box, a collection, or a nested
  `make` keeps a model instance of another realm, because a stored value is
  data and storing it compares no realm. Reading its boxes in the holder's
  realm throws, at the read, not where the value was stored.
- **An update of one realm inside another's.** A rollback of the outer
  update leaves the writes the inner one made to its own realm.
- **A value changed in place through a cast.** A value is plain data, not a
  proxy, so the change is checked by no schema and seen by no watcher.
- **A write that breaks a check on the class as a whole.** A write checks the
  box's own schema. A check on a `Model.Schema` as a whole runs when an
  instance is made, decoded, or written to a schema box, never on a write to
  one of its boxes.
- **An update that decides on a guess.** While a visible stage shows a
  guess, a `Realm.update` recipe reads the confirmed value under it, so a
  recipe that adds 1 to a shown 11 leaves 12 after the guess drops. Change
  a guessed value through a stage made above the guess. Checking every read
  for a guess would cost the read path a branch.
- **A shown value read at rest and written later.** `Source.peek($count)` in
  a handler, then `write($count, count)` in an update, writes the shown
  guess into the confirmed values. Read the value inside the recipe that
  writes it.
- **A write during a React render.** `Realm.update` in a component's render
  body lands, and every mounted reader settles on it; React logs "Cannot
  update a component while rendering a different component" when the write
  reaches another mounted component. Refusing it
  would cost every write a check for a renderer Pinna does not know. Write
  in an event handler or an effect.
- **A draft stored inside a `Map` or a `Set`.** `write.modify` finalizes a
  draft held in a plain object or an array, and treats a `Map`, a `Set`, and
  a class instance as opaque values. `draft.byKey = new Map([["a",
  draft.row]])` stores the draft itself, and every read of it after the
  recipe throws `pinna: a draft is used after its recipe returned`. Walking
  into containers Pinna cannot copy would cost every `write.modify`. Put the
  value in an object or an array, or read it with `read($box).row` first.
- **A select nested in an update that writes through `Model.restore` or
  `Collection.reconcile`.** `Realm.watch` called inside a `Realm.update`
  runs its select at once, and a `Model.restore` or a `Collection.reconcile`
  there writes, where a select outside an update throws
  `pinna/update-in-derivation`. The nested select is not marked as a
  derivation, and marking it would cost `Realm.update` a field on its path.
  Start the watch outside the update.
- **Raw `Reaction.adopt()` of `pinna-core` called from a derived value or
  inside the reaction's own `trackPending` run.** The first is refused with
  `pinna: ... cannot observe or release while it computes`, and the last
  pending read is not kept for the next valid `adopt`, so a write to what
  it read notifies nobody. The second is not refused, and a pending run
  that throws does not keep the committed sources. `Reaction` is the raw
  core API, which applications do not call, and keeping the last run would
  cost every `trackPending`.
- **Raw `Capture.changed()` of `pinna-core` over an atom nothing observes.**
  It answers by writes alone, so it returns `false` while the atom's outside
  value moved. `Reaction.follow` and `Reaction.activate` see the change, and
  the hooks decide through them. A walk at each `changed` would call such an
  atom changed every time, and a renderer's snapshot would never settle.
- **A misuse inside a computed value's `equals`.** `Source.observe`, a write,
  or a release in the `equals` of a named `Computed.make` throws the usual
  error, so the misuse still fails loudly; only the label is generic,
  "a derived value", not the computed value's name. The comparator runs with
  no active node, so naming its owner would need a store on each recompute
  that has an `equals`, which is not worth a weaker label on a loud error.
- **Two copies of Pinna in one application.** A `read` or a `write` of one
  copy given an observable of the other throws `pinna/foreign-realm`, but
  `Box.make` and `Realm.autorun` of one copy accept a realm of the other.
  One copy of each Pinna package is the supported install.

## Glitch-free by construction

A watcher never sees a half-applied update, and a derived value never
computes from a stale source. A write marks what depends on it; a derived
value checks its sources' versions, in read order, before it recomputes;
watchers run after the write settles. An update that writes a value and then
its old value back recomputes nothing.

The cost of these guarantees together is speed. Every read is tracked, every
write to a `Box.schema` or a `Model.boxField` is checked against its schema, and Pinna does
not trade either away. Its budget for 1.0, measured on Hermes, is the public layer within 2×
of alien-signals and the graph core within 1.6×. The measurements are in
[performance.md](https://github.com/frondruntime/pinna/blob/main/docs/performance.md).

That makes Pinna a library for domain state: models, forms, lists loaded from
a server, totals derived from them, and the charts and canvases that draw
them once a frame. Per-entity simulation state, such as particles or physics,
stays in plain arrays and objects, and writes what the UI shows once a frame.

## Hermes first

Pinna is measured where applications ship. A React Native app runs on Hermes,
where memory is at a premium, so a change counts when Hermes confirms it, and
a win measured only in Bun counts as a hint.

Memory is measured as live bytes after a full collection. They stay flat
after warm-up in every measured scenario — rows added and removed, a realm
made and dropped per screen, rejected writes, undone updates — and nothing
outlives dispose beyond the measuring harness's own 15 to 30 KB.

The limit is the list of scenarios. A number holds for what was measured, on
Hermes, and a workload outside that list is not covered by it.

## The synchronous counterpart to Effect

Effect runs the programs; Pinna holds the state they read and write. Pinna
started on Effect, and its models are still Effect Schema classes: one class
decodes server data, checks every write to its fields, and encodes back. The
realm is an Effect service, and `Program.watchScoped`, `Program.changes`, and `Program.fromStream`
turn watches, streams, and changes into programs that stop with their scope.

State itself stays synchronous. A read returns a value, not a program, and an
update finishes before it returns. The hooks read through
`useSyncExternalStore`, which takes a synchronous value.

The graph was later extracted from the Effect layer. `pinna-core` imports
nothing at runtime, and `@frondruntime/pinna` has the same calls on boxes
that take no schema, with no Effect.

The cost sits in `pinna-effect`. A `Model.Schema` decodes only through
`Model.decode`, which provides the realm as a service: about 1.2 µs more per
instance than a decode without one. And `Model.Schema` reads two internals of
Effect's `Schema.Class`, as of `effect` 4.1.0, and throws if either is gone.

## Why not Effect's Atom

Effect ships a reactive layer of its own, `Atom` in `effect/reactivity`, and
it was the first base tried for Pinna. It was set aside for what it does on a
write. This holds as of `effect` 4.1.0.

- **An unbatched write shows a mixed state.** `Atom` recomputes dependents
  eagerly, one after another. With `b` and `c` derived from `a`, and `d`
  reading both, one write to `a` computes `d` twice: first from the new `b`
  and the old `c`, then from both new. `Atom.batch` rebuilds dependents once, after
  its callback, which avoids this when every write is wrapped in one. Pinna
  computes `d` once. The case is
  [bench/diamond.ts](https://github.com/frondruntime/pinna/blob/main/packages/pinna/bench/diamond.ts),
  and `bun run --cwd packages/pinna bench` prints both.
- **A failed batch keeps its writes.** What a batch wrote before it threw
  stays written. A Pinna update is undone.
- **A write is not checked.** `Atom` uses Schema to store and to serialize a
  value, not to check one on a write. `AtomRef` makes a ref for each property
  of a plain value, and a collection of refs, and neither takes a schema.
  There is no class decoded from server data whose fields are checked boxes.

`Atom` is built for a different job: values that come from an Effect or a
Stream, with their loading and failure states. For that it is the better
choice, and it is first-party. Pinna holds synchronous domain state — models,
their fields, the values derived from them — and both can live in one
application.

The cost is a second reactive layer beside the one Effect ships, owned by
this project and not by Effect's maintainers.

## The decision

Where a guarantee and speed conflict, the guarantee wins and the budget says
by how much. No API is speculative: nothing is added that nobody asked for,
so the surface an agent has to learn stays small, and what is added is
complete. The rules an agent follows while writing code ship
with the package, in
[AGENTS.md](https://github.com/frondruntime/pinna/blob/main/packages/pinna/AGENTS.md).

## See also

- [Start](./index.md): a realm, a box, a computed value, and an update.
- [Coming from MobX](./mobx.md): the Pinna call for each MobX one.
- [Errors and debugging](../guides/errors.md): what throws, and `Source.inspect`.
