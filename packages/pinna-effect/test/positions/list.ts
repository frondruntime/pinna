/**
 * The sample list of positions: a keyed collection, a lookup by id, and the
 * two live edits. Loading, refreshing, and the update stream are the host's;
 * the tests drive them by hand.
 */
import { Schema } from "effect";
import { CollectionField, type Computed, SchemaModel, update } from "../../src/index.ts";
import { Position } from "./contract.ts";

export class Positions extends SchemaModel<Positions>("Positions")({
  $items: CollectionField(Position, { keyOf: (position) => position.id }),
}) {
  getById(id: string): Computed<Position | undefined> {
    return this.$items.row(id);
  }

  /** Replaces the position with the same id, or puts a new one first. */
  upsert(position: Position): void {
    update(this.realm, (_read, write) => {
      write.upsert(this.$items, position);
    });
  }

  remove(id: string): void {
    update(this.realm, (_read, write) => {
      write.remove(this.$items, id);
    });
  }
}

/** One message of the server's update stream. */
export const PositionUpdate = Schema.Union([
  Schema.Struct({ type: Schema.Literal("upsert"), position: Position }),
  Schema.Struct({ type: Schema.Literal("delete"), id: Schema.String }),
]);
