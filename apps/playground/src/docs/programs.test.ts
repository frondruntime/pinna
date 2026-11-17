/// <reference types="bun" />
// Backs the claims docs/public/effect/programs.md makes about the samples in
// `programs.ts`.
import { expect, test } from "bun:test";
import {
  changes,
  observe,
  observeScoped,
  RealmService,
  untracked,
  update,
} from "@frondruntime/pinna-effect";
import { Effect, Exit, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import {
  $orderStatus,
  type OrderStatus,
  orders,
  type RateState,
  RateUnavailable,
  rate,
  realm,
  sendAndRead,
  sendOrder,
  showRate,
} from "./programs.ts";

const resetOrder = () => update(realm, (_read, write) => write($orderStatus, "idle"));
const statusNow = () => untracked(realm, (read) => read($orderStatus));
const firstStatus = (wanted: OrderStatus) =>
  changes($orderStatus).pipe(
    Stream.filter((status) => status === wanted),
    Stream.runHead,
  );

test("a value from fromStream runs its stream with the services it was made with", async () => {
  const seen = await Effect.gen(function* () {
    // `rate` was made with Rates provided; this program provides none.
    const $rate = yield* rate;
    yield* observeScoped($rate);
    return yield* changes($rate).pipe(
      Stream.filter((value) => value !== undefined),
      Stream.runHead,
    );
  }).pipe(Effect.scoped, Effect.provideService(RealmService, realm), Effect.runPromise);
  expect(seen._tag).toBe("Some");
  expect(seen._tag === "Some" ? seen.value : undefined).toBe(1.08);
});

test("a failure mapped into the union ends the stream on it, and the value shows it", async () => {
  const final = await Effect.gen(function* () {
    const $state = yield* showRate(
      Stream.make(1.1).pipe(Stream.concat(Stream.fail(new RateUnavailable({ reason: "offline" })))),
    );
    const release = observe($state);
    const last = yield* changes($state).pipe(
      Stream.filter((state: RateState) => state._tag === "Unavailable"),
      Stream.runHead,
    );
    // Still shown after the stream ended.
    yield* Effect.yieldNow;
    const held = untracked(realm, (read) => read($state));
    release();
    const released = untracked(realm, (read) => read($state));
    return { last, held, released };
  }).pipe(Effect.scoped, Effect.provideService(RealmService, realm), Effect.runPromise);
  expect(final.last._tag).toBe("Some");
  expect(final.held).toEqual({ _tag: "Unavailable", reason: "offline" });
  expect(final.released).toEqual({ _tag: "Loading" });
});

test("a command runs in the application's scope, not an observer's", async () => {
  resetOrder();
  await Effect.gen(function* () {
    const application = yield* Scope.make();
    const { send } = yield* orders.pipe(Scope.provide(application));

    const release = observe($orderStatus);
    send(10);
    yield* firstStatus("sending");
    // The last observer leaving interrupts nothing.
    release();
    yield* TestClock.adjust("1 second");
    expect(statusNow()).toBe("sent");

    resetOrder();
    send(20);
    yield* firstStatus("sending");
    // Closing the application's scope interrupts the order.
    yield* Scope.close(application, Exit.void);
    yield* TestClock.adjust("1 second");
    expect(statusNow()).toBe("sending");
  }).pipe(
    Effect.provideService(RealmService, realm),
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
});

test("startImmediately runs the fiber up to its first wait before the next line", async () => {
  resetOrder();
  const started = await sendAndRead.pipe(
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
  expect(started).toBe("sending");

  resetOrder();
  const deferred = await Effect.gen(function* () {
    yield* Effect.forkScoped(sendOrder(10));
    return untracked(realm, (read) => read($orderStatus));
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise);
  expect(deferred).toBe("idle");
});
