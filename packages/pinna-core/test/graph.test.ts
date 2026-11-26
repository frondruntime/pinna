import { describe, expect, test } from "bun:test";
import {
  Capture,
  Graph,
  observerCount,
  peekCell,
  peekDerived,
  placeDeriving,
  Reaction,
  readAtom,
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
      expect(first.place & placeDeriving).not.toBe(0);
      expect(second.place & placeDeriving).toBe(0);
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

describe("a capture and Reaction.follow", () => {
  test("a capture observes nothing and starts no hook", () => {
    const graph = new Graph();
    const a = graph.cell(1);
    const events: Array<string> = [];
    graph.onObserved(a, () => {
      events.push("start a");
      return () => events.push("stop a");
    });
    const double = graph.derived(() => readCell(a) * 2);
    const capture = new Capture(graph);

    expect(capture.run(() => readDerived(double))).toBe(2);
    expect(events).toEqual([]);
    expect(observerCount(a)).toBe(0);
    expect(observerCount(double)).toBe(0);
  });

  test("changed is false until a source it read moves, and a write to another leaves it false", () => {
    const graph = new Graph();
    const a = graph.cell(1);
    const other = graph.cell(0);
    const double = graph.derived(() => readCell(a) * 2);
    const capture = new Capture(graph);
    capture.run(() => readDerived(double));

    expect(capture.changed()).toBe(false);
    graph.batch(() => writeCell(other, 1));
    expect(capture.changed()).toBe(false);
    graph.batch(() => writeCell(a, 2));
    expect(capture.changed()).toBe(true);
    capture.run(() => readDerived(double));
    expect(capture.changed()).toBe(false);
  });

  test("with nothing written, changed is false over an atom nothing observes", () => {
    const graph = new Graph();
    const atom = graph.atom();
    let runs = 0;
    const fresh = graph.derived(() => {
      readAtom(atom);
      runs++;
      return {};
    });
    const capture = new Capture(graph);
    capture.run(() => readDerived(fresh));
    const ran = runs;

    expect(capture.changed()).toBe(false);
    expect(capture.changed()).toBe(false);
    expect(runs).toBe(ran);
  });

  test("follow keeps the sources both read live and links and unlinks the rest", () => {
    const graph = new Graph();
    const a = graph.cell(1);
    const b = graph.cell(10);
    const c = graph.cell(100);
    const events: Array<string> = [];
    for (const [cell, name] of [
      [a, "a"],
      [b, "b"],
      [c, "c"],
    ] as const) {
      graph.onObserved(cell, () => {
        events.push(`start ${name}`);
        return () => events.push(`stop ${name}`);
      });
    }
    let changes = 0;
    const reaction = new Reaction(graph, () => changes++);
    const first = new Capture(graph);
    first.run(() => readCell(a) + readCell(b));
    expect(reaction.follow(first)).toBe(false);
    reaction.activate();
    expect(events).toEqual(["start a", "start b"]);

    const second = new Capture(graph);
    second.run(() => readCell(b) + readCell(c));
    expect(reaction.follow(second)).toBe(false);
    expect(events).toEqual(["start a", "start b", "start c", "stop a"]);
    graph.batch(() => writeCell(a, 2));
    expect(changes).toBe(0);
    graph.batch(() => writeCell(b, 11));
    expect(changes).toBe(1);
    expect(second.changed()).toBe(true);

    reaction.deactivate();
    expect(events).toEqual(["start a", "start b", "start c", "stop a", "stop b", "stop c"]);
  });

  test("follow reports a write between the capture and the follow", () => {
    const graph = new Graph();
    const a = graph.cell(1);
    const reaction = new Reaction(graph, () => {});
    const first = new Capture(graph);
    first.run(() => readCell(a));
    reaction.follow(first);
    reaction.activate();
    const second = new Capture(graph);
    second.run(() => readCell(a));
    graph.batch(() => writeCell(a, 2));

    expect(reaction.follow(second)).toBe(true);
    reaction.deactivate();
  });

  test("a capture that throws keeps what it read", () => {
    const graph = new Graph();
    const a = graph.cell(1);
    const capture = new Capture(graph);
    expect(() =>
      capture.run(() => {
        readCell(a);
        throw new Error("select");
      }),
    ).toThrow("select");
    const reaction = new Reaction(graph, () => {});
    reaction.follow(capture);
    reaction.activate();

    expect(observerCount(a)).toBe(1);
    reaction.deactivate();
  });
});

describe("a capture's own writes", () => {
  // A selector place does not refuse a write: only deriving does. A capture
  // that reads a cell and then writes it holds the version it read, so the
  // write is a change it has not seen.
  test("changed is true after a capture writes a cell it read", () => {
    const graph = new Graph();
    const a = graph.cell(1);
    const capture = new Capture(graph);
    capture.run(() => {
      const value = readCell(a);
      writeCell(a, value + 1);
      return value;
    });

    expect(capture.changed()).toBe(true);
    expect(capture.run(() => readCell(a))).toBe(2);
    expect(capture.changed()).toBe(false);
    expectAtRest(graph);
  });
});

describe("a capture over an atom nothing observes", () => {
  // An unobserved atom is never current: a walk gives it a new version, so
  // every walk would call the capture changed. `changed` answers from the
  // clock instead, and the walk that links the atom (`Reaction.follow`,
  // `Reaction.activate`) is the one that tells: React's getSnapshot needs two
  // calls with nothing written to agree.
  test("changed stays false with nothing written, and the follow that links the atom reports the change", () => {
    const graph = new Graph();
    const atom = graph.atom();
    let outside = 1;
    const capture = new Capture(graph);
    expect(
      capture.run(() => {
        readAtom(atom);
        return outside;
      }),
    ).toBe(1);
    outside = 2;

    expect(capture.changed()).toBe(false);
    expect(capture.changed()).toBe(false);
    const reaction = new Reaction(graph, () => {});
    reaction.track(() => undefined);
    reaction.activate();
    expect(reaction.follow(capture)).toBe(true);
    reaction.deactivate();
    expectAtRest(graph);
  });
});

describe("an atom linked outside a walk, through follow", () => {
  // As `adopt` (test/core.test.ts, "brings a derived value over it current
  // on adopt"): the follow links the atom in a walk of its own, so the atom
  // counts as changed and the derived value over it is checked.
  test("brings a derived value over it current on follow", () => {
    const graph = new Graph();
    const atom = graph.atom();
    let outside = 0;
    const derived = graph.derived(() => {
      readAtom(atom);
      return outside;
    });
    readDerived(derived);
    const reaction = new Reaction(graph, () => {});
    reaction.track(() => undefined);
    reaction.activate();
    const capture = new Capture(graph);
    capture.run(() => readDerived(derived));
    outside = 1;

    expect(reaction.follow(capture)).toBe(true);
    expect(readDerived(derived)).toBe(1);
    reaction.deactivate();
    expectAtRest(graph);
  });
});

describe("a reaction notified when marked", () => {
  test("is told of each settle that marks it, with no refresh first", () => {
    const graph = new Graph();
    const cell = graph.cell(0);
    let computes = 0;
    const doubled = graph.derived(() => {
      computes++;
      return readCell(cell) * 2;
    });
    let notices = 0;
    const reaction = new Reaction(graph, () => notices++, "marked", "marked");
    reaction.track(() => readDerived(doubled));
    reaction.activate();
    computes = 0;

    for (let value = 1; value <= 100; value++) {
      writeCell(cell, value);
    }

    expect(notices).toBe(100);
    expect(computes).toBe(0);
    expect(reaction.changed()).toBe(true);
    expect(computes).toBe(1);
    reaction.deactivate();
    expectAtRest(graph);
  });

  test("changed is false when a derived value cuts the change off", () => {
    const graph = new Graph();
    const cell = graph.cell(0);
    const parity = graph.derived(() => readCell(cell) % 2);
    let notices = 0;
    const reaction = new Reaction(graph, () => notices++, "parity", "marked");
    reaction.track(() => readDerived(parity));
    reaction.activate();

    writeCell(cell, 2);

    expect(notices).toBe(1);
    expect(reaction.changed()).toBe(false);
    reaction.deactivate();
    expectAtRest(graph);
  });

  test("changed is false once a track has read the change, and while inactive", () => {
    const graph = new Graph();
    const cell = graph.cell(0);
    const reaction = new Reaction(graph, () => undefined, "reader", "marked");
    reaction.track(() => readCell(cell));
    expect(reaction.changed()).toBe(false);
    reaction.activate();
    writeCell(cell, 1);
    expect(reaction.changed()).toBe(true);
    reaction.track(() => readCell(cell));
    expect(reaction.changed()).toBe(false);
    reaction.deactivate();
    writeCell(cell, 2);
    expect(reaction.changed()).toBe(false);
    expectAtRest(graph);
  });

  test("a reaction notified when changed is told only of a real change", () => {
    const graph = new Graph();
    const cell = graph.cell(0);
    const parity = graph.derived(() => readCell(cell) % 2);
    let notices = 0;
    const reaction = new Reaction(graph, () => notices++);
    reaction.track(() => readDerived(parity));
    reaction.activate();

    writeCell(cell, 2);
    writeCell(cell, 3);

    expect(notices).toBe(1);
    reaction.deactivate();
    expectAtRest(graph);
  });
});

describe("a reaction's track that writes", () => {
  test("is notified when the run wrote a source it read for the first time", () => {
    const graph = new Graph();
    const gate = graph.cell(false);
    const cell = graph.cell(0);
    let notices = 0;
    const reaction = new Reaction(graph, () => notices++);
    const run = (): void => {
      if (readCell(gate)) {
        writeCell(cell, readCell(cell) + 1);
      }
    };
    reaction.track(run);
    reaction.activate();
    writeCell(gate, true);
    expect(notices).toBe(1);
    notices = 0;

    // The run reads `cell` for the first time and writes it: no mark reaches
    // the edge it links only at the run's end.
    reaction.track(run);

    expect(notices).toBe(1);
    reaction.deactivate();
    expectAtRest(graph);
  });

  test("a run that writes nothing it read is not notified", () => {
    const graph = new Graph();
    const source = graph.cell(0);
    const target = graph.cell(0);
    let notices = 0;
    const reaction = new Reaction(graph, () => notices++);
    reaction.activate();
    reaction.track(() => writeCell(target, readCell(source) + 1));
    expect(notices).toBe(0);
    reaction.deactivate();
    expectAtRest(graph);
  });
});
