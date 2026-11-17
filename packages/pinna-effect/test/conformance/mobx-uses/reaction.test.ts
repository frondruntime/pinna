import { describe, expect, test } from "bun:test";
import { Effect, Schema, Stream } from "effect";
import { observable, reaction, runInAction } from "mobx";
import {
  changes,
  createRealm,
  RealmService,
  schemaBox,
  untracked,
  update,
  watch,
} from "../../../src/index.ts";

/**
 * An application's `reaction` uses, beside `watch`: a test that sees each new
 * greeting, and a panel that sends a debounced estimate as the user types.
 */

describe("reaction", () => {
  // Not run for the current value; an equal value runs nothing.
  const trace = ["Hello, Ada", "Hello, Grace"];

  test("MobX: runs the effect on each change of the expression", () => {
    const state = observable({ name: "World" });
    const seen: Array<string> = [];
    const stop = reaction(
      () => `Hello, ${state.name}`,
      (text) => {
        seen.push(text);
      },
    );
    for (const name of ["Ada", "Ada", "Grace"]) {
      runInAction(() => {
        state.name = name;
      });
    }
    stop();
    expect(seen).toEqual(trace);
  });

  test("Pinna: watch", () => {
    const realm = createRealm();
    const $name = schemaBox(realm, Schema.String, "World");
    const seen: Array<string> = [];
    const stop = watch(
      realm,
      (read) => `Hello, ${read($name)}`,
      (text) => {
        seen.push(text);
      },
    );
    for (const name of ["Ada", "Ada", "Grace"]) {
      update(realm, (_read, write) => {
        write($name, name);
      });
    }
    stop();
    expect(seen).toEqual(trace);
  });
});

describe("reaction({ delay, fireImmediately })", () => {
  // The current text runs at once; two quick edits run once, with the last.
  const trace = ["a", "abc"];
  const wait = (milliseconds: number) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

  test("MobX: fires at once, then once per delay window", async () => {
    const state = observable({ text: "a" });
    const seen: Array<string> = [];
    const stop = reaction(
      () => state.text,
      (text) => {
        seen.push(text);
      },
      { delay: 20, fireImmediately: true },
    );
    for (const text of ["ab", "abc"]) {
      runInAction(() => {
        state.text = text;
      });
    }
    await wait(100);
    stop();
    expect(seen).toEqual(trace);
  });

  test("Pinna: the effect once by hand, then changes with Stream.debounce", async () => {
    const realm = createRealm();
    const $text = schemaBox(realm, Schema.String, "a");
    const seen: Array<string> = [];
    const send = (text: string) => {
      seen.push(text);
    };
    send(untracked(realm, (read) => read($text)));
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* changes($text).pipe(
          Stream.drop(1),
          Stream.debounce("20 millis"),
          Stream.runForEach((text) => Effect.sync(() => send(text))),
          Effect.forkScoped,
        );
        yield* Effect.sleep("5 millis");
        for (const text of ["ab", "abc"]) {
          update(realm, (_read, write) => {
            write($text, text);
          });
        }
        yield* Effect.sleep("100 millis");
      }).pipe(Effect.scoped, Effect.provideService(RealmService, realm)),
    );
    expect(seen).toEqual(trace);
  });
});
