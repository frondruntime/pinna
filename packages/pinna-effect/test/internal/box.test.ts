import { describe, expect, test } from "bun:test";
import { realmOf } from "@frondruntime/pinna/internal";
import { Reaction } from "@frondruntime/pinna-core";
import { Schema } from "effect";
import { Box, Realm } from "../../src/index.ts";
import { keptRead } from "../kept.ts";

/** Internals: a renderer's core `Reaction` tracking a run inside an update, which only `pinna-react` does. */

const realm = Realm.make();

describe("box with a schema", () => {
  // A renderer can track a run inside an update. The check reads boxes of
  // its own, which are not what the run read.
  test("a box's check adds nothing to the reads of a run that writes it", () => {
    const $limit = Box.schema(realm, Schema.Number, 10);
    // A filter is handed no read, so the check keeps one, as a model's filter
    // might; it reads wherever the check runs.
    const read = keptRead(realm);
    const Count = Schema.Number.check(Schema.makeFilter((count) => count <= read($limit)));
    const $count = Realm.untracked(realm, () => Box.schema(realm, Count, 0));
    let changes = 0;
    const reaction = new Reaction(realmOf($count).core, () => changes++);
    Realm.update(realm, (_read, write) => {
      reaction.track(() => {
        write($count, 1);
      });
    });
    reaction.activate();
    Realm.update(realm, (_read, write) => {
      write($limit, 20);
    });
    expect(changes).toBe(0);
    reaction.deactivate();
  });
});
