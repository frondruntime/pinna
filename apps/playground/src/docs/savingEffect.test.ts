/// <reference types="bun" />
// Backs the claims docs/public/guides/saving.md makes about `savingEffect.ts`.
import { expect, test } from "bun:test";
import { readSaved } from "./savingEffect.ts";

test("a valid save restores every field", () => {
  expect(readSaved(JSON.stringify({ theme: "dark", sidebarOpen: false }))).toEqual({
    theme: "dark",
    sidebarOpen: false,
  });
});

test("a field the schema refuses is left out, and the rest restore", () => {
  expect(readSaved(JSON.stringify({ theme: "dark", sidebarOpen: "yes" }))).toEqual({
    theme: "dark",
  });
  expect(readSaved(JSON.stringify({ theme: "blue", sidebarOpen: true }))).toEqual({
    sidebarOpen: true,
  });
});

test("a missing field is left out", () => {
  expect(readSaved(JSON.stringify({ theme: "light" }))).toEqual({ theme: "light" });
});

test("text that does not parse restores no field", () => {
  expect(readSaved("{not json")).toEqual({});
  expect(readSaved(JSON.stringify(["dark"]))).toEqual({});
});
