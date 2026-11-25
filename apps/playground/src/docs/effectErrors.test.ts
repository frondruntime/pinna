/// <reference types="bun" />
// Backs the claims docs/public/guides/errors.md makes about the samples in
// `effectErrors.ts`.
import { expect, test } from "bun:test";
import { Realm } from "@frondruntime/pinna-effect";
import { $signup, editPassword, issuesOf, realm, submit } from "./effectErrors.ts";

test("a decode that fails gives the refused field's path and the filter's message", () => {
  expect(submit({ email: "a@example.com", password: "short" })).toEqual({
    signup: undefined,
    issues: [{ path: ["password"], message: "Use at least 8 characters" }],
  });
  expect(submit({ email: "a@example.com", password: "long enough" }).issues).toEqual([]);
});

test("a decode reports the first field it refuses, not every one", () => {
  expect(submit({ email: 1, password: "short" }).issues).toEqual([
    { path: ["email"], message: "Expected string" },
  ]);
});

test("a missing field reads as Missing key at its path", () => {
  expect(submit({ email: "a@example.com" }).issues).toEqual([
    { path: ["password"], message: "Missing key" },
  ]);
});

test("a refused box write gives the same issues through its cause, and keeps the box", () => {
  const before = Realm.untracked(realm, (read) => read($signup));
  expect(editPassword("short")).toEqual([
    { path: ["password"], message: "Use at least 8 characters" },
  ]);
  expect(Realm.untracked(realm, (read) => read($signup))).toBe(before);
  expect(editPassword("long enough")).toEqual([]);
});

test("an error that is not a schema's refusal is thrown again", () => {
  const failure = new Error("network");
  expect(() => issuesOf(failure)).toThrow(failure);
  expect(() => issuesOf("text")).toThrow();
});
