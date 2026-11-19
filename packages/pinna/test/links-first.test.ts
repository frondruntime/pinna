import { describe, expect, test } from "bun:test";
import {
  type DerivedNode,
  Graph,
  observerCount,
  Reaction,
  readAtom,
  readCell,
  readDerived,
  writeCell,
} from "@frondruntime/pinna-core";
import {
  atom,
  autorun,
  box,
  type Computed,
  computed,
  computedFunction,
  createRealm,
  inspect,
  onObserved,
  untracked,
  update,
  watch,
} from "../src/index.ts";
import { keptRead } from "./kept.ts";
import { captureReports } from "./reports.ts";

/**
 * An observing call links or unlinks everything first, then starts or stops
 * the hooks: a hook or cleanup sees every observer count in place, and at
 * rest a source's hooks are started exactly when it is observed.
 */

const quiet = (): Graph => new Graph(() => {});

describe("a hook sees every count in place", () => {
  test("a watch's first link starts a hook once its later sources are linked", () => {
    const local = quiet();
    const cells = [local.cell(0), local.cell(0), local.cell(0)] as const;
    const seen: Array<ReadonlyArray<number>> = [];
    local.onObserved(cells[0], () => {
      seen.push([observerCount(cells[1]), observerCount(cells[2])]);
      return () => {
        seen.push([observerCount(cells[1]), observerCount(cells[2])]);
      };
    });

    const stop = local.watch(() => readCell(cells[0]) + readCell(cells[1]) + readCell(cells[2]));
    stop();
    expect(seen).toEqual([
      [1, 1],
      [0, 0],
    ]);
  });

  test("a reaction's activate and deactivate run hooks once every source is linked or unlinked", () => {
    const local = quiet();
    const cells = [local.cell(0), local.cell(0), local.cell(0)] as const;
    const seen: Array<ReadonlyArray<number>> = [];
    local.onObserved(cells[0], () => {
      seen.push([observerCount(cells[1]), observerCount(cells[2])]);
      return () => {
        seen.push([observerCount(cells[1]), observerCount(cells[2])]);
      };
    });
    const reaction = new Reaction(local, () => {});
    reaction.track(() => readCell(cells[0]) + readCell(cells[1]) + readCell(cells[2]));

    reaction.activate();
    reaction.deactivate();
    expect(seen).toEqual([
      [1, 1],
      [0, 0],
    ]);
  });

  test("a computed value's first source starts its hook once the computed value's later sources are linked", () => {
    const local = quiet();
    const cells = [local.cell(0), local.cell(0), local.cell(0)] as const;
    const sum = local.derived(() => readCell(cells[0]) + readCell(cells[1]) + readCell(cells[2]));
    const seen: Array<ReadonlyArray<number>> = [];
    local.onObserved(cells[0], () => {
      seen.push([observerCount(sum), observerCount(cells[1]), observerCount(cells[2])]);
      return () => {
        seen.push([observerCount(sum), observerCount(cells[1]), observerCount(cells[2])]);
      };
    });

    const stop = local.watch(() => readDerived(sum));
    stop();
    expect(seen).toEqual([
      [1, 1, 1],
      [0, 0, 0],
    ]);
  });

  test("a relink outside an update starts the new source's hook once the dropped one is unlinked", () => {
    const local = quiet();
    const flag = local.cell(false);
    const left = local.cell(1);
    const right = local.cell(2);
    const pick = local.derived(() => (readCell(flag) ? readCell(right) : readCell(left)));
    const seen: Array<number> = [];
    local.onObserved(right, () => {
      seen.push(observerCount(left));
      return undefined;
    });
    const stop = local.watch(() => readDerived(pick));

    writeCell(flag, true);
    expect(seen).toEqual([0]);
    stop();
  });
});

describe("a hook's write while a computed value links", () => {
  test("leaves the computed value linked only to what it reads", () => {
    const local = quiet();
    const gate = local.cell(0);
    const middle = local.cell(0);
    const near = local.cell(10);
    const far = local.cell(20);
    const pick = local.derived(() => {
      if (readCell(gate) > 0) {
        return readCell(near);
      }
      readCell(middle);
      return readCell(far);
    });
    let middleRunning = false;
    local.onObserved(middle, () => {
      middleRunning = true;
      writeCell(gate, 1);
      return () => {
        middleRunning = false;
      };
    });
    let changes = 0;
    const reaction = new Reaction(local, () => {
      changes++;
    });
    reaction.track(() => readDerived(pick));

    reaction.activate();
    expect(local.untracked(() => readDerived(pick))).toBe(10);
    expect([gate, near, middle, far].map((cell) => observerCount(cell))).toEqual([1, 1, 0, 0]);
    expect(middleRunning).toBe(false);
    expect(changes).toBe(1);
    reaction.deactivate();
  });

  test("a read outside an update that relinks a stale computed value sees the hook's write next", () => {
    const local = quiet();
    const trigger = local.cell(0);
    const flag = local.cell(false);
    const base = local.cell(1);
    const extra = local.cell(0);
    const added = local.derived(() =>
      readCell(flag) ? readCell(base) + readCell(extra) : readCell(base),
    );
    local.onObserved(extra, () => {
      writeCell(extra, 5);
      return undefined;
    });
    let changes = 0;
    const reaction = new Reaction(local, () => {
      changes++;
    });
    // The trigger comes first, so a change to it stops the check there and
    // leaves the computed value stale for the read below.
    reaction.track(() => readCell(trigger) + readDerived(added));
    reaction.activate();

    local.batch(() => {
      writeCell(trigger, 1);
      writeCell(flag, true);
    });
    expect(changes).toBe(1);
    local.untracked(() => readDerived(added));
    expect(local.untracked(() => readDerived(added))).toBe(6);
    reaction.deactivate();
  });
});

describe("at rest, hooks are started exactly when observed", () => {
  test("a hook that stops the watch whose link started it leaves nothing started", () => {
    const local = quiet();
    const cells = [local.cell(0), local.cell(0), local.cell(0)] as const;
    const running = new Set<number>();
    let stop: (() => void) | undefined;
    cells.forEach((cell, index) => {
      local.onObserved(cell, () => {
        running.add(index);
        if (index === 0) {
          stop?.();
        }
        return () => {
          running.delete(index);
        };
      });
    });
    const reaction = new Reaction(local, () => {});
    reaction.track(() => readCell(cells[0]) + readCell(cells[1]) + readCell(cells[2]));
    stop = () => reaction.deactivate();

    reaction.activate();
    expect(cells.map((cell) => observerCount(cell))).toEqual([0, 0, 0]);
    expect([...running]).toEqual([]);
  });

  test("a hook added inside a batch to an observed source starts when the batch ends", () => {
    const local = quiet();
    const cell = local.cell(0);
    const stop = local.watch(() => readCell(cell));
    const log: Array<string> = [];
    local.batch(() => {
      local.onObserved(cell, () => {
        log.push("start");
        return undefined;
      });
      log.push("added");
    });
    expect(log).toEqual(["added", "start"]);
    stop();
  });
});

describe("hooks added while a computed value computes", () => {
  test("a hook added to an observed source while a computed value computes starts once the read is over", () => {
    const local = quiet();
    const cell = local.cell(0);
    const stop = local.watch(() => readCell(cell));
    const log: Array<string> = [];
    const adds = local.derived(() => {
      local.onObserved(cell, () => {
        log.push("start");
        return undefined;
      });
      log.push("computed");
      return 0;
    });
    local.untracked(() => readDerived(adds));
    expect(log).toEqual(["computed", "start"]);
    stop();
  });
});

describe("a reporter that throws while an observing call settles", () => {
  const failing = (): Graph =>
    new Graph(() => {
      throw new Error("the reporter fails");
    });

  test("a hook's error goes to the host and the call returns", () => {
    const local = failing();
    const cell = local.cell(0);
    local.onObserved(cell, () => {
      throw new Error("the hook fails");
    });
    let stop: (() => void) | undefined;
    const reports = captureReports(() => {
      stop = local.watch(() => readCell(cell));
    });
    expect(reports).toEqual([new Error("the reporter fails")]);
    expect(observerCount(cell)).toBe(1);
    stop?.();
  });

  test("another watcher's error goes to the host and the call returns", () => {
    const local = failing();
    const cell = local.cell(0);
    const other = local.cell(0);
    local.watch(() => {
      if (readCell(other) > 0) {
        throw new Error("the other watcher fails");
      }
    });
    local.onObserved(cell, () => {
      writeCell(other, 1);
      return undefined;
    });
    let stop: (() => void) | undefined;
    const reports = captureReports(() => {
      stop = local.watch(() => readCell(cell));
    });
    expect(reports).toEqual([new Error("the reporter fails")]);
    expect(observerCount(cell)).toBe(1);
    stop?.();
  });
});

describe("a computed value cannot observe or release while it computes", () => {
  const message = "cannot observe or release while it computes";

  test("watch", () => {
    const local = quiet();
    const cell = local.cell(0);
    const bad = local.derived(() => {
      local.watch(() => readCell(cell));
      return 0;
    });
    expect(() => local.untracked(() => readDerived(bad))).toThrow(message);
    expect(observerCount(cell)).toBe(0);
  });

  test("a watch's stop function", () => {
    const local = quiet();
    const cell = local.cell(0);
    const stop = local.watch(() => readCell(cell));
    const bad = local.derived(() => {
      stop();
      return 0;
    });
    expect(() => local.untracked(() => readDerived(bad))).toThrow(message);
    expect(observerCount(cell)).toBe(1);
    stop();
  });

  test("a reaction's activate, deactivate, track, and adopt while active", () => {
    const local = quiet();
    const cell = local.cell(0);
    const reaction = new Reaction(local, () => {});
    reaction.track(() => readCell(cell));
    const activate = local.derived(() => reaction.activate());
    expect(() => local.untracked(() => readDerived(activate))).toThrow(message);
    expect(observerCount(cell)).toBe(0);

    reaction.activate();
    const track = local.derived(() => reaction.track(() => readCell(cell)));
    expect(() => local.untracked(() => readDerived(track))).toThrow(message);
    const deactivate = local.derived(() => {
      reaction.deactivate();
      return 0;
    });
    expect(() => local.untracked(() => readDerived(deactivate))).toThrow(message);
    expect(observerCount(cell)).toBe(1);
    reaction.trackPending(() => readCell(cell));
    const adopt = local.derived(() => reaction.adopt());
    expect(() => local.untracked(() => readDerived(adopt))).toThrow(message);
    expect(observerCount(cell)).toBe(1);
    reaction.deactivate();
  });

  test("the error names the computed value", () => {
    const local = quiet();
    const cell = local.cell(0);
    const bad = local.derived(
      () => {
        local.watch(() => readCell(cell));
        return 0;
      },
      { label: "total" },
    );
    expect(() => local.untracked(() => readDerived(bad))).toThrow(
      "pinna: total cannot observe or release while it computes",
    );
  });
});

describe("a hook removed while a computed value computes", () => {
  test("ends at the settle, so a cleanup that deactivates the reaction leaves nothing linked", () => {
    const local = quiet();
    const first = local.cell(0);
    const far = local.cell(0);
    const anchor = local.cell(0);
    const tick = local.cell(0);
    local.watch(() => readCell(anchor));
    let reaction: Reaction | undefined;
    const order: Array<string> = [];
    const remove = local.onObserved(anchor, () => () => {
      order.push("cleanup");
      reaction?.deactivate();
    });
    let removing = false;
    const trigger = local.derived(() => {
      readCell(tick);
      if (removing) {
        removing = false;
        remove();
        order.push("compute ends");
      }
      return 0;
    });
    const sum = local.derived(() => readCell(first) + readDerived(trigger) + readCell(far));
    reaction = new Reaction(local, () => {});
    reaction.track(() => readDerived(sum));
    // Written while nothing observes it, so the check after the link
    // recomputes `trigger`, and the hook is removed inside that compute.
    writeCell(tick, 1);
    removing = true;

    expect(reaction.activate()).toBe(false);
    expect(order).toEqual(["compute ends", "cleanup"]);
    expect([sum, first, trigger, far].map((node) => observerCount(node))).toEqual([0, 0, 0, 0]);
  });

  test("ends at the settle, so a cleanup's write leaves the computed value linked only to what it reads", () => {
    const local = quiet();
    const gate = local.cell(0);
    const near = local.cell(10);
    const far = local.cell(20);
    const anchor = local.cell(0);
    const tick = local.cell(0);
    local.watch(() => readCell(anchor));
    let pick: DerivedNode<number> | undefined;
    const order: Array<string> = [];
    const remove = local.onObserved(anchor, () => () => {
      order.push("cleanup");
      writeCell(gate, 1);
      local.untracked(() => (pick === undefined ? undefined : readDerived(pick)));
    });
    let removing = false;
    const trigger = local.derived(() => {
      readCell(tick);
      if (removing) {
        removing = false;
        remove();
        order.push("compute ends");
      }
      return 0;
    });
    pick = local.derived(() => {
      if (readCell(gate) > 0) {
        return readCell(near);
      }
      readDerived(trigger);
      return readCell(far);
    });
    const stop = local.watch(() => (pick === undefined ? undefined : readDerived(pick)));
    // The settle after this write recomputes `trigger`, which removes the
    // hook inside that compute.
    removing = true;
    writeCell(tick, 1);

    expect(order).toEqual(["compute ends", "cleanup"]);
    expect(local.untracked(() => (pick === undefined ? undefined : readDerived(pick)))).toBe(10);
    expect([gate, near, trigger, far].map((node) => observerCount(node))).toEqual([1, 1, 0, 0]);
    stop();
    expect([gate, near, trigger, far].map((node) => observerCount(node))).toEqual([0, 0, 0, 0]);
  });

  test("runs its cleanup once the read is over, not inside the compute", () => {
    const local = quiet();
    const cell = local.cell(0);
    const stop = local.watch(() => readCell(cell));
    const remove = local.onObserved(cell, () => () => {
      stop();
    });
    let during = -1;
    const removes = local.derived(() => {
      remove();
      during = observerCount(cell);
      return 0;
    });

    local.untracked(() => readDerived(removes));
    expect(during).toBe(1);
    expect(observerCount(cell)).toBe(0);
  });
});

describe("memo inside a compute that a read outside an update runs", () => {
  test("two calls with the same new arguments share one entry", () => {
    const realm = createRealm();
    const core = (realm as unknown as { readonly core: Graph }).core;
    const $trigger = box(realm, 0);
    const $arg = box(realm, 2);
    let computes = 0;
    const square = computedFunction(realm, (_read, x: number) => {
      computes++;
      return x * x;
    });
    const $sum = computed(realm, (read) => read(square(read($arg))) + read(square(read($arg))));
    // The trigger comes first, so a change to it stops the check there and
    // leaves the sum stale, and observed, for the read below.
    // A core reaction hands out no Pinna read, so the test keeps one; it reads
    // and tracks inside the reaction's run.
    const read = keptRead(realm);
    const reaction = new Reaction(core, () => {});
    reaction.track(() => read($trigger) + read($sum));
    reaction.activate();
    expect(computes).toBe(1);

    update(realm, (_read, write) => {
      write($trigger, 1);
      write($arg, 3);
    });
    computes = 0;
    expect(untracked(realm, (read) => read($sum))).toBe(18);
    expect(computes).toBe(1);
    reaction.deactivate();
  });
});

describe("a watch that stops itself", () => {
  test("in its own select leaves nothing linked", () => {
    const local = quiet();
    const cell = local.cell(0);
    const log: Array<string> = [];
    local.onObserved(cell, () => {
      log.push("start");
      return () => {
        log.push("stop");
      };
    });
    let stop: () => void = () => {};
    stop = local.watch(() => {
      if (readCell(cell) > 0) {
        stop();
      }
    });

    writeCell(cell, 1);
    expect(observerCount(cell)).toBe(0);
    expect(log).toEqual(["start", "stop"]);
  });
});

describe("memo making an entry inside a compute that a read outside an update runs", () => {
  test("does not end a hook removed earlier in the compute before the read is over", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const $x = box(realm, 0);
    watch(
      realm,
      (read) => read($x),
      () => {},
    );
    let computing = false;
    const seen: Array<boolean> = [];
    const remove = onObserved($x, () => () => {
      seen.push(computing);
    });
    const square = computedFunction(realm, (_read, n: number) => n * n);
    const $d = computed(realm, (read) => {
      computing = true;
      remove();
      const value = read(square(5));
      computing = false;
      return value;
    });

    expect(untracked(realm, (read) => read($d))).toBe(25);
    expect(errors).toEqual([]);
    expect(seen).toEqual([false]);
  });

  test("does not stop a hook a nested relink made due while the outer value computes", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const core = (realm as unknown as { readonly core: Graph }).core;
    const $trigger = box(realm, 0);
    const $flag = box(realm, false);
    const $a = box(realm, 1);
    const $b = box(realm, 2);
    let computing = false;
    const seen: Array<boolean> = [];
    onObserved($b, () => () => {
      seen.push(computing);
    });
    const $e = computed(realm, (read) => (read($flag) ? read($a) : read($b)));
    // A core reaction hands out no Pinna read, so the test keeps one; it reads
    // and tracks inside the reaction's run.
    const read = keptRead(realm);
    const reaction = new Reaction(core, () => {});
    reaction.track(() => read($trigger) + read($e));
    reaction.activate();
    // The trigger comes first, so the check stops there and leaves $e stale and observed.
    update(realm, (_read, write) => {
      write($trigger, 1);
      write($flag, true);
    });
    const square = computedFunction(realm, (_read, n: number) => n * n);
    const $d = computed(realm, (read) => {
      computing = true;
      const value = read($e) + read(square(7));
      computing = false;
      return value;
    });

    expect(untracked(realm, (read) => read($d))).toBe(50);
    expect(errors).toEqual([]);
    expect(seen).toEqual([false]);
    reaction.deactivate();
  });

  test("does not rerun, mid-compute, a watcher that reads the computing value", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const $x = box(realm, 0);
    const $y = box(realm, 0);
    watch(
      realm,
      (read) => read($x),
      () => {},
    );
    const remove = onObserved($x, () => () => {
      update(realm, (_read, write) => {
        write($y, 1);
      });
    });
    const square = computedFunction(realm, (_read, n: number) => n * n);
    const $d = computed(realm, (read) => {
      remove();
      return read(square(3));
    });
    const seen: Array<number> = [];
    watch(
      realm,
      (read) => read($y),
      () => {
        seen.push(untracked(realm, (read) => read($d)));
      },
    );

    expect(untracked(realm, (read) => read($d))).toBe(9);
    expect(errors.map(String)).toEqual([]);
    expect(seen).toEqual([9]);
  });

  test("does not evict an entry made earlier in the same compute", () => {
    const realm = createRealm();
    let computes = 0;
    const square = computedFunction(realm, (_read, n: number) => {
      computes++;
      return n * n;
    });
    const $d = computed(realm, (read) => read(square(2)) + read(square(3)) + read(square(2)));
    expect(untracked(realm, (read) => read($d))).toBe(17);
    expect(computes).toBe(2);
  });
});

describe("a read outside an update settles once it is over", () => {
  test("a refused update inside the compute does not evict a memo entry made earlier in it", () => {
    const realm = createRealm();
    let computes = 0;
    const square = computedFunction(realm, (_read, n: number) => {
      computes++;
      return n * n;
    });
    const $d = computed(realm, (read) => {
      const first = read(square(2));
      expect(() => untracked(realm, () => update(realm, () => undefined))).toThrow(
        "update cannot run in a computed value",
      );
      return first + read(square(2));
    });
    expect(untracked(realm, (read) => read($d))).toBe(8);
    expect(computes).toBe(1);
  });

  test("a refused update inside the compute does not run a cleanup removed earlier in it", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const $x = box(realm, 0);
    watch(
      realm,
      (read) => read($x),
      () => {},
    );
    let computing = false;
    const seen: Array<boolean> = [];
    const remove = onObserved($x, () => () => {
      seen.push(computing);
    });
    const $d = computed(realm, () => {
      computing = true;
      remove();
      expect(() => untracked(realm, () => update(realm, () => undefined))).toThrow(
        "update cannot run in a computed value",
      );
      computing = false;
      return 1;
    });
    expect(untracked(realm, (read) => read($d))).toBe(1);
    expect(errors).toEqual([]);
    expect(seen).toEqual([false]);
  });

  test("a failing update inside the compute settles nothing before the read is over", () => {
    const realm = createRealm();
    const $y = box(realm, 0);
    let computes = 0;
    const square = computedFunction(realm, (_read, n: number) => {
      computes++;
      return n * n;
    });
    const $d = computed(realm, (read) => {
      const first = read(square(2));
      try {
        untracked(realm, () =>
          update(realm, (_read, write) => {
            write($y, 1);
          }),
        );
      } catch {}
      return first + read(square(2));
    });
    expect(untracked(realm, (read) => read($d))).toBe(8);
    expect(computes).toBe(1);
  });

  test("a refused update inside the compute does not rerun, mid-compute, a watcher that reads the computing value", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const $x = box(realm, 0);
    const $y = box(realm, 0);
    watch(
      realm,
      (read) => read($x),
      () => {},
    );
    const remove = onObserved($x, () => () => {
      update(realm, (_read, write) => {
        write($y, 1);
      });
    });
    const $d = computed(realm, () => {
      remove();
      expect(() => untracked(realm, () => update(realm, () => undefined))).toThrow(
        "update cannot run in a computed value",
      );
      return 9;
    });
    const seen: Array<number> = [];
    watch(
      realm,
      (read) => read($y),
      () => {
        seen.push(untracked(realm, (read) => read($d)));
      },
    );
    expect(untracked(realm, (read) => read($d))).toBe(9);
    expect(errors.map(String)).toEqual([]);
    expect(seen).toEqual([9]);
  });

  test("a read that throws out of equals still runs a cleanup removed in the compute", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const $x = box(realm, 0);
    watch(
      realm,
      (read) => read($x),
      () => {},
    );
    const seen: Array<string> = [];
    const remove = onObserved($x, () => () => {
      seen.push("cleanup");
    });
    const $src = box(realm, 0);
    const $d = computed(
      realm,
      (read) => {
        const value = read($src);
        if (value === 1) {
          remove();
        }
        return value;
      },
      {
        equals: (left, right) => {
          if (right === 1) {
            throw new Error("equals");
          }
          return left === right;
        },
      },
    );
    expect(untracked(realm, (read) => read($d))).toBe(0);
    update(realm, (_read, write) => {
      write($src, 1);
    });
    expect(() => untracked(realm, (read) => read($d))).toThrow("equals");
    // Ruling 31: the cleanup runs once the outermost read is over.
    expect(seen).toEqual(["cleanup"]);
  });

  test("a read that throws out of equals leaves nothing due, so a later hook begins at once", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const $x = box(realm, 0);
    watch(
      realm,
      (read) => read($x),
      () => {},
    );
    const remove = onObserved($x, () => undefined);
    const $src = box(realm, 0);
    const $d = computed(
      realm,
      (read) => {
        if (read($src) === 1) {
          remove();
        }
        return read($src);
      },
      {
        equals: (_left, right) => {
          if (right === 1) {
            throw new Error("equals");
          }
          return false;
        },
      },
    );
    expect(untracked(realm, (read) => read($d))).toBe(0);
    update(realm, (_read, write) => {
      write($src, 1);
    });
    expect(() => untracked(realm, (read) => read($d))).toThrow("equals");
    const log: Array<string> = [];
    onObserved($x, () => {
      log.push("start");
      return undefined;
    });
    // Ruling 31: outside an update, compute, or observing call, a hook on an observed observable begins at once.
    expect(log).toEqual(["start"]);
  });

  test("a read that throws out of equals after memo runs a cleanup removed in the compute once it is over", () => {
    const realm = createRealm();
    const $x = box(realm, 0);
    watch(
      realm,
      (read) => read($x),
      () => {},
    );
    let computing = false;
    const seen: Array<boolean> = [];
    const remove = onObserved($x, () => () => {
      seen.push(computing);
    });
    const square = computedFunction(realm, (_read, n: number) => n * n);
    const $src = box(realm, 0);
    const $d = computed(
      realm,
      (read) => {
        const value = read($src);
        if (value === 1) {
          computing = true;
          remove();
          read(square(3));
          computing = false;
        }
        return value;
      },
      {
        equals: (_left, right) => {
          if (right === 1) {
            throw new Error("equals");
          }
          return false;
        },
      },
    );
    expect(untracked(realm, (read) => read($d))).toBe(0);
    update(realm, (_read, write) => {
      write($src, 1);
    });
    expect(() => untracked(realm, (read) => read($d))).toThrow("equals");
    expect(seen).toEqual([false]);
  });

  test("a read that throws out of equals still reaches watchers with a hook's write", () => {
    const errors: Array<unknown> = [];
    const realm = createRealm({ onError: (error) => errors.push(error) });
    const core = (realm as unknown as { readonly core: Graph }).core;
    const $y = box(realm, 0);
    const seen: Array<number> = [];
    watch(
      realm,
      (read) => read($y),
      (value) => {
        seen.push(value);
      },
    );
    const source = core.derived(() => 0);
    const $src = box(realm, 0);
    const $d = computed(
      realm,
      (read) => {
        if (read($src) === 1) {
          core.onObservedNow(source, () => {
            update(realm, (_read, write) => {
              write($y, 7);
            });
            return undefined;
          });
        }
        return read($src);
      },
      {
        equals: (_left, right) => {
          if (right === 1) {
            throw new Error("equals");
          }
          return false;
        },
      },
    );
    expect(untracked(realm, (read) => read($d))).toBe(0);
    update(realm, (_read, write) => {
      write($src, 1);
    });
    expect(() => untracked(realm, (read) => read($d))).toThrow("equals");
    expect(seen).toEqual([7]);
  });

  test("a read that throws out of equals does not leave a memo entry made in it cached", () => {
    const realm = createRealm();
    let computes = 0;
    const square = computedFunction(realm, (_read, n: number) => {
      computes++;
      return n * n;
    });
    const $src = box(realm, 0);
    const $f = computed(realm, (read) => (read($src) === 1 ? read(square(6)) : 0), {
      equals: (_left, right) => {
        if (right === 36) {
          throw new Error("equals");
        }
        return false;
      },
    });
    expect(untracked(realm, (read) => read($f))).toBe(0);
    update(realm, (_read, write) => {
      write($src, 1);
    });
    expect(() => untracked(realm, (read) => read($f))).toThrow("equals");
    computes = 0;
    untracked(realm, (read) => read(square(6)));
    expect(computes).toBe(1);
  });
});

describe("a computed value's equals is part of its compute", () => {
  test("equals cannot observe, outermost or nested", () => {
    const local = quiet();
    const source = local.cell(0);
    const other = local.cell(0);
    const observeOnChange = (_left: number, right: number): boolean => {
      if (right === 1) {
        local.watch(() => readCell(other));
      }
      return false;
    };
    const outermost = local.derived(() => readCell(source), { equals: observeOnChange });
    const inner = local.derived(() => readCell(source), { equals: observeOnChange });
    const outer = local.derived(() => readDerived(inner));
    readDerived(outermost);
    readDerived(outer);
    writeCell(source, 1);

    expect(() => readDerived(outermost)).toThrow("cannot observe or release while it computes");
    expect(() => readDerived(outer)).toThrow("cannot observe or release while it computes");
    expect(observerCount(other)).toBe(0);
  });

  test("equals cannot release the reaction that links it: the error is the value's", () => {
    const local = quiet();
    const source = local.cell(0);
    const later = local.cell(0);
    const log: Array<string> = [];
    local.onObserved(later, () => {
      log.push("start");
      return () => log.push("stop");
    });
    let reaction: Reaction | undefined;
    const value = local.derived(() => readCell(source), {
      equals: (left, right) => {
        if (right === 1) {
          reaction?.deactivate();
        }
        return left === right;
      },
    });
    reaction = new Reaction(local, () => {});
    reaction.track(() => readDerived(value) + readCell(later));
    writeCell(source, 1);

    expect(reaction.activate()).toBe(true);
    expect(() => readDerived(value)).toThrow("cannot observe or release while it computes");
    expect([observerCount(value), observerCount(later)]).toEqual([1, 1]);
    reaction.deactivate();
    expect([observerCount(value), observerCount(later)]).toEqual([0, 0]);
    expect(log).toEqual(["start", "stop"]);
  });

  test("a hook removed in equals ends at the settle, seeing every count in place", () => {
    const local = quiet();
    const source = local.cell(0);
    const later = local.cell(0);
    const watched = local.cell(0);
    const stop = local.watch(() => readCell(watched));
    const seen: Array<number> = [];
    const remove = local.onObserved(watched, () => () => {
      seen.push(observerCount(later));
    });
    const value = local.derived(() => readCell(source), {
      equals: (left, right) => {
        if (right === 1) {
          remove();
        }
        return left === right;
      },
    });
    const reaction = new Reaction(local, () => {});
    reaction.track(() => readDerived(value) + readCell(later));
    writeCell(source, 1);

    expect(reaction.activate()).toBe(true);
    expect(seen).toEqual([1]);
    reaction.deactivate();
    stop();
  });

  test("equals cannot write", () => {
    const local = quiet();
    const source = local.cell(0);
    const value = local.derived(() => readCell(source), {
      equals: (left, right) => {
        if (right === 1) {
          writeCell(source, 100);
        }
        return left === right;
      },
    });
    readDerived(value);
    writeCell(source, 1);

    expect(() => readDerived(value)).toThrow("cannot write while it computes");
    expect(readCell(source)).toBe(1);
  });

  test("an update in equals cannot write, and the value stays fresh", () => {
    const realm = createRealm({ onError: () => {} });
    const $source = box(realm, 0);
    const $value = computed(realm, (read) => read($source), {
      equals: (left, right) => {
        if (right === 1) {
          update(realm, (_read, write) => {
            write($source, 100);
          });
        }
        return left === right;
      },
    });
    expect(untracked(realm, (read) => read($value))).toBe(0);
    update(realm, (_read, write) => {
      write($source, 1);
    });

    expect(() => untracked(realm, (read) => read($value))).toThrow(
      "update cannot run in a computed value",
    );
    expect(untracked(realm, (read) => read($source))).toBe(1);
  });
});

describe("an equals that throws is kept as the value's error", () => {
  const throwingOn =
    (thrownFor: number) =>
    (left: number, right: number): boolean => {
      if (right === thrownFor) {
        throw new Error("equals");
      }
      return left === right;
    };

  test("a read throws it until a source changes, and never serves the old value", () => {
    const local = quiet();
    const source = local.cell(0);
    const value = local.derived(() => readCell(source), { equals: throwingOn(1) });
    expect(readDerived(value)).toBe(0);
    writeCell(source, 1);

    expect(() => readDerived(value)).toThrow("equals");
    expect(() => readDerived(value)).toThrow("equals");
    writeCell(source, 2);
    expect(readDerived(value)).toBe(2);
  });

  test("a watch sees it as a change and reports it", () => {
    const errors: Array<unknown> = [];
    const local = new Graph((error) => errors.push(error));
    const source = local.cell(0);
    const value = local.derived(() => readCell(source), { equals: throwingOn(1) });
    const seen: Array<number> = [];
    const stop = local.watch(() => seen.push(readDerived(value)));
    writeCell(source, 1);

    expect(errors.map(String)).toEqual(["Error: equals"]);
    expect(() => readDerived(value)).toThrow("equals");
    writeCell(source, 2);
    expect(readDerived(value)).toBe(2);
    expect(seen.at(-1)).toBe(2);
    stop();
  });

  test("activate links everything and reports the change", () => {
    const local = quiet();
    const first = local.cell(0);
    const source = local.cell(0);
    const log: Array<string> = [];
    local.onObserved(first, () => {
      log.push("start");
      return () => log.push("stop");
    });
    const value = local.derived(() => readCell(source), { equals: throwingOn(1) });
    const reaction = new Reaction(local, () => {});
    reaction.track(() => readCell(first) + readDerived(value));
    writeCell(source, 1);

    expect(reaction.activate()).toBe(true);
    expect([observerCount(first), observerCount(value)]).toEqual([1, 1]);
    expect(() => readDerived(value)).toThrow("equals");
    reaction.deactivate();
    expect([observerCount(first), observerCount(value)]).toEqual([0, 0]);
    expect(log).toEqual(["start", "stop"]);
  });

  test("a render's relink that recomputes it leaves nothing linked after release", () => {
    const local = quiet();
    const before = local.cell(0);
    const first = local.cell(0);
    const atom = local.atom();
    const log: Array<string> = [];
    local.onObserved(first, () => {
      log.push("start");
      return () => log.push("stop");
    });
    // Volatile, so linking it recomputes it, and equals runs there.
    const value = local.derived(
      () => {
        readAtom(atom);
        return 1;
      },
      {
        equals: () => {
          throw new Error("equals");
        },
      },
    );
    const reaction = new Reaction(local, () => {});
    reaction.track(() => readCell(before));
    reaction.activate();

    expect(reaction.track(() => readCell(first) + readDerived(value))).toBe(1);
    reaction.deactivate();
    expect([observerCount(before), observerCount(first), observerCount(value)]).toEqual([0, 0, 0]);
    expect(log).toEqual(["start", "stop"]);
  });
});

describe("a reaction whose activate throws links nothing", () => {
  test("a link that throws lets go of what was linked before it", () => {
    const errors: Array<unknown> = [];
    const local = new Graph((error) => errors.push(error));
    const first = local.cell(0);
    const source = local.cell(0);
    const watched = local.cell(0);
    const stop = local.watch(() => readCell(watched));
    const log: Array<string> = [];
    local.onObserved(first, () => {
      log.push("start");
      return () => log.push("stop");
    });
    let reaction: Reaction | undefined;
    let armed = false;
    const value = local.derived(() => {
      const read = readCell(source);
      if (armed) {
        armed = false;
        // A hook that begins at once runs outside the compute's guard; its
        // activate links first, then reaches value, which is computing.
        local.onObservedNow(watched, () => {
          reaction?.activate();
          return undefined;
        });
      }
      return read;
    });
    reaction = new Reaction(local, () => {});
    reaction.track(() => readCell(first) + readDerived(value));
    armed = true;
    writeCell(source, 1);
    local.batch(() => readDerived(value));

    expect(errors.length).toBe(1);
    expect(String(errors[0])).toContain("cycle");
    expect(observerCount(first)).toBe(0);
    expect(log).toEqual([]);
    expect(reaction.activate()).toBe(true);
    expect(observerCount(first)).toBe(1);
    reaction.deactivate();
    expect(log).toEqual(["start", "stop"]);
    stop();
  });
});

describe("a computed value is current as of the version its check began at", () => {
  test("a hook that begins at once in a compute and writes what it read leaves it stale", () => {
    const local = quiet();
    const source = local.cell(0);
    const watched = local.cell(0);
    const stop = local.watch(() => readCell(watched));
    const value = local.derived(() => {
      const read = readCell(source);
      if (read === 0) {
        local.onObservedNow(watched, () => {
          writeCell(source, 1);
          return undefined;
        });
      }
      return read;
    });
    local.batch(() => readDerived(value));

    expect(readCell(source)).toBe(1);
    expect(readDerived(value)).toBe(1);
    stop();
  });

  test("an error it keeps from that run is stale too, for a read later in the same walk", () => {
    const local = quiet();
    const source = local.cell(0);
    const watched = local.cell(0);
    const stop = local.watch(() => readCell(watched));
    let runs = 0;
    const value = local.derived(() => {
      runs++;
      const read = readCell(source);
      if (read === 0) {
        local.onObservedNow(watched, () => {
          writeCell(source, 1);
          return undefined;
        });
        throw new Error("zero");
      }
      return read;
    });
    const attempt = (): unknown => {
      try {
        return readDerived(value);
      } catch (error) {
        return (error as Error).message;
      }
    };
    const outer = local.derived(() => [attempt(), attempt()]);

    expect(local.batch(() => readDerived(outer))).toEqual(["zero", 1]);
    expect(runs).toBe(2);
    expect(readDerived(value)).toBe(1);
    stop();
  });

  test("a cycle that closes on it mid-walk, after a hook wrote what it read, leaves it stale", () => {
    const local = quiet();
    const gate = local.cell(true);
    const trigger = local.cell(0);
    const watched = local.cell(0);
    const stop = local.watch(() => readCell(watched));
    let armed = false;
    let origin: DerivedNode<number> | undefined;
    const inner = local.derived(() => {
      const read = readCell(trigger);
      if (armed && origin !== undefined) {
        local.onObservedNow(watched, () => {
          writeCell(gate, false);
          return undefined;
        });
        return readDerived(origin);
      }
      return read;
    });
    origin = local.derived(() => (readCell(gate) ? readDerived(inner) : 7));
    const closed = origin;
    readDerived(closed);
    armed = true;
    const attempt = (): unknown => {
      try {
        return readDerived(closed);
      } catch (error) {
        return (error as Error).message.includes("cycle") ? "cycle" : error;
      }
    };
    const outer = local.derived(() => [attempt(), attempt()]);

    const pair = local.batch(() => {
      writeCell(trigger, 1);
      return readDerived(outer);
    });
    expect(pair).toEqual(["cycle", 7]);
    stop();
  });
});

describe("a computed value that turns volatile in a run with an equal value", () => {
  test("its readers learn it, and check it on every read", () => {
    const local = quiet();
    const mode = local.cell(false);
    const atom = local.atom();
    let outside = 1;
    const value = local.derived(() => {
      if (readCell(mode)) {
        readAtom(atom);
      }
      return outside;
    });
    const reader = local.derived(() => readDerived(value));
    expect(readDerived(reader)).toBe(1);
    writeCell(mode, true);
    expect(readDerived(reader)).toBe(1);
    outside = 2;

    expect(readDerived(value)).toBe(2);
    expect(readDerived(reader)).toBe(2);
  });

  // With the flag learned, a reader over a computing value is never current,
  // so its relink cannot reach that value through a stale cache.
  const build = () => {
    const local = quiet();
    const mode = local.cell(false);
    const flag = local.cell(false);
    const first = local.cell(0);
    const k = local.cell(1);
    const atom = local.atom();
    const log: Array<string> = [];
    local.onObserved(first, () => {
      log.push("start");
      return () => log.push("stop");
    });
    let armed = false;
    let middle: DerivedNode<number> | undefined;
    const outer = local.derived(() => {
      if (readCell(mode)) {
        readAtom(atom);
        if (armed) {
          armed = false;
          if (middle !== undefined) {
            readDerived(middle);
          }
        }
      }
      return readCell(k);
    });
    const inner = local.derived(() => readCell(first) + readDerived(outer));
    const seen: Array<number> = [];
    const watched = local.derived(() => (readCell(flag) ? readDerived(inner) : 0));
    middle = watched;
    const stop = local.watch(() => seen.push(readDerived(watched)));
    local.untracked(() => readDerived(inner));
    const arm = (): void => {
      armed = true;
    };
    return { local, mode, flag, first, k, outer, inner, stop, log, seen, arm };
  };

  test("a cycle met through it leaves nothing linked once everything is released", () => {
    const { local, first, inner, mode, flag, outer, stop, log, arm } = build();
    local.batch(() => {
      writeCell(mode, true);
      writeCell(flag, true);
      readDerived(inner);
      arm();
      try {
        readDerived(outer);
      } catch {}
      writeCell(flag, false);
    });
    stop();

    expect([observerCount(inner), observerCount(first)]).toEqual([0, 0]);
    expect(log.filter((event) => event === "start").length).toBe(
      log.filter((event) => event === "stop").length,
    );
  });

  test("a cycle met through it is kept only by the value it began at, so the watch recovers", () => {
    const { local, inner, first, mode, flag, outer, k, stop, seen, arm } = build();
    local.batch(() => {
      writeCell(mode, true);
      writeCell(flag, true);
      readDerived(inner);
      arm();
      try {
        readDerived(outer);
      } catch {}
    });
    writeCell(k, 5);

    // The cycle began at outer; the watched value, between outer and the read
    // that closed it, kept nothing and read again when the batch ended.
    expect(seen).toEqual([0, 1, 5]);
    expect([observerCount(inner), observerCount(first)]).toEqual([1, 1]);
    stop();
    expect([observerCount(inner), observerCount(first)]).toEqual([0, 0]);
  });

  test("through the realm, a cycle met through it leaves nothing observed", () => {
    const realm = createRealm({ onError: () => {} });
    const $mode = box(realm, false);
    const $flag = box(realm, false);
    const $first = box(realm, 0);
    const $k = box(realm, 1);
    const $atom = atom(realm);
    const events: Array<string> = [];
    onObserved($first, () => {
      events.push("start");
      return () => events.push("stop");
    });
    let armed = false;
    let $middle: Computed<number> | undefined;
    const $outer = computed(realm, (read) => {
      if (read($mode)) {
        read($atom);
        if (armed) {
          armed = false;
          if ($middle !== undefined) {
            read($middle);
          }
        }
      }
      return read($k);
    });
    const $inner = computed(realm, (read) => read($first) + read($outer));
    const $watched = computed(realm, (read) => (read($flag) ? read($inner) : 0));
    $middle = $watched;
    const stop = autorun(realm, (read) => {
      read($watched);
    });
    untracked(realm, (read) => read($inner));
    update(realm, (read, write) => {
      write($mode, true);
      write($flag, true);
      read($inner);
      armed = true;
      try {
        read($outer);
      } catch {}
      write($flag, false);
    });
    stop();

    expect(inspect($inner).observers).toBe(0);
    expect(inspect($first).observers).toBe(0);
    expect(events.filter((event) => event === "start").length).toBe(
      events.filter((event) => event === "stop").length,
    );
  });
});

describe("a value that turns volatile with an equal value is unchanged", () => {
  const build = () => {
    const local = quiet();
    const mode = local.cell(false);
    const atom = local.atom();
    const value = local.derived(
      () => {
        if (readCell(mode)) {
          readAtom(atom);
        }
        return [1, 2];
      },
      {
        equals: (left, right) =>
          left.length === right.length && left.every((item, index) => item === right[index]),
      },
    );
    return { local, mode, value };
  };

  test("it keeps its previous instance", () => {
    const { mode, value } = build();
    const before = readDerived(value);
    writeCell(mode, true);

    expect(readDerived(value)).toBe(before);
  });

  test("a watch over it does not rerun", () => {
    const { local, mode, value } = build();
    let runs = 0;
    const stop = local.watch(() => {
      runs++;
      return readDerived(value);
    });
    writeCell(mode, true);

    expect(runs).toBe(1);
    stop();
  });

  test("a reaction over it is not told of a change", () => {
    const { local, mode, value } = build();
    let changes = 0;
    const reaction = new Reaction(local, () => changes++);
    reaction.track(() => readDerived(value));
    reaction.activate();
    writeCell(mode, true);

    expect(changes).toBe(0);
    reaction.deactivate();
  });

  test("a realm autorun over it does not rerun", () => {
    const realm = createRealm({ onError: () => {} });
    const $mode = box(realm, false);
    const $atom = atom(realm);
    const $value = computed(realm, (read) => {
      if (read($mode)) {
        read($atom);
      }
      return 1;
    });
    let runs = 0;
    const stop = autorun(realm, (read) => {
      runs++;
      read($value);
    });
    update(realm, (_read, write) => {
      write($mode, true);
    });

    expect(runs).toBe(1);
    stop();
  });
});

describe("a read of a computed value from inside its own equals", () => {
  test("is a cycle, kept as the value's error, and both recover", () => {
    const local = quiet();
    const source = local.cell(0);
    let reader: DerivedNode<number> | undefined;
    const value = local.derived(() => readCell(source), {
      equals: (left, right) => {
        if (reader !== undefined) {
          readDerived(reader);
        }
        return left === right;
      },
    });
    const read = local.derived(() => readDerived(value) * 10);
    reader = read;
    expect(readDerived(read)).toBe(0);
    writeCell(source, 1);

    expect(() => readDerived(value)).toThrow("cycle");
    expect(() => readDerived(read)).toThrow("cycle");
    reader = undefined;
    writeCell(source, 2);
    expect(readDerived(value)).toBe(2);
    expect(readDerived(read)).toBe(20);
  });
});
