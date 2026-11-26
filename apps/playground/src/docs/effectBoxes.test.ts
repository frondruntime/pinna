/// <reference types="bun" />
// Backs the claims docs/public/effect/boxes.md makes about the samples in
// `effectBoxes.ts`.
import { expect, test } from "bun:test";
import { held } from "@frondruntime/pinna/testing";
import { Box, Computed, Model, Realm, Source } from "@frondruntime/pinna-effect";
import { Schema } from "effect";
import { $changeable, $today, Booking, booking, changeStay, realm } from "./effectBoxes.ts";

const stayOf = () => Realm.untracked(realm, (read) => read(booking.$stay));

test("a check runs on each write of a new value, never on a read or a recompute", () => {
  let checks = 0;
  const counted = Schema.Number.check(
    Schema.makeFilter(() => {
      checks += 1;
      return true;
    }),
  );
  const own = Realm.make();
  const $count = Box.schema(own, counted, 0);
  const $double = Computed.make(own, (read) => read($count) * 2);
  using _ = held(Source.observe($double));
  const afterInitial = checks;
  Realm.untracked(own, (read) => [read($count), read($double)]);
  expect(checks).toBe(afterInitial);
  Realm.update(own, (_read, write) => write($count, 1));
  expect(checks).toBe(afterInitial + 1);
  Realm.untracked(own, (read) => [read($count), read($double)]);
  expect(checks).toBe(afterInitial + 1);
});

test("one field of both dates checks them together, with the filter's message", () => {
  const before = stayOf();
  let thrown: unknown;
  try {
    Realm.update(realm, (_read, write) =>
      write(booking.$stay, { checkIn: "2026-05-04", checkOut: "2026-05-03" }),
    );
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect(String((thrown as Error).cause)).toContain("Check out after checking in");
  expect(stayOf()).toBe(before);
});

test("decode checks the dates together too", () => {
  expect(() =>
    Model.decode(
      realm,
      Booking,
    )({ id: "b2", stay: { checkIn: "2026-05-04", checkOut: "2026-05-03" } }),
  ).toThrow("Check out after checking in");
});

test("a rule on today is checked as the input arrives, and eligibility follows today", () => {
  using _ = held(Source.observe($changeable));
  expect(Realm.untracked(realm, (read) => read($changeable))).toBe(true);
  expect(() => changeStay({ checkIn: "2026-04-19", checkOut: "2026-04-25" })).toThrow(
    "Check in after today",
  );
  changeStay({ checkIn: "2026-04-22", checkOut: "2026-04-25" });
  const kept = stayOf();
  // Today passes the check-in: the stay is not checked again, and is kept.
  Realm.update(realm, (_read, write) => write($today, "2026-04-23"));
  expect(stayOf()).toBe(kept);
  expect(Realm.untracked(realm, (read) => read($changeable))).toBe(false);
});
