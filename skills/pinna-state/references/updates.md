# Updates: Example, Rules, Answers

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/state/updates.md, its sections "Example", "Rules", "Answers".

Sections: Example, Rules, Answers.

## Example

A box has one way in: `Realm.update`, which hands out `read` and `write`. An array
or a plain object is changed through a draft from `write.modify` — mutated
inside the recipe, then written back once. The samples on this page and on
[Reacting](reacting.md) share this realm and box.

```ts
import { Box, Realm } from "@frondruntime/pinna";

const realm = Realm.make();
const $tags = Box.make<ReadonlyArray<string>>(realm, []);
```

```ts
import { Realm } from "@frondruntime/pinna";

const addTag = (tag: string) => {
  Realm.update(realm, (_read, write) => {
    write.modify($tags, (tags) => {
      tags.push(tag);
    });
  });
};
```

An update is atomic. An update that throws is undone: every write before the
throw in the same update is taken back. Watchers run once the update ends, so
after a rollback they see the old state.

```ts
import { Box, Realm } from "@frondruntime/pinna";

const $quantity = Box.make(realm, 1);
const $note = Box.make(realm, "");

const take = (amount: number) => {
  Realm.update(realm, (read, write) => {
    write($note, `took ${amount}`);
    const left = read($quantity) - amount;
    if (left < 0) throw new Error("not enough in stock"); // $note is undone too
    write($quantity, left);
  });
};
```

A refetch hands back new objects for items that did not change. `Collection.reconcile`
keeps the previous object of every item that did not change, so what derives
one item from the list returns the same value and its readers do not rerun.

```ts
import { Box, Collection, Realm } from "@frondruntime/pinna";

interface Rate {
  readonly currency: string;
  readonly rate: number;
}

const $rates = Box.make<ReadonlyArray<Rate>>(realm, []);

const receiveRates = (next: ReadonlyArray<Rate>) => {
  Realm.update(realm, (read, write) => {
    // An unchanged rate keeps its previous object, so what derives one rate
    // from $rates returns the same value and its readers do not rerun.
    write(
      $rates,
      Collection.reconcile(read($rates), next, {
        keyOf: (rate) => rate.currency,
        equals: (previous, latest) => previous.rate === latest.rate,
      }),
    );
  });
};
```

An event handler wants the value as it is now, not a subscription. It reads
through `Realm.untracked`.

```ts
import { Realm } from "@frondruntime/pinna";

const onSave = () => {
  const tags = Realm.untracked(realm, (read) => read($tags));
  console.log("saving", tags);
};
```

## Rules

- Never keep a `read` or a `write` past its place. Neither is bound to the
  place that handed it out: outside every place of its realm a `read` throws,
  outside every update a `write` throws, and inside some other place a kept
  `read` acts as that place's own. Pass `read` down as an argument instead.
- Values are plain data. Change them with `write` or
  `write.modify`, never in place: a value is not a proxy, so a change made in
  place is seen by no watcher.
- A box's value is a tree: every key holds its own value. An array or object
  a recipe assigns is copied on the first write through the draft, so the
  caller's object keeps its value, and an object assigned at two keys is two
  values once one of them is written. Refer to one object from two places by
  a key (`selectedId`), a collection row, or a box, never by holding it
  twice: the next `write.modify` drafts each key apart, so a write through
  one key does not show at the other.
- A draft's copy is the value it copies: a plain object keeps its
  prototype, `null` included, and its symbol keys; an array keeps its
  elements, its symbol keys, and a match array's `index`, `input`, and
  `groups`. An array's other named properties are not copied, because
  finding them costs a walk over every index; keep such data in an object.
- An outer `write.modify`'s draft that the outer recipe wrote, assigned
  inside an inner one, throws
  `pinna: write.modify was given a draft another recipe wrote`, and the
  update is undone: the outer recipe can change the draft after the inner
  box's check, and a copy would hide that write. An unwritten one lands as
  the value it drafts.
- A draft handed to a plain `write` is not a value. A `Box.schema` or
  `Model.boxField` refuses it, or a value holding it, with
  `pinna: a checked box was given a draft of an open write.modify`, and the
  update is undone. A plain box stores it, and every read after the recipe
  returns throws `pinna: a draft is used after its recipe returned`: a plain
  box runs no check, and a walk on every write would cost `write` itself.
- A draft the recipe wrote and left at a second key, inside itself, or
  inside an object the recipe placed at two keys, throws
  `pinna: write.modify left an object it wrote under two keys`, and the
  update is undone. `draft.history.push(draft.present)` followed by
  `draft.present.count++` throws; a snapshot is read before the write, with
  `read($box).present`, which is the plain value. A draft at two keys that
  the recipe never wrote finalizes to the one object the box held.
- A draft stored inside a `Map`, a `Set`, or a class instance is stored as
  a draft: those are opaque values, and a read of it after the recipe
  throws `pinna: a draft is used after its recipe returned`. Keep a drafted
  value in a plain object or an array.
- An update is synchronous. A recipe that returns a promise throws at once and
  is undone, because a write after an `await` would land outside the update.
  Await first, then open a new update.
- Nested updates join the outermost one. Watchers run once, when it ends, and
  see only its end state.
- An update runs from an event, a watch's effect, or an autorun's body. It
  throws in a computed value, a watch's select, or a selector, which only
  read.
- An effect that cannot be taken back, such as a request, a message, or a
  file write, runs after the update, never inside its recipe. An update that
  throws undoes its writes, not what the recipe did outside the realm: a
  request sent inside it has gone out, and a later throw, in the same update
  or in a caller's update it joined, leaves the server with what the realm
  no longer holds. See [Effects after the update](effects-after-the-update.md#effects-after-the-update).

## Answers

| Call | Answers |
| --- | --- |
| `Realm.update(realm, (read, write) => ...)` | Runs the recipe atomically. If it throws, every box it wrote gets its old value back. |
| `write($box, value)` | Replaces the value. The write for a number, a string, a boolean, or any value but an array or a plain object: `write($count, read($count) + 1)`. |
| `write.modify($box, (draft) => ...)` | Writes the drafted array or object back once. It takes no updater function, and throws `pinna/modify-not-draftable` on any other value. |
| `Write` | The type of `write`, for a function an update hands it to. Each of its calls returns `undefined`, so a recipe can end in one. |
| `Collection.reconcile(previous, next, { keyOf, equals })` | `next`, with each item `equals` finds unchanged replaced by its previous instance; `previous` itself when nothing changed. A key repeated in `next` throws. |
| `Realm.untracked(realm, (read) => ...)` | What the function returns, read without subscribing. |
| `Stage.make(realm, { name?, conflicts?, visible? })` | A new `Stage` over the realm, holding nothing. `conflicts: "fail"` makes `Stage.apply` refuse when what the stage read or wrote changed. `visible: true` shows its writes over the realm's confirmed values until it applies or drops. |
| `Stage.make(stage, { name? })` | A child stage over `stage`: a savepoint that applies into it. |
| `Stage.update(stage, (read, write) => ...)` | Runs the recipe at once against the stage and keeps it. No box changes. A recipe that throws puts back what it wrote to the stage and is not kept. |
| `Stage.read(stage, (read) => ...)` | What the function returns, reading through the stage: its own writes, then, for a visible stage, the showing stages below it, and the realm's confirmed values elsewhere. |
| `Stage.realmRead(stage, (read) => ...)` | What the function returns, reading the realm's confirmed values, ignoring every stage. These reads are not recorded for the conflict check. |
| `Stage.apply(stage)` | Replays its recipes in order: over a realm, into a fresh overlay, then lands its final state in one update nested in an open one; over a stage, into that stage. A conflict or replay throw drops it; a precondition failure leaves it open. |
| `Stage.drop(stage)` | Closes the stage and its open children, and discards them. No box changes. Does nothing to a closed stage. |
| `Stage.status(stage)` | `"open"`, `"applied"`, or `"dropped"`. |
| `Stage.inspect(stage)` | The stage's name, realm, parent, status, and conflict mode; the names of the boxes and collections it wrote; under `{ conflicts: "fail" }`, the names of what it read or wrote and `Stage.apply` checks; how many recipes and open children it holds; `visible`; `showing`, `false` for a hidden stage and a stopped one; and `failure`, the error a stopped stage keeps. |
| `UpdateRecipe` | `(read, write) => undefined`: what `Realm.update` and `Stage.update` run. |
| `StageClosedError` | Thrown by `Stage.update`, `Stage.read`, `Stage.realmRead`, `Stage.apply`, or `Stage.make` of a child on a closed stage; `_tag` is `"StageClosedError"`, `stage` its name, and `status` how it closed. |
| `StageConflictError` | Thrown by `Stage.apply` on a conflict, and by `Stage.update` and `Stage.read` on a visible stage stopped by one; `_tag` is `"StageConflictError"`, `changed` names what changed, a named box or collection by its `name`, and `observables` holds it. |
