import { createRealm, schemaBox, update } from "@frondruntime/pinna-effect";
import { RealmProvider, useRealm, useSelect, useValue } from "@frondruntime/pinna-react";
import { Schema } from "effect";
import { memo, useState } from "react";
import { ClockExample } from "./clock.tsx";
import { makeTodos, type Todo, Todos } from "./model.ts";
import { PositionsExample } from "./positions-view.tsx";
import { Renders, useRenders } from "./renders.tsx";

/** The one realm this app keeps its state in. */
const realm = createRealm();

const $count = schemaBox(realm, Schema.Number, 0);
const $step = schemaBox(realm, Schema.Number, 1);

const increment = (): void =>
  update(realm, (read, write) => {
    write($count, read($count) + read($step));
  });

const CounterValue = () => {
  const renders = useRenders();
  const count = useValue($count);
  return (
    <p>
      count: <strong>{count}</strong> <Renders count={renders} />
    </p>
  );
};

const CounterStep = () => {
  const renders = useRenders();
  const current = useValue($step);
  return (
    <p>
      step:{" "}
      {[1, 5, 10].map((step) => (
        <button
          key={step}
          type="button"
          aria-pressed={current === step}
          onClick={() =>
            update(realm, (_read, write) => {
              write($step, step);
            })
          }
        >
          {step}
        </button>
      ))}{" "}
      <Renders count={renders} />
    </p>
  );
};

const LocalCounter = () => {
  const local = useRealm();
  const [$clicks] = useState(() => schemaBox(local, Schema.Number, 0));
  const clicks = useValue($clicks);
  const renders = useRenders();
  return (
    <p>
      <button
        type="button"
        onClick={() =>
          update(local, (read, write) => {
            write($clicks, read($clicks) + 1);
          })
        }
      >
        local clicks: {clicks}
      </button>{" "}
      <Renders count={renders} />
    </p>
  );
};

const Counter = () => (
  <section>
    <h2>Counter · box</h2>
    <CounterValue />
    <CounterStep />
    <button type="button" onClick={increment}>
      increment
    </button>
    <LocalCounter />
  </section>
);

const Row = memo(function Row({ todo, todos }: { readonly todo: Todo; readonly todos: Todos }) {
  const renders = useRenders();
  const done = useValue(todo.$done);
  const starred = useSelect((read) => read(todos.$starred).includes(todo.id));
  return (
    <li>
      <label>
        <input type="checkbox" checked={done} onChange={() => todo.toggle()} />
        <span className={done ? "done" : undefined}>{todo.title}</span>
      </label>{" "}
      <button
        type="button"
        aria-pressed={starred}
        aria-label="star"
        onClick={() => todos.toggleStar(todo.id)}
      >
        {starred ? "★" : "☆"}
      </button>
      <Renders count={renders} />
    </li>
  );
});

const Remaining = ({ todos }: { readonly todos: Todos }) => {
  const renders = useRenders();
  const remaining = useValue(todos.$remaining);
  return (
    <p>
      {remaining} remaining <Renders count={renders} />
    </p>
  );
};

const Starred = ({ todos }: { readonly todos: Todos }) => {
  const renders = useRenders();
  const count = useSelect((read) => read(todos.$starred).length);
  return (
    <p>
      {count} starred <Renders count={renders} />
    </p>
  );
};

const Filters = ({ todos }: { readonly todos: Todos }) => {
  const renders = useRenders();
  const current = useValue(todos.$filter);
  return (
    <p>
      {(["all", "open", "done"] as const).map((filter) => (
        <button
          key={filter}
          type="button"
          aria-pressed={current === filter}
          onClick={() => todos.setFilter(filter)}
        >
          {filter}
        </button>
      ))}{" "}
      <Renders count={renders} />
    </p>
  );
};

const List = ({ todos }: { readonly todos: Todos }) => {
  const renders = useRenders();
  const visible = useValue(todos.$visible);
  return (
    <>
      <p className="muted">
        list <Renders count={renders} />
      </p>
      <ul>
        {visible.map((todo) => (
          <Row key={todo.id} todo={todo} todos={todos} />
        ))}
      </ul>
    </>
  );
};

const AddTodo = ({ todos }: { readonly todos: Todos }) => {
  const [title, setTitle] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (title.trim() !== "") {
          todos.add(title.trim());
          setTitle("");
        }
      }}
    >
      <input
        value={title}
        placeholder="What needs doing?"
        onChange={(event) => setTitle(event.target.value)}
      />
      <button type="submit">add</button>
    </form>
  );
};

const TodoApp = ({ size }: { readonly size: number }) => {
  const [todos] = useState(() => makeTodos(realm, size));
  const [encoded, setEncoded] = useState<string>();
  return (
    <section>
      <h2>Todos · SchemaModel · {size.toLocaleString()} items</h2>
      <AddTodo todos={todos} />
      <p>
        <button type="button" onClick={() => todos.toggleAll()}>
          toggle all
        </button>{" "}
        <button type="button" onClick={() => todos.clearDone()}>
          clear done
        </button>{" "}
        <button
          type="button"
          onClick={() => setEncoded(JSON.stringify(Schema.encodeSync(Todos)(todos)).slice(0, 200))}
        >
          encode
        </button>
      </p>
      {encoded !== undefined && <pre>{encoded}…</pre>}
      <Filters todos={todos} />
      <Remaining todos={todos} />
      <Starred todos={todos} />
      <List todos={todos} />
    </section>
  );
};

export const App = () => {
  const [size, setSize] = useState(20);
  return (
    <RealmProvider realm={realm}>
      <main>
        <h1>Pinna playground</h1>
        <p className="muted">Each badge counts that component's renders.</p>
        <Counter />
        <ClockExample realm={realm} />
        <PositionsExample realm={realm} />
        <p>
          size:{" "}
          {[20, 1000].map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={size === option}
              onClick={() => setSize(option)}
            >
              {option}
            </button>
          ))}
        </p>
        <TodoApp key={size} size={size} />
      </main>
    </RealmProvider>
  );
};
