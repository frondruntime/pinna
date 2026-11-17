import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Option, Schema, Stream } from "effect";
import { observable, runInAction, when } from "mobx";
import { changes, createRealm, RealmService, schemaBox, update } from "../../../src/index.ts";

/**
 * An application's `when` use: load a profile once the session is ready. Pinna
 * keeps `when` in the Effect programs: `changes` filtered to the first match.
 */

type Session = "Pending" | "Ready" | "Closed";

// The effect runs once, on the first Ready, and not again when the session
// leaves Ready and comes back.
const steps: ReadonlyArray<Session> = ["Ready", "Closed", "Ready"];
const trace = ["load"];

describe("when", () => {
  test("MobX: runs the effect once, the first time the predicate holds", () => {
    const state = observable({ session: "Pending" as Session });
    const loads: Array<string> = [];
    const stop = when(
      () => state.session === "Ready",
      () => {
        loads.push("load");
      },
    );
    for (const session of steps) {
      runInAction(() => {
        state.session = session;
      });
    }
    stop();
    expect(loads).toEqual(trace);
  });

  test("Pinna: changes, Stream.filter, and Stream.runHead from the Effect programs", async () => {
    const realm = createRealm();
    const $session = schemaBox(realm, Schema.Literals(["Pending", "Ready", "Closed"]), "Pending");
    const loads: Array<string> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const ready = yield* changes($session).pipe(
          Stream.filter((session) => session === "Ready"),
          Stream.runHead,
          Effect.tap((ready) =>
            Effect.sync(() => {
              if (Option.isSome(ready)) {
                loads.push("load");
              }
            }),
          ),
          Effect.forkChild,
        );
        yield* Effect.sleep("5 millis");
        for (const session of steps) {
          update(realm, (_read, write) => {
            write($session, session);
          });
          yield* Effect.sleep("5 millis");
        }
        yield* Fiber.join(ready);
      }).pipe(Effect.provideService(RealmService, realm)),
    );
    expect(loads).toEqual(trace);
  });
});
