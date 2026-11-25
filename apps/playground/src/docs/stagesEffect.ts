// The site's docs print the regions of this file (docs/public/effect/programs.md, "Stages"),
// so `bun run typecheck` compiles what the page shows.
import { Box, Realm, Stage } from "@frondruntime/pinna-effect";
import { Effect } from "effect";

const realm = Realm.make();
const send = (_amount: number): Effect.Effect<void, "refused"> => Effect.void;
const describeTransfer = (note: string): Effect.Effect<string, "unavailable"> =>
  Effect.succeed(note);

// #region withStage
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
// #endregion

// #region savepoint
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
// #endregion

// #region conflicts
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

// #endregion

// #region visible
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
// #endregion

// #region guess
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

// #endregion

export { $count, $title, checkout, like, realm, rename, transfer, transferWithNote };
