// The site's docs print the regions of this file (docs/public/state/changes.md),
// so `bun run typecheck` compiles what the page shows.
import { Box, Collection, Realm, type UpdateRecord } from "@frondruntime/pinna";

// #region listen
interface Todo {
  readonly id: string;
  readonly title: string;
}

const realm = Realm.make();
const $filter = Box.make<"all" | "open">(realm, "all");
const todos = Collection.make(realm, { keyOf: (todo: Todo) => todo.id });

const log: Array<string> = [];
// After each landed update, once its watchers ran: what changed, before and after.
const stopLog = Realm.onUpdate(realm, (record) => {
  for (const change of record.boxes)
    log.push(`${String(change.before)} -> ${String(change.after)}`);
  for (const change of record.collections) log.push(`${change.rows.length} rows`);
});

Realm.update(
  realm,
  (_read, write) => {
    write($filter, "open");
    write.upsert(todos, { id: "a", title: "Write the docs" });
  },
  { name: "add todo" },
);
// log: ["all -> open", "1 rows"]; the record's name is "add todo".
// #endregion

// #region undo
// An undo stack: each landed update, except the undo's own.
const done: Array<UpdateRecord> = [];
let undoing = false;
const stopHistory = Realm.onUpdate(realm, (record) => {
  if (!undoing) done.push(record);
});

const undo = (): void => {
  const record = done.pop();
  if (record === undefined) return;
  undoing = true;
  try {
    // Every box, row, and key order back to `before`, as writes: checked, and undone on a throw.
    Realm.update(realm, (_read, write) => write.revert(record), { name: "undo" });
  } finally {
    undoing = false;
  }
};
// #endregion

// #region paths
// A record names a box, never a path: the code that declared the shape maps one to the other.
const paths = new Map<unknown, string>([
  [$filter, "filter"],
  [todos, "todos"],
]);
const changedPaths = (record: UpdateRecord): ReadonlyArray<string> => [
  ...record.boxes.map((change) => paths.get(change.box) ?? "?"),
  ...record.collections.map((change) => paths.get(change.collection) ?? "?"),
];

// #endregion

export { changedPaths, log, stopHistory, stopLog, undo };
