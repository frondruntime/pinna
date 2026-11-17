import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { configure, autorun as mobxAutorun, observable } from "mobx";
import { autorun, box, createRealm, untracked } from "../../../src/index.ts";
import { keptRead } from "../../kept.ts";

/**
 * An application's `configure` use: `observableRequiresReaction`, turned on in
 * a test to catch a read outside a derivation. Pinna has no switch; the rule is
 * always on, and the read throws where MobX warns. The rewrite keeps the goal,
 * not the behavior: such a read is caught, and a read meant to be untracked
 * says so.
 */

afterEach(() => {
  configure({ observableRequiresReaction: false });
});

describe("configure({ observableRequiresReaction })", () => {
  test("MobX: a read outside a derivation warns, and one inside does not", () => {
    configure({ observableRequiresReaction: true });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const state = observable({ count: 1 });
      const stop = mobxAutorun(() => {
        void state.count;
      });
      expect(warn).not.toHaveBeenCalled();
      void state.count;
      expect(warn).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      warn.mockRestore();
    }
  });

  test("Pinna: a read kept past its place throws, and untracked reads", () => {
    const realm = createRealm();
    const $count = box(realm, 1);
    const seen: Array<number> = [];
    const stop = autorun(realm, (read) => {
      seen.push(read($count));
    });
    const kept = keptRead(realm);
    expect(() => kept($count)).toThrow("pinna: read($observable) runs outside a place");
    expect(untracked(realm, (read) => read($count))).toBe(1);
    stop();
    expect(seen).toEqual([1]);
  });
});
