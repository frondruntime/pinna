import { describe, expect, test } from "bun:test";
import { Box, Computed, Realm, Stage } from "../../src/index.ts";
import {
  coverOfNode,
  kindOf,
  nameOfNode,
  nodeOf,
  observersOf,
  onStageChange,
  stagesOf,
} from "../../src/internal/index.ts";
import { testRealm } from "../../src/testing/index.ts";

/**
 * What `pinna-devtools` reads through `src/internal` (ruling 70): a node by
 * observable, a node's name, the realm's open stages, a listener for stage
 * calls, and what covers a box reached through the graph. None touches
 * `Realm.update`, `read`, or `write`.
 */

describe("nodes and names", () => {
  test("nodeOf is the node the graph links, and nameOfNode names it", () => {
    using realm = testRealm();
    const $price = Box.make(realm, 2, { name: "price" });
    const $double = Computed.make(realm, (read) => read($price) * 2, { name: "double" });
    const stop = Realm.watch(
      realm,
      (read) => read($double),
      () => undefined,
      { name: "log" },
    );
    const stopAutorun = Realm.autorun(realm, (read) => {
      read($price);
    });
    const observers = observersOf(nodeOf($price));
    expect(observers).toContain(nodeOf($double));
    expect(observers.map(kindOf)).toEqual(["derived", "watch"]);
    expect(observers.map(nameOfNode)).toEqual(["double", "autorun"]);
    expect(observersOf(nodeOf($double)).map(nameOfNode)).toEqual(["log"]);
    expect(nameOfNode(nodeOf(Box.make(realm, 1)))).toBeUndefined();
    stop();
    stopAutorun();
  });

  test("nodeOf refuses what Pinna did not make", () => {
    expect(() => nodeOf({} as never)).toThrow("Devtools.source needs a box");
  });
});

describe("stagesOf and onStageChange", () => {
  test("each stage call notifies once, thrown or not", () => {
    using realm = testRealm({ onError: () => {} });
    const $count = Box.make(realm, 0);
    let calls = 0;
    const stop = onStageChange(realm, () => calls++);
    const stage = Stage.make(realm, { name: "save" });
    expect(calls).toBe(1);
    expect(stagesOf(realm)).toEqual([stage]);
    Stage.update(stage, (read, write) => write($count, read($count) + 1));
    expect(calls).toBe(2);
    expect(() =>
      Stage.update(stage, () => {
        throw new Error("no");
      }),
    ).toThrow("no");
    expect(calls).toBe(3);
    const child = Stage.make(stage);
    expect(stagesOf(realm)).toEqual([stage, child]);
    Stage.drop(child);
    expect(calls).toBe(5);
    Stage.drop(child);
    expect(calls).toBe(5);
    Stage.apply(stage);
    expect(calls).toBe(6);
    expect(stagesOf(realm)).toEqual([]);
    stop();
    stop();
    Stage.drop(Stage.make(realm));
    expect(calls).toBe(6);
  });

  test("a visible stage that stops showing notifies once its update ends", () => {
    using realm = testRealm({ onError: () => {} });
    const $count = Box.make(realm, 10);
    const guess = Stage.make(realm, { visible: true });
    Stage.update(guess, (read, write) => {
      if (read($count) > 50) throw new Error("too high");
      write($count, read($count) + 1);
    });
    const seen: Array<boolean> = [];
    const stop = onStageChange(realm, () => seen.push(Stage.inspect(guess).showing));
    Realm.update(realm, (_read, write) => write($count, 20));
    expect(seen).toEqual([]);
    Realm.update(realm, (_read, write) => write($count, 60));
    expect(seen).toEqual([false]);
    Stage.drop(guess);
    expect(seen).toEqual([false, false]);
    stop();
  });

  test("a listener's error goes to onError, and the others still run", () => {
    const reported: Array<unknown> = [];
    using realm = testRealm({ onError: (error) => reported.push(error) });
    let calls = 0;
    const stopFirst = onStageChange(realm, () => {
      throw new Error("listener");
    });
    const stopSecond = onStageChange(realm, () => calls++);
    Stage.drop(Stage.make(realm));
    expect(calls).toBe(2);
    expect(reported.map((error) => (error as Error).message)).toEqual(["listener", "listener"]);
    stopFirst();
    stopSecond();
  });

  test("Realm.dispose stops a listener, and testRealm reports one left open", () => {
    const realm = testRealm();
    onStageChange(realm, () => {});
    expect(() => realm[Symbol.dispose]()).toThrow("stage listener still running");
    expect(() => onStageChange(realm, () => {})).toThrow();
  });
});

describe("coverOfNode", () => {
  test("names the showing stages over a box and reads its base", () => {
    using realm = testRealm();
    const $count = Box.make(realm, 1, { name: "count" });
    const $other = Box.make(realm, 5);
    expect(coverOfNode(realm, nodeOf($count))).toBeUndefined();
    const lower = Stage.make(realm, { name: "lower", visible: true });
    const upper = Stage.make(realm, { visible: true });
    Stage.update(lower, (_read, write) => write($count, 2));
    Stage.update(upper, (_read, write) => write($count, 3));
    expect(coverOfNode(realm, nodeOf($count))).toEqual({
      stages: ["lower", "<anonymous>"],
      base: 1,
    });
    expect(coverOfNode(realm, nodeOf($other))).toBeUndefined();
    Stage.drop(upper);
    Stage.drop(lower);
    expect(coverOfNode(realm, nodeOf($count))).toBeUndefined();
  });
});
