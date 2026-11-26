import { afterEach, describe, expect, test } from "bun:test";
import {
  Atom,
  Box,
  Computed,
  Program,
  Realm,
  RealmService,
  Source,
} from "@frondruntime/pinna-effect";
import { Effect, Queue, Schema, Stream } from "effect";
import {
  act,
  Component,
  memo,
  type ReactNode,
  StrictMode,
  Suspense,
  startTransition,
  useLayoutEffect,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { RealmProvider, useRealm, useSelect, useValue, useValues } from "../src/index.ts";
import { Portfolio, type Position, PositionsResponse, positionsJson } from "./model.ts";

const renders = new Map<string, number>();
const count = (name: string): void => {
  renders.set(name, (renders.get(name) ?? 0) + 1);
};

let root: Root | undefined;
let container: HTMLElement | undefined;

const mount = (element: React.ReactNode): HTMLElement => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
  renders.clear();
  return container;
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  renders.clear();
});

const Row = memo(function Row({ position }: { readonly position: Position }) {
  count("Row");
  const value = useValue(position.$value);
  return (
    <li>
      {position.label}: {value}
    </li>
  );
});

function Positions({ portfolio }: { readonly portfolio: Portfolio }) {
  count("Positions");
  const items = useSelect((read) => read(portfolio.$response).items);
  return (
    <ul>
      {items.map((position) => (
        <Row key={position.id} position={position} />
      ))}
    </ul>
  );
}

function Total({ portfolio }: { readonly portfolio: Portfolio }) {
  count("Total");
  const label = useValue(portfolio.$totalLabel);
  return <p>{label}</p>;
}

const App = ({ portfolio }: { readonly portfolio: Portfolio }) => (
  <RealmProvider realm={portfolio.realm}>
    <Positions portfolio={portfolio} />
    <Total portfolio={portfolio} />
  </RealmProvider>
);

/** Runs `run` with React's error logging silenced, for renders expected to throw. */
const quietly = <Result,>(run: () => Result): Result => {
  const original = console.error;
  console.error = () => {};
  try {
    return run();
  } finally {
    console.error = original;
  }
};

class Boundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? <p>failed</p> : this.props.children;
  }
}

const loaded = (count: number): Portfolio => {
  const portfolio = new Portfolio(Realm.make());
  portfolio.load(positionsJson(count));
  return portfolio;
};

describe("fromStream in a component", () => {
  const forms = {
    useValue: ($value: Computed<number>) => useValue($value),
    useValues: ($value: Computed<number>) => useValues([$value])[0],
    useSelect: ($value: Computed<number>) => useSelect((read) => read($value)),
  };

  for (const [form, read] of Object.entries(forms)) {
    test(`a remount shows initial until the next element, through ${form}`, async () => {
      const realm = Realm.make();
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const queue = yield* Queue.unbounded<number>();
            const $value = yield* Program.fromStream(realm, Stream.fromQueue(queue), 0);
            function Price(): ReactNode {
              const price = read($value);
              return (
                <button type="button" disabled={price === 0}>
                  {price}
                </button>
              );
            }
            const element = (
              <RealmProvider realm={realm}>
                <Price />
              </RealmProvider>
            );
            const view = mount(element);
            expect(view.textContent).toBe("0");
            yield* Effect.promise(() =>
              act(async () => {
                await Effect.runPromise(Queue.offer(queue, 10));
                await Effect.runPromise(Effect.sleep("5 millis"));
              }),
            );
            expect(view.textContent).toBe("10");
            expect(view.querySelector("button")?.disabled).toBe(false);
            act(() => root?.render(null));
            expect(Realm.untracked(realm, (read) => read($value))).toBe(0);
            act(() => root?.render(element));
            expect(view.textContent).toBe("0");
            expect(view.querySelector("button")?.disabled).toBe(true);
            yield* Effect.promise(() =>
              act(async () => {
                await Effect.runPromise(Queue.offer(queue, 20));
                await Effect.runPromise(Effect.sleep("5 millis"));
              }),
            );
            expect(view.textContent).toBe("20");
            act(() => root?.render(null));
          }),
        ).pipe(Effect.provideService(RealmService, realm)),
      );
    });

    test(`StrictMode resets the first mount before the second run emits, through ${form}`, async () => {
      const realm = Realm.make();
      const events: Array<number> = [];
      let runs = 0;
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const queue = yield* Queue.unbounded<number>();
            const stream = Stream.unwrap(
              Effect.sync(() => {
                runs++;
                return runs === 1
                  ? Stream.concat(Stream.make(10), Stream.never)
                  : Stream.fromQueue(queue);
              }),
            );
            const $value = yield* Program.fromStream(realm, stream, 0);
            Source.onObserved($value, () => {
              events.push(Realm.untracked(realm, (read) => read($value)));
              return () => {
                events.push(Realm.untracked(realm, (read) => read($value)));
              };
            });
            function Price(): ReactNode {
              return <p>{read($value)}</p>;
            }
            const view = mount(
              <StrictMode>
                <RealmProvider realm={realm}>
                  <Price />
                </RealmProvider>
              </StrictMode>,
            );
            expect(runs).toBe(2);
            expect(events).toEqual([10, 0, 0]);
            expect(view.textContent).toBe("0");
            yield* Effect.promise(() =>
              act(async () => {
                await Effect.runPromise(Queue.offer(queue, 20));
                await Effect.runPromise(Effect.sleep("5 millis"));
              }),
            );
            expect(view.textContent).toBe("20");
            act(() => root?.render(null));
            expect(events.at(-1)).toBe(0);
          }),
        ).pipe(Effect.provideService(RealmService, realm)),
      );
    });

    test(`a rerender keeps the stream observed, through ${form}`, async () => {
      const realm = Realm.make();
      const events: Array<string> = [];
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const queue = yield* Queue.unbounded<number>();
            const $value = yield* Program.fromStream(realm, Stream.fromQueue(queue), 0);
            Source.onObserved($value, () => {
              events.push("start");
              return () => {
                events.push("stop");
              };
            });
            function Price({ label }: { readonly label: string }): ReactNode {
              return (
                <p>
                  {label}: {read($value)}
                </p>
              );
            }
            const view = mount(
              <RealmProvider realm={realm}>
                <Price label="first" />
              </RealmProvider>,
            );
            yield* Effect.promise(() =>
              act(async () => {
                await Effect.runPromise(Queue.offer(queue, 10));
                await Effect.runPromise(Effect.sleep("5 millis"));
              }),
            );
            act(() =>
              root?.render(
                <RealmProvider realm={realm}>
                  <Price label="second" />
                </RealmProvider>,
              ),
            );
            expect(view.textContent).toBe("second: 10");
            expect(events).toEqual(["start"]);
            act(() => root?.render(null));
          }),
        ).pipe(Effect.provideService(RealmService, realm)),
      );
    });
  }

  test("changing a useValues source list keeps the shared stream observed and its value", async () => {
    const realm = Realm.make();
    const $other = Box.schema(realm, Schema.Number, 1);
    const events: Array<string> = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<number>();
          const $value = yield* Program.fromStream(realm, Stream.fromQueue(queue), 0);
          Source.onObserved($value, () => {
            events.push("start");
            return () => {
              events.push("stop");
            };
          });
          function Price({ extra }: { readonly extra: boolean }): ReactNode {
            const values = useValues(extra ? [$value, $other] : [$value]);
            return <p>{values[0]}</p>;
          }
          const view = mount(<Price extra={false} />);
          yield* Effect.promise(() =>
            act(async () => {
              await Effect.runPromise(Queue.offer(queue, 10));
              await Effect.runPromise(Effect.sleep("5 millis"));
            }),
          );
          expect(view.textContent).toBe("10");
          // The commit keeps the source both lists read, so the stream is
          // not restarted and keeps its last element.
          act(() => root?.render(<Price extra={true} />));
          expect(events).toEqual(["start"]);
          expect(view.textContent).toBe("10");
          yield* Effect.promise(() =>
            act(async () => {
              await Effect.runPromise(Queue.offer(queue, 20));
              await Effect.runPromise(Effect.sleep("5 millis"));
            }),
          );
          expect(view.textContent).toBe("20");
          act(() => root?.render(null));
        }),
      ).pipe(Effect.provideService(RealmService, realm)),
    );
  });
});

describe("useValue", () => {
  test("a tick in 1,000 rows renders one Row and Total", () => {
    const portfolio = loaded(1000);
    const view = mount(<App portfolio={portfolio} />);
    act(() => portfolio.tick({ id: "p5", price: 20 }));
    expect(Object.fromEntries(renders)).toEqual({ Row: 1, Total: 1 });
    expect(view.querySelectorAll("li")[5]?.textContent).toBe("6 T5: 120");
  });

  test("a tick with the same price renders nothing", () => {
    const portfolio = loaded(10);
    mount(<App portfolio={portfolio} />);
    act(() => portfolio.tick({ id: "p5", price: 10 }));
    expect(Object.fromEntries(renders)).toEqual({});
  });

  test("closing a position renders the list, not the other rows", () => {
    const portfolio = loaded(10);
    const view = mount(<App portfolio={portfolio} />);
    act(() => portfolio.close("p5"));
    expect(Object.fromEntries(renders)).toEqual({ Positions: 1, Total: 1 });
    expect(view.querySelectorAll("li")).toHaveLength(9);
  });

  test("a read function that returns an equal value does not render", () => {
    const portfolio = loaded(10);
    function Count() {
      count("Count");
      const size = useSelect((read) => read(portfolio.$response).items.length);
      return <p>{size}</p>;
    }
    mount(
      <RealmProvider realm={portfolio.realm}>
        <Count />
      </RealmProvider>,
    );
    act(() =>
      Realm.update(portfolio.realm, (read, write) => {
        const current = read(portfolio.$response);
        write(
          portfolio.$response,
          PositionsResponse.make({ items: [...current.items], realm: portfolio.realm }),
        );
      }),
    );
    expect(Object.fromEntries(renders)).toEqual({});
  });

  test("reading in a render outside useValue throws", () => {
    const portfolio = loaded(1);
    const leaked = Realm.untracked(portfolio.realm, (read) => read);
    function Bad() {
      return <p>{leaked(portfolio.$totalLabel)}</p>;
    }
    quietly(() => expect(() => mount(<Bad />)).toThrow("runs outside a place"));
  });

  test("unmounting stops the stream hook; StrictMode holds no extra subscription", () => {
    const portfolio = loaded(3);
    const events: Array<string> = [];
    Source.onObserved(portfolio.$response, () => {
      events.push("start");
      return () => events.push("stop");
    });
    mount(
      <StrictMode>
        <App portfolio={portfolio} />
      </StrictMode>,
    );
    act(() => root?.unmount());
    root = undefined;
    expect(events.filter((event) => event === "start").length).toBe(
      events.filter((event) => event === "stop").length,
    );
    expect(events.at(-1)).toBe("stop");
  });
  test("a read function rerenders when what it read changes", () => {
    const portfolio = loaded(3);
    function Label() {
      count("Label");
      const label = useSelect(
        (read) => `${read(portfolio.$currency)} ${read(portfolio.$response).items.length}`,
      );
      return <p>{label}</p>;
    }
    const view = mount(
      <RealmProvider realm={portfolio.realm}>
        <Label />
      </RealmProvider>,
    );
    act(() =>
      Realm.update(portfolio.realm, (_read, write) => {
        write(portfolio.$currency, "EUR");
      }),
    );
    expect(Object.fromEntries(renders)).toEqual({ Label: 1 });
    expect(view.textContent).toBe("EUR 3");
  });

  test("a read function without a RealmProvider throws", () => {
    const portfolio = loaded(1);
    function Bare() {
      return <p>{useSelect((read) => read(portfolio.$currency))}</p>;
    }
    quietly(() => expect(() => mount(<Bare />)).toThrow("RealmProvider"));
  });

  test("a read function that updates throws", () => {
    const portfolio = loaded(1);
    function Writer() {
      const currency = useSelect((read) => {
        Realm.update(portfolio.realm, () => undefined);
        return read(portfolio.$currency);
      });
      return <p>{currency}</p>;
    }
    quietly(() =>
      expect(() =>
        mount(
          <RealmProvider realm={portfolio.realm}>
            <Writer />
          </RealmProvider>,
        ),
      ).toThrow(
        "pinna: Realm.update cannot run in a watch's select or a selector; write from an event, a watch's effect, or an autorun",
      ),
    );
  });

  test("a read function reading another realm's observable throws", () => {
    const portfolio = loaded(1);
    const other = loaded(1);
    function Mixed() {
      return <p>{useSelect((read) => read(other.$currency))}</p>;
    }
    quietly(() =>
      expect(() =>
        mount(
          <RealmProvider realm={portfolio.realm}>
            <Mixed />
          </RealmProvider>,
        ),
      ).toThrow("another realm"),
    );
  });

  test("a render React discards starts no onObserved hook", () => {
    const portfolio = loaded(3);
    const events: Array<string> = [];
    Source.onObserved(portfolio.$response, () => {
      events.push("start");
      return () => events.push("stop");
    });
    function Fails(): never {
      throw new Error("fails");
    }
    const view = quietly(() =>
      mount(
        <Boundary>
          <App portfolio={portfolio} />
          <Fails />
        </Boundary>,
      ),
    );
    expect(view.textContent).toBe("failed");
    expect(events).toEqual([]);
    act(() => portfolio.close("p1"));
    expect(events).toEqual([]);
  });

  test("an equals that throws at subscribe leaves nothing observed", () => {
    const realm = Realm.make({ onError: () => {} });
    const $first = Box.schema(realm, Schema.Number, 0);
    const $source = Box.schema(realm, Schema.Number, 0);
    const events: Array<string> = [];
    Source.onObserved($first, () => {
      events.push("start");
      return () => events.push("stop");
    });
    const $value = Computed.make(realm, (read) => read($source), {
      equals: (_left, right) => {
        if (right === 1) {
          throw new Error("equals");
        }
        return false;
      },
    });
    function View(): ReactNode {
      const value = useSelect((read) => read($first) + read($value));
      useLayoutEffect(() => {
        Realm.update(realm, (_read, write) => {
          write($source, 1);
        });
      }, []);
      return <p>{value}</p>;
    }
    quietly(() =>
      mount(
        <RealmProvider realm={realm}>
          <Boundary>
            <View />
          </Boundary>
        </RealmProvider>,
      ),
    );
    act(() => root?.unmount());
    root = undefined;
    expect(Source.inspect($first).observers).toBe(0);
    expect(events.filter((event) => event === "start").length).toBe(
      events.filter((event) => event === "stop").length,
    );
  });

  test("an equals that throws when a write relinks leaves nothing observed", () => {
    const realm = Realm.make({ onError: () => {} });
    const $wide = Box.schema(realm, Schema.Boolean, false);
    const $first = Box.schema(realm, Schema.Number, 0);
    const $atom = Atom.make(realm);
    const events: Array<string> = [];
    Source.onObserved($first, () => {
      events.push("start");
      return () => events.push("stop");
    });
    // Volatile, so linking it recomputes it, and equals runs there.
    const $value = Computed.make(
      realm,
      (read) => {
        read($atom);
        return 1;
      },
      {
        equals: () => {
          throw new Error("equals");
        },
      },
    );
    function View(): ReactNode {
      const value = useSelect((read) => (read($wide) ? read($first) + read($value) : 0));
      return <p>{value}</p>;
    }
    quietly(() => {
      mount(
        <RealmProvider realm={realm}>
          <Boundary>
            <View />
          </Boundary>
        </RealmProvider>,
      );
      act(() => {
        Realm.update(realm, (_read, write) => {
          write($wide, true);
        });
      });
      act(() => root?.unmount());
    });
    root = undefined;
    expect(Source.inspect($first).observers).toBe(0);
    expect(events.filter((event) => event === "start").length).toBe(
      events.filter((event) => event === "stop").length,
    );
  });

  test("an equals that throws when a kept render relinks leaves nothing observed", () => {
    const realm = Realm.make({ onError: () => {} });
    const $first = Box.schema(realm, Schema.Number, 0);
    const $atom = Atom.make(realm);
    const events: Array<string> = [];
    Source.onObserved($first, () => {
      events.push("start");
      return () => events.push("stop");
    });
    // Volatile, so linking it recomputes it, and equals runs there.
    const $value = Computed.make(
      realm,
      (read) => {
        read($atom);
        return 1;
      },
      {
        equals: () => {
          throw new Error("equals");
        },
      },
    );
    function View({ wide }: { readonly wide: boolean }): ReactNode {
      const value = useSelect((read) => (wide ? read($first) + read($value) : 0));
      return <p>{value}</p>;
    }
    const app = (wide: boolean) => (
      <RealmProvider realm={realm}>
        <Boundary>
          <View wide={wide} />
        </Boundary>
      </RealmProvider>
    );
    // The new read links only once React keeps the render, so the throw
    // comes from that link, after the render.
    const view = quietly(() => {
      const view = mount(app(false));
      act(() => root?.render(app(true)));
      return view;
    });
    expect(view.textContent).toBe("failed");
    act(() => root?.unmount());
    root = undefined;
    expect(Source.inspect($first).observers).toBe(0);
    expect(events.filter((event) => event === "start").length).toBe(
      events.filter((event) => event === "stop").length,
    );
  });

  test("an observable from another realm replaces the subscription", () => {
    const first = loaded(1);
    const second = loaded(1);
    const events: Array<string> = [];
    Source.onObserved(first.$currency, () => {
      events.push("start");
      return () => events.push("stop");
    });
    Realm.update(second.realm, (_read, write) => {
      write(second.$currency, "EUR");
    });
    function Currency({ portfolio }: { readonly portfolio: Portfolio }) {
      return <p>{useValue(portfolio.$currency)}</p>;
    }
    const view = mount(<Currency portfolio={first} />);
    act(() => root?.render(<Currency portfolio={second} />));
    expect(events).toEqual(["start", "stop"]);
    expect(view.textContent).toBe("EUR");
    act(() => {
      Realm.update(second.realm, (_read, write) => {
        write(second.$currency, "USD");
      });
    });
    expect(view.textContent).toBe("USD");
  });
});

describe("a mounted value that fails in a later update", () => {
  const failing = (fails: "compute" | "equals") => {
    const errors: Array<unknown> = [];
    const realm = Realm.make({ onError: (error) => errors.push(error) });
    const $source = Box.schema(realm, Schema.Number, 0);
    const $value = Computed.make(
      realm,
      (read) => {
        const value = read($source);
        if (fails === "compute" && value === 1) {
          throw new Error("compute");
        }
        return value;
      },
      {
        equals: (left, right) => {
          if (fails === "equals" && right === 1) {
            throw new Error("equals");
          }
          return left === right;
        },
      },
    );
    return { errors, realm, $source, $value };
  };

  for (const fails of ["compute", "equals"] as const) {
    test(`an error in ${fails} reaches the error boundary, not onError`, () => {
      const { errors, realm, $source, $value } = failing(fails);
      function View(): ReactNode {
        return <p>{useValue($value)}</p>;
      }
      const view = quietly(() => {
        const view = mount(
          <Boundary>
            <View />
          </Boundary>,
        );
        act(() => {
          Realm.update(realm, (_read, write) => {
            write($source, 1);
          });
        });
        return view;
      });
      expect(view.textContent).toBe("failed");
      expect(errors).toEqual([]);
    });
  }

  test("through useValues", () => {
    const { errors, realm, $source, $value } = failing("compute");
    function View(): ReactNode {
      const [value] = useValues([$value]);
      return <p>{value}</p>;
    }
    const view = quietly(() => {
      const view = mount(
        <Boundary>
          <View />
        </Boundary>,
      );
      act(() => {
        Realm.update(realm, (_read, write) => {
          write($source, 1);
        });
      });
      return view;
    });
    expect(view.textContent).toBe("failed");
    expect(errors).toEqual([]);
  });
});

describe("useRealm", () => {
  test("returns the provided realm", () => {
    const realm = Realm.make();
    let seen: unknown;
    function Reader() {
      seen = useRealm();
      return null;
    }
    mount(
      <RealmProvider realm={realm}>
        <Reader />
      </RealmProvider>,
    );
    expect(seen).toBe(realm);
  });

  test("throws without a RealmProvider", () => {
    function Reader() {
      useRealm();
      return null;
    }
    quietly(() => expect(() => mount(<Reader />)).toThrow("RealmProvider"));
  });
});

describe("useValues", () => {
  test("resubscribes when a source is replaced in the same input array", () => {
    const realm = Realm.make();
    const $first = Box.schema(realm, Schema.Number, 1);
    const $second = Box.schema(realm, Schema.Number, 2);
    const input = [$first];
    const seen: Array<ReadonlyArray<number>> = [];
    function Values() {
      const values = useValues(input);
      seen.push(values);
      return <p>{values.join(",")}</p>;
    }
    const view = mount(<Values />);
    expect(view.textContent).toBe("1");
    expect([observers($first), observers($second)]).toEqual([1, 0]);
    act(() => root?.render(<Values />));
    expect(seen.at(-1)).toBe(seen[0]);

    input[0] = $second;
    act(() => root?.render(<Values />));
    expect(view.textContent).toBe("2");
    expect([observers($first), observers($second)]).toEqual([0, 1]);
    act(() => Realm.update(realm, (_read, write) => write($second, 3)));
    expect(view.textContent).toBe("3");
    expect(seen[0]).toEqual([1]);

    input.length = 0;
    act(() => root?.render(<Values />));
    expect(view.textContent).toBe("");
    expect(seen.at(-1)).toEqual([]);
    expect([observers($first), observers($second)]).toEqual([0, 0]);
  });

  test("drops cached values when the same input array is truncated", () => {
    const realm = Realm.make();
    const $value = Box.schema(realm, Schema.Number, 1);
    const input = [$value];
    function Values() {
      return <p>{useValues(input).join(",")}</p>;
    }
    const view = mount(<Values />);
    input.length = 0;
    act(() => root?.render(<Values />));
    expect(view.textContent).toBe("");
    expect(observers($value)).toBe(0);
  });

  test("checks realms when a source is replaced in the same input array", () => {
    const portfolio = loaded(1);
    const other = loaded(1);
    const input = [portfolio.$currency, portfolio.$currency];
    function Mixed() {
      useValues(input);
      return null;
    }
    mount(<Mixed />);
    input[1] = other.$currency;
    quietly(() =>
      expect(() => act(() => root?.render(<Mixed />))).toThrow(
        "useValues takes observables of one realm",
      ),
    );
  });

  test("throws for observables of two realms", () => {
    const portfolio = loaded(1);
    const other = loaded(1);
    function Mixed() {
      useValues([portfolio.$currency, other.$currency]);
      return null;
    }
    quietly(() =>
      expect(() => mount(<Mixed />)).toThrow(
        expect.objectContaining({ _tag: "PinnaUsageError", code: "pinna-react/mixed-realms" }),
      ),
    );
  });

  test("useRealm without a RealmProvider throws the no-provider code", () => {
    function Orphan() {
      useRealm();
      return null;
    }
    quietly(() =>
      expect(() => mount(<Orphan />)).toThrow(
        expect.objectContaining({ _tag: "PinnaUsageError", code: "pinna-react/no-provider" }),
      ),
    );
  });

  test("returns each value and rerenders when one changes", () => {
    const portfolio = loaded(2);
    function Summary() {
      count("Summary");
      const [currency, label]: readonly ["USD" | "EUR", string] = useValues([
        portfolio.$currency,
        portfolio.$totalLabel,
      ]);
      return (
        <p>
          {currency}/{label}
        </p>
      );
    }
    const view = mount(<Summary />);
    expect(view.textContent).toBe("USD/30 USD");
    act(() =>
      Realm.update(portfolio.realm, (_read, write) => {
        write(portfolio.$currency, "EUR");
      }),
    );
    expect(Object.fromEntries(renders)).toEqual({ Summary: 1 });
    expect(view.textContent).toBe("EUR/30 EUR");
  });

  test("keeps the array's identity until an element changes", () => {
    const portfolio = loaded(2);
    const seen: Array<ReadonlyArray<unknown>> = [];
    function Summary({ tag }: { readonly tag: string }) {
      seen.push(useValues([portfolio.$currency, portfolio.$response]));
      return <p>{tag}</p>;
    }
    mount(<Summary tag="a" />);
    act(() => root?.render(<Summary tag="b" />));
    expect(seen.at(-1)).toBe(seen[0]);
    act(() =>
      Realm.update(portfolio.realm, (_read, write) => {
        write(portfolio.$currency, "EUR");
      }),
    );
    expect(seen.at(-1)).not.toBe(seen[0]);
  });

  test("a change past the first element reads every value", () => {
    const realm = Realm.make();
    const $first = Box.schema(realm, Schema.Number, 1);
    const $second = Box.schema(realm, Schema.Number, 2);
    const $third = Box.schema(realm, Schema.Number, 3);
    const seen: Array<ReadonlyArray<number>> = [];
    function Three() {
      seen.push(useValues([$first, $second, $third]));
      return null;
    }
    mount(<Three />);
    act(() =>
      Realm.update(realm, (_read, write) => {
        write($second, 20);
      }),
    );
    expect(seen.at(-1)).toEqual([1, 20, 3]);
    act(() =>
      Realm.update(realm, (_read, write) => {
        write($third, 30);
      }),
    );
    expect(seen.at(-1)).toEqual([1, 20, 30]);
    expect(seen[0]).toEqual([1, 2, 3]);
  });

  test("an empty array returns an empty array and subscribes to nothing", () => {
    let seen: ReadonlyArray<unknown> | undefined;
    function Nothing() {
      seen = useValues([]);
      return null;
    }
    mount(<Nothing />);
    expect(seen).toEqual([]);
  });
});

const observers = (box: Box<number>): number => Source.inspect(box).observers;

const never = new Promise<never>(() => {});

/** Suspends forever while `hang`, so a transition that sets it is never kept. */
function Hang({ hang }: { readonly hang: boolean }): ReactNode {
  if (hang) {
    throw never;
  }
  return null;
}

describe("an update render React throws away", () => {
  const forms = {
    useValue: ({ $x }: { readonly $x: Box<number> }) => useValue($x),
    useValues: ({ $x }: { readonly $x: Box<number> }) => useValues([$x])[0],
    useSelect: ({ $x }: { readonly $x: Box<number> }) => useSelect((read) => read($x) * 1),
  };
  for (const [form, read] of Object.entries(forms)) {
    test(`keeps the kept render's subscription, through ${form}`, () => {
      const realm = Realm.make();
      const $a = Box.schema(realm, Schema.Number, 1);
      const $b = Box.schema(realm, Schema.Number, 100);
      function Show({ $x }: { readonly $x: Box<number> }): ReactNode {
        count("Show");
        return <p>{read({ $x })}</p>;
      }
      const App = ({ $x, hang }: { readonly $x: Box<number>; readonly hang: boolean }) => (
        <RealmProvider realm={realm}>
          <Suspense fallback={<p>loading</p>}>
            <Show $x={$x} />
            <Hang hang={hang} />
          </Suspense>
        </RealmProvider>
      );
      const view = mount(<App $x={$a} hang={false} />);

      act(() => startTransition(() => root?.render(<App $x={$b} hang={true} />)));
      expect(view.textContent).toBe("1");
      expect(renders.get("Show")).toBe(1);
      expect([observers($a), observers($b)]).toEqual([1, 0]);
      renders.clear();

      act(() => {
        Realm.update(realm, (_read, write) => {
          write($b, 200);
        });
      });
      expect(renders.get("Show")).toBeUndefined();
      // React also retries the transition after this update, so only the
      // screen is checked.
      act(() => {
        Realm.update(realm, (_read, write) => {
          write($a, 2);
        });
      });
      expect(view.textContent).toBe("2");
    });
  }
});

describe("a write before the component subscribes", () => {
  const forms = {
    useValue: ({ $x }: { readonly $x: Box<number> }) => useValue($x),
    useValues: ({ $x }: { readonly $x: Box<number> }) => useValues([$x])[0],
    useSelect: ({ $x }: { readonly $x: Box<number> }) => useSelect((read) => read($x)),
  };
  for (const [form, read] of Object.entries(forms)) {
    test(`a layout effect's write after the render shows, through ${form}`, () => {
      const realm = Realm.make();
      const $a = Box.schema(realm, Schema.Number, 1);
      function Show(): ReactNode {
        return <p>{read({ $x: $a })}</p>;
      }
      function Write(): null {
        useLayoutEffect(() => {
          Realm.update(realm, (_read, write) => {
            write($a, 2);
          });
        }, []);
        return null;
      }
      const view = mount(
        <RealmProvider realm={realm}>
          <Show />
          <Write />
        </RealmProvider>,
      );
      expect(view.textContent).toBe("2");
      act(() => {
        Realm.update(realm, (_read, write) => {
          write($a, 3);
        });
      });
      expect(view.textContent).toBe("3");
    });

    test(`a hook that loads when the component subscribes shows, through ${form}`, () => {
      const realm = Realm.make();
      const $a = Box.schema(realm, Schema.Number, 1);
      Source.onObserved($a, () => {
        Realm.update(realm, (_read, write) => {
          write($a, 2);
        });
        return undefined;
      });
      function Show(): ReactNode {
        return <p>{read({ $x: $a })}</p>;
      }
      const view = mount(
        <RealmProvider realm={realm}>
          <Show />
        </RealmProvider>,
      );
      expect(view.textContent).toBe("2");
      expect(observers($a)).toBe(1);
    });
  }
});

describe("switching what a mounted component reads", () => {
  test("another observable in the same realm: the component follows the new one only", () => {
    const realm = Realm.make();
    const $a = Box.schema(realm, Schema.Number, 1);
    const $b = Box.schema(realm, Schema.Number, 100);
    function Show({ $x }: { readonly $x: Box<number> }): ReactNode {
      count("Show");
      return <p>{useValue($x)}</p>;
    }
    const view = mount(<Show $x={$a} />);
    act(() => root?.render(<Show $x={$b} />));
    expect(view.textContent).toBe("100");
    expect([observers($a), observers($b)]).toEqual([0, 1]);
    renders.clear();

    act(() => {
      Realm.update(realm, (_read, write) => {
        write($a, 2);
      });
    });
    expect(renders.get("Show")).toBeUndefined();
    act(() => {
      Realm.update(realm, (_read, write) => {
        write($b, 200);
      });
    });
    expect(view.textContent).toBe("200");
  });

  test("a write between a render and its layout effect keeps the new select's sources", () => {
    // The child's layout effect writes what the old select read, so the
    // reaction tracks the old select again before the render is kept; the
    // kept render still wins.
    const realm = Realm.make();
    const $a = Box.schema(realm, Schema.Number, 1);
    const $b = Box.schema(realm, Schema.Number, 10);
    function Child({ useB }: { readonly useB: boolean }): ReactNode {
      useLayoutEffect(() => {
        if (useB) {
          Realm.update(realm, (read, write) => {
            write($a, read($a) + 1);
          });
        }
      }, [useB]);
      return null;
    }
    function Show({ useB }: { readonly useB: boolean }): ReactNode {
      const value = useSelect((read) => {
        if (useB) {
          return read($b);
        }
        read($a);
        return 0;
      });
      return (
        <p>
          {value}
          <Child useB={useB} />
        </p>
      );
    }
    const app = (useB: boolean): ReactNode => (
      <RealmProvider realm={realm}>
        <Show useB={useB} />
      </RealmProvider>
    );
    const view = mount(app(false));
    act(() => root?.render(app(true)));
    expect([observers($a), observers($b)]).toEqual([0, 1]);
    act(() => {
      Realm.update(realm, (_read, write) => {
        write($b, 11);
      });
    });
    expect(view.textContent).toBe("11");
  });

  test("useValues over an array that grows and shrinks", () => {
    const realm = Realm.make();
    const $a = Box.schema(realm, Schema.Number, 1);
    const $b = Box.schema(realm, Schema.Number, 2);
    function Sum({ list }: { readonly list: ReadonlyArray<Box<number>> }): ReactNode {
      const values = useValues(list);
      return <p>{values.join(",")}</p>;
    }
    const view = mount(<Sum list={[]} />);
    act(() => root?.render(<Sum list={[$a, $b]} />));
    expect(view.textContent).toBe("1,2");
    act(() => {
      Realm.update(realm, (_read, write) => {
        write($b, 3);
      });
    });
    expect(view.textContent).toBe("1,3");

    act(() => root?.render(<Sum list={[$a]} />));
    expect(view.textContent).toBe("1");
    expect([observers($a), observers($b)]).toEqual([1, 0]);
    act(() => root?.render(<Sum list={[]} />));
    expect(view.textContent).toBe("");
    expect([observers($a), observers($b)]).toEqual([0, 0]);
  });
});

test("a component remounted after its error boundary resets follows its value", () => {
  const realm = Realm.make();
  const $source = Box.schema(realm, Schema.Number, 0);
  const $value = Computed.make(realm, (read) => {
    const value = read($source);
    if (value === 1) {
      throw new Error("compute");
    }
    return value;
  });
  function View(): ReactNode {
    return <p>{useValue($value)}</p>;
  }
  const view = quietly(() => {
    const view = mount(
      <Boundary key={0}>
        <View />
      </Boundary>,
    );
    act(() => {
      Realm.update(realm, (_read, write) => {
        write($source, 1);
      });
    });
    return view;
  });
  expect(view.textContent).toBe("failed");
  expect(observers($source)).toBe(0);

  act(() => {
    Realm.update(realm, (_read, write) => {
      write($source, 2);
    });
  });
  act(() =>
    root?.render(
      <Boundary key={1}>
        <View />
      </Boundary>,
    ),
  );
  expect(view.textContent).toBe("2");
  act(() => {
    Realm.update(realm, (_read, write) => {
      write($source, 3);
    });
  });
  expect(view.textContent).toBe("3");
});

test("server rendering reads the values and observes nothing", () => {
  const realm = Realm.make();
  const $a = Box.schema(realm, Schema.Number, 1);
  const events: Array<string> = [];
  Source.onObserved($a, () => {
    events.push("start");
    return () => events.push("stop");
  });
  function View(): ReactNode {
    const one = useValue($a);
    const two = useSelect((read) => read($a) + 1);
    const [three] = useValues([$a]);
    return (
      <p>
        {one} {two} {three}
      </p>
    );
  }
  const html = renderToString(
    <RealmProvider realm={realm}>
      <View />
    </RealmProvider>,
  );
  expect(html).toBe("<p>1<!-- --> <!-- -->2<!-- --> <!-- -->1</p>");
  expect(events).toEqual([]);
  expect(observers($a)).toBe(0);
});

describe("useSelect hands its function read", () => {
  test("a write that leaves the result equal rerenders nothing", () => {
    const realm = Realm.make();
    const $count = Box.schema(realm, Schema.Number, 1);
    function View(): ReactNode {
      count("View");
      return <p>{useSelect((read) => (read($count) > 0 ? "positive" : "not positive"))}</p>;
    }
    const element = mount(
      <RealmProvider realm={realm}>
        <View />
      </RealmProvider>,
    );
    act(() => Realm.update(realm, (_read, write) => write($count, 2)));
    expect(renders.get("View")).toBeUndefined();
    act(() => Realm.update(realm, (_read, write) => write($count, 0)));
    expect(renders.get("View")).toBe(1);
    expect(element.textContent).toBe("not positive");
  });
});
