/// <reference types="bun" />
// Backs the claims docs/public/guides/saving.md makes about the samples in
// `saving.ts`. `saving.ts` makes a workspace on localStorage when it loads, so
// this file runs under a DOM.
import { expect, test } from "bun:test";
import { untracked, update } from "@frondruntime/pinna";
import { testRealm } from "@frondruntime/pinna/testing";
import { type SettingsStorage, Workspace } from "./saving.ts";

const memoryStorage = (initial?: string) => {
  const saves: Array<string> = [];
  let refuse = false;
  const storage: SettingsStorage = {
    load: () => saves.at(-1) ?? initial,
    save: (text) => {
      if (refuse) throw new Error("The quota has been exceeded.");
      saves.push(text);
    },
  };
  return {
    saves,
    storage,
    refuse: (value: boolean) => {
      refuse = value;
    },
  };
};

// Lets the queued microtask run.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("restoring takes each valid field, keeps the defaults for the rest, and saves nothing back", async () => {
  using realm = testRealm();
  const { saves, storage } = memoryStorage(JSON.stringify({ theme: "dark", sidebarOpen: "yes" }));
  using workspace = new Workspace(realm, storage);
  await settle();
  expect(untracked(realm, (read) => read(workspace.$theme))).toBe("dark");
  expect(untracked(realm, (read) => read(workspace.$sidebarOpen))).toBe(true);
  expect(saves).toEqual([]);
});

test("a damaged save starts from the defaults", () => {
  using realm = testRealm();
  using workspace = new Workspace(realm, memoryStorage("{not json").storage);
  expect(untracked(realm, (read) => read(workspace.$theme))).toBe("light");
});

test("a burst of updates in one task saves once, with the end state", async () => {
  using realm = testRealm();
  const { saves, storage } = memoryStorage();
  using workspace = new Workspace(realm, storage);
  update(realm, (_read, write) => write(workspace.$theme, "dark"));
  update(realm, (_read, write) => write(workspace.$sidebarOpen, false));
  update(realm, (_read, write) => write(workspace.$sidebarOpen, true));
  update(realm, (_read, write) => write(workspace.$sidebarOpen, false));
  await settle();
  expect(saves).toEqual([JSON.stringify({ theme: "dark", sidebarOpen: false })]);
});

test("a write to a field that is not saved saves nothing, nor does a burst that ends where it began", async () => {
  using realm = testRealm();
  const { saves, storage } = memoryStorage();
  using workspace = new Workspace(realm, storage);
  update(realm, (_read, write) => write(workspace.$hovered, "sidebar"));
  await settle();
  update(realm, (_read, write) => write(workspace.$theme, "dark"));
  update(realm, (_read, write) => write(workspace.$theme, "light"));
  await settle();
  expect(saves).toEqual([]);
});

test("a storage error is kept as state, and the next change tries again", async () => {
  using realm = testRealm();
  const { saves, storage, refuse } = memoryStorage();
  using workspace = new Workspace(realm, storage);
  refuse(true);
  update(realm, (_read, write) => write(workspace.$theme, "dark"));
  await settle();
  expect(untracked(realm, (read) => read(workspace.$storageError))).toBe(
    "The quota has been exceeded.",
  );
  refuse(false);
  update(realm, (_read, write) => write(workspace.$sidebarOpen, false));
  await settle();
  expect(saves).toEqual([JSON.stringify({ theme: "dark", sidebarOpen: false })]);
  expect(untracked(realm, (read) => read(workspace.$storageError))).toBeUndefined();
});

test("disposing stops the watch and writes a save still queued", async () => {
  using realm = testRealm();
  const { saves, storage } = memoryStorage();
  const workspace = new Workspace(realm, storage);
  update(realm, (_read, write) => write(workspace.$theme, "dark"));
  workspace[Symbol.dispose]();
  expect(saves).toEqual([JSON.stringify({ theme: "dark", sidebarOpen: true })]);
  update(realm, (_read, write) => write(workspace.$theme, "light"));
  await settle();
  expect(saves).toHaveLength(1);
  // The realm's dispose, when the test ends, finds no watch still running.
});

test("a workspace made right after the dispose loads what the dispose saved", () => {
  using realm = testRealm();
  const { storage } = memoryStorage();
  const first = new Workspace(realm, storage);
  update(realm, (_read, write) => write(first.$theme, "dark"));
  first[Symbol.dispose]();
  using second = new Workspace(realm, storage);
  expect(untracked(realm, (read) => read(second.$theme))).toBe("dark");
});

test("a workspace not disposed leaves its watch running, and the test realm says so", () => {
  const realm = testRealm();
  new Workspace(realm, memoryStorage().storage);
  expect(() => realm[Symbol.dispose]()).toThrow("not at rest");
});
