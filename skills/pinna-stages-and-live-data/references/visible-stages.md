# Updates: Visible stages

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/state/updates.md, its section "Visible stages".

## Visible stages

A stage made with `{ visible: true }` shows its writes at once, over the
realm's confirmed values, and keeps showing them until `Stage.apply` lands
them or `Stage.drop` takes them off. An optimistic write is a visible
stage: a failure drops it and leaves nothing to undo by hand, and a refetch
that lands under it keeps the guess on top. When the guess is the answer,
the stage applies on success.

```ts
import { Box, Stage } from "@frondruntime/pinna";

const $title = Box.make(realm, "Untitled");

const rename = async (title: string, save: (title: string) => Promise<void>) => {
  // Shown at once over the realm's confirmed values; the guess is the answer.
  const stage = Stage.make(realm, { name: "rename", visible: true });
  try {
    Stage.update(stage, (_read, write) => {
      write($title, title);
    });
    await save(title);
    Stage.apply(stage);
  } finally {
    // A failed save takes the guess off the screen: $title shows the confirmed title.
    Stage.drop(stage);
  }
};
```

When the server's answer wins, the guess goes in a visible stage, the
answer in a hidden one, and one `Realm.update` applies the answer and drops
the guess, so a watcher runs once, with the settled value. A box the guess
writes, such as `$saving`, marks the row as pending for exactly as long as
the guess shows.

```ts
import { Box, Collection, Realm, Stage } from "@frondruntime/pinna";

interface Item {
  readonly id: string;
  readonly done: boolean;
}

const $items = Collection.make<string, Item>(realm, { keyOf: (item) => item.id, name: "items" });
const $saving = Box.make(realm, false);

const toggle = async (id: string, done: boolean, send: () => Promise<Item>) => {
  const guess = Stage.make(realm, { name: "toggle (guess)", visible: true });
  const answer = Stage.make(realm, { name: "toggle" });
  try {
    Stage.update(guess, (_read, write) => {
      write.upsert($items, { id, done });
      // A pending marker the guess writes: it shows while the guess shows.
      write($saving, true);
    });
    const saved = await send();
    Stage.update(answer, (_read, write) => {
      write.upsert($items, saved);
    });
    // The server's answer wins: one update lands it and takes the guess off,
    // so a watcher runs once, with the settled row.
    Realm.update(realm, () => {
      Stage.apply(answer);
      Stage.drop(guess);
    });
  } finally {
    Stage.drop(answer);
    Stage.drop(guess);
  }
};
```

A visible stage replays its recipes each time something it read changes
under it. One that `Stage.apply` would refuse, by a conflict under
`{ conflicts: "fail" }` or a recipe that throws on replay, stops showing
and keeps the reason.

```ts
import { Stage } from "@frondruntime/pinna";

const showFailure = (stage: Stage): string | undefined => {
  const { showing, failure, status } = Stage.inspect(stage);
  // A guess that can no longer apply stops showing and keeps the reason.
  return status === "open" && !showing && failure instanceof Error ? failure.message : undefined;
};
```

### Rules

- The realm's own values are the confirmed values. Visible stages stack in
  the order made, and every reader at rest (a computed value, a watch, an
  autorun, a hook, `Realm.untracked`, `Source.peek`) sees the confirmed
  values with each showing stage on top, the newest last.
- A `Realm.update` recipe reads and writes the confirmed values, even where
  the screen shows a guess: a recipe that added 1 to a shown 11 would leave
  12 after the guess dropped. A further change to a guessed value goes in a
  stage made above the guess. Pinna does not check this, because the read
  path cannot afford the check.
- A value read at rest and written later in an update writes the shown
  value into the confirmed values: `Source.peek($count)` in a handler, then
  `write($count, count)` in an update, confirms a guess. Read inside the
  recipe instead. Pinna does not check this either.
- After each outermost update that changed something a showing stage read,
  the stack replays from the lowest such stage: each recipe runs again over
  the confirmed values and the showing stages below it. A shown value equal
  to the one shown before keeps its version, so an update that moves
  nothing under the stack reruns no reader. Showing or taking off a guess
  writes nothing to the confirmed values; a rollback restores them.
- A visible stage reads the showing stages below it. A hidden stage and
  `Stage.realmRead` read the confirmed values, so a hidden stage's
  `{ conflicts: "fail" }` check sees a guess only once it is applied.
- A stage that `Stage.apply` would refuse stops showing for good:
  `Stage.inspect(stage).showing` is `false`, its status stays `"open"`, the
  stages above replay without it, and the update that moved the value under
  it does not fail. `Stage.update`, `Stage.read`, and `Stage.apply` throw the
  error it keeps, and `Stage.apply` also drops it. A recipe's own throw also
  reaches the realm's `onError` once, after the outermost update that
  stopped the stage ends, or after the stage call that stopped it outside an
  update, since the answer-wins flow never applies the guess; a
  `StageConflictError` does not. A handler that writes or drops a stage
  runs its own update then, so every stage replays against it.
- Under `{ conflicts: "fail" }`, a read of a value a lower guess covers
  records the confirmed version, so the upper stage conflicts when the
  lower one applies. A box a replay reads or writes for the first time,
  such as through a branch a lower guess opens, joins the stage's reads at
  its confirmed version then; a replay that throws adds none.
- `Stage.apply` of a visible stage takes it off the stack and lands it as a
  hidden one lands; the stages above replay over the new values. Applying
  the bottom stage notifies nobody, since it shows what it lands: a box
  whose landing value its `equals` finds equal to the shown one keeps the
  shown value and its version. A throw
  drops the stage and reaches the caller; the caller's update keeps its own
  writes if it catches it.
- A box's `equals` runs while the stack settles what it shows, under the
  same guard as a recipe: one that updates or observes throws there. A
  throw counts as unequal, so the stack never stops half shown, and
  reaches `onError` once the outermost update ends, as a recipe's throw
  does: a handler that drops a stage there is not lost under the walk.
- An atom a visible stage marks reruns its readers when the mark starts
  showing and when it stops, not again when the stage applies. A
  `Stage.apply` that throws withdraws the mark as a drop does. A fail
  stage's conflict check counts an atom's confirmed changes, so a mark
  conflicts once its stage applies, and a dropped mark never does.
- A child of a visible stage is a hidden savepoint; `{ visible: true }` on a
  child throws `pinna/stage-visible-option`.
- Every stage call runs inside an update while a visible stage is open, so
  it is allowed exactly where `Realm.update` is. A view made while a guess is
  pending shows the guessed rows.
- `Realm.dispose` takes every visible stage off and drops it, so a read after
  disposal returns confirmed values. A test realm reports a visible stage
  left open as it reports a hidden one. `Source.inspect($box).stages` names
  the showing stages over a box, bottom first.
- An update under a guess replays the guess's recipes and swaps the rows of
  the keys the guess wrote, not the collection: about 5 µs per update under
  a one-row guess at 100,000 rows (`bench:rows`). A guess that adds or
  removes keys copies the key order once each time it replays and once when
  it applies: about 0.6 ms at 100,000 rows.
- A `Computed.fromPromise` or `Program.fromStream` value is not writable, so
  no guess stands over it: copy the answer into a box or a collection.
