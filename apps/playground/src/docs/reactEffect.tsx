// The site's docs print the regions of this file (docs/public/react/hooks.md), so
// `bun run typecheck` compiles what the page shows. The models are `models.ts`, on pinna-effect.
import { useValue } from "@frondruntime/pinna-react";
import { memo } from "react";
import type { Todo, TodoList } from "./models.ts";

// #region rows
// Rerenders when a key is added, removed, or moved; never for a row's own change.
function TodoRows({ list }: { readonly list: TodoList }) {
  const ids = useValue(list.$items.keys);
  return (
    <ul>
      {ids.map((id) => (
        <TodoRow key={id} list={list} id={id} />
      ))}
    </ul>
  );
}

// Rerenders when the row under its key is replaced.
const TodoRow = memo(function TodoRow({
  list,
  id,
}: {
  readonly list: TodoList;
  readonly id: string;
}) {
  const todo = useValue(list.$items.row(id));
  return todo === undefined ? null : <TodoLabel todo={todo} />;
});

// Rerenders when its own label changes.
const TodoLabel = memo(function TodoLabel({ todo }: { readonly todo: Todo }) {
  const label = useValue(todo.$label);
  return (
    <li>
      <button type="button" onClick={() => todo.toggle()}>
        {label}
      </button>
    </li>
  );
});

// #endregion

export { TodoRows };
