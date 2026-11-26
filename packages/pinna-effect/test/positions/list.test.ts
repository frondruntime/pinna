/**
 * The sample list of positions: decoding the list and its updates with the
 * caller's context, and what observers see when the list changes. The tests
 * hand the server's JSON to `Model.decode` directly, with no transport.
 */
import { describe, expect, test } from "bun:test";
import { BigDecimal } from "effect";
import { Box, Model, Realm } from "../../src/index.ts";
import { context, type PositionJson, positionJson } from "./fixture.ts";
import { Positions, PositionUpdate } from "./list.ts";

const decodeList = (realm: Realm, items: ReadonlyArray<PositionJson>) =>
  Model.decode(realm, Positions, context)({ items });

/** What a host does with one message of the update stream. */
const apply = (realm: Realm, positions: Positions, message: unknown) => {
  const update = Model.decode(realm, PositionUpdate, context)(message);
  if (update.type === "upsert") {
    positions.upsert(update.position);
  } else {
    positions.remove(update.id);
  }
};

const idsOf = (realm: Realm, positions: Positions) =>
  Realm.untracked(realm, (read) => read(positions.$items.keys));

describe("Positions", () => {
  test("decodes a list whose positions format dates with the caller's context", () => {
    const realm = Realm.make();
    const positions = decodeList(realm, [positionJson({ id: "open-position" })]);

    const position = Realm.untracked(realm, (read) => read(positions.getById("open-position")));
    expect(position === undefined ? undefined : BigDecimal.format(position.collateral)).toBe(
      "100.25",
    );
    expect(Realm.untracked(realm, (read) => position?.openedAtFormatted(read))).toBe(
      "2026-08-25T08:01:00.000Z",
    );
    expect(Realm.untracked(realm, (read) => read(positions.getById("missing")))).toBeUndefined();
  });

  test("a list that does not decode leaves the held list alone", () => {
    const realm = Realm.make();
    const $positions = Box.schema(realm, Positions, decodeList(realm, [positionJson()]));
    const held = Realm.untracked(realm, (read) => read($positions));

    expect(() => decodeList(realm, [positionJson({ collateral: 12 })])).toThrow();
    expect(Realm.untracked(realm, (read) => read($positions))).toBe(held);
  });

  test("updates change the list in place, and observers see each change", () => {
    const realm = Realm.make();
    const positions = decodeList(realm, [positionJson(), positionJson({ id: "position-7" })]);
    const kept = Realm.untracked(realm, (read) => read(positions.getById("position-7")));
    const observedIds: Array<ReadonlyArray<string>> = [idsOf(realm, positions)];
    const stop = Realm.watch(
      realm,
      (read) => read(positions.$items.keys),
      (ids) => {
        observedIds.push(ids);
      },
    );

    apply(realm, positions, {
      type: "upsert",
      position: positionJson({ id: "position-99", collateral: "333.75" }),
    });
    const added = Realm.untracked(realm, (read) => read(positions.getById("position-99")));
    expect(added === undefined ? undefined : BigDecimal.format(added.collateral)).toBe("333.75");
    expect(Realm.untracked(realm, (read) => added?.openedAtFormatted(read))).toBe(
      "2026-08-25T08:01:00.000Z",
    );

    apply(realm, positions, { type: "delete", id: "position-42" });
    expect(
      Realm.untracked(realm, (read) => read(positions.getById("position-42"))),
    ).toBeUndefined();

    expect(observedIds).toEqual([
      ["position-42", "position-7"],
      ["position-99", "position-42", "position-7"],
      ["position-99", "position-7"],
    ]);
    expect(Realm.untracked(realm, (read) => read(positions.getById("position-7")))).toBe(
      kept as never,
    );
    stop();
  });

  test("an upsert of a known id replaces that row and no other", () => {
    const realm = Realm.make();
    const positions = decodeList(realm, [positionJson(), positionJson({ id: "position-7" })]);
    const first = Realm.untracked(realm, (read) => read(positions.getById("position-42")));
    const leverages: Array<number | undefined> = [];
    const stop = Realm.watch(
      realm,
      (read) => read(positions.getById("position-7"))?.leverage,
      (leverage) => {
        leverages.push(leverage);
      },
    );

    apply(realm, positions, {
      type: "upsert",
      position: positionJson({ id: "position-7", leverage: 3 }),
    });

    expect(leverages).toEqual([3]);
    expect(idsOf(realm, positions)).toEqual(["position-42", "position-7"]);
    expect(Realm.untracked(realm, (read) => read(positions.getById("position-42")))).toBe(
      first as never,
    );
    stop();
  });

  test("a message that does not decode changes nothing", () => {
    const realm = Realm.make();
    const positions = decodeList(realm, [positionJson()]);

    expect(() => apply(realm, positions, { type: "upsert", position: { id: 1 } })).toThrow();
    expect(idsOf(realm, positions)).toEqual(["position-42"]);
  });
});
