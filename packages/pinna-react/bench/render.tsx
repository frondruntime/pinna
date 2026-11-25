/**
 * React benchmark on Bun with happy-dom: a list of rows, each showing one
 * price, read three ways: Pinna's `useValue`, the core of MobX's `observer`
 * written out (as `test/conformance/mobx-uses/observer.test.tsx` does), and
 * a plain `useSyncExternalStore` store per row, the least React charges.
 *
 * Each library runs in its own process on React's production build. Every
 * operation runs in `flushSync`, so a time covers the renders and React
 * applying them to the DOM. Every operation checks the rows it rendered and
 * the text it left, so a time is never of nothing.
 *
 * bun bench/render.tsx
 *
 * `PINNA_HOOKS=<module>` measures another build of the hooks, such as an
 * earlier commit's `src/index.ts` copied into `bench/`.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

const {
  Realm: { make: createRealm, update },
  Box: { schema: schemaBox },
} = await import("@frondruntime/pinna-effect");
const { Schema } = await import("effect");
const mobx = await import("mobx");
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { flushSync } = await import("react-dom");
const { PINNA_HOOKS: hooksModule, NODE_ENV: mode } = process.env;
const hooks = (await import(hooksModule ?? "../src/index.ts")) as typeof import("../src/index.ts");

const { createElement, memo, useEffect, useReducer, useRef, useSyncExternalStore } = React;
type ReactNode = import("react").ReactNode;

/** Renders counted while an operation runs. */
const renders = { list: 0, rows: 0 };

/** One library's list: what it shows and how a write reaches it. */
interface Subject {
  readonly App: () => ReactNode;
  /** Sets row `index`'s price in one update. */
  readonly tick: (index: number, price: number) => void;
  /** Sets every row's price in one update. */
  readonly tickAll: (price: number) => void;
  /** Adds a row at the end. */
  readonly add: () => void;
  /** Removes the first row. */
  readonly remove: () => void;
}

type Make = (count: number) => Subject;

const idOf = (index: number): string => `r${index}`;

const rowElement = (id: string, price: number): ReactNode =>
  createElement("li", null, `${id} ${price}`);

const listElement = (children: ReactNode): ReactNode => createElement("ul", null, children);

const pinna: Make = (count) => {
  const realm = createRealm();
  let made = 0;
  const prices = new Map<string, import("@frondruntime/pinna-effect").Box<number>>();
  const make = (): string => {
    const id = idOf(made++);
    prices.set(id, schemaBox(realm, Schema.Number, 0));
    return id;
  };
  const initial = Array.from({ length: count }, make);
  const $ids = schemaBox(realm, Schema.Array(Schema.String), initial);
  const Row = memo(function Row({ id }: { readonly id: string }): ReactNode {
    renders.rows++;
    const $price = prices.get(id);
    if ($price === undefined) {
      throw new Error(`bench: no row ${id}`);
    }
    return rowElement(id, hooks.useValue($price));
  });
  function List(): ReactNode {
    renders.list++;
    const ids = hooks.useValue($ids);
    return listElement(ids.map((id) => createElement(Row, { key: id, id })));
  }
  return {
    App: () => createElement(hooks.RealmProvider, { realm }, createElement(List)),
    tick: (index, price) => {
      update(realm, (read, write) => {
        const $price = prices.get(read($ids)[index] as string);
        if ($price !== undefined) {
          write($price, price);
        }
      });
    },
    tickAll: (price) => {
      update(realm, (read, write) => {
        for (const id of read($ids)) {
          const $price = prices.get(id);
          if ($price !== undefined) {
            write($price, price);
          }
        }
      });
    },
    add: () => {
      update(realm, (read, write) => {
        write($ids, [...read($ids), make()]);
      });
    },
    remove: () => {
      update(realm, (read, write) => {
        const [first, ...rest] = read($ids);
        write($ids, rest);
        prices.delete(first as string);
      });
    },
  };
};

/** The core of `observer`: tracks each render and rerenders on its change. */
const observer = <Props,>(render: (props: Props) => ReactNode) =>
  function Observed(props: Props): ReactNode {
    const [, rerender] = useReducer((tally: number) => tally + 1, 0);
    const reaction = useRef<import("mobx").Reaction | null>(null);
    if (reaction.current === null) {
      reaction.current = new mobx.Reaction("observer", rerender);
    }
    useEffect(() => () => reaction.current?.dispose(), []);
    let output: ReactNode = null;
    reaction.current.track(() => {
      output = render(props);
    });
    return output;
  };

const mobxObserver: Make = (count) => {
  let made = 0;
  const prices = new Map<string, import("mobx").IObservableValue<number>>();
  const make = (): string => {
    const id = idOf(made++);
    prices.set(id, mobx.observable.box(0));
    return id;
  };
  const ids = mobx.observable.box<ReadonlyArray<string>>(Array.from({ length: count }, make), {
    deep: false,
  });
  const Row = memo(
    observer(({ id }: { readonly id: string }): ReactNode => {
      renders.rows++;
      const price = prices.get(id);
      if (price === undefined) {
        throw new Error(`bench: no row ${id}`);
      }
      return rowElement(id, price.get());
    }),
  );
  const List = observer((): ReactNode => {
    renders.list++;
    return listElement(ids.get().map((id) => createElement(Row, { key: id, id })));
  });
  return {
    App: () => createElement(List, {}),
    tick: (index, price) => {
      mobx.runInAction(() => {
        prices.get(ids.get()[index] as string)?.set(price);
      });
    },
    tickAll: (price) => {
      mobx.runInAction(() => {
        for (const id of ids.get()) {
          prices.get(id)?.set(price);
        }
      });
    },
    add: () => {
      mobx.runInAction(() => {
        ids.set([...ids.get(), make()]);
      });
    },
    remove: () => {
      mobx.runInAction(() => {
        const [first, ...rest] = ids.get();
        ids.set(rest);
        prices.delete(first as string);
      });
    },
  };
};

/** A value with listeners: what `useSyncExternalStore` asks of a store. */
class Store<Value> {
  private readonly listeners = new Set<() => void>();
  constructor(private value: Value) {}
  readonly get = (): Value => this.value;
  set(value: Value): void {
    if (Object.is(value, this.value)) {
      return;
    }
    this.value = value;
    for (const listener of this.listeners) {
      listener();
    }
  }
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

const useStore = <Value,>(store: Store<Value>): Value =>
  useSyncExternalStore(store.subscribe, store.get, store.get);

const plainStore: Make = (count) => {
  let made = 0;
  const prices = new Map<string, Store<number>>();
  const make = (): string => {
    const id = idOf(made++);
    prices.set(id, new Store(0));
    return id;
  };
  const ids = new Store<ReadonlyArray<string>>(Array.from({ length: count }, make));
  const Row = memo(function Row({ id }: { readonly id: string }): ReactNode {
    renders.rows++;
    const price = prices.get(id);
    if (price === undefined) {
      throw new Error(`bench: no row ${id}`);
    }
    return rowElement(id, useStore(price));
  });
  function List(): ReactNode {
    renders.list++;
    return listElement(useStore(ids).map((id) => createElement(Row, { key: id, id })));
  }
  return {
    App: () => createElement(List),
    tick: (index, price) => {
      prices.get(ids.get()[index] as string)?.set(price);
    },
    tickAll: (price) => {
      for (const id of ids.get()) {
        prices.get(id)?.set(price);
      }
    },
    add: () => {
      ids.set([...ids.get(), make()]);
    },
    remove: () => {
      const [first, ...rest] = ids.get();
      ids.set(rest);
      prices.delete(first as string);
    },
  };
};

export const libraries = {
  pinna,
  "mobx observer": mobxObserver,
  "plain store": plainStore,
} as const;

export type LibraryName = keyof typeof libraries;

/** One scenario's numbers for one library. */
export interface Measured {
  readonly minimum: number;
  readonly median: number;
}

const runs = 7;

const middle = (values: Array<number>): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] as number;
};

/** Throws when an operation rendered or showed something other than expected. */
const expect = (actual: unknown, expected: unknown, what: string): void => {
  if (actual !== expected) {
    throw new Error(`bench: ${what} was ${String(actual)}, expected ${String(expected)}`);
  }
};

interface Mounted {
  readonly subject: Subject;
  readonly container: HTMLElement;
  /** Renders the list, when `mount` did not. */
  readonly render: () => void;
  readonly unmount: () => void;
}

const mount = (make: Make, count: number, shown: boolean): Mounted => {
  const subject = make(count);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (): void => {
    root.render(createElement(subject.App));
  };
  if (shown) {
    flushSync(render);
  }
  return {
    subject,
    container,
    render,
    unmount: () => {
      flushSync(() => {
        root.unmount();
      });
      container.remove();
    },
  };
};

const rowsShown = (container: HTMLElement): number => container.querySelectorAll("li").length;

/**
 * Times `run` on a fresh list of `count` rows, `runs` times, and checks the
 * renders it counted against `rows` and `list`.
 */
const measureOne = (
  make: Make,
  count: number,
  expected: { readonly rows: number; readonly list: number; readonly shown: number },
  run: (mounted: Mounted) => void,
  shown = true,
): Measured => {
  const times: Array<number> = [];
  for (let index = 0; index < runs; index++) {
    const mounted = mount(make, count, shown);
    Bun.gc(true);
    renders.list = 0;
    renders.rows = 0;
    const start = performance.now();
    run(mounted);
    times.push(performance.now() - start);
    expect(renders.rows, expected.rows, "rows rendered");
    expect(renders.list, expected.list, "lists rendered");
    expect(rowsShown(mounted.container), expected.shown, "rows shown");
    mounted.unmount();
  }
  return { minimum: Math.min(...times), median: middle(times) };
};

export const measure = (make: Make): Record<string, Measured> => {
  const result: Record<string, Measured> = {};
  for (const count of [1000, 10_000]) {
    result[`mount ${count} rows`] = measureOne(
      make,
      count,
      { rows: count, list: 1, shown: count },
      (mounted) => {
        flushSync(mounted.render);
      },
      false,
    );
    result[`${count} rows: one row ticks ×100`] = measureOne(
      make,
      count,
      { rows: 100, list: 0, shown: count },
      ({ subject, container }) => {
        for (let tick = 1; tick <= 100; tick++) {
          flushSync(() => {
            subject.tick((tick * 7) % count, tick);
          });
        }
        expect(container.querySelectorAll("li")[700 % count]?.textContent, "r700 100", "row text");
      },
    );
    result[`${count} rows: every row ticks ×10`] = measureOne(
      make,
      count,
      { rows: count * 10, list: 0, shown: count },
      ({ subject, container }) => {
        for (let tick = 1; tick <= 10; tick++) {
          flushSync(() => {
            subject.tickAll(tick);
          });
        }
        expect(container.querySelector("li")?.textContent, "r0 10", "row text");
      },
    );
    result[`${count} rows: add a row ×20`] = measureOne(
      make,
      count,
      { rows: 20, list: 20, shown: count + 20 },
      ({ subject }) => {
        for (let added = 0; added < 20; added++) {
          flushSync(() => {
            subject.add();
          });
        }
      },
    );
    result[`${count} rows: remove a row ×20`] = measureOne(
      make,
      count,
      { rows: 0, list: 20, shown: count - 20 },
      ({ subject, container }) => {
        for (let removed = 0; removed < 20; removed++) {
          flushSync(() => {
            subject.remove();
          });
        }
        expect(container.querySelector("li")?.textContent, "r20 0", "row text");
      },
    );
  }
  return result;
};

const ratio = (over: Measured | undefined, under: Measured | undefined): string =>
  over === undefined || under === undefined ? "" : `${(over.minimum / under.minimum).toFixed(2)}×`;

const report = (results: Record<LibraryName, Record<string, Measured>>): string => {
  const names = Object.keys(libraries) as Array<LibraryName>;
  const header = ["", ...names, "Pinna ÷ MobX", "Pinna ÷ plain"];
  const lines = [
    `Bun ${Bun.version}, React ${React.version} (production), happy-dom: minimum / median ms of ${runs} runs`,
    "",
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
  ];
  for (const scenario of Object.keys(results.pinna)) {
    const cells = names.map((name) => {
      const measured = results[name][scenario];
      return measured === undefined
        ? ""
        : `${measured.minimum.toFixed(2)} / ${measured.median.toFixed(2)}`;
    });
    cells.push(
      ratio(results.pinna[scenario], results["mobx observer"][scenario]),
      ratio(results.pinna[scenario], results["plain store"][scenario]),
    );
    lines.push(`| ${scenario} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
};

const requested = process.argv[2];

if (requested === undefined) {
  const names = Object.keys(libraries) as Array<LibraryName>;
  const results = Object.fromEntries(
    names.map((name) => {
      const child = Bun.spawnSync([process.execPath, ...process.execArgv, import.meta.path, name], {
        env: { ...process.env, NODE_ENV: "production" },
      });
      if (child.exitCode !== 0) {
        throw new Error(`${name} failed:\n${child.stderr.toString()}`);
      }
      return [name, JSON.parse(child.stdout.toString()) as Record<string, Measured>];
    }),
  ) as Record<LibraryName, Record<string, Measured>>;
  console.log(report(results));
} else {
  if (mode !== "production") {
    throw new Error(
      "bench: a library runs on React's production build; run bench/render.tsx alone",
    );
  }
  const make = libraries[requested as LibraryName];
  if (make === undefined) {
    throw new Error(`bench: no library ${requested}`);
  }
  console.log(JSON.stringify(measure(make)));
}
