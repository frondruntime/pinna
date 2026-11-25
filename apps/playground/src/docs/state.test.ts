/// <reference types="bun" />
// Backs the claims docs/public/state/updates.md makes about the samples in
// `state.ts`. `state.ts` writes `document.title`, so this file runs under a DOM.
import { expect, test } from "bun:test";
import { Box, Realm } from "@frondruntime/pinna";
import { $cart, addPair, realm, requests } from "./state.ts";

const clear = () => {
  Realm.update(realm, (_read, write) => write($cart, []));
  requests.length = 0;
};

test("an update that is undone sends nothing from the watch", () => {
  clear();
  expect(() => addPair("tea", "")).toThrow("a pair needs two items");
  expect(Realm.untracked(realm, (read) => read($cart))).toEqual([]);
  expect(requests).toEqual([]);
});

test("an update that succeeds sends once, after the outermost update ends", () => {
  clear();
  addPair("tea", "milk");
  expect(requests).toEqual([["tea", "milk"]]);
});

test("a request sent inside the recipe goes out although the update is undone", () => {
  const $items = Box.make<ReadonlyArray<string>>(realm, []);
  const sent: Array<ReadonlyArray<string>> = [];
  expect(() =>
    Realm.update(realm, (_read, write) => {
      write($items, ["tea"]);
      sent.push(["tea"]);
      throw new Error("refused");
    }),
  ).toThrow("refused");
  expect(Realm.untracked(realm, (read) => read($items))).toEqual([]);
  expect(sent).toEqual([["tea"]]);
});
