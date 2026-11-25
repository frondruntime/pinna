// The site's docs print the regions of this file (docs/public/state/snapshots.md,
// "With Effect"), so `bun run typecheck` compiles what the page shows.
import { Computed, Model, Realm, Stage } from "@frondruntime/pinna-effect";
import { Schema } from "effect";

const realm = Realm.make();

// #region model
class Todo extends Model.Schema<Todo>("Todo")({
  id: Schema.Number,
  title: Schema.String,
  $done: Model.boxField(Schema.Boolean),
}) {}

class Board extends Model.Schema<Board>("Board")({
  id: Schema.String,
  $todos: Model.collectionField(Todo, { keyOf: (todo) => todo.id }),
}) {}

const board = Model.decode(realm, Board)({ id: "main", todos: [] });
// #endregion

// #region modelSnapshot
// Wire keys, each $ field's snapshot in place of its box: { id, todos: [{ id, title, done }] }.
const data = Realm.untracked(realm, (read) => read.snapshot({ board }));
// #endregion

// #region hydrate
// Decodes, then restores in place: a held row stays the same instance, and a
// new row is the decoded one.
const hydrate = (input: unknown): void => {
  Model.restore(realm, Board)(board, input);
};
// #endregion

// #region encode
// Encoding reads the boxes as read does: this recomputes when a todo changes.
const $wire = Computed.make(realm, () => Schema.encodeSync(Board)(board));
// #endregion

// #region stage
const refetch = (input: unknown, stage: Stage): void => {
  // A decode makes boxes, which a stage recipe may not: decode outside.
  const fresh = Model.decode(realm, Board)(input);
  Stage.update(stage, (_read, write) => {
    write.restore(board, fresh);
  });
};

// #endregion

export { $wire, data, hydrate, refetch };
