import { describe, expect, test } from "bun:test";
import {
  type DerivedNode,
  forgetValue,
  Graph,
  hasRun,
  observerCount,
  peekCell,
  peekDerived,
  Reaction,
  readAtom,
  readCell,
  readDerived,
  restoreCell,
  touchSource,
  writeCell,
} from "../src/graph.ts";
import { captureReports } from "./reports.ts";
import { expectAtRest } from "./rest.ts";

const graph = new Graph();

describe("consistency", () => {
  test("a diamond recomputes once and never shows a mixed value, without batch", () => {
    const a = graph.cell(1);
    const b = graph.derived(() => readCell(a) * 2);
    const c = graph.derived(() => readCell(a) * 3);
    const seen: Array<string> = [];
    const d = graph.derived(() => {
      const value = `${readDerived(b)}+${readDerived(c)}`;
      seen.push(value);
      return value;
    });
    const notified: Array<string> = [];
    const stop = graph.watch(
      () => readDerived(d),
      (value) => notified.push(value),
    );
    seen.length = 0;

    writeCell(a, 2);

    expect(seen).toEqual(["4+6"]);
    expect(notified).toEqual(["4+6"]);
    stop();
  });

  test("an unobserved derived reads a consistent value and caches it", () => {
    const a = graph.cell(1);
    let runs = 0;
    const b = graph.derived(() => {
      runs++;
      return readCell(a) + 1;
    });
    expect(readDerived(b)).toBe(2);
    expect(readDerived(b)).toBe(2);
    expect(runs).toBe(1);
    writeCell(a, 5);
    expect(readDerived(b)).toBe(6);
    expect(runs).toBe(2);
  });

  test("dependencies follow the branch the last run took", () => {
    const useLeft = graph.cell(true);
    const left = graph.cell("left");
    const right = graph.cell("right");
    let runs = 0;
    const picked = graph.derived(() => {
      runs++;
      return readCell(useLeft) ? readCell(left) : readCell(right);
    });
    const stop = graph.watch(() => readDerived(picked));
    runs = 0;
    writeCell(right, "right 2");
    expect(runs).toBe(0);
    writeCell(useLeft, false);
    expect(readDerived(picked)).toBe("right 2");
    writeCell(left, "left 2");
    expect(runs).toBe(1);
    stop();
  });

  test("a derived that reads itself throws", () => {
    const self: { readonly value: ReturnType<typeof graph.derived<number>> } = {
      value: graph.derived((): number => readDerived(self.value) + 1),
    };
    expect(() => readDerived(self.value)).toThrow(/cycle/);
    expectAtRest(graph);
  });
});

describe("equality cutoff", () => {
  test("dependents do not rerun when a derived value is unchanged", () => {
    const a = graph.cell(1);
    const parity = graph.derived(() => readCell(a) % 2);
    let runs = 0;
    const label = graph.derived(() => {
      runs++;
      return readDerived(parity) === 0 ? "even" : "odd";
    });
    const notified: Array<string> = [];
    const stop = graph.watch(
      () => readDerived(label),
      (value) => notified.push(value),
    );
    runs = 0;
    writeCell(a, 3);
    expect(runs).toBe(0);
    expect(notified).toEqual([]);
    writeCell(a, 4);
    expect(runs).toBe(1);
    expect(notified).toEqual(["even"]);
    stop();
  });

  test("a custom equals decides the cutoff", () => {
    const point = graph.cell({ x: 1, y: 2 }, { equals: (left, right) => left.x === right.x });
    const notified: Array<number> = [];
    const stop = graph.watch(
      () => readCell(point).y,
      (y) => notified.push(y),
    );
    writeCell(point, { x: 1, y: 3 });
    expect(notified).toEqual([]);
    writeCell(point, { x: 2, y: 4 });
    expect(notified).toEqual([4]);
    stop();
  });
});

describe("batch", () => {
  test("coalesces notifications to one, with the final values", () => {
    const first = graph.cell("Ada");
    const last = graph.cell("Lovelace");
    const notified: Array<string> = [];
    const stop = graph.watch(
      () => `${readCell(first)} ${readCell(last)}`,
      (value) => notified.push(value),
    );
    graph.batch(() => {
      writeCell(first, "Grace");
      writeCell(last, "Hopper");
    });
    expect(notified).toEqual(["Grace Hopper"]);
    stop();
  });

  test("a read inside a batch sees the latest write", () => {
    const a = graph.cell(1);
    const doubled = graph.derived(() => readCell(a) * 2);
    let inside = 0;
    graph.batch(() => {
      writeCell(a, 10);
      inside = readDerived(doubled);
    });
    expect(inside).toBe(20);
  });

  test("a write from a watch effect runs after the current flush", () => {
    const source = graph.cell(1);
    const mirror = graph.cell(0);
    const notified: Array<number> = [];
    const stopCopy = graph.watch(
      () => readCell(source),
      (value) => writeCell(mirror, value * 10),
    );
    const stopLog = graph.watch(
      () => readCell(mirror),
      (value) => notified.push(value),
    );
    writeCell(source, 2);
    expect(readCell(mirror)).toBe(20);
    expect(notified).toEqual([20]);
    stopCopy();
    stopLog();
  });
});

describe("watch", () => {
  test("without an effect, the tracked function is the side effect", () => {
    const a = graph.cell(1);
    const seen: Array<number> = [];
    const stop = graph.watch(() => {
      seen.push(readCell(a));
    });
    writeCell(a, 2);
    stop();
    writeCell(a, 3);
    expect(seen).toEqual([1, 2]);
  });

  test("untracked reads do not subscribe", () => {
    const tracked = graph.cell(1);
    const ignored = graph.cell(1);
    let runs = 0;
    const stop = graph.watch(() => {
      runs++;
      readCell(tracked);
      graph.untracked(() => readCell(ignored));
    });
    writeCell(ignored, 2);
    expect(runs).toBe(1);
    writeCell(tracked, 2);
    expect(runs).toBe(2);
    stop();
  });

  test("a watcher stopped while due leaves the others due, in order", () => {
    const a = graph.cell(0);
    const seen: Array<string> = [];
    const stops = ["first", "second", "third", "fourth"].map((name) =>
      graph.watch(
        () => readCell(a),
        () => {
          seen.push(name);
        },
      ),
    );
    graph.batch(() => {
      writeCell(a, 1);
      stops[1]?.();
    });
    expect(seen).toEqual(["first", "third", "fourth"]);
    seen.length = 0;
    writeCell(a, 2);
    expect(seen).toEqual(["first", "third", "fourth"]);
    for (const stop of stops) {
      stop();
    }
  });

  // A first run's edges link only once it ends, so no mark reaches a write
  // it makes to what it read: the run itself schedules the watch again.
  test("a run that writes what it read runs again, on its first run too", () => {
    const own = new Graph();
    const a = own.cell(0);
    const seen: Array<number> = [];
    const stop = own.watch(() => {
      const value = readCell(a);
      seen.push(value);
      if (value < 3) {
        writeCell(a, value + 1);
      }
    });
    expect(seen).toEqual([0, 1, 2, 3]);
    writeCell(a, 1);
    expect(seen).toEqual([0, 1, 2, 3, 1, 2, 3]);
    stop();
    expectAtRest(own);
  });

  test("a run that writes what it reads only after the write does not run again", () => {
    const own = new Graph();
    const a = own.cell(0);
    const other = own.cell(0);
    let runs = 0;
    const stop = own.watch(() => {
      runs++;
      writeCell(other, runs);
      writeCell(a, 5);
      readCell(a);
    });
    expect(runs).toBe(1);
    stop();
    expectAtRest(own);
  });

  test("a run that always changes what it read stops at the round limit", () => {
    const own = new Graph();
    const a = own.cell(0);
    let runs = 0;
    const reports = captureReports(() => {
      own.watch(() => {
        runs++;
        writeCell(a, readCell(a) + 1);
      });
    });
    expect(reports.map((error) => (error as Error).message)).toEqual([
      "pinna: watchers did not settle after 100 rounds",
    ]);
    expect(runs).toBe(101);
    expectAtRest(own);
  });
});

describe("onObserved", () => {
  test("starts on the first observer and cleans up after the last, through a derived chain", () => {
    const source = graph.cell(0);
    const events: Array<string> = [];
    graph.onObserved(source, () => {
      events.push("start");
      return () => events.push("stop");
    });
    const doubled = graph.derived(() => readCell(source) * 2);
    const quadrupled = graph.derived(() => readDerived(doubled) * 2);

    expect(readDerived(quadrupled)).toBe(0);
    expect(events).toEqual([]);

    const stopFirst = graph.watch(() => readDerived(quadrupled));
    const stopSecond = graph.watch(() => readDerived(doubled));
    expect(events).toEqual(["start"]);

    stopFirst();
    expect(events).toEqual(["start"]);
    stopSecond();
    expect(events).toEqual(["start", "stop"]);
  });

  test("does not flap when a derived swaps away and back within one run", () => {
    const source = graph.cell(0);
    const toggle = graph.cell(false);
    const events: Array<string> = [];
    graph.onObserved(source, () => {
      events.push("start");
      return () => events.push("stop");
    });
    const stop = graph.watch(() => {
      readCell(toggle);
      readCell(source);
    });
    writeCell(toggle, true);
    expect(events).toEqual(["start"]);
    stop();
    expect(events).toEqual(["start", "stop"]);
  });

  test("a watcher that stops reading a source releases it", () => {
    const source = graph.cell(0);
    const reading = graph.cell(true);
    const events: Array<string> = [];
    graph.onObserved(source, () => {
      events.push("start");
      return () => events.push("stop");
    });
    const stop = graph.watch(() => (readCell(reading) ? readCell(source) : -1));
    writeCell(reading, false);
    expect(events).toEqual(["start", "stop"]);
    stop();
  });

  test("a source read again after a nested run starts its hook once", () => {
    const source = graph.cell(0);
    const events: Array<string> = [];
    graph.onObserved(source, () => {
      events.push("start");
      return () => events.push("stop");
    });
    const outer = new Reaction(graph, () => {});
    const inner = new Reaction(graph, () => {});
    outer.track(() => {
      readCell(source);
      inner.track(() => readCell(source));
      readCell(source);
    });

    expect(outer.activate()).toBe(false);
    expect(events).toEqual(["start"]);
    outer.deactivate();
    expect(events).toEqual(["start", "stop"]);
  });

  for (const failing of [false, true]) {
    test(`a hook that drops the last observer${failing ? " and throws" : ""} stops the next hook from starting`, () => {
      const reports: Array<unknown> = [];
      const local = new Graph((error) => reports.push(error));
      const cell = local.cell(0);
      const live = new Set<string>();
      const reaction = new Reaction(local, () => {});
      reaction.track(() => readCell(cell));
      local.onObserved(cell, () => {
        live.add("first");
        reaction.deactivate();
        if (failing) {
          throw new Error("the first start fails");
        }
        return () => live.delete("first");
      });
      local.onObserved(cell, () => {
        live.add("second");
        return () => live.delete("second");
      });

      expect(reaction.activate()).toBe(false);
      expect(reports).toEqual(failing ? [new Error("the first start fails")] : []);
      expect(observerCount(cell)).toBe(0);
      expect(live.has("second")).toBe(false);
    });
  }

  test("a reporter that drops the last observer stops the next hook from starting", () => {
    let onReport = (): void => {};
    const local = new Graph(() => onReport());
    const cell = local.cell(0);
    const live = new Set<string>();
    const reaction = new Reaction(local, () => {});
    reaction.track(() => readCell(cell));
    onReport = () => reaction.deactivate();
    for (const name of ["first", "second"]) {
      local.onObserved(cell, () => {
        throw new Error(`the ${name} start fails`);
      });
    }
    local.onObserved(cell, () => {
      live.add("third");
      return () => live.delete("third");
    });

    expect(reaction.activate()).toBe(false);
    expect(observerCount(cell)).toBe(0);
    expect(live.has("third")).toBe(false);
    expectAtRest(local);
  });

  test("a reporter that observes again leaves the next hook started", () => {
    let onReport = (): void => {};
    const local = new Graph(() => onReport());
    const cell = local.cell(0);
    const live = new Set<string>();
    const reaction = new Reaction(local, () => {});
    reaction.track(() => readCell(cell));
    const other = new Reaction(local, () => {});
    other.track(() => readCell(cell));
    for (const name of ["first", "second"]) {
      local.onObserved(cell, () => {
        live.add(name);
        return () => {
          live.delete(name);
          throw new Error(`the ${name} cleanup fails`);
        };
      });
    }
    local.onObserved(cell, () => {
      live.add("third");
      return () => live.delete("third");
    });
    reaction.activate();
    onReport = () => {
      onReport = () => {};
      other.activate();
    };

    reaction.deactivate();
    expect(observerCount(cell)).toBe(1);
    expect([...live].sort()).toEqual(["first", "second", "third"]);
    expectAtRest(local);
  });
});

describe("reentry", () => {
  test("a watch reruns when a hook writes a source it read but has not linked yet", () => {
    const local = new Graph(() => {});
    const first = local.cell(0);
    const second = local.cell(0);
    local.onObserved(first, () => {
      writeCell(second, 1);
      return undefined;
    });
    const seen: Array<number> = [];
    const stop = local.watch(() => {
      const value = readCell(first) + readCell(second);
      seen.push(value);
      return value;
    });
    expect(seen).toEqual([0, 1]);
    stop();
  });

  test("a watch reruns when a hook touches an atom it read but has not linked yet", () => {
    const local = new Graph(() => {});
    const first = local.cell(0);
    const atom = local.atom();
    let external = 0;
    local.onObserved(first, () => {
      external = 1;
      touchSource(atom);
      return undefined;
    });
    const seen: Array<number> = [];
    const stop = local.watch(() => {
      readCell(first);
      readAtom(atom);
      seen.push(external);
      return external;
    });
    expect(seen).toEqual([0, 1]);
    stop();
  });

  test("a watch reruns when a hook writes what a later computed value read", () => {
    const local = new Graph(() => {});
    const first = local.cell(0);
    const second = local.cell(0);
    const tenfold = local.derived(() => readCell(second) * 10);
    local.onObserved(first, () => {
      writeCell(second, 1);
      return undefined;
    });
    const seen: Array<number> = [];
    const stop = local.watch(() => {
      const value = readCell(first) + readDerived(tenfold);
      seen.push(value);
      return value;
    });
    expect(seen).toEqual([0, 10]);
    stop();
  });

  test("a cleanup that activates the reaction being deactivated keeps every link", () => {
    const local = new Graph(() => {});
    const first = local.cell(0);
    const second = local.cell(0);
    let changes = 0;
    const reaction = new Reaction(local, () => {
      changes++;
    });
    reaction.track(() => readCell(first) + readCell(second));
    let again = false;
    local.onObserved(first, () => () => {
      if (!again) {
        again = true;
        reaction.activate();
      }
    });
    reaction.activate();

    reaction.deactivate();
    expect(observerCount(first)).toBe(1);
    expect(observerCount(second)).toBe(1);
    writeCell(second, 1);
    expect(changes).toBe(1);
    reaction.deactivate();
  });
});

describe("reentry, with errors", () => {
  test("a watch whose first run throws starts no hook and does not run again", () => {
    const local = new Graph();
    const source = local.cell(0);
    // The watch is unlinked before the settle, so this hook never begins.
    const log: Array<string> = [];
    local.onObserved(source, () => {
      log.push("start");
      writeCell(source, peekCell(source) + 1);
      return () => {
        log.push("stop");
      };
    });
    let runs = 0;
    expect(() =>
      local.watch(() => {
        runs++;
        readCell(source);
        throw new Error("the first run fails");
      }),
    ).toThrow("the first run fails");
    expect(runs).toBe(1);
    expect(log).toEqual([]);
    expect(observerCount(source)).toBe(0);
    expectAtRest(local);
  });

  test("a reaction whose source hook throws on activate still links the rest", () => {
    const reports: Array<unknown> = [];
    const local = new Graph((error) => {
      reports.push(error);
    });
    const cells = [local.cell(0), local.cell(0), local.cell(0)] as const;
    for (const cell of [cells[0], cells[1]]) {
      local.onObserved(cell, () => {
        throw new Error(cell === cells[0] ? "the first hook fails" : "the second hook fails");
      });
    }
    let changes = 0;
    const reaction = new Reaction(local, () => {
      changes++;
    });
    reaction.track(() => readCell(cells[0]) + readCell(cells[1]) + readCell(cells[2]));

    expect(reaction.activate()).toBe(false);
    expect(reports).toEqual([
      new Error("the first hook fails"),
      new Error("the second hook fails"),
    ]);
    expect(cells.map((cell) => observerCount(cell))).toEqual([1, 1, 1]);
    writeCell(cells[2], 1);
    expect(changes).toBe(1);
    reaction.deactivate();
    expectAtRest(local);
  });

  for (const throws of [false, true]) {
    test(`a source hook that deactivates the activating reaction leaves nothing linked${throws ? ", when it throws" : ""}`, () => {
      const reports: Array<unknown> = [];
      const local = new Graph((error) => reports.push(error));
      const cells = [local.cell(0), local.cell(0), local.cell(0)] as const;
      const reaction = new Reaction(local, () => {});
      reaction.track(() => readCell(cells[0]) + readCell(cells[1]) + readCell(cells[2]));
      local.onObserved(cells[1], () => {
        reaction.deactivate();
        if (throws) {
          throw new Error("the middle hook fails");
        }
        return undefined;
      });
      let running = 0;
      local.onObserved(cells[2], () => {
        running++;
        return () => {
          running--;
        };
      });

      expect(reaction.activate()).toBe(false);
      expect(reports).toEqual(throws ? [new Error("the middle hook fails")] : []);
      expect(cells.map((cell) => observerCount(cell))).toEqual([0, 0, 0]);
      expect(running).toBe(0);
    });
  }

  // Ruling 28: hooks settle by comparing once every link is done, so a hook
  // that deactivates the reaction leaves the later sources' hooks never
  // started, and their cleanups never run.
  test("a hook that deactivates the reaction its activate settles leaves the later hooks never started", () => {
    const local = new Graph(() => {});
    const cells = [local.cell(0), local.cell(0), local.cell(0), local.cell(0)] as const;
    let changes = 0;
    const reaction = new Reaction(local, () => {
      changes++;
    });
    reaction.track(() => cells.reduce((total, cell) => total + readCell(cell), 0));
    let deactivated = false;
    local.onObserved(cells[1], () => {
      if (!deactivated) {
        deactivated = true;
        reaction.deactivate();
      }
      return undefined;
    });
    let activated = false;
    local.onObserved(cells[2], () => () => {
      if (!activated) {
        activated = true;
        reaction.activate();
      }
    });

    reaction.activate();
    expect(activated).toBe(false);
    expect(cells.map((cell) => observerCount(cell))).toEqual([0, 0, 0, 0]);
    writeCell(cells[3], 1);
    expect(changes).toBe(0);
  });

  // Ruling 28, as above, for a computed value a hook releases.
  test("a hook that releases the computed value its link settles leaves the later hooks never started", () => {
    const local = new Graph(() => {});
    const cells = [local.cell(0), local.cell(0), local.cell(0), local.cell(0)] as const;
    const sum = local.derived(() => cells.reduce((total, cell) => total + readCell(cell), 0));
    const first = new Reaction(local, () => {});
    first.track(() => readDerived(sum));
    let changes = 0;
    const second = new Reaction(local, () => {
      changes++;
    });
    second.track(() => readDerived(sum));
    local.onObserved(cells[1], () => {
      first.deactivate();
      return undefined;
    });
    let observed = false;
    local.onObserved(cells[2], () => () => {
      if (!observed) {
        observed = true;
        second.activate();
      }
    });

    first.activate();
    expect(observed).toBe(false);
    expect(observerCount(sum)).toBe(0);
    expect(cells.map((cell) => observerCount(cell))).toEqual([0, 0, 0, 0]);
    writeCell(cells[3], 1);
    expect(changes).toBe(0);
  });

  for (const throws of [false, true]) {
    test(`a source hook that releases the computed value's only observer leaves nothing linked${throws ? ", when it throws" : ""}`, () => {
      const reports: Array<unknown> = [];
      const local = new Graph((error) => reports.push(error));
      const cells = [local.cell(0), local.cell(0), local.cell(0)] as const;
      const sum = local.derived(() => readCell(cells[0]) + readCell(cells[1]) + readCell(cells[2]));
      const reaction = new Reaction(local, () => {});
      reaction.track(() => readDerived(sum));
      local.onObserved(cells[1], () => {
        reaction.deactivate();
        if (throws) {
          throw new Error("the middle hook fails");
        }
        return undefined;
      });
      let running = 0;
      for (const source of [cells[2], sum]) {
        local.onObserved(source, () => {
          running++;
          return () => {
            running--;
          };
        });
      }

      expect(reaction.activate()).toBe(false);
      expect(reports).toEqual(throws ? [new Error("the middle hook fails")] : []);
      expect(observerCount(sum)).toBe(0);
      expect(cells.map((cell) => observerCount(cell))).toEqual([0, 0, 0]);
      expect(running).toBe(0);
    });
  }

  test("a computed value whose source hook throws on its first link still links the rest", () => {
    const reports: Array<unknown> = [];
    const local = new Graph((error) => {
      reports.push(error);
    });
    const cells = [local.cell(0), local.cell(0), local.cell(0)] as const;
    const sum = local.derived(() => readCell(cells[0]) + readCell(cells[1]) + readCell(cells[2]));
    local.onObserved(cells[1], () => {
      throw new Error("the middle hook fails");
    });
    let sumHooks = 0;
    local.onObserved(sum, () => {
      sumHooks++;
      return undefined;
    });
    let changes = 0;
    const reaction = new Reaction(local, () => {
      changes++;
    });
    reaction.track(() => readDerived(sum));

    expect(reaction.activate()).toBe(false);
    expect(reports).toEqual([new Error("the middle hook fails")]);
    expect(cells.map((cell) => observerCount(cell))).toEqual([1, 1, 1]);
    expect(sumHooks).toBe(1);
    writeCell(cells[2], 1);
    expect(changes).toBe(1);
    reaction.deactivate();
    expectAtRest(local);
  });

  // Ruling 28: the cleanup's activate relinks every source before the settle
  // goes on, so a source lost and gained in that settle fires nothing.
  test("a cleanup that reactivates the reaction its deactivate settles reports its error and restarts no other hook", () => {
    const reports: Array<unknown> = [];
    const local = new Graph((error) => reports.push(error));
    const cells = [local.cell(0), local.cell(0), local.cell(0)] as const;
    const reaction = new Reaction(local, () => {});
    reaction.track(() => readCell(cells[0]) + readCell(cells[1]) + readCell(cells[2]));
    let again = false;
    local.onObserved(cells[0], () => () => {
      if (!again) {
        again = true;
        reaction.activate();
        throw new Error("the unlink fails");
      }
    });
    let starts = 0;
    local.onObserved(cells[1], () => {
      starts++;
      if (starts === 2) {
        throw new Error("the relink fails");
      }
      return undefined;
    });
    reaction.activate();

    reaction.deactivate();
    expect(reports).toEqual([new Error("the unlink fails")]);
    expect(starts).toBe(1);
    expect(cells.map((cell) => observerCount(cell))).toEqual([1, 1, 1]);
    reaction.deactivate();
    expectAtRest(local);
  });
});

describe("errors", () => {
  test("a thrown error is cached until what the run read changes", () => {
    const divisor = graph.cell(0);
    let runs = 0;
    const ratio = graph.derived(() => {
      runs++;
      if (readCell(divisor) === 0) {
        throw new Error("divide by zero");
      }
      return 10 / readCell(divisor);
    });
    expect(() => readDerived(ratio)).toThrow("divide by zero");
    expect(() => readDerived(ratio)).toThrow("divide by zero");
    expect(runs).toBe(1);
    writeCell(divisor, 2);
    expect(readDerived(ratio)).toBe(5);
    expectAtRest(graph);
  });

  test("an observed derived follows the sources its throwing run read", () => {
    const mode = graph.cell("constant");
    const divisor = graph.cell(0);
    const ratio = graph.derived(() => {
      if (readCell(mode) === "constant") {
        return 1;
      }
      const value = readCell(divisor);
      if (value === 0) {
        throw new Error("divide by zero");
      }
      return 10 / value;
    });
    const shown = graph.derived(() => {
      try {
        return String(readDerived(ratio));
      } catch {
        return "error";
      }
    });
    const seen: Array<string> = [];
    const stop = graph.watch(
      () => readDerived(shown),
      (value) => seen.push(value),
    );
    writeCell(mode, "divide");
    writeCell(divisor, 5);
    expect(seen).toEqual(["error", "2"]);
    stop();
    expectAtRest(graph);
  });
});

describe("watcher errors", () => {
  test("a throwing watcher does not fail the write; it is reported and the rest still run", () => {
    const count = graph.cell(0);
    const seen: Array<number> = [];
    const stopFailing = graph.watch(
      () => readCell(count),
      () => {
        throw new Error("watcher failed");
      },
    );
    const stopSeeing = graph.watch(
      () => readCell(count),
      (value) => seen.push(value),
    );
    const reports = captureReports(() => {
      expect(() => writeCell(count, 1)).not.toThrow();
    });
    expect(readCell(count)).toBe(1);
    expect(seen).toEqual([1]);
    expect(reports).toHaveLength(1);
    expect(String(reports[0])).toContain("watcher failed");
    stopFailing();
    stopSeeing();
    expectAtRest(graph);
  });

  test("watchers that never settle are stopped and reported, not thrown to the writer", () => {
    const count = graph.cell(0);
    const stop = graph.watch(
      () => readCell(count),
      (value) => writeCell(count, value + 1),
    );
    const reports = captureReports(() => {
      expect(() => writeCell(count, 1)).not.toThrow();
    });
    expect(reports).toHaveLength(1);
    expect(String(reports[0])).toContain("did not settle");
    stop();
    expectAtRest(graph);
  });

  test("watchers run in the order they were marked, and their writes run in the next round", () => {
    const first = graph.cell(0);
    const second = graph.cell(0);
    const order: Array<string> = [];
    const stops = [
      graph.watch(
        () => readCell(second),
        () => order.push("second"),
      ),
      graph.watch(
        () => readCell(first),
        (value) => {
          order.push("first");
          writeCell(second, value);
        },
      ),
      graph.watch(
        () => readCell(first),
        () => order.push("first again"),
      ),
    ];
    graph.batch(() => {
      writeCell(first, 1);
    });
    expect(order).toEqual(["first", "first again", "second"]);
    for (const stop of stops) {
      stop();
    }
  });

  test("a watcher behind a computed value runs again in the next round after an earlier watcher writes", () => {
    const count = graph.cell(0);
    const doubled = graph.derived(() => readCell(count) * 2);
    const order: Array<string> = [];
    const stops = [
      graph.watch(
        () => readCell(count),
        (value) => {
          order.push(`first sees ${value}`);
          if (value < 3) {
            writeCell(count, value + 1);
          }
        },
      ),
      graph.watch(
        () => readDerived(doubled),
        (value) => order.push(`second sees ${value}`),
      ),
    ];
    writeCell(count, 1);
    expect(order).toEqual([
      "first sees 1",
      "second sees 4",
      "first sees 2",
      "second sees 6",
      "first sees 3",
    ]);
    for (const stop of stops) {
      stop();
    }
  });
});

describe("observer links", () => {
  test("a nested read after reordering does not reuse a stale duplicate edge", () => {
    const local = new Graph();
    const left = local.cell(1);
    const right = local.cell(2);
    const reversed = local.cell(false);
    const derived = local.derived(() => readCell(right));
    const aggregate = local.derived(() => {
      if (readCell(reversed)) {
        readCell(right);
        readCell(left);
      } else {
        readCell(left);
        readCell(right);
      }
      return readDerived(derived) + readCell(right);
    });
    const stop = local.watch(() => readDerived(aggregate));
    local.batch(() => {
      writeCell(right, 3);
      writeCell(reversed, true);
    });
    expect(readDerived(aggregate)).toBe(6);
    expect(observerCount(right)).toBe(2);
    stop();
    expect(observerCount(right)).toBe(0);
    expectAtRest(local);
  });

  test("a wide aggregate reads computed-then-source pairs once and releases dropped rows", () => {
    const local = new Graph();
    const rows = Array.from({ length: 8000 }, (_, index) => {
      const source = local.cell(index);
      return { source, derived: local.derived(() => 2 * readCell(source)) };
    });
    const count = local.cell(rows.length);
    const aggregate = local.derived(() => {
      let total = 0;
      for (let index = 0; index < readCell(count); index++) {
        const row = rows[index] as (typeof rows)[number];
        total += readDerived(row.derived) + readCell(row.source);
      }
      return total;
    });
    expect(readDerived(aggregate)).toBe((3 * 8000 * 7999) / 2);
    const stop = local.watch(() => readDerived(aggregate));
    const first = rows[0] as (typeof rows)[number];
    const last = rows[7999] as (typeof rows)[number];
    expect(observerCount(first.source)).toBe(2);
    expect(observerCount(last.source)).toBe(2);
    writeCell(first.source, 10);
    expect(readDerived(aggregate)).toBe((3 * 8000 * 7999) / 2 + 30);
    writeCell(count, 1);
    expect(readDerived(aggregate)).toBe(30);
    expect(observerCount(last.source)).toBe(0);
    stop();
    expect(observerCount(first.source)).toBe(0);
    expectAtRest(local);
  });

  test("watchers run in link order after the first observer leaves", () => {
    const local = new Graph();
    const cell = local.cell(0);
    const ran: Array<string> = [];
    const stops = ["first", "second", "third"].map((name) =>
      local.watch(
        () => readCell(cell),
        () => ran.push(name),
      ),
    );
    stops[0]?.();
    const stopFourth = local.watch(
      () => readCell(cell),
      () => ran.push("fourth"),
    );

    writeCell(cell, 1);

    expect(ran).toEqual(["second", "third", "fourth"]);
    expect(observerCount(cell)).toBe(3);
    stops[1]?.();
    stops[2]?.();
    stopFourth();
    expect(observerCount(cell)).toBe(0);
  });

  test("a source a run reads twice, around a first compute that reads it too, is linked once and unlinked fully", () => {
    const local = new Graph();
    const cell = local.cell(1);
    const flag = local.cell(true);
    const inner = local.derived(() => readCell(cell) * 10);
    const outer = local.derived(() => {
      const before = readCell(cell);
      const middle = readCell(flag) ? readDerived(inner) : 0;
      return before + middle + readCell(cell);
    });
    const seen: Array<number> = [];
    const stop = local.watch(
      () => readDerived(outer),
      (value) => seen.push(value),
    );
    expect(observerCount(cell)).toBe(2);

    writeCell(cell, 2);
    writeCell(flag, false);
    expect(observerCount(cell)).toBe(1);
    expect(observerCount(inner)).toBe(0);
    writeCell(flag, true);
    expect(observerCount(cell)).toBe(2);
    writeCell(cell, 3);

    expect(seen).toEqual([24, 4, 24, 36]);
    stop();
    expect([observerCount(cell), observerCount(flag), observerCount(inner)]).toEqual([0, 0, 0]);
  });

  test("a derived value a run reads twice is linked once after a recompute", () => {
    const local = new Graph();
    const cell = local.cell(1);
    const doubled = local.derived(() => readCell(cell) * 2);
    const sum = local.derived(() => readDerived(doubled) + readDerived(doubled));
    const seen: Array<number> = [];
    const stop = local.watch(
      () => readDerived(sum),
      (value) => seen.push(value),
    );
    expect(observerCount(doubled)).toBe(1);

    writeCell(cell, 2);
    writeCell(cell, 3);

    expect(seen).toEqual([8, 12]);
    expect(observerCount(doubled)).toBe(1);
    stop();
    expect(observerCount(doubled)).toBe(0);
  });

  test("a recompute that drops one source keeps the links to the rest", () => {
    const local = new Graph();
    const flag = local.cell(true);
    const left = local.cell("left");
    const right = local.cell("right");
    const kept = local.cell("kept");
    let runs = 0;
    const stop = local.watch(() => {
      runs++;
      return `${readCell(kept)} ${readCell(flag) ? readCell(left) : readCell(right)}`;
    });

    writeCell(flag, false);
    expect([left, right, kept].map((cell) => observerCount(cell))).toEqual([0, 1, 1]);
    runs = 0;
    writeCell(left, "ignored");
    expect(runs).toBe(0);
    writeCell(kept, "still kept");
    writeCell(right, "right again");
    expect(runs).toBe(2);
    stop();
    expect([flag, left, right, kept].map((cell) => observerCount(cell))).toEqual([0, 0, 0, 0]);
  });

  test("a recompute that reads fewer sources in another order unlinks every one it dropped", () => {
    const local = new Graph();
    const flip = local.cell(false);
    const cells = [0, 1, 2, 3, 4].map((value) => local.cell(value));
    const sum = local.derived(() =>
      readCell(flip)
        ? (cells[4] === undefined ? 0 : readCell(cells[4])) +
          (cells[2] === undefined ? 0 : readCell(cells[2]))
        : cells.reduce((total, cell) => total + readCell(cell), 0),
    );
    const seen: Array<number> = [];
    const stop = local.watch(
      () => readDerived(sum),
      (value) => seen.push(value),
    );

    // The source read again, the third, sits between dropped ones in the
    // old list: the one after it must be unlinked too.
    writeCell(flip, true);
    expect(cells.map((cell) => observerCount(cell))).toEqual([0, 0, 1, 0, 1]);
    writeCell(flip, false);
    expect(cells.map((cell) => observerCount(cell))).toEqual([1, 1, 1, 1, 1]);
    stop();

    expect(seen).toEqual([6, 10]);
    expect(cells.map((cell) => observerCount(cell))).toEqual([0, 0, 0, 0, 0]);
    expectAtRest(local);
  });

  test("adopting a pending run that reads fewer sources in another order unlinks every one it dropped", () => {
    const local = new Graph();
    const cells = [local.cell(0), local.cell(1), local.cell(2), local.cell(3)] as const;
    const reaction = new Reaction(local, () => {});
    reaction.track(() => cells.reduce((total, cell) => total + readCell(cell), 0));
    reaction.activate();

    reaction.trackPending(() => readCell(cells[3]) + readCell(cells[1]));
    reaction.adopt();
    expect(cells.map((cell) => observerCount(cell))).toEqual([0, 1, 0, 1]);

    reaction.deactivate();
    expect(cells.map((cell) => observerCount(cell))).toEqual([0, 0, 0, 0]);
    expectAtRest(local);
  });

  test("a derived value that loses its last observer during its own run leaves the sources it just read to their other observers", () => {
    const local = new Graph();
    const flag = local.cell(false);
    const shared = local.cell(0);
    const late: { value?: DerivedNode<number> } = {};
    // On the flag, `inner` reads `shared` for the first time and then
    // `outer`, which stops reading `inner`: `inner` loses its last observer
    // while its run has added the edge to `shared` and not linked it yet.
    const inner = local.derived(() => {
      if (!readCell(flag)) {
        return 0;
      }
      readCell(shared);
      return (late.value === undefined ? 0 : readDerived(late.value)) + 1;
    });
    const outer = local.derived(() => (readCell(flag) ? 10 : readDerived(inner)));
    late.value = outer;
    const stopOuter = local.watch(() => readDerived(outer));
    const seen: Array<number> = [];
    const stopShared = local.watch(
      () => readCell(shared),
      (value) => seen.push(value),
    );

    local.batch(() => {
      writeCell(flag, true);
      peekDerived(inner);
    });
    writeCell(shared, 1);

    expect(seen).toEqual([1]);
    expect([observerCount(shared), observerCount(inner)]).toEqual([1, 0]);
    stopOuter();
    stopShared();
    expect([flag, shared].map((cell) => observerCount(cell))).toEqual([0, 0]);
    expectAtRest(local);
  });

  test("a track that throws after reading a source out of order keeps every source linked once", () => {
    const local = new Graph();
    const cells = [local.cell(0), local.cell(1), local.cell(2)] as const;
    const reaction = new Reaction(local, () => {});
    reaction.track(() => readCell(cells[0]) + readCell(cells[1]) + readCell(cells[2]));
    expect(reaction.activate()).toBe(false);

    // The failed run reads the last source first: its old edge must go, and
    // the sources it never reached stay linked.
    expect(() =>
      reaction.track(() => {
        readCell(cells[2]);
        throw new Error("the track fails");
      }),
    ).toThrow("the track fails");
    expect(cells.map((cell) => observerCount(cell))).toEqual([1, 1, 1]);

    reaction.deactivate();
    expect(cells.map((cell) => observerCount(cell))).toEqual([0, 0, 0]);
    expectAtRest(local);
  });
});

describe("repeat marks", () => {
  test("a computed value marked and not checked since tells its observers once", () => {
    const local = new Graph(() => {});
    const base = local.cell(0);
    const doubled = local.derived(() => readCell(base) * 2);
    let changes = 0;
    const reaction = new Reaction(local, () => changes++);
    reaction.track(() => readDerived(doubled));
    reaction.activate();

    local.batch(() => {
      for (let index = 1; index <= 100; index++) {
        writeCell(base, index);
      }
    });
    expect(changes).toBe(1);

    expect(reaction.track(() => readDerived(doubled))).toBe(200);
    writeCell(base, 0);
    expect(changes).toBe(2);
    reaction.deactivate();
  });

  test("a cell written again in a batch reaches a watcher linked between the writes", () => {
    const local = new Graph(() => {});
    const base = local.cell(0);
    const doubled = local.derived(() => readCell(base) * 2);
    const seen: Array<string> = [];
    const stopFirst = local.watch(
      () => readDerived(doubled),
      (value) => seen.push(`first ${value}`),
    );
    let stopSecond = (): void => {};

    local.batch(() => {
      writeCell(base, 1);
      stopSecond = local.watch(
        () => readCell(base),
        (value) => seen.push(`second ${value}`),
      );
      writeCell(base, 2);
    });

    expect(seen).toEqual(["first 4", "second 2"]);
    stopFirst();
    stopSecond();
    expectAtRest(local);
  });

  test("a watcher whose select throws before reading a computed value reruns on its next change", () => {
    const reports: Array<unknown> = [];
    const local = new Graph((error) => reports.push(error));
    const failing = local.cell(false);
    const base = local.cell(0);
    const doubled = local.derived(() => readCell(base) * 2);
    const seen: Array<number> = [];
    local.watch(
      () => {
        if (readCell(failing)) {
          throw new Error("the select fails");
        }
        return readDerived(doubled);
      },
      (value) => seen.push(value),
    );

    local.batch(() => {
      writeCell(failing, true);
      writeCell(base, 1);
    });
    expect(reports).toEqual([new Error("the select fails")]);

    writeCell(base, 2);
    expect(reports).toEqual([new Error("the select fails"), new Error("the select fails")]);

    writeCell(failing, false);
    expect(seen).toEqual([4]);
    expectAtRest(local);
  });

  test("a watcher left unrun at the round limit reruns on the next change of a computed value", () => {
    const local = new Graph(() => {});
    const loop = local.cell(0);
    const base = local.cell(0);
    const doubled = local.derived(() => readCell(base) * 2);
    const seen: Array<number> = [];
    local.watch(
      () => readDerived(doubled),
      (value) => seen.push(value),
    );
    let looping = true;
    let count = 0;
    local.watch(
      () => readCell(loop),
      () => {
        if (looping) {
          count++;
          local.batch(() => {
            writeCell(base, count);
            writeCell(loop, count);
          });
        }
      },
    );

    writeCell(loop, -1);
    const last = seen.at(-1);
    expect(last).toBeLessThan(count * 2);

    looping = false;
    writeCell(base, 1000);
    expect(seen.at(-1)).toBe(2000);
  });

  test("a reaction told of a change and not tracked again is told of the next one", () => {
    const local = new Graph(() => {});
    const other = local.cell(0);
    const base = local.cell(0);
    const doubled = local.derived(() => readCell(base) * 2);
    let told = 0;
    const reaction = new Reaction(local, () => {
      told++;
    });
    reaction.track(() => readCell(other) + readDerived(doubled));
    reaction.activate();

    local.batch(() => {
      writeCell(other, 1);
      writeCell(base, 1);
    });
    expect(told).toBe(1);

    writeCell(base, 2);
    expect(told).toBe(2);
    reaction.deactivate();
  });

  test("a reaction activated on stale reads is told of a later change of a computed value", () => {
    const local = new Graph(() => {});
    const other = local.cell(0);
    const base = local.cell(0);
    const doubled = local.derived(() => readCell(base) * 2);
    const stop = local.watch(
      () => readDerived(doubled),
      () => {},
    );
    let told = 0;
    const reaction = new Reaction(local, () => {
      told++;
    });
    reaction.track(() => readCell(other) + readDerived(doubled));

    local.batch(() => {
      writeCell(other, 1);
      writeCell(base, 1);
      expect(reaction.activate()).toBe(true);
      writeCell(base, 2);
    });
    expect(told).toBe(1);
    reaction.deactivate();
    stop();
  });
});

describe("a compute cannot write, however deep", () => {
  const message = "cannot write while it computes";

  test("through nested untracked calls", () => {
    const local = new Graph();
    const cell = local.cell(1);
    const value = local.derived(() =>
      local.untracked(() => local.untracked(() => writeCell(cell, 2))),
    );
    expect(() => readDerived(value)).toThrow(message);
    expect(peekCell(cell)).toBe(1);
    expectAtRest(local);
  });

  test("through a reaction's track or pending track", () => {
    const local = new Graph();
    const cell = local.cell(1);
    const reaction = new Reaction(local, () => {});
    const tracked = local.derived(() => reaction.track(() => writeCell(cell, 2)), {
      label: "tracked",
    });
    const pending = local.derived(() => reaction.trackPending(() => writeCell(cell, 3)));
    expect(() => readDerived(tracked)).toThrow(`pinna: tracked ${message}`);
    expect(() => readDerived(pending)).toThrow(message);
    expect(peekCell(cell)).toBe(1);
    expectAtRest(local);
  });

  test("through untracked inside a custom equals", () => {
    const local = new Graph();
    const cell = local.cell(1);
    const source = local.cell(0);
    const value = local.derived(() => readCell(source), {
      equals: () => {
        local.untracked(() => writeCell(cell, 5));
        return false;
      },
    });
    readDerived(value);
    writeCell(source, 1);
    expect(() => readDerived(value)).toThrow(message);
    expect(peekCell(cell)).toBe(1);
    expectAtRest(local);
  });

  test("an unlabeled value is named in the error", () => {
    const local = new Graph();
    const value = local.derived(() => local.watch(() => 0));
    expect(() => readDerived(value)).toThrow(
      "pinna: a derived value cannot observe or release while it computes",
    );
    expectAtRest(local);
  });

  test("nor observe or release through a reaction's track", () => {
    const local = new Graph();
    const cell = local.cell(1);
    const stop = local.watch(() => readCell(cell));
    const reaction = new Reaction(local, () => {});
    const observes = local.derived(() => reaction.track(() => local.watch(() => 0)));
    const releases = local.derived(() => reaction.track(() => stop()));
    expect(() => readDerived(observes)).toThrow("cannot observe or release while it computes");
    expect(() => readDerived(releases)).toThrow("cannot observe or release while it computes");
    stop();
    expectAtRest(local);
  });

  test("a hook begun by a compute's read still writes, at the settle", () => {
    const local = new Graph();
    const observed = local.cell(0);
    const written = local.cell(0);
    local.onObserved(observed, () => {
      writeCell(written, 1);
      return undefined;
    });
    const value = local.derived(() => readCell(observed));
    const stop = local.watch(() => readDerived(value));
    expect(peekCell(written)).toBe(1);
    stop();
    expectAtRest(local);
  });
});

describe("a stopped watch", () => {
  test("that stops itself in its own select does not run its effect", () => {
    const local = new Graph();
    const cell = local.cell(0);
    const effects: Array<number> = [];
    let stop: () => void = () => {};
    stop = local.watch(
      () => {
        const value = readCell(cell);
        if (value > 0) {
          stop();
        }
        return value;
      },
      (value) => {
        effects.push(value);
      },
    );
    writeCell(cell, 1);
    writeCell(cell, 2);
    expect(effects).toEqual([]);
    expect(observerCount(cell)).toBe(0);
    expectAtRest(local);
  });
});

describe("beginBatch and endBatch", () => {
  test("an endBatch with no beginBatch throws and leaves the graph working", () => {
    const local = new Graph();
    const cell = local.cell(0);
    const seen: Array<number> = [];
    const stop = local.watch(
      () => readCell(cell),
      (value) => {
        seen.push(value);
      },
    );
    expect(() => local.endBatch(false)).toThrow("pinna: endBatch needs a beginBatch before it");
    expect(() => local.batch(() => local.endBatch(false))).toThrow(
      "pinna: endBatch needs a beginBatch before it",
    );
    expectAtRest(local);
    writeCell(cell, 1);
    expect(seen).toEqual([1]);
    local.beginBatch();
    writeCell(cell, 2);
    expect(seen).toEqual([1]);
    local.endBatch(false);
    expect(seen).toEqual([1, 2]);
    stop();
    expectAtRest(local);
  });
});

describe("a value one write reaches directly", () => {
  test("computes once for that write, and not again for a write to another source", () => {
    const local = new Graph();
    const a = local.cell(1);
    const b = local.cell(10);
    let runs = 0;
    const derived = local.derived(() => {
      runs++;
      return readCell(a) * 2;
    });
    const seen: Array<number> = [];
    const stop = local.watch(
      () => readDerived(derived) + readCell(b),
      (value) => seen.push(value),
    );
    writeCell(a, 2);
    expect(runs).toBe(2);
    writeCell(b, 20);
    expect(runs).toBe(2);
    expect(seen).toEqual([14, 24]);
    stop();
    expectAtRest(local);
  });

  test("a dirty value with two sources names the first that changed, in read order", () => {
    const local = new Graph();
    const a = local.cell(1, { label: "a" });
    const b = local.cell(10, { label: "b" });
    const derived = local.derived(() => readCell(a) + readCell(b));
    const stop = local.watch(
      () => readDerived(derived),
      () => {},
    );
    local.beginBatch();
    writeCell(b, 20);
    writeCell(a, 2);
    local.endBatch(false);
    expect(derived.cause?.label).toBe("a");
    stop();
    expectAtRest(local);
  });
});

describe("restore", () => {
  test("inside a compute throws, as set does, and changes nothing", () => {
    const local = new Graph();
    const cell = local.cell(1);
    const version = cell.version;
    const derived = local.derived(
      () => {
        restoreCell(cell, 5, version);
        return 0;
      },
      { label: "d" },
    );
    expect(() => readDerived(derived)).toThrow("pinna: d cannot write while it computes");
    expect(peekCell(cell)).toBe(1);
    expect(cell.version).toBe(version);
    expectAtRest(local);
  });

  test("a write put back in the same update runs nothing that observes the cell", () => {
    const local = new Graph();
    const cell = local.cell(1);
    let runs = 0;
    const derived = local.derived(() => {
      runs++;
      return readCell(cell) * 2;
    });
    const seen: Array<number> = [];
    const stop = local.watch(
      () => readDerived(derived),
      (value) => seen.push(value),
    );
    expect(runs).toBe(1);
    const version = cell.version;
    local.beginBatch();
    writeCell(cell, 2);
    restoreCell(cell, 1, version);
    local.endBatch(false);
    expect(runs).toBe(1);
    expect(seen).toEqual([]);
    writeCell(cell, 3);
    expect(runs).toBe(2);
    expect(seen).toEqual([6]);
    stop();
    expectAtRest(local);
  });

  test("a value read between the write and the put back computes again once", () => {
    const local = new Graph();
    const cell = local.cell(1);
    let runs = 0;
    const derived = local.derived(() => {
      runs++;
      return readCell(cell) * 2;
    });
    const seen: Array<number> = [];
    const stop = local.watch(
      () => readDerived(derived),
      (value) => seen.push(value),
    );
    const version = cell.version;
    local.beginBatch();
    writeCell(cell, 2);
    expect(peekDerived(derived)).toBe(4);
    restoreCell(cell, 1, version);
    expect(peekDerived(derived)).toBe(2);
    local.endBatch(false);
    expect(runs).toBe(3);
    expect(seen).toEqual([]);
    stop();
    expectAtRest(local);
  });

  test("a value that loses its observers between the write and the put back does not compute", () => {
    const local = new Graph();
    const cell = local.cell(1);
    let runs = 0;
    const derived = local.derived(() => {
      runs++;
      return readCell(cell) * 2;
    });
    const stop = local.watch(
      () => readDerived(derived),
      () => {},
    );
    const version = cell.version;
    local.beginBatch();
    writeCell(cell, 2);
    stop();
    restoreCell(cell, 1, version);
    local.endBatch(false);
    expect(peekDerived(derived)).toBe(2);
    expect(runs).toBe(1);
    expectAtRest(local);
  });

  test("a put back that follows another write to the cell still reaches every reader", () => {
    const local = new Graph();
    const cell = local.cell(1);
    let runs = 0;
    const derived = local.derived(() => {
      runs++;
      return readCell(cell) + 1;
    });
    const stop = local.watch(
      () => readDerived(derived),
      () => {},
    );
    const version = cell.version;
    local.beginBatch();
    writeCell(cell, 2);
    writeCell(cell, 3);
    restoreCell(cell, 1, version);
    writeCell(cell, 4);
    restoreCell(cell, 1, version);
    local.endBatch(false);
    expect(runs).toBe(1);
    expect(peekDerived(derived)).toBe(2);
    stop();
    expectAtRest(local);
  });
});

describe("adopt", () => {
  test("follows the pending run even after a track in between", () => {
    const local = new Graph();
    const a = local.cell(1);
    const b = local.cell(10);
    let changes = 0;
    const reaction = new Reaction(local, () => changes++);
    reaction.track(() => readCell(a));
    reaction.activate();
    reaction.trackPending(() => readCell(b));
    reaction.track(() => readCell(a));
    writeCell(b, 11);
    expect(changes).toBe(0);
    expect(reaction.adopt()).toBe(true);
    expect(observerCount(a)).toBe(0);
    expect(observerCount(b)).toBe(1);
    reaction.deactivate();
    expectAtRest(local);
  });
});

describe("an atom linked outside a walk", () => {
  // A derived value over an unobserved atom is never current, so a read
  // rechecks it in a walk that checks the atom too. A link right after that
  // walk still counts the atom as changed, so the derived value is checked.
  test("gives activate the same answer whatever the last walk checked", () => {
    const results: Array<boolean> = [];
    for (const walkBetween of [false, true]) {
      const local = new Graph();
      const atom = local.atom();
      const derived = local.derived(() => {
        readAtom(atom);
        return 0;
      });
      const unrelated = local.derived(() => 0);
      readDerived(derived);
      const reaction = new Reaction(local, () => {});
      reaction.track(() => {
        readDerived(derived);
        readAtom(atom);
      });
      if (walkBetween) {
        readDerived(unrelated);
      }
      results.push(reaction.activate());
      reaction.deactivate();
      expectAtRest(local);
    }
    // The atom read directly counts as changed both times.
    expect(results).toEqual([true, true]);
  });

  test("brings a derived value over it current on activate", () => {
    const local = new Graph();
    const atom = local.atom();
    let outside = 0;
    const derived = local.derived(() => {
      readAtom(atom);
      return outside;
    });
    readDerived(derived);
    const reaction = new Reaction(local, () => {});
    reaction.track(() => readDerived(derived));
    outside = 1;
    expect(reaction.activate()).toBe(true);
    expect(readDerived(derived)).toBe(1);
    reaction.deactivate();
    expectAtRest(local);
  });

  test("brings a derived value over it current on adopt", () => {
    const local = new Graph();
    const atom = local.atom();
    let outside = 0;
    const derived = local.derived(() => {
      readAtom(atom);
      return outside;
    });
    readDerived(derived);
    const reaction = new Reaction(local, () => {});
    reaction.track(() => undefined);
    reaction.activate();
    reaction.trackPending(() => readDerived(derived));
    outside = 1;
    expect(reaction.adopt()).toBe(true);
    expect(readDerived(derived)).toBe(1);
    reaction.deactivate();
    expectAtRest(local);
  });
});

describe("a value over an atom nothing observes", () => {
  // Such a value is never current, and neither is what reads it: nothing
  // tells the graph when the state the atom stands for changes.
  for (const through of [false, true]) {
    test(`keeps its reader never current across a walk below, ${through ? "two values deep" : "one value deep"}`, () => {
      const local = new Graph();
      const atom = local.atom();
      const cell = local.cell(0);
      let outside = 0;
      const overAtom = local.derived(() => {
        readAtom(atom);
        return outside;
      });
      const passed = local.derived(() => readCell(cell));
      const parity = through
        ? local.derived(() => readDerived(passed) % 2)
        : local.derived(() => readCell(cell) % 2);
      const reader = local.derived(() => `${readDerived(overAtom)}:${readDerived(parity)}`);
      expect(readDerived(reader)).toBe("0:0");
      // The write leaves `parity` to check, in a walk below `reader`.
      writeCell(cell, 2);
      expect(readDerived(reader)).toBe("0:0");
      outside = 1;
      expect(readDerived(reader)).toBe("1:0");
      expectAtRest(local);
    });
  }
});

describe("forgetValue", () => {
  test("an unobserved value drops what it kept and runs again at the next read", () => {
    const local = new Graph();
    const source = local.cell(1);
    let runs = 0;
    const derived = local.derived(() => {
      runs++;
      return { doubled: readCell(source) * 2 };
    });
    const first = readDerived(derived);
    forgetValue(derived);
    expect(hasRun(derived)).toBe(false);
    expect(derived.value).toBeUndefined();
    const second = readDerived(derived);
    expect(second).toEqual({ doubled: 2 });
    expect(second).not.toBe(first);
    expect(runs).toBe(2);
    // The edge it kept still follows the source.
    writeCell(source, 3);
    expect(readDerived(derived)).toEqual({ doubled: 6 });
    expect(runs).toBe(3);
    expectAtRest(local);
  });

  test("a value read in the clock it was dropped in runs again", () => {
    const local = new Graph();
    const source = local.cell(1);
    let runs = 0;
    const derived = local.derived(() => {
      runs++;
      return readCell(source) + 1;
    });
    // Current at this clock: without the reset, the next read would skip its run.
    expect(readDerived(derived)).toBe(2);
    forgetValue(derived);
    expect(peekDerived(derived)).toBe(2);
    expect(runs).toBe(2);
  });

  test("an unobserved reader of a dropped value keeps its own value until a source changes", () => {
    const local = new Graph();
    const source = local.cell(1);
    const derived = local.derived(() => readCell(source) * 2);
    let readerRuns = 0;
    const reader = local.derived(() => {
      readerRuns++;
      return readDerived(derived) + 1;
    });
    expect(readDerived(reader)).toBe(3);
    forgetValue(derived);
    // Nothing changed: the reader is current and keeps what it holds.
    expect(readDerived(reader)).toBe(3);
    expect(readerRuns).toBe(1);
    expect(hasRun(derived)).toBe(false);
    // The walk meets the dropped value, runs it, and runs the reader after it.
    writeCell(source, 2);
    expect(readDerived(reader)).toBe(5);
    expect(readerRuns).toBe(2);
    expect(readDerived(derived)).toBe(4);
    expectAtRest(local);
  });

  test("an observed value keeps what it holds", () => {
    const local = new Graph();
    const source = local.cell(1);
    let runs = 0;
    const derived = local.derived(() => {
      runs++;
      return readCell(source) * 2;
    });
    const seen: Array<number> = [];
    const stop = local.watch(() => {
      seen.push(readDerived(derived));
    });
    expect(observerCount(derived)).toBe(1);
    forgetValue(derived);
    expect(hasRun(derived)).toBe(true);
    expect(peekDerived(derived)).toBe(2);
    expect(runs).toBe(1);
    writeCell(source, 2);
    expect(seen).toEqual([2, 4]);
    stop();
    expectAtRest(local);
  });

  test("a dropped value that gains an observer runs, links, and reports each change", () => {
    const local = new Graph();
    const source = local.cell(1);
    let runs = 0;
    const derived = local.derived(() => {
      runs++;
      return readCell(source) * 2;
    });
    expect(readDerived(derived)).toBe(2);
    forgetValue(derived);
    const seen: Array<number> = [];
    const stop = local.watch(() => {
      seen.push(readDerived(derived));
    });
    expect(observerCount(derived)).toBe(1);
    expect(observerCount(source)).toBe(1);
    writeCell(source, 2);
    writeCell(source, 3);
    expect(seen).toEqual([2, 4, 6]);
    expect(runs).toBe(4);
    stop();
    expect(observerCount(source)).toBe(0);
    expectAtRest(local);
  });

  test("a value forgotten from its own run keeps its result", () => {
    const local = new Graph();
    const source = local.cell(1);
    const derived: DerivedNode<number> = local.derived(() => {
      const value = readCell(source) * 2;
      forgetValue(derived);
      return value;
    });
    expect(readDerived(derived)).toBe(2);
    expect(hasRun(derived)).toBe(true);
    expectAtRest(local);
  });

  test("an error a value kept is dropped too", () => {
    const local = new Graph();
    const source = local.cell(0);
    let runs = 0;
    const derived = local.derived(() => {
      runs++;
      if (readCell(source) === 0) {
        throw new Error("zero");
      }
      return readCell(source);
    });
    expect(() => readDerived(derived)).toThrow("zero");
    forgetValue(derived);
    expect(hasRun(derived)).toBe(false);
    expect(() => readDerived(derived)).toThrow("zero");
    expect(runs).toBe(2);
    expectAtRest(local);
  });
});
