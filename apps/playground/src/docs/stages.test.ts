/// <reference types="bun" />
// Backs the claims docs/public/state/updates.md, "Visible stages", makes about
// the samples in `stages.ts`.
import { expect, test } from "bun:test";
import { Box, Realm, Stage } from "@frondruntime/pinna";
import { $items, $saving, $title, realm, rename, showFailure, toggle } from "./stages.ts";

test("a visible stage shows at once, lands on success, and leaves on failure", async () => {
  let finish = () => {};
  const saving = rename("Draft", () => new Promise<void>((resolve) => (finish = resolve)));
  expect(Realm.untracked(realm, (read) => read($title))).toBe("Draft");
  finish();
  await saving;
  expect(Realm.untracked(realm, (read) => read($title))).toBe("Draft");
  let refuse = (_error: Error) => {};
  const failing = rename("Final", () => new Promise<void>((_resolve, reject) => (refuse = reject)));
  expect(Realm.untracked(realm, (read) => read($title))).toBe("Final");
  refuse(new Error("offline"));
  await expect(failing).rejects.toThrow("offline");
  expect(Realm.untracked(realm, (read) => read($title))).toBe("Draft");
});

test("the server's answer replaces the guess in one update", async () => {
  const seen: Array<ReadonlyArray<boolean | undefined>> = [];
  const stop = Realm.watch(
    realm,
    (read) => [read($items.row("a"))?.done, read($saving)],
    (value) => {
      seen.push(value);
    },
  );
  let answer = (_item: { id: string; done: boolean }) => {};
  const toggling = toggle("a", true, () => new Promise((resolve) => (answer = resolve)));
  answer({ id: "a", done: false });
  await toggling;
  stop();
  expect(Realm.untracked(realm, (read) => [read($items.row("a"))?.done, read($saving)])).toEqual([
    false,
    false,
  ]);
  expect(seen).toEqual([
    [true, true],
    [false, false],
  ]);
});

test("a stopped guess keeps the reason it stopped", () => {
  const reported: unknown[] = [];
  const own = Realm.make({ onError: (error) => reported.push(error) });
  const $name = Box.make(own, "open");
  const guess = Stage.make(own, { visible: true });
  Stage.update(guess, (read, write) => {
    if (read($name) === "locked") throw new Error("the name is locked");
    write($name, `${read($name)}!`);
  });
  expect(showFailure(guess)).toBeUndefined();
  Realm.update(own, (_read, write) => {
    write($name, "locked");
  });
  expect(showFailure(guess)).toBe("the name is locked");
  expect(reported).toHaveLength(1);
  Stage.drop(guess);
});
