# Programs: Stages

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/effect/programs.md, its section "Stages".

## Stages

`Stage.scoped` holds a section's writes in a stage
([Updates](https://pinna.frondruntime.dev/docs/state/updates#stages)) and lands them when the section
succeeds. A section failure, defect, or interruption drops
them, so nothing the section staged reaches the realm. An interruption
once landing began leaves the stage applied; the exit still contains `Interrupt`.

```ts
import { Box, Stage } from "@frondruntime/pinna-effect";
import { Effect } from "effect";

const $balance = Box.make(realm, 100);
const $status = Box.make<"idle" | "sent">(realm, "idle");

const transfer = (amount: number) =>
  Stage.scoped(realm, (stage) =>
    Effect.gen(function* () {
      Stage.update(stage, (read, write) => {
        write($balance, read($balance) - amount);
        write($status, "sent");
      });
      // Nothing shows until send succeeds; a failure or an interruption drops it.
      yield* send(amount);
    }),
  );
```

Over a stage, `Stage.scoped` is a savepoint. A section that fails and is caught
leaves the outer stage as it was, and each attempt of an `Effect.retry`
opens a fresh child.

```ts
import { Box, Stage } from "@frondruntime/pinna-effect";
import { Effect } from "effect";

const $notes = Box.make<ReadonlyArray<string>>(realm, []);

const transferWithNote = (amount: number, note: string) =>
  Stage.scoped(realm, (stage) =>
    Effect.gen(function* () {
      Stage.update(stage, (read, write) => {
        write($balance, read($balance) - amount);
      });
      // A child stage: when the section fails, its writes never reach the outer
      // stage, and each retry starts from a fresh child.
      yield* Stage.scoped(stage, (section) =>
        Effect.gen(function* () {
          const text = yield* describeTransfer(note);
          Stage.update(section, (_read, write) => {
            write.modify($notes, (notes) => {
              notes.push(text);
            });
          });
        }),
      ).pipe(
        Effect.retry({ times: 2 }),
        Effect.catch(() => Effect.void),
      );
      yield* send(amount);
    }),
  );
```

With `{ conflicts: "fail" }`, a stage whose reads changed before it landed
fails with `StageConflictError`, and `Effect.retry` runs the section again over
the new values.

```ts
import { Box, Stage } from "@frondruntime/pinna-effect";
import { Effect } from "effect";

const $price = Box.make(realm, 10);
const $total = Box.make(realm, 0);

const checkout = Stage.scoped(
  realm,
  (stage) =>
    Effect.sync(() => {
      Stage.update(stage, (read, write) => {
        write($total, read($price) * 2);
      });
    }),
  { conflicts: "fail" },
).pipe(
  // The price changed after the stage read it: run the section again over the new one.
  Effect.retry({ while: (error) => error._tag === "StageConflictError", times: 3 }),
);
```

- `Stage.scoped` applies the stage after the section succeeds, synchronously,
  so nothing runs between the section's last write and the landing.
- The release drops the stage whether or not it applied: `Stage.drop` does
  nothing to a closed stage. A `Stage.apply` precondition failure leaves
  the stage open and becomes a defect in `Stage.scoped`; the release then
  drops it and its open children. A conflict or replay throw drops it
  before the release.
- Retrying reruns the section, requests included. Retry only a section that
  is safe to repeat; `Stage.scoped` never retries on its own.
- A host that lands a stage inside its own update, or applies only on a
  condition, calls `Stage.make`, `Stage.apply`, and `Stage.drop` itself, with
  `Effect.acquireUseRelease`.

### Showing the section's writes

With `{ visible: true }`, the section's writes show over the realm's
confirmed values while it runs ([Visible stages](https://pinna.frondruntime.dev/docs/state/updates#visible-stages)):
the guess is the answer, applied on success and taken off otherwise.

```ts
import { Box, Stage } from "@frondruntime/pinna-effect";
import { Effect } from "effect";

const $title = Box.make(realm, "Untitled");
const save = (_title: string): Effect.Effect<void, "refused"> => Effect.void;

const rename = (title: string) =>
  Stage.scoped(
    realm,
    (stage) =>
      Effect.gen(function* () {
        Stage.update(stage, (_read, write) => {
          write($title, title);
        });
        // The new title shows while the save runs; a failure takes it off.
        yield* save(title);
      }),
    { name: "rename", visible: true },
  );
```

With `{ guess: recipe }`, a visible stage shows `recipe` while the section
writes a hidden stage. On success one `Realm.update` applies the section's
stage and drops the guess, so the server's answer wins and a watcher sees
the settled value once; a failure or an interruption drops both.

```ts
import { Box, Stage } from "@frondruntime/pinna-effect";
import { Effect } from "effect";

const $count = Box.make(realm, 0);
const increment = (): Effect.Effect<number, "refused"> => Effect.succeed(1);

const like = Stage.scoped(
  realm,
  (stage) =>
    Effect.gen(function* () {
      const count = yield* increment();
      Stage.update(stage, (_read, write) => {
        write($count, count);
      });
    }),
  {
    name: "like",
    // Shown while the request runs; the server's count replaces it in one update.
    guess: (read, write) => write($count, read($count) + 1),
  },
);
```

- `name` and `conflicts` describe the section's stage. The guess is named
  `"<name> (guess)"`, or `"guess"`, and replays over what lands under it.
- `guess` with `visible`, or either over a stage, throws
  `pinna/stage-visible-option`: a stage is the guess or the answer, and a
  child stage shows nothing.
- A `StageConflictError` from any call on the section's stage fails the
  effect, as the one from `Stage.apply` does: a visible `"fail"` stage
  stopped mid-section throws it from the section's next `Stage.update`,
  also when that call runs before the section returns its Effect.
