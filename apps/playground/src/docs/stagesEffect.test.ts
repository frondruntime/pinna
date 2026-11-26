/// <reference types="bun" />
// Backs the claims docs/public/effect/programs.md, "Stages", makes about the
// visible samples in `stagesEffect.ts`.
import { expect, test } from "bun:test";
import { Realm } from "@frondruntime/pinna-effect";
import { Effect } from "effect";
import { $count, $title, like, realm, rename } from "./stagesEffect.ts";

test("a visible scoped stage lands the title it showed", async () => {
  await Effect.runPromise(rename("Draft"));
  expect(Realm.untracked(realm, (read) => read($title))).toBe("Draft");
});

test("a guess gives way to the server's count", async () => {
  Realm.update(realm, (_read, write) => {
    write($count, 41);
  });
  await Effect.runPromise(like);
  // The guess showed 42; the server answered 1, and its answer wins.
  expect(Realm.untracked(realm, (read) => read($count))).toBe(1);
});
