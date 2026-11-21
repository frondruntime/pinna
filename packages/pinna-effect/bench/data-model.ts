/**
 * The data benchmark's subjects and scenarios: Pinna against MobX on the same
 * todo model. Hosts run it: `data.ts` on Bun, `hermes.ts` on Hermes. A host
 * supplies the clock and the memory reading, which no two engines share.
 *
 * Bare Pinna holds the same plain objects MobX does, its boxes checked by
 * `Schema.Unknown`, so it compares the reactive core with MobX's. Schema
 * Pinna holds `SchemaModel` instances and checks every write; it is compared
 * with bare Pinna, so what the schema costs shows on its own.
 */

import { Schema } from "effect";
import { makeAutoObservable, observable, reaction, runInAction } from "mobx";
import {
  type Box,
  BoxField,
  CollectionField,
  type Computed,
  computed,
  createRealm,
  type Draft,
  decode,
  type Read,
  SchemaModel,
  schemaBox,
  untracked,
  update,
  watch,
} from "../src/index.ts";

export const rows = 10_000;
const operations = 1_000;
const runs = 7;

/**
 * Reads take the read of the place that calls them, so the harness can call
 * them inside a watch: Pinna reads only with a place's read. MobX models
 * read their own fields and ignore it.
 */
interface Model {
  readonly size: (read: Read) => number;
  readonly remaining: (read: Read) => number;
  readonly label: (read: Read, index: number) => string;
  toggle(index: number): void;
  add(title: string): void;
  addMany(titles: ReadonlyArray<string>): void;
  toggleAll(): void;
}

/** Rows by key: the shape a live list of priced rows takes. */
interface Keyed {
  readonly title: (read: Read, key: string) => string | undefined;
  rename(key: string, title: string): void;
}

export interface Subject {
  readonly build: () => Model;
  readonly decode: (json: unknown) => Model;
  /** A keyed collection of `rows` rows, from the same JSON `decode` takes. */
  readonly keyed: (json: TodosJson) => Keyed;
  readonly watch: <Value>(select: (read: Read) => Value) => () => void;
}

// Pinna

const realm = createRealm();

/** What the Pinna model needs of a row, with or without a schema. */
interface Row {
  readonly $done: Box<boolean>;
  readonly $label: Computed<string>;
}

class Todo extends SchemaModel<Todo>("Todo")({
  id: Schema.String,
  title: Schema.String,
  $done: BoxField(Schema.Boolean),
}) {
  readonly $label = computed(this.realm, (read) =>
    read(this.$done) ? `✓ ${this.title}` : this.title,
  );
}

class Todos extends SchemaModel<Todos>("Todos")({ items: Schema.Array(Todo) }) {}

const newTodo = (id: string, title: string): Todo => Todo.make({ id, title, done: false, realm });

class PinnaModel<Item extends Row> implements Model {
  readonly $remaining = computed(
    realm,
    (read) => read(this.$items).filter((todo) => !read(todo.$done)).length,
  );

  constructor(
    readonly $items: Box<ReadonlyArray<Item>>,
    private readonly newRow: (title: string) => Draft<Item>,
  ) {}

  readonly size = (read: Read): number => read(this.$items).length;
  readonly remaining = (read: Read): number => read(this.$remaining);
  readonly label = (read: Read, index: number): string => {
    const todo = read(this.$items)[index];
    return todo === undefined ? "" : read(todo.$label);
  };

  toggle(index: number): void {
    update(realm, (read, write) => {
      const todo = read(this.$items)[index];
      if (todo !== undefined) {
        write(todo.$done, !read(todo.$done));
      }
    });
  }

  add(title: string): void {
    update(realm, (_read, write) => {
      write.modify(this.$items, (items) => {
        items.push(this.newRow(title));
      });
    });
  }

  addMany(titles: ReadonlyArray<string>): void {
    update(realm, (_read, write) => {
      write.modify(this.$items, (items) => {
        for (const title of titles) {
          items.push(this.newRow(title));
        }
      });
    });
  }

  toggleAll(): void {
    update(realm, (read, write) => {
      const items = read(this.$items);
      const done = items.some((todo) => !read(todo.$done));
      for (const todo of items) {
        write(todo.$done, done);
      }
    });
  }
}

const decodeTodos = decode(realm, Todos);

const schemaModel = (items: ReadonlyArray<Todo>): PinnaModel<Todo> =>
  new PinnaModel(schemaBox(realm, Schema.Array(Todo), items), (title) => newTodo(title, title));

class Entry extends SchemaModel<Entry>("Entry")({
  id: Schema.String,
  title: Schema.String,
  done: Schema.Boolean,
}) {}

class Entries extends SchemaModel<Entries>("Entries")({
  $items: CollectionField(Entry, { keyOf: (entry) => entry.id }),
}) {}

const decodeEntries = decode(realm, Entries);

const pinnaSchema: Subject = {
  build: () =>
    schemaModel(
      Array.from({ length: rows }, (_, index) => newTodo(String(index), `todo ${index}`)),
    ),
  decode: (json) => schemaModel(decodeTodos(json).items),
  keyed: (json) => {
    const { $items } = decodeEntries(json);
    return {
      title: (read, key) => read($items.row(key))?.title,
      rename: (key, title) => {
        update(realm, (_read, write) => {
          write.upsert($items, Entry.make({ id: key, title, done: false, realm }));
        });
      },
    };
  },
  watch: (select) => watch(realm, select, () => {}),
};

// Bare Pinna: plain objects, every box checked by Schema.Unknown

interface BareTodo extends Row {
  readonly id: string;
  readonly title: string;
}

const bareBox = <Value>(initial: Value): Box<Value> =>
  schemaBox(realm, Schema.Unknown, initial) as Box<Value>;

const bareTodo = (id: string, title: string, done: boolean): BareTodo => {
  const $done = bareBox(done);
  return {
    id,
    title,
    $done,
    $label: computed(realm, (read) => (read($done) ? `✓ ${title}` : title)),
  };
};

const bareModel = (items: ReadonlyArray<BareTodo>): PinnaModel<BareTodo> =>
  new PinnaModel(bareBox(items), (title) => bareTodo(title, title, false));

class BareEntries extends SchemaModel<BareEntries>("BareEntries")({
  $items: CollectionField(Schema.Unknown, { keyOf: (entry) => (entry as TodoJson).id }),
}) {}

const decodeBareEntries = decode(realm, BareEntries);

const pinnaBare: Subject = {
  build: () =>
    bareModel(
      Array.from({ length: rows }, (_, index) => bareTodo(String(index), `todo ${index}`, false)),
    ),
  decode: (json) =>
    bareModel(
      (json as { readonly items: ReadonlyArray<TodoJson> }).items.map((item) =>
        bareTodo(item.id, item.title, item.done),
      ),
    ),
  keyed: (json) => {
    const { $items } = decodeBareEntries(json);
    return {
      title: (read, key) => (read($items.row(key)) as TodoJson | undefined)?.title,
      rename: (key, title) => {
        update(realm, (_read, write) => {
          write.upsert($items, { id: key, title, done: false });
        });
      },
    };
  },
  watch: (select) => watch(realm, select, () => {}),
};

// MobX

class MobxTodo {
  constructor(
    public id: string,
    public title: string,
    public done: boolean,
  ) {
    makeAutoObservable(this);
  }

  get label(): string {
    return this.done ? `✓ ${this.title}` : this.title;
  }

  toggle(): void {
    this.done = !this.done;
  }
}

class MobxTodos implements Model {
  constructor(public items: Array<MobxTodo>) {
    makeAutoObservable(this);
  }

  get remainingCount(): number {
    return this.items.filter((todo) => !todo.done).length;
  }

  readonly size = (_read: Read): number => this.items.length;
  readonly remaining = (_read: Read): number => this.remainingCount;
  readonly label = (_read: Read, index: number): string => this.items[index]?.label ?? "";

  toggle(index: number): void {
    this.items[index]?.toggle();
  }

  add(title: string): void {
    this.items.push(new MobxTodo(title, title, false));
  }

  addMany(titles: ReadonlyArray<string>): void {
    for (const title of titles) {
      this.items.push(new MobxTodo(title, title, false));
    }
  }

  toggleAll(): void {
    const done = this.items.some((todo) => !todo.done);
    for (const todo of this.items) {
      todo.done = done;
    }
  }
}

interface TodoJson {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

interface TodosJson {
  readonly items: ReadonlyArray<TodoJson>;
}

/** MobX models read their own fields, so the read a MobX watch hands them is never called. */
const unusedRead: Read = untracked(realm, (read) => read);

const mobx: Subject = {
  build: () =>
    new MobxTodos(
      Array.from(
        { length: rows },
        (_, index) => new MobxTodo(String(index), `todo ${index}`, false),
      ),
    ),
  decode: (json) =>
    new MobxTodos(
      (json as { readonly items: ReadonlyArray<TodoJson> }).items.map(
        (item) => new MobxTodo(item.id, item.title, item.done),
      ),
    ),
  keyed: (json) => {
    const items = observable.map<string, TodoJson>(
      json.items.map((item) => [item.id, item]),
      { deep: false },
    );
    return {
      title: (_read, key) => items.get(key)?.title,
      rename: (key, title) => {
        runInAction(() => {
          items.set(key, { id: key, title, done: false });
        });
      },
    };
  },
  watch: (select) =>
    reaction(
      () => select(unusedRead),
      () => {},
    ),
};

// Harness

/** What a benchmark needs of the engine it runs on. */
export interface Host {
  /** Milliseconds, as precise as the engine allows. */
  readonly now: () => number;
  /** What `make`'s result holds after a collection, as a table cell. Keeps it alive. */
  readonly retained: (make: () => unknown) => string;
}

const median = (values: Array<number>): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] as number;
};

const time = (host: Host, setup: () => () => void): number => {
  const samples: Array<number> = [];
  for (let run = 0; run < runs; run++) {
    const measured = setup();
    const start = host.now();
    measured();
    samples.push(host.now() - start);
  }
  return median(samples);
};

const observeAll = (subject: Subject, model: Model): Array<() => void> => [
  subject.watch((read) => model.remaining(read)),
  subject.watch((read) => model.size(read)),
  ...Array.from({ length: rows }, (_, index) => subject.watch((read) => model.label(read, index))),
];

const titles = Array.from({ length: operations }, (_, index) => `new ${index}`);

export const measure = (subject: Subject, host: Host): Record<string, string> => {
  const json = {
    items: Array.from({ length: rows }, (_, index) => ({
      id: String(index),
      title: `todo ${index}`,
      done: false,
    })),
  };
  const result: Record<string, string> = {};
  const ms = (value: number): string => `${value.toFixed(2)} ms`;

  result["build 10k"] = ms(time(host, () => () => subject.build()));
  result["decode 10k"] = ms(time(host, () => () => subject.decode(json)));
  result["memory 10k decoded"] = host.retained(() => subject.decode(json));
  result["memory 10k observed"] = host.retained(() => {
    const model = subject.build();
    return [model, observeAll(subject, model)];
  });
  result["observe 10k rows"] = ms(
    time(host, () => {
      const model = subject.build();
      return () => observeAll(subject, model);
    }),
  );
  result[`toggle 1 row ×${operations}, observed`] = ms(
    time(host, () => {
      const model = subject.build();
      observeAll(subject, model);
      return () => {
        for (let index = 0; index < operations; index++) {
          model.toggle((index * 7919) % rows);
        }
      };
    }),
  );
  result["toggleAll 10k, observed"] = ms(
    time(host, () => {
      const model = subject.build();
      observeAll(subject, model);
      return () => model.toggleAll();
    }),
  );
  result[`rename 1 keyed row ×${operations}, 10k readers`] = ms(
    time(host, () => {
      const keyed = subject.keyed(json);
      for (let index = 0; index < rows; index++) {
        subject.watch((read) => keyed.title(read, String(index)));
      }
      return () => {
        for (let index = 0; index < operations; index++) {
          keyed.rename(String((index * 7919) % rows), `renamed ${index}`);
        }
      };
    }),
  );
  result[`add ×${operations}, observed`] = ms(
    time(host, () => {
      const model = subject.build();
      subject.watch((read) => model.size(read));
      return () => {
        for (const title of titles) {
          model.add(title);
        }
      };
    }),
  );
  result[`add ×${operations}, unobserved`] = ms(
    time(host, () => {
      const model = subject.build();
      return () => {
        for (const title of titles) {
          model.add(title);
        }
      };
    }),
  );
  result[`add ${operations} in one update, observed`] = ms(
    time(host, () => {
      const model = subject.build();
      subject.watch((read) => model.size(read));
      return () => model.addMany(titles);
    }),
  );
  return result;
};

/**
 * Ceilings, as a multiple of the other subject's time. Each sits about twice
 * above the ratio measured when it was set, so noise does not fail it and a
 * real regression does. Memory rows have none.
 */
export const bareCeilings: Record<string, number> = {
  "build 10k": 1.5,
  "decode 10k": 1.5,
  "observe 10k rows": 1,
  [`toggle 1 row ×${operations}, observed`]: 2,
  "toggleAll 10k, observed": 2,
  // A cell per key read: a rename reruns that key's reader, not all 10k.
  [`rename 1 keyed row ×${operations}, 10k readers`]: 1.5,
  // Every update copies the 10k-row array: about 12 times MobX's in-place
  // push. The ceiling holds that cost where it is.
  [`add ×${operations}, observed`]: 30,
  [`add ×${operations}, unobserved`]: 30,
  [`add ${operations} in one update, observed`]: 3,
};

/** What checking with Effect Schema costs over bare Pinna. */
export const schemaCeilings: Record<string, number> = {
  // Build, decode, and toggleAll set 2026-11-11, after bare Pinna's decode
  // fell from 4.1 ms to 1.2 to 2 ms and the schema path stayed: about 11 and
  // 3.3 times bare for decode and toggleAll. Build runs at about 4 or about
  // 7.3 times, run to run, so its ceiling sits above the higher.
  "build 10k": 10,
  "decode 10k": 20,
  "observe 10k rows": 2.5,
  [`toggle 1 row ×${operations}, observed`]: 3,
  "toggleAll 10k, observed": 6,
  [`rename 1 keyed row ×${operations}, 10k readers`]: 3,
  // Every update checks the whole 10k-row array: 17 to 27 times bare Pinna,
  // whose add is short enough that its noise moves the ratio.
  [`add ×${operations}, observed`]: 50,
  [`add ×${operations}, unobserved`]: 50,
  [`add ${operations} in one update, observed`]: 3,
};

export const subjects = { mobx, "pinna-bare": pinnaBare, "pinna-schema": pinnaSchema } as const;
