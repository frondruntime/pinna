import { expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import { Box, Realm, Stage, StageConflictError } from "../../src/index.ts";

test("a conflict in a synchronous section prefix is recoverable", async () => {
  const realm = Realm.make();
  const count = Box.make(realm, 10);
  const exit = await Effect.runPromiseExit(
    Stage.scoped(
      realm,
      (stage) => {
        Stage.update(stage, (read, write) => write(count, read(count) + 1));
        Realm.update(realm, (_read, write) => write(count, 20));
        Stage.update(stage, () => undefined);
        return Effect.succeed("done");
      },
      { visible: true, conflicts: "fail" },
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.findErrorOption(exit.cause);
    expect(failure._tag === "Some" && failure.value instanceof StageConflictError).toBe(true);
  }
  Realm.dispose(realm);
});
