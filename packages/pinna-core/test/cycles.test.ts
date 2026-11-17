import { describe, expect, test } from "bun:test";
import {
  type DerivedNode,
  dependenciesOf,
  Graph,
  observerCount,
  readCell,
  readDerived,
  writeCell,
} from "../src/graph.ts";
import { expectAtRest } from "./rest.ts";

const quiet = (): Graph => new Graph(() => {});

/**
 * `first` reads `second` while `wide` is on, and `second` always reads
 * `first`, so reading `first` with `wide` on meets a cycle inside `second`
 * before `second` has read anything else.
 */
const cycle = (graph: Graph) => {
  const wide = graph.cell(true);
  const values: { first?: DerivedNode<number>; second?: DerivedNode<number> } = {};
  const first = graph.derived(() =>
    readCell(wide) ? (values.second === undefined ? 0 : readDerived(values.second)) : 0,
  );
  const second = graph.derived(() => readDerived(first) + 1);
  values.first = first;
  values.second = second;
  return { wide, first, second };
};

describe("a value that meets a cycle before it reads anything else", () => {
  test("recovers once the cycle is gone", () => {
    const graph = quiet();
    const { wide, first, second } = cycle(graph);
    expect(() => readDerived(first)).toThrow(/cycle/);
    graph.batch(() => writeCell(wide, false));
    expect(readDerived(first)).toBe(0);
    expect(readDerived(second)).toBe(1);
    expectAtRest(graph);
  });

  test("recovers when it is read first after the cycle is gone", () => {
    const graph = quiet();
    const { wide, first, second } = cycle(graph);
    expect(() => readDerived(first)).toThrow(/cycle/);
    graph.batch(() => writeCell(wide, false));
    expect(readDerived(second)).toBe(1);
    expect(readDerived(first)).toBe(0);
    expectAtRest(graph);
  });

  test("a watch over it sees the recovery", () => {
    const graph = quiet();
    const { wide, first, second } = cycle(graph);
    expect(() => readDerived(first)).toThrow(/cycle/);
    const seen: Array<number | string> = [];
    const stop = graph.watch(() => {
      try {
        seen.push(readDerived(second));
      } catch {
        seen.push("cycle");
      }
    });
    graph.batch(() => writeCell(wide, false));
    expect(seen).toEqual(["cycle", 1]);
    stop();
    expect(observerCount(wide)).toBe(0);
    expectAtRest(graph);
  });

  test("a value read after the cycle keeps the cycle's error until it is gone", () => {
    const graph = quiet();
    const { wide, first, second } = cycle(graph);
    expect(() => readDerived(first)).toThrow(/cycle/);
    expect(() => readDerived(second)).toThrow(/cycle/);
    expect(dependenciesOf(second)).toEqual([first]);
    graph.batch(() => writeCell(wide, false));
    expect(readDerived(second)).toBe(1);
    expectAtRest(graph);
  });

  test("a cycle with no condition is kept by whichever value it began at", () => {
    const graph = quiet();
    const values: { first?: DerivedNode<number> } = {};
    const second = graph.derived(
      () => (values.first === undefined ? 0 : readDerived(values.first)) + 1,
    );
    const first = graph.derived(() => readDerived(second) + 1);
    values.first = first;
    expect(() => readDerived(second)).toThrow(/cycle/);
    expect(() => readDerived(first)).toThrow(/cycle/);
    expect(dependenciesOf(second)).toEqual([]);
    expect(dependenciesOf(first)).toEqual([second]);
    expect(() => readDerived(second)).toThrow(/cycle/);
    expectAtRest(graph);
  });
});

describe("a cycle whose condition is read by a value it passes through", () => {
  // `inner` reads `wide` before it closes the cycle; `outer`, where the cycle
  // begins, reads nothing before it.
  const build = (graph: Graph) => {
    const wide = graph.cell(true);
    const values: { outer?: DerivedNode<number> } = {};
    const inner = graph.derived(() =>
      readCell(wide) ? (values.outer === undefined ? 0 : readDerived(values.outer)) : 1,
    );
    const outer = graph.derived(() => readDerived(inner) + 1);
    values.outer = outer;
    return { wide, inner, outer };
  };

  test("the value it began at recovers once the cycle is gone", () => {
    const graph = quiet();
    const { wide, inner, outer } = build(graph);
    expect(() => readDerived(outer)).toThrow(/cycle/);
    graph.batch(() => writeCell(wide, false));
    expect(readDerived(outer)).toBe(2);
    expect(readDerived(inner)).toBe(1);
    expectAtRest(graph);
  });

  test("a watch over the value it began at sees the recovery", () => {
    const graph = quiet();
    const { wide, outer } = build(graph);
    const seen: Array<number | string> = [];
    const stop = graph.watch(() => {
      try {
        seen.push(readDerived(outer));
      } catch {
        seen.push("cycle");
      }
    });
    graph.batch(() => writeCell(wide, false));
    expect(seen).toEqual(["cycle", 2]);
    stop();
    expect(observerCount(wide)).toBe(0);
  });

  test("a value that catches the cycle recomputes once the cycle is gone", () => {
    const graph = quiet();
    const wide = graph.cell(true);
    const values: { outer?: DerivedNode<number> } = {};
    const closing = graph.derived(() =>
      readCell(wide) ? (values.outer === undefined ? 0 : readDerived(values.outer)) : 5,
    );
    const catching = graph.derived(() => {
      try {
        return readDerived(closing);
      } catch {
        return -1;
      }
    });
    const outer = graph.derived(() => readDerived(catching) + 1);
    values.outer = outer;
    expect(readDerived(outer)).toBe(0);
    graph.batch(() => writeCell(wide, false));
    expect(readDerived(catching)).toBe(5);
    expect(readDerived(outer)).toBe(6);
  });
});

describe("a cycle closed in an equals", () => {
  test("is kept by the value it began at, not the value whose equals closed it", () => {
    const graph = quiet();
    const source = graph.cell(0);
    const wide = graph.cell(false);
    let closes = false;
    const values: { outer?: DerivedNode<number> } = {};
    const inner = graph.derived(() => readCell(source), {
      equals: (left, right) => {
        if (closes && values.outer !== undefined) {
          readDerived(values.outer);
        }
        return left === right;
      },
    });
    const outer = graph.derived(() => (readCell(wide) ? readDerived(inner) : 0));
    values.outer = outer;
    expect(readDerived(inner)).toBe(0);
    expect(readDerived(outer)).toBe(0);
    graph.batch(() => {
      writeCell(wide, true);
      writeCell(source, 1);
    });
    closes = true;
    expect(() => readDerived(outer)).toThrow(/cycle/);
    closes = false;
    expect(readDerived(inner)).toBe(1);
    graph.batch(() => writeCell(wide, false));
    expect(readDerived(outer)).toBe(0);
    expectAtRest(graph);
  });
});

describe("a compute that catches a cycle", () => {
  /**
   * `catching` reads `leaf`, then `origin`, and catches the error; `origin`
   * reads `catching`. A watch on `origin` observes `leaf` through both.
   */
  const caught = (graph: Graph) => {
    const leaf = graph.cell(0);
    const hooks = { started: 0, ended: 0 };
    graph.onObserved(leaf, () => {
      hooks.started++;
      return () => {
        hooks.ended++;
      };
    });
    const values: { origin?: DerivedNode<number> } = {};
    const catching = graph.derived(() => {
      readCell(leaf);
      try {
        return values.origin === undefined ? 0 : readDerived(values.origin);
      } catch {
        return -1;
      }
    });
    const origin = graph.derived(() => readDerived(catching) + 1);
    values.origin = origin;
    return { leaf, hooks, catching, origin };
  };

  const expectReleased = (graph: Graph, { hooks, catching, origin }: ReturnType<typeof caught>) => {
    expect(hooks).toEqual({ started: 1, ended: 1 });
    expect(observerCount(origin)).toBe(0);
    expect(observerCount(catching)).toBe(0);
    expectAtRest(graph);
  };

  test("leaves no cycle of links once its watch stops", () => {
    const graph = quiet();
    const values = caught(graph);
    graph.watch(() => readDerived(values.origin))();
    expectReleased(graph, values);
  });

  test("leaves no cycle of links when each value is read on its own first", () => {
    const graph = quiet();
    const values = caught(graph);
    expect(readDerived(values.origin)).toBe(0);
    expect(readDerived(values.catching)).toBe(-1);
    graph.watch(() => readDerived(values.origin))();
    expectReleased(graph, values);
  });

  test("leaves no cycle of links when one watch reads both", () => {
    const graph = quiet();
    const values = caught(graph);
    graph.watch(() => [readDerived(values.origin), readDerived(values.catching)])();
    expectReleased(graph, values);
  });

  test("leaves no cycle of links when the catching value is read first", () => {
    const graph = quiet();
    const values = caught(graph);
    expect(readDerived(values.catching)).toBe(-1);
    expect(readDerived(values.origin)).toBe(0);
    graph.watch(() => [readDerived(values.catching), readDerived(values.origin)])();
    expectReleased(graph, values);
  });

  test("leaves no two values linked to each other, in either read order", () => {
    const graph = quiet();
    const { catching, origin } = caught(graph);
    const other = graph.cell(0);
    const read = (value: DerivedNode<number>): number | "cycle" => {
      try {
        return readDerived(value);
      } catch {
        return "cycle";
      }
    };
    const linkedBoth = () =>
      dependenciesOf(origin).includes(catching) && dependenciesOf(catching).includes(origin);
    expect([read(origin), read(catching)]).toEqual([0, -1]);
    expect(linkedBoth()).toBe(false);
    read(catching);
    read(origin);
    expect(linkedBoth()).toBe(false);
    writeCell(other, 1);
    expect([read(origin), read(catching)]).toEqual([0, -1]);
    expect(linkedBoth()).toBe(false);
  });

  test("leaves no cycle of links through a third value", () => {
    const graph = quiet();
    const leaf = graph.cell(0);
    let ended = 0;
    graph.onObserved(leaf, () => () => {
      ended++;
    });
    const values: { origin?: DerivedNode<number> } = {};
    const catching = graph.derived(() => {
      readCell(leaf);
      try {
        return values.origin === undefined ? 0 : readDerived(values.origin);
      } catch {
        return -1;
      }
    });
    const middle = graph.derived(() => readDerived(catching) + 1);
    const origin = graph.derived(() => readDerived(middle) + 1);
    values.origin = origin;
    graph.watch(() => readDerived(origin))();
    expect(readDerived(origin)).toBe(1);
    graph.watch(() => [readDerived(catching), readDerived(middle), readDerived(origin)])();
    expect(ended).toBe(2);
    expect([origin, middle, catching].map((value) => observerCount(value))).toEqual([0, 0, 0]);
    expectAtRest(graph);
  });

  test("leaves no cycle of links when two values catch the same cycle", () => {
    const graph = quiet();
    const leaf = graph.cell(0);
    let ended = 0;
    graph.onObserved(leaf, () => () => {
      ended++;
    });
    const values: { origin?: DerivedNode<number> } = {};
    const catchingOf = () =>
      graph.derived(() => {
        readCell(leaf);
        try {
          return values.origin === undefined ? 0 : readDerived(values.origin);
        } catch {
          return -1;
        }
      });
    const left = catchingOf();
    const right = catchingOf();
    const origin = graph.derived(() => readDerived(left) + readDerived(right));
    values.origin = origin;
    graph.watch(() => [readDerived(origin), readDerived(left), readDerived(right)])();
    expect(ended).toBe(1);
    expect([origin, left, right].map((value) => observerCount(value))).toEqual([0, 0, 0]);
    expectAtRest(graph);
  });

  test("leaves no cycle of links when it catches a second cycle it closes", () => {
    const graph = quiet();
    const leaf = graph.cell(0);
    let ended = 0;
    graph.onObserved(leaf, () => () => {
      ended++;
    });
    const values: { origin?: DerivedNode<number>; back?: DerivedNode<number> } = {};
    const catching = graph.derived(() => {
      readCell(leaf);
      let total = 0;
      try {
        total += values.origin === undefined ? 0 : readDerived(values.origin);
      } catch {
        total -= 1;
      }
      try {
        total += values.back === undefined ? 0 : readDerived(values.back);
      } catch {
        total -= 10;
      }
      return total;
    });
    const back = graph.derived(() => readDerived(catching) * 2);
    const origin = graph.derived(() => readDerived(catching) + 1);
    values.origin = origin;
    values.back = back;
    graph.watch(() => [readDerived(origin), readDerived(catching), readDerived(back)])();
    expect(ended).toBe(1);
    expect([origin, catching, back].map((value) => observerCount(value))).toEqual([0, 0, 0]);
    expectAtRest(graph);
  });

  test("recovers once the cycle is gone, under a watch", () => {
    const graph = quiet();
    const wide = graph.cell(true);
    const values: { origin?: DerivedNode<number> } = {};
    const catching = graph.derived(() => {
      if (!readCell(wide)) {
        return 7;
      }
      try {
        return values.origin === undefined ? 0 : readDerived(values.origin);
      } catch {
        return -1;
      }
    });
    const origin = graph.derived(() => readDerived(catching) + 1);
    values.origin = origin;
    const seen: number[] = [];
    const stop = graph.watch(
      () => readDerived(origin),
      (value) => seen.push(value),
    );
    graph.batch(() => writeCell(wide, false));
    expect(seen).toEqual([8]);
    stop();
    expect([origin, catching].map((value) => observerCount(value))).toEqual([0, 0]);
    expectAtRest(graph);
  });
});
