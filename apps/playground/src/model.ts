import { Box, Computed, Model, Realm } from "@frondruntime/pinna-effect";
import { Schema } from "effect";

export type Filter = "all" | "open" | "done";

export class Todo extends Model.Schema<Todo>("Todo")({
  id: Schema.String,
  title: Schema.String,
  $done: Model.boxField(Schema.Boolean),
}) {
  toggle(): void {
    Realm.update(this.realm, (read, write) => {
      write(this.$done, !read(this.$done));
    });
  }
}

const newTodo = (realm: Realm, id: string, title: string, done: boolean): Todo =>
  Todo.make({ id, title, done, realm });

export class Todos extends Model.Schema<Todos>("Todos")({
  $items: Model.boxField(Schema.Array(Todo)),
  $starred: Model.boxField(Schema.Array(Schema.String)),
}) {
  readonly $filter = Box.schema(this.realm, Schema.Literals(["all", "open", "done"]), "all");

  readonly $visible = Computed.make(this.realm, (read) => {
    const filter = read(this.$filter);
    const items = read(this.$items);
    return filter === "all"
      ? items
      : items.filter((todo) => read(todo.$done) === (filter === "done"));
  });

  readonly $remaining = Computed.make(
    this.realm,
    (read) => read(this.$items).filter((todo) => !read(todo.$done)).length,
  );

  add(title: string): void {
    Realm.update(this.realm, (_read, write) => {
      write.modify(this.$items, (items) => {
        items.push(newTodo(this.realm, crypto.randomUUID(), title, false));
      });
    });
  }

  toggleAll(): void {
    Realm.update(this.realm, (read, write) => {
      const items = read(this.$items);
      const done = items.some((todo) => !read(todo.$done));
      for (const todo of items) {
        write(todo.$done, done);
      }
    });
  }

  clearDone(): void {
    Realm.update(this.realm, (read, write) => {
      write(
        this.$items,
        read(this.$items).filter((todo) => !read(todo.$done)),
      );
    });
  }

  toggleStar(id: string): void {
    Realm.update(this.realm, (_read, write) => {
      write.modify(this.$starred, (starred) => {
        const index = starred.indexOf(id);
        if (index === -1) {
          starred.push(id);
        } else {
          starred.splice(index, 1);
        }
      });
    });
  }

  setFilter(filter: Filter): void {
    Realm.update(this.realm, (_read, write) => {
      write(this.$filter, filter);
    });
  }
}

export const makeTodos = (realm: Realm, count: number): Todos =>
  Todos.make({
    items: Array.from({ length: count }, (_, index) =>
      newTodo(realm, String(index), `Todo ${index + 1}`, index % 3 === 0),
    ),
    starred: [],
    realm,
  });
