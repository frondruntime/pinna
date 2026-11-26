import { describe, expect, test } from "bun:test";
import { autorun as mobxAutorun, observable, runInAction } from "mobx";
import { Box, Realm } from "../../../src/index.ts";

/**
 * An application's `Realm.autorun` uses, beside Pinna's `Realm.autorun`. Its tests push
 * what a model shows on each run, then dispose.
 */

// The flag switches the reader from the first source to the second; a write
// to the source it no longer reads reruns nothing, and nothing runs after
// the stop.
const trace = ["first:1", "second:2", "second:20"];

describe("autorun", () => {
  test("MobX: runs at once, tracks its last run's reads, and stops", () => {
    const state = observable({ useSecond: false, first: 1, second: 2 });
    const seen: Array<string> = [];
    const stop = mobxAutorun(() => {
      seen.push(state.useSecond ? `second:${state.second}` : `first:${state.first}`);
    });
    runInAction(() => {
      state.useSecond = true;
    });
    runInAction(() => {
      state.first = 10;
    });
    runInAction(() => {
      state.second = 20;
    });
    stop();
    runInAction(() => {
      state.second = 30;
    });
    expect(seen).toEqual(trace);
  });

  test("Pinna: autorun", () => {
    const realm = Realm.make();
    const $useSecond = Box.make(realm, false);
    const $first = Box.make(realm, 1);
    const $second = Box.make(realm, 2);
    const seen: Array<string> = [];
    const stop = Realm.autorun(realm, (read) => {
      seen.push(read($useSecond) ? `second:${read($second)}` : `first:${read($first)}`);
    });
    Realm.update(realm, (_read, write) => {
      write($useSecond, true);
    });
    Realm.update(realm, (_read, write) => {
      write($first, 10);
    });
    Realm.update(realm, (_read, write) => {
      write($second, 20);
    });
    stop();
    Realm.update(realm, (_read, write) => {
      write($second, 30);
    });
    expect(seen).toEqual(trace);
  });
});
