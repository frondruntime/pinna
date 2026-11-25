/// <reference types="bun" />
// Backs the claims docs/public/effect/classes.md and docs/public/effect/collections.md
// make about the samples in `models.ts`.
import { expect, test } from "bun:test";
import { Model, Realm } from "@frondruntime/pinna-effect";
import { Schema } from "effect";
import { realm, refreshTodo, Todo } from "./models.ts";

const doneOf = (todo: Todo) => Realm.untracked(realm, (read) => read(todo.$done));

test("encoding a model gives its declared fields under their wire keys, and nothing else", () => {
  const todo = Model.decode(realm, Todo)({ id: "e1", title: "Encode", done: true });
  expect(Realm.untracked(realm, (read) => read(todo.$label))).toBe("✓ Encode");
  const wire = Schema.encodeSync(Todo)(todo);
  expect(wire).toEqual({ id: "e1", title: "Encode", done: true });
  expect(Object.keys(wire).sort()).toEqual(["done", "id", "title"]);
});

test("reconcileSchema on one model keeps the held instance and sets its box", () => {
  const held = Model.decode(realm, Todo)({ id: "r1", title: "Refetch", done: false });
  const next = refreshTodo(held, { id: "r1", title: "Refetch", done: true });
  expect(next).toBe(held);
  expect(doneOf(held)).toBe(true);
});

test("reconcileSchema on one model gives the refetched instance when a plain field differs", () => {
  const held = Model.decode(realm, Todo)({ id: "r2", title: "Old", done: false });
  const next = refreshTodo(held, { id: "r2", title: "New", done: false });
  expect(next).not.toBe(held);
  expect(next.title).toBe("New");
});
