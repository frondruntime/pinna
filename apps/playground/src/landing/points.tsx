// The site's landing page prints the regions of this file (apps/site/src/pages/index.astro), so
// `bun run typecheck` compiles what the page shows. The React section prints its one region.
import { box, collection, createRealm, Model, type Realm, update } from "@frondruntime/pinna";
import { RealmProvider, useValue } from "@frondruntime/pinna-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Todo } from "./todo.tsx";

// The model the React sample renders.
class TodoList extends Model {
  readonly $todos = collection(this.realm, { keyOf: (todo: Todo) => todo.id });
  readonly $finished = box(this.realm, 0);

  finish(todo: Todo): void {
    update(this.realm, (read, write) => {
      write(todo.$done, true);
      write(this.$finished, read(this.$finished) + 1);
    });
  }
}

const realm = createRealm();
const list = new TodoList(realm);
update(realm, (_read, write) => {
  write.replaceAll(list.$todos, [new Todo(realm, "1", "Write the docs")]);
});

// #region react
// Plain components, no wrapper: a hook reads, and React Compiler memoizes the rest.
function TodoRow({ todo }: { readonly todo: Todo }) {
  const label = useValue(todo.$label);
  // A write is a model method, called from a handler like any other.
  return (
    <li>
      <button type="button" onClick={() => todo.toggle()}>
        {label}
      </button>
    </li>
  );
}

// TodoList is a model whose $todos is a collection of todos.
function TodoListView({ list }: { readonly list: TodoList }) {
  const todos = useValue(list.$todos.rows); // the collection's rows, in order
  return (
    <ul>
      {todos.map((todo) => (
        <TodoRow key={todo.id} todo={todo} />
      ))}
    </ul>
  );
}

// The provider hands down a realm: a server request or a test creates its own.
function mount(container: HTMLElement, realm: Realm, list: TodoList) {
  createRoot(container).render(
    <StrictMode>
      <RealmProvider realm={realm}>
        <TodoListView list={list} />
      </RealmProvider>
    </StrictMode>,
  );
}

// #endregion

export { list, mount, TodoList, TodoListView };
