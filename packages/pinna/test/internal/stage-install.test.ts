import { expect, test } from "bun:test";
import type { Realm } from "../../src/index.ts";
import type { ObservableRealm } from "../../src/realm.ts";
import type { Stack } from "../../src/stack.ts";
import { generate, handlerOf, run, seeds } from "../fuzz/stage-script.ts";

/**
 * The install rule of the visible stack (`docs/design.md`, "Visible
 * stages"): no application code runs between the first and the last raw
 * write of a swap. `Stack.installing` is true while the stack opens the
 * window, shows again, or runs its install pass. Over the visible-stage
 * fuzz's scripts, every application function (a recipe, a box's `equals`,
 * a row listener, a view's `compare`, `onError`, an autorun, a computed
 * value) counts its entries while it is true.
 */
const installing = (realm: Realm): boolean =>
  ((realm as ObservableRealm).stack as Stack | undefined)?.installing === true;

test("no application function is entered while the stack writes cells raw", () => {
  let entered = 0;
  const duringInstall: Array<string> = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const { entries } = run(generate(seed), true, false, handlerOf(seed), installing);
    entered += entries.entered;
    for (const name of entries.duringInstall) duringInstall.push(`seed ${seed}: ${name}`);
  }
  expect(duringInstall).toEqual([]);
  expect(entered).toBeGreaterThan(5000);
});
