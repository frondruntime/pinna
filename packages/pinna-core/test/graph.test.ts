import { describe, expect, test } from "bun:test";
import {
  Graph,
  peekCell,
  peekDerived,
  Reaction,
  readCell,
  readDerived,
  writeCell,
} from "../src/graph.ts";
import { captureReports } from "./reports.ts";
import { expectAtRest } from "./rest.ts";

describe("two graphs", () => {
  test("a batch in one graph does not defer the other graph's watchers", () => {
    const first = new Graph();
    const second = new Graph();
    const a = first.cell(1);
    const b = second.cell(1);
    const seen: Array<string> = [];
    const stopFirst = first.watch(
      () => readCell(a),
      (value) => seen.push(`first ${value}`),
    );
    const stopSecond = second.watch(
      () => readCell(b),
      (value) => seen.push(`second ${value}`),
    );

    first.batch(() => {
      writeCell(a, 2);
      writeCell(b, 2);
      expect(seen).toEqual(["second 2"]);
    });

    expect(seen).toEqual(["second 2", "first 2"]);
    stopFirst();
    stopSecond();
  });

  test("a read of another graph inside a derived is not tracked", () => {
    const first = new Graph();
    const second = new Graph();
    const a = first.cell(1);
    const b = second.cell(10);
    let runs = 0;
    const sum = first.derived(() => {
      runs++;
      return readCell(a) + readCell(b);
    });
    const stop = first.watch(() => readDerived(sum));
    expect(runs).toBe(1);

    writeCell(b, 20);

    expect(runs).toBe(1);
    expect(second.isTracking()).toBe(false);
    stop();
  });

  test("a derived computing in one graph does not block writes in the other", () => {
    const first = new Graph();
    const second = new Graph();
    const b = second.cell(0);
    const a = first.derived(() => {
      expect(first.deriving).toBeDefined();
      expect(second.deriving).toBeUndefined();
      writeCell(b, 1);
      return peekCell(b);
    });

    expect(readDerived(a)).toBe(1);
  });

  test("a throwing watcher is reported by its graph and the other graph still settles", () => {
    const first = new Graph();
    const second = new Graph();
    const a = first.cell(1);
    const b = second.cell(1);
    const seen: Array<number> = [];
    first.watch(
      () => readCell(a),
      () => {
        throw new Error("boom");
      },
    );
    second.watch(
      () => readCell(b),
      (value) => seen.push(value),
    );

    const reports = captureReports(() =>
      first.batch(() => {
        writeCell(a, 2);
        writeCell(b, 2);
      }),
    );

    expect(reports.map((error) => (error as Error).message)).toEqual(["boom"]);
    expect(seen).toEqual([2]);
    expectAtRest(first);
    expectAtRest(second);
  });

  test("a reaction belongs to the graph it was made in", () => {
    const first = new Graph();
    const second = new Graph();
    const a = first.cell(1);
    let changes = 0;
    const reaction = new Reaction(first, () => changes++);
    reaction.track(() => readCell(a));
    reaction.activate();

    second.batch(() => writeCell(a, 2));

    expect(changes).toBe(1);
    reaction.deactivate();
  });

  test("onObserved refuses a source from another graph", () => {
    const first = new Graph();
    const second = new Graph();
    const a = first.cell(1);
    expect(() => second.onObserved(a, () => undefined)).toThrow("from this graph");
    expectAtRest(first);
    expectAtRest(second);
  });
});

describe("hooks added while a derived links or unlinks", () => {
  test("a hook added twice while observed begins once and its cleanup runs once", () => {
    const graph = new Graph();
    const cell = graph.cell(1);
    const stop = graph.watch(() => readCell(cell));
    let starts = 0;
    let cleanups = 0;
    const start = () => {
      starts++;
      return () => {
        cleanups++;
      };
    };
    const first = graph.onObserved(cell, start);
    const second = graph.onObserved(cell, start);
    expect(starts).toBe(1);
    stop();
    expect(cleanups).toBe(1);
    first();
    second();
    expect([starts, cleanups]).toEqual([1, 1]);
    expectAtRest(graph);
  });

  test("a hook added to a derived while it links starts once", () => {
    const graph = new Graph();
    const cell = graph.cell(1);
    const derived = graph.derived(() => readCell(cell) * 2);
    const log: Array<string> = [];
    graph.onObserved(cell, () => {
      graph.onObserved(derived, () => {
        log.push("start");
        return () => log.push("cleanup");
      });
      return undefined;
    });

    const stop = graph.watch(() => readDerived(derived));
    stop();

    expect(log).toEqual(["start", "cleanup"]);
  });

  // Ruling 28: the cleanup runs once the derived is unlinked, so the hook it
  // adds goes on a source nothing observes.
  test("a hook a cleanup adds to a derived it unlinked does not start", () => {
    const graph = new Graph();
    const cell = graph.cell(1);
    const derived = graph.derived(() => readCell(cell) * 2);
    const log: Array<string> = [];
    graph.onObserved(cell, () => () => {
      graph.onObserved(derived, () => {
        log.push("start");
        return () => log.push("cleanup");
      });
    });

    const stop = graph.watch(() => readDerived(derived));
    stop();

    expect(log).toEqual([]);
  });
});

describe("a derived's peek", () => {
  test("computes the current value and subscribes nothing", () => {
    const graph = new Graph();
    const cell = graph.cell(1);
    const other = graph.cell(10);
    const derived = graph.derived(() => readCell(cell) * 2);
    const seen: Array<number> = [];
    const stop = graph.watch(
      () => readCell(other) + peekDerived(derived),
      (value) => seen.push(value),
    );

    writeCell(cell, 2);
    expect(seen).toEqual([]);
    expect(peekDerived(derived)).toBe(4);
    writeCell(other, 20);
    expect(seen).toEqual([24]);
    stop();
  });

  test("throws the error the derived keeps", () => {
    const graph = new Graph();
    const derived = graph.derived((): number => {
      throw new Error("boom");
    });
    expect(() => peekDerived(derived)).toThrow("boom");
    expectAtRest(graph);
  });

  test("restores tracking after a throw", () => {
    const graph = new Graph();
    const cell = graph.cell(1);
    const failing = graph.derived((): number => {
      throw new Error("boom");
    });
    let runs = 0;
    const stop = graph.watch(() => {
      runs++;
      try {
        peekDerived(failing);
      } catch {
        // The read after it is still tracked.
      }
      return readCell(cell);
    });

    writeCell(cell, 2);
    expect(runs).toBe(2);
    stop();
    expectAtRest(graph);
  });
});

describe("flush", () => {
  test("a reaction deactivated and activated mid-flush is due once per round", () => {
    const graph = new Graph();
    const cell = graph.cell(0);
    const first = graph.cell(0);
    const second = graph.cell(0);
    let changes = 0;
    const reaction = new Reaction(graph, () => changes++);
    reaction.track(() => readCell(cell));
    reaction.activate();
    graph.watch(
      () => readCell(first),
      () => {
        reaction.deactivate();
        reaction.activate();
        writeCell(cell, peekCell(cell) + 1);
      },
    );
    graph.watch(
      () => readCell(second),
      () => writeCell(cell, peekCell(cell) + 1),
    );

    graph.batch(() => {
      writeCell(first, 1);
      writeCell(cell, 100);
      writeCell(second, 1);
    });

    expect(changes).toBe(2);
    reaction.deactivate();
  });

  test("a reporter that throws leaves no watcher stuck", () => {
    const graph = new Graph();
    const cell = graph.cell(0);
    const runs: Array<string> = [];
    graph.watch(() => {
      readCell(cell);
      runs.push("first");
      if (peekCell(cell) === 1) {
        throw new Error("boom");
      }
    });
    graph.watch(() => {
      readCell(cell);
      runs.push("second");
    });
    const original = globalThis.reportError;
    globalThis.reportError = () => {
      throw new Error("reporter failed");
    };
    try {
      expect(() => writeCell(cell, 1)).toThrow("reporter failed");
    } finally {
      globalThis.reportError = original;
    }
    runs.length = 0;

    writeCell(cell, 2);

    expect(runs).toEqual(["first", "second"]);
    expectAtRest(graph);
  });

  test("a reporter that throws leaves the round limit in place", () => {
    const graph = new Graph();
    const cell = graph.cell(0);
    graph.watch(() => {
      if (readCell(cell) === 1) {
        throw new Error("boom");
      }
    });
    graph.watch(() => readCell(cell));
    const original = globalThis.reportError;
    globalThis.reportError = () => {
      throw new Error("reporter failed");
    };
    try {
      expect(() => writeCell(cell, 1)).toThrow("reporter failed");
    } finally {
      globalThis.reportError = original;
    }
    const loop = graph.cell(0);
    let runs = 0;
    graph.watch(
      () => readCell(loop),
      (value) => {
        runs++;
        if (runs < 1000) {
          writeCell(loop, value + 1);
        }
      },
    );

    const reports = captureReports(() => writeCell(loop, 1));

    expect(reports.map((error) => (error as Error).message)).toEqual([
      "pinna: watchers did not settle after 100 rounds",
    ]);
    expect(runs).toBeLessThan(1000);
    expectAtRest(graph);
  });

  // A reporter that throws: its first error is the one a write throws.
  const rejecting = () =>
    new Graph((error) => {
      throw new Error(`reporter failed on ${(error as Error).message}`);
    });

  test("a write throws the reporter's first error when two watchers throw", () => {
    const graph = rejecting();
    const cell = graph.cell(0);
    for (const name of ["first", "second"]) {
      graph.watch(() => {
        if (readCell(cell) === 1) {
          throw new Error(name);
        }
      });
    }

    expect(() => writeCell(cell, 1)).toThrow("reporter failed on first");
    expectAtRest(graph);
  });

  test("a write throws the reporter's first error when two hooks begun in one pass throw", () => {
    const graph = rejecting();
    const flag = graph.cell(false);
    const first = graph.cell(0);
    const second = graph.cell(0);
    graph.onObserved(first, () => {
      throw new Error("first hook");
    });
    graph.onObserved(second, () => {
      throw new Error("second hook");
    });
    graph.watch(() => (readCell(flag) ? readCell(first) + readCell(second) : 0));

    expect(() => writeCell(flag, true)).toThrow("reporter failed on first hook");
    expectAtRest(graph);
  });

  test("a write throws the reporter's error on the round limit report", () => {
    const graph = rejecting();
    const loop = graph.cell(0);
    graph.watch(
      () => readCell(loop),
      (value) => {
        if (value > 0) {
          writeCell(loop, value + 1);
        }
      },
    );

    expect(() => writeCell(loop, 1)).toThrow(
      "reporter failed on pinna: watchers did not settle after 100 rounds",
    );
    expectAtRest(graph);
  });

  // An observing call with no owner has no write to throw to, so a hook's
  // error the reporter rejects goes to the host.
  test("a hook error a reaction's activation settles goes to the host when the reporter throws", () => {
    const graph = rejecting();
    const cell = graph.cell(0);
    graph.onObserved(cell, () => {
      throw new Error("hook failed");
    });
    const reaction = new Reaction(graph, () => undefined);
    reaction.track(() => readCell(cell));

    const reports = captureReports(() => {
      reaction.activate();
    });

    expect(reports.map((error) => (error as Error).message)).toEqual([
      "reporter failed on hook failed",
    ]);
    reaction.deactivate();
    expectAtRest(graph);
  });
});

describe("a reaction's pending run", () => {
  test("an active reaction stays linked to its sources while a pending run reads others", () => {
    const graph = new Graph();
    const a = graph.cell(1);
    const b = graph.cell(10);
    let changes = 0;
    const reaction = new Reaction(graph, () => changes++);
    reaction.track(() => readCell(a));
    reaction.activate();

    expect(reaction.trackPending(() => readCell(b))).toBe(10);
    graph.batch(() => writeCell(b, 11));
    expect(changes).toBe(0);
    graph.batch(() => writeCell(a, 2));
    expect(changes).toBe(1);
    reaction.deactivate();
  });

  test("adopt links what the pending run read and unlinks the rest", () => {
    const graph = new Graph();
    const a = graph.cell(1);
    const b = graph.cell(10);
    const events: Array<string> = [];
    graph.onObserved(a, () => {
      events.push("start a");
      return () => events.push("stop a");
    });
    graph.onObserved(b, () => {
      events.push("start b");
      return () => events.push("stop b");
    });
    let changes = 0;
    const reaction = new Reaction(graph, () => changes++);
    reaction.track(() => readCell(a));
    reaction.activate();
    reaction.trackPending(() => readCell(b));
    expect(events).toEqual(["start a"]);

    expect(reaction.adopt()).toBe(false);
    expect(events).toEqual(["start a", "start b", "stop a"]);
    graph.batch(() => writeCell(a, 2));
    expect(changes).toBe(0);
    graph.batch(() => writeCell(b, 11));
    expect(changes).toBe(1);
    reaction.deactivate();
    expect(events).toEqual(["start a", "start b", "stop a", "stop b"]);
  });

  test("adopt reports a change made between the pending run and adopt", () => {
    const graph = new Graph();
    const a = graph.cell(1);
    const b = graph.cell(10);
    const reaction = new Reaction(graph, () => {});
    reaction.track(() => readCell(a));
    reaction.activate();
    reaction.trackPending(() => readCell(b));
    graph.batch(() => writeCell(b, 11));

    expect(reaction.adopt()).toBe(true);
    reaction.deactivate();
  });

  test("adopt with nothing pending keeps the sources", () => {
    const graph = new Graph();
    const a = graph.cell(1);
    const b = graph.cell(10);
    let changes = 0;
    const reaction = new Reaction(graph, () => changes++);
    reaction.track(() => readCell(a));
    reaction.activate();
    reaction.trackPending(() => readCell(b));
    reaction.adopt();

    expect(reaction.adopt()).toBe(false);
    graph.batch(() => writeCell(b, 11));
    expect(changes).toBe(1);
    reaction.deactivate();
  });

  test("a pending run that reads the same sources leaves the links in place", () => {
    const graph = new Graph();
    const a = graph.cell(1);
    const events: Array<string> = [];
    graph.onObserved(a, () => {
      events.push("start");
      return () => events.push("stop");
    });
    let changes = 0;
    const reaction = new Reaction(graph, () => changes++);
    reaction.track(() => readCell(a));
    reaction.activate();
    for (let run = 0; run < 3; run++) {
      reaction.trackPending(() => readCell(a));
      expect(reaction.adopt()).toBe(false);
    }

    graph.batch(() => writeCell(a, 2));
    expect(changes).toBe(1);
    expect(events).toEqual(["start"]);
    reaction.deactivate();
    expect(events).toEqual(["start", "stop"]);
  });

  test("an inactive reaction adopts the pending run and links it when activated", () => {
    const graph = new Graph();
    const a = graph.cell(1);
    const b = graph.cell(10);
    let changes = 0;
    const reaction = new Reaction(graph, () => changes++);
    reaction.track(() => readCell(a));
    reaction.trackPending(() => readCell(b));
    expect(reaction.adopt()).toBe(false);
    graph.batch(() => writeCell(b, 11));

    expect(reaction.activate()).toBe(true);
    graph.batch(() => writeCell(a, 2));
    expect(changes).toBe(0);
    graph.batch(() => writeCell(b, 12));
    expect(changes).toBe(1);
    reaction.deactivate();
  });

  test("a pending run that throws keeps the last pending run", () => {
    const graph = new Graph();
    const a = graph.cell(1);
    const b = graph.cell(10);
    let changes = 0;
    const reaction = new Reaction(graph, () => changes++);
    reaction.track(() => readCell(a));
    reaction.activate();
    reaction.trackPending(() => readCell(b));
    expect(() =>
      reaction.trackPending(() => {
        readCell(a);
        throw new Error("read failed");
      }),
    ).toThrow("read failed");

    reaction.adopt();
    graph.batch(() => writeCell(a, 2));
    expect(changes).toBe(0);
    graph.batch(() => writeCell(b, 11));
    expect(changes).toBe(1);
    reaction.deactivate();
    expectAtRest(graph);
  });

  test("a pending run or an adopt inside the reaction's own run is refused and changes nothing", () => {
    const graph = new Graph();
    const a = graph.cell(1);
    const b = graph.cell(10);
    let changes = 0;
    const reaction = new Reaction(graph, () => changes++);
    reaction.track(() => readCell(a));
    reaction.activate();
    reaction.trackPending(() => readCell(b));

    expect(() =>
      reaction.track(() => {
        readCell(a);
        reaction.trackPending(() => readCell(b));
      }),
    ).toThrow("reaction cannot track inside its own run");
    expect(() =>
      reaction.track(() => {
        readCell(a);
        reaction.adopt();
      }),
    ).toThrow("reaction cannot adopt inside its own run");

    // Still linked to "a" only, and the earlier pending run is still there to adopt.
    graph.batch(() => writeCell(b, 11));
    expect(changes).toBe(0);
    graph.batch(() => writeCell(a, 2));
    expect(changes).toBe(1);
    expect(reaction.adopt()).toBe(true);
    graph.batch(() => writeCell(a, 3));
    expect(changes).toBe(1);
    graph.batch(() => writeCell(b, 12));
    expect(changes).toBe(2);
    reaction.deactivate();
    expectAtRest(graph);
  });
});
