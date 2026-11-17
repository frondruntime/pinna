/**
 * Nothing Pinna is done with stays reachable. Each test repeats an
 * operation, holds what each round made only weakly, forces a full
 * collection, and counts what is left. Where a box stays alive, the test
 * also checks the box links no observer, so the failure names the link.
 *
 * A leak keeps at least one value per round, so the tests run at least
 * 100 rounds and allow up to `noise` values to stay. Some stay without a
 * leak: JavaScriptCore scans the stack conservatively, so stale slots root
 * recent watches, computed values, closures, and Effect's most recent
 * fiber, which holds its exit value. React also keeps its most recent
 * discarded render, with or without Pinna. Heap snapshots show each value
 * that stays rooted directly, through no realm, graph, or observer set; the
 * most measured was 16 values from 100 rounds.
 *
 * `bun run test` turns concurrent JIT off. A compile JavaScriptCore runs in
 * the background holds the values of the frame that started it until it is
 * installed, so a round that was hot then stays alive; a debugging heap
 * snapshot names the root `JITWorkList`. With it on, the stopped-watch test
 * kept 16 to 28 of its 200 values in a full run and failed a few runs in
 * thirty; with it off, it keeps none.
 */

import { describe, expect, test } from "bun:test";
import type { BoxCell } from "@frondruntime/pinna/internal";
import { observerCount } from "@frondruntime/pinna-core";
import {
  type Box,
  computed,
  createRealm,
  onObserved,
  schemaBox,
  untracked,
  update,
  watch,
} from "@frondruntime/pinna-effect";
import { Schema } from "effect";
import { act, Component, type ReactNode, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { RealmProvider, useSelect, useValue } from "../src/index.ts";
import { Portfolio, positionsJson } from "./model.ts";

/** Large enough that keeping one alive by mistake is cheap to notice. */
class Marker {
  readonly payload = new Array<number>(1024).fill(0);
}

const rounds = 100;

/** What stale stack slots may keep; a quarter of the one per round a leak keeps. */
const noise = rounds / 4;

const settle = async (): Promise<void> => {
  for (let round = 0; round < 4; round++) {
    await Bun.sleep(0);
    Bun.gc(true);
  }
};

/** Runs `round` the given number of times, each in its own frame, and weakly holds what it returns. */
const repeat = (count: number, round: () => ReadonlyArray<object>): Array<WeakRef<object>> => {
  const refs: Array<WeakRef<object>> = [];
  for (let index = 0; index < count; index++) {
    for (const made of round()) {
      refs.push(new WeakRef(made));
    }
  }
  return refs;
};

const kept = async (refs: ReadonlyArray<WeakRef<object>>): Promise<number> => {
  await settle();
  return refs.filter((ref) => ref.deref() !== undefined).length;
};

const observersOf = <Value,>(box: Box<Value>): number =>
  observerCount((box as BoxCell<Value>).source);

const quietly = <Result,>(run: () => Result): Result => {
  const original = console.error;
  console.error = () => {};
  try {
    return run();
  } finally {
    console.error = original;
  }
};

describe("the harness", () => {
  const held: Array<object> = [];

  test("counts every held marker and only noise of the dropped ones", async () => {
    const heldRefs = repeat(rounds, () => {
      const marker = new Marker();
      held.push(marker);
      return [marker];
    });
    const droppedRefs = repeat(rounds, () => [new Marker()]);
    expect(await kept(heldRefs)).toBe(rounds);
    expect(await kept(droppedRefs)).toBeLessThanOrEqual(noise);
  });
});

describe("the graph", () => {
  test("computed values read untracked are collected and link nothing", async () => {
    const realm = createRealm();
    const $count = schemaBox(realm, Schema.Number, 0);
    const refs = repeat(rounds, () => {
      const marker = new Marker();
      const $sum = computed(realm, (read) => read($count) + marker.payload.length);
      untracked(realm, (read) => read($sum));
      return [marker];
    });
    expect(observersOf($count)).toBe(0);
    expect(await kept(refs)).toBeLessThanOrEqual(noise);
  });

  test("stopped watches release their select, their effect, and the computed values they read", async () => {
    const realm = createRealm();
    const $count = schemaBox(realm, Schema.Number, 0);
    const refs = repeat(rounds, () => {
      const select = new Marker();
      const effect = new Marker();
      const $sum = computed(realm, (read) => read($count) + select.payload.length);
      const stop = watch(
        realm,
        (read) => read($sum),
        () => {
          effect.payload[0] = 1;
        },
      );
      update(realm, (read, write) => {
        write($count, read($count) + 1);
      });
      stop();
      return [select, effect];
    });
    expect(observersOf($count)).toBe(0);
    expect(await kept(refs)).toBeLessThanOrEqual(noise);
  });

  test("a run that reads many values holds none of them once a shorter run follows", async () => {
    const realm = createRealm();
    const $count = schemaBox(realm, Schema.Number, 0);
    const refs = repeat(1, () => {
      const markers = Array.from({ length: rounds }, () => new Marker());
      const sums = markers.map((marker) =>
        computed(realm, (read) => read($count) + marker.payload.length),
      );
      const stop = watch(
        realm,
        (read) => sums.reduce((total, $sum) => total + read($sum), 0),
        () => {},
      );
      stop();
      return markers;
    });
    const stop = watch(
      realm,
      (read) => read($count),
      () => {},
    );
    stop();
    expect(observersOf($count)).toBe(0);
    expect(await kept(refs)).toBeLessThanOrEqual(noise);
  });

  test("a watch stopped while another is due is not held by the watchers due", async () => {
    const realm = createRealm();
    const $count = schemaBox(realm, Schema.Number, 0);
    const refs = repeat(1, () => {
      const markers = Array.from({ length: rounds }, () => new Marker());
      const stopFirst = watch(
        realm,
        (read) => read($count),
        () => {},
      );
      const stopSecond = watch(
        realm,
        (read) => read($count) + markers.length,
        () => {},
      );
      update(realm, (_read, write) => {
        write($count, 1);
        stopFirst();
      });
      stopSecond();
      return markers;
    });
    expect(observersOf($count)).toBe(0);
    expect(await kept(refs)).toBeLessThanOrEqual(noise);
  });

  test("cleanups that ran are released while their hook stays", async () => {
    const realm = createRealm();
    const $count = schemaBox(realm, Schema.Number, 0);
    const refs: Array<WeakRef<object>> = [];
    onObserved($count, () => {
      const marker = new Marker();
      refs.push(new WeakRef(marker));
      return () => {
        marker.payload[0] = 1;
      };
    });
    for (let round = 0; round < rounds; round++) {
      watch(
        realm,
        (read) => read($count),
        () => {},
      )();
    }
    expect(refs).toHaveLength(rounds);
    expect(await kept(refs)).toBeLessThanOrEqual(noise);
  });

  test("removed onObserved hooks release their start and their cleanup", async () => {
    const realm = createRealm();
    const $count = schemaBox(realm, Schema.Number, 0);
    const stop = watch(
      realm,
      (read) => read($count),
      () => {},
    );
    const refs = repeat(rounds, () => {
      const start = new Marker();
      const cleanup = new Marker();
      onObserved($count, () => {
        start.payload[0] = 1;
        return () => {
          cleanup.payload[0] = 1;
        };
      })();
      return [start, cleanup];
    });
    expect(await kept(refs)).toBeLessThanOrEqual(noise);
    stop();
  });

  test("realms nothing holds are collected, with their watches and hooks still active", async () => {
    const refs = repeat(rounds, () => {
      const realm = createRealm();
      const $count = schemaBox(realm, Schema.Number, 0);
      onObserved($count, () => () => {});
      watch(
        realm,
        (read) => read($count),
        () => {},
      );
      return [realm];
    });
    expect(await kept(refs)).toBeLessThanOrEqual(noise);
  });
});

describe("updates", () => {
  test("finished updates keep no old value", async () => {
    const realm = createRealm();
    const $value = schemaBox(realm, Schema.Unknown, null);
    const refs = repeat(rounds, () => {
      const marker = new Marker();
      update(realm, (_read, write) => {
        write($value, marker);
      });
      update(realm, (_read, write) => {
        write($value, null);
      });
      return [marker];
    });
    expect(await kept(refs)).toBeLessThanOrEqual(noise);
  });

  test("rolled-back updates keep nothing they wrote", async () => {
    const realm = createRealm();
    const $value = schemaBox(realm, Schema.Unknown, null);
    const refs = repeat(rounds, () => {
      const marker = new Marker();
      expect(() =>
        update(realm, (_read, write) => {
          write($value, marker);
          throw new Error("rolled back");
        }),
      ).toThrow("rolled back");
      return [marker];
    });
    expect(untracked(realm, (read) => read($value))).toBeNull();
    expect(await kept(refs)).toBeLessThanOrEqual(noise);
  });

  test("an update that wrote many boxes keeps none of their old values", async () => {
    const realm = createRealm();
    const refs = (() => {
      const boxes: Array<Box<unknown>> = [];
      const made = repeat(rounds, () => {
        const marker = new Marker();
        boxes.push(schemaBox(realm, Schema.Unknown, marker));
        return [marker];
      });
      update(realm, (_read, write) => {
        for (const $box of boxes) {
          write($box, null);
        }
      });
      return made;
    })();
    expect(await kept(refs)).toBeLessThanOrEqual(noise);
    update(realm, () => undefined);
  });

  test("a rolled-back nested update keeps none of the old values it recorded", async () => {
    const realm = createRealm();
    const refs = (() => {
      const boxes: Array<Box<unknown>> = [];
      const made = repeat(rounds, () => {
        const marker = new Marker();
        boxes.push(schemaBox(realm, Schema.Unknown, marker));
        return [marker];
      });
      update(realm, () => {
        expect(() =>
          update(realm, (_read, write) => {
            for (const $box of boxes) {
              write($box, null);
            }
            throw new Error("rolled back");
          }),
        ).toThrow("rolled back");
      });
      return made;
    })();
    expect(await kept(refs)).toBeLessThanOrEqual(noise);
    update(realm, () => undefined);
  });

  test("draft updates keep neither the old value nor the draft", async () => {
    const realm = createRealm();
    const $items = schemaBox(realm, Schema.Array(Schema.Number), [0]);
    const refs = repeat(rounds, () => {
      const old = untracked(realm, (read) => read($items));
      update(realm, (_read, write) => {
        write.modify($items, (items) => {
          items.push(items.length);
        });
      });
      return [old];
    });
    expect(untracked(realm, (read) => read($items))).toHaveLength(rounds + 1);
    expect(await kept(refs)).toBeLessThanOrEqual(noise);
  });

  test("closed positions are collected while the portfolio is watched", async () => {
    const portfolio = new Portfolio(createRealm());
    const stop = watch(
      portfolio.realm,
      (read) => read(portfolio.$totalLabel),
      () => {},
    );
    const refs = repeat(rounds, () => {
      portfolio.load(positionsJson(3));
      const response = untracked(portfolio.realm, (read) => read(portfolio.$response));
      portfolio.close("p0");
      return [response, response.items[0] as object];
    });
    expect(await kept(refs)).toBeLessThanOrEqual(noise);
    stop();
  });
});

describe("React", () => {
  const realm = createRealm();
  const $shared = schemaBox(realm, Schema.Number, 0);
  const refs: Array<WeakRef<object>> = [];

  /** Reads `$shared` both ways, through a marker only this mount holds. */
  function Reader() {
    const [marker] = useState(() => {
      const made = new Marker();
      refs.push(new WeakRef(made));
      return made;
    });
    const one = useValue($shared);
    const both = useSelect((read) => read($shared) + marker.payload.length);
    return (
      <p>
        {one}/{both}
      </p>
    );
  }

  class Boundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
    override state = { failed: false };
    static getDerivedStateFromError(): { readonly failed: boolean } {
      return { failed: true };
    }
    override render(): ReactNode {
      return this.state.failed ? null : this.props.children;
    }
  }

  function Fails(): never {
    throw new Error("fails");
  }

  const cycle = (element: ReactNode): void => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(<RealmProvider realm={realm}>{element}</RealmProvider>));
    act(() =>
      update(realm, (read, write) => {
        write($shared, read($shared) + 1);
      }),
    );
    act(() => root.unmount());
  };

  test("1,000 mounts and unmounts leave no link and keep no marker", async () => {
    refs.length = 0;
    for (let round = 0; round < 1000; round++) {
      cycle(<Reader />);
    }
    expect(observersOf($shared)).toBe(0);
    expect(refs.length).toBeGreaterThanOrEqual(1000);
    expect(await kept(refs)).toBeLessThanOrEqual(noise);
  });

  test("Strict Mode mounts leave no link and keep no marker", async () => {
    refs.length = 0;
    for (let round = 0; round < 100; round++) {
      cycle(
        <StrictMode>
          <Reader />
        </StrictMode>,
      );
    }
    expect(observersOf($shared)).toBe(0);
    expect(await kept(refs)).toBeLessThanOrEqual(noise);
  });

  test("discarded renders leave no link and keep no marker", async () => {
    refs.length = 0;
    quietly(() => {
      for (let round = 0; round < 100; round++) {
        cycle(
          <Boundary>
            <Reader />
            <Fails />
          </Boundary>,
        );
      }
    });
    expect(refs.length).toBeGreaterThanOrEqual(100);
    expect(observersOf($shared)).toBe(0);
    expect(await kept(refs)).toBeLessThanOrEqual(noise);
  });

  test("switching a component to another realm unlinks the first", () => {
    const other = createRealm();
    const $other = schemaBox(other, Schema.Number, 0);
    function One({ $value }: { readonly $value: Box<number> }) {
      return <p>{useValue($value)}</p>;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(<One $value={$shared} />));
    expect(observersOf($shared)).toBe(1);
    act(() => root.render(<One $value={$other} />));
    expect(observersOf($shared)).toBe(0);
    expect(observersOf($other)).toBe(1);
    act(() => root.unmount());
    expect(observersOf($other)).toBe(0);
  });
});
