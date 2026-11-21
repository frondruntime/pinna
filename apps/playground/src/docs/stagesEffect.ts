// The site's docs print the regions of this file (docs/public/effect/programs.md, "Stages"),
// so `bun run typecheck` compiles what the page shows.
import {
  box,
  createRealm,
  StageConflict,
  stageUpdate,
  withStage,
} from "@frondruntime/pinna-effect";
import { Effect } from "effect";

const realm = createRealm();
const send = (_amount: number): Effect.Effect<void, "refused"> => Effect.void;
const describeTransfer = (note: string): Effect.Effect<string, "unavailable"> =>
  Effect.succeed(note);

// #region withStage
const $balance = box(realm, 100);
const $status = box<"idle" | "sent">(realm, "idle");

const transfer = (amount: number) =>
  withStage(realm, (stage) =>
    Effect.gen(function* () {
      stageUpdate(stage, (read, write) => {
        write($balance, read($balance) - amount);
        write($status, "sent");
      });
      // Nothing shows until send succeeds; a failure or an interruption drops it.
      yield* send(amount);
    }),
  );
// #endregion

// #region savepoint
const $notes = box<ReadonlyArray<string>>(realm, []);

const transferWithNote = (amount: number, note: string) =>
  withStage(realm, (stage) =>
    Effect.gen(function* () {
      stageUpdate(stage, (read, write) => {
        write($balance, read($balance) - amount);
      });
      // A child stage: when the section fails, its writes never reach the outer
      // stage, and each retry starts from a fresh child.
      yield* withStage(stage, (section) =>
        Effect.gen(function* () {
          const text = yield* describeTransfer(note);
          stageUpdate(section, (_read, write) => {
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
const $price = box(realm, 10);
const $total = box(realm, 0);

const checkout = withStage(
  realm,
  (stage) =>
    Effect.sync(() => {
      stageUpdate(stage, (read, write) => {
        write($total, read($price) * 2);
      });
    }),
  { conflicts: "fail" },
).pipe(
  // The price changed after the stage read it: run the section again over the new one.
  Effect.retry({ while: (error) => error instanceof StageConflict, times: 3 }),
);

// #endregion

export { checkout, transfer, transferWithNote };
