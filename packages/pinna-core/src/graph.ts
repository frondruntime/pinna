/**
 * Pinna's reactive graph: cells, derived values, watches, and reactions,
 * joined by edge objects that a rerun reuses in place. Walks are iterative
 * and the hot paths are free functions, and every feature a cached read
 * does not need stays off its path. `docs/design.md` describes the design.
 *
 * Invariants the code relies on:
 *
 * - One node type. Every node is a plain `Node` object with no prototype;
 *   the functions in the public section take it by kind.
 * - An edge is in its source's observer list exactly while its observer is
 *   observed (`observers > 0`, a live watch, or an active reaction).
 * - A node is current (`checkedAt === clock`) only if it holds a value no
 *   source can have changed since, and it is neither volatile nor thrown.
 *   Thrown and volatile nodes are never current, so their reads take the
 *   slow branch and nothing on the cached branch asks about them.
 * - `computing` or `cursor !== undefined` means the node is mid-run or
 *   mid-walk. A read that reaches such a node is a cycle.
 * - Linking never runs user code: it is pointer work over the lists the last
 *   runs left, and a following refresh fixes whatever was stale.
 * - An observer that still reads a source keeps its place in that source's
 *   observer list: the run-end reconcile moves the old edge instead of
 *   appending a new one.
 * - A mark is skipped only when every observer of the node was marked by the
 *   same write and no link was added since (`markFloor` moves on every link
 *   and at every settle step). A whole source's mark is skipped only when it
 *   was the last source marked and the floor has not moved since.
 * - Every version number comes from one graph counter and is never issued
 *   twice, so a restored cell version is safe.
 */

export type Equals<Value> = (left: Value, right: Value) => boolean;

export interface Options<Value> {
  readonly equals?: Equals<Value> | undefined;
  readonly label?: string | undefined;
}

/**
 * A node's `kind`. The order is relied on: a kind up to `DERIVED` is a
 * source other nodes can read, and one above it only reads.
 */
const CELL = 0;
const ATOM = 1;
const DERIVED = 2;
const WATCH = 3;
const REACTION = 4;
/** The node a reaction's pending run records into: never linked, never walked. */
const PENDING = 5;

/** A node's `status`: what its last run left. */
const EMPTY = 0;
const VALUE = 1;
const ERROR = 2;

const maximumSettleRounds = 100;

/**
 * How many stale reads nest before the next one waits. A chain of first
 * computes or refreshes can recurse through user code, one call stack frame
 * set per value: past this depth the read throws `suspension`, the outermost
 * read brings the value it stopped at current from its own shallow stack,
 * then retries. Well under the depth a stack holds: about 1,000 on
 * Node and 1,100 on Hermes, less what the caller is already inside of.
 */
const maximumComputeDepth = 256;

/**
 * Thrown by a stale read past `maximumComputeDepth`, and through every compute
 * above it, even one whose compute catches it. Each discards the unfinished
 * result, retaining a cached value only for the retry's equality check.
 * Never reaches code outside a compute.
 */
const suspension = new Error("pinna: a compute past the depth limit waits (internal)");

class CycleError extends Error {
  constructor(readonly origin: Node) {
    super(`pinna: ${origin.label ?? "a derived value"} is read while it computes (cycle)`);
  }
}

/**
 * A read of `origin` mid-run. The run that read it, and each run around it,
 * drops its links back as it ends, even if its compute catches the error, and
 * ends volatile: a value made from one the cycle empties is never current, so
 * each read walks it until it computes with no cycle.
 */
const meetCycle = (graph: Graph, origin: Node): CycleError => {
  graph.cycleRun = graph.run;
  return new CycleError(origin);
};

interface Edge {
  source: Node;
  observer: Node;
  /** The read version, or -1 to retry an interrupted cached compute. */
  version: number;
  nextDependency: Edge | undefined;
  previousObserver: Edge | undefined;
  nextObserver: Edge | undefined;
  linked: boolean;
}

/** Membership through `through` in a wide run with nested reads. */
interface ReadIndex {
  readonly sources: Set<Node>;
  through: Edge;
}

type Start = () => (() => void) | undefined;

/**
 * The `onObserved` hooks of a source, made on the first one. Each hook
 * begins at most once until it ends, so starting or stopping twice does
 * nothing.
 */
interface Hooks {
  /** The hooks, in the order they were added. */
  readonly starts: Array<Start>;
  /** The hooks that have begun, in the order they began. */
  readonly begun: Array<Start>;
  /** The cleanup of each hook in `begun`, at the same index. */
  readonly cleanups: Array<(() => void) | undefined>;
  /**
   * Whether the hooks have started, as of the last settle. The observer
   * count is not this: it moves with the links, and the hooks follow it at
   * the settle.
   */
  started: boolean;
  /** A hook removed inside a compute has begun, and ends at the settle. */
  endsDue: boolean;
  /** Queued in the graph's `hooksDue`. */
  due: boolean;
}

/** What a settle returns when no reporter threw an error it is to throw. */
const noFailure: unknown = {};

/**
 * The `nextDue` of the last watcher in the queue, and the `nextInRound` of
 * the last watcher in a round, so that a set link means a member. Only
 * compared, never read.
 */
const endOfDue = {} as Node;

/**
 * Where an error goes when a graph's owner gives no reporter, or when the
 * reporter throws: the host's `reportError`, as an uncaught error.
 */
export const reportUncaught = (error: unknown): void => {
  if (typeof globalThis.reportError === "function") {
    globalThis.reportError(error);
  } else {
    queueMicrotask(() => {
      throw error;
    });
  }
};

/** `reportUncaught` for an error that must not hide the one being thrown. */
const reportHidden = (error: unknown): void => {
  try {
    reportUncaught(error);
  } catch {
    // A host reporter that throws must not hide the error being thrown.
  }
};

/**
 * One type for every kind, in two shapes:
 *
 * - a cell or an atom: the common fields (kind through graph) and the source
 *   fields (readBy through hooks);
 * - every other kind: all fields. A derived value never uses `effect`,
 *   `nextDue`, or `nextInRound`, and keeps its dirty mark in `linked`; a
 *   watch, a reaction, or a pending node never uses the source fields, but
 *   one shape keeps every observer-side property read monomorphic, which is
 *   worth the bytes (measured on Hermes).
 *
 * A field outside a node's shape is never read on it: every such read is
 * behind a kind check. Nodes are made by the plain object literals below,
 * never by `new` and with no prototype: on Hermes a literal is sized to its
 * fields, while assigned fields grow the storage in steps and leave the old
 * storage as garbage; on V8 a literal that sets `__proto__` goes through a
 * runtime call, which made making and disposing nodes five times slower.
 */
export interface Node {
  kind: number;
  version: number;
  value: unknown;
  equals: Equals<unknown>;
  label: string | undefined;
  /** Reads an unobserved atom, directly or below: checked again on every outermost walk. */
  volatile: boolean;
  /** The walk that last checked a node that is never current: volatile or thrown. */
  walkedAt: number;
  readonly graph: Graph;

  readBy: number;
  observersHead: Edge | undefined;
  observersTail: Edge | undefined;
  observers: number;
  /** Run-end reconcile scratch: the stale edge of this source and the reconcile that stamped it. */
  staleEdge: Edge | undefined;
  staleStamp: number;
  hooks: Hooks | undefined;

  checkedAt: number;
  /** The clock at which a volatile or thrown result was checked in `walkedAt`. */
  walkedClock: number;
  markedAt: number;
  dependenciesHead: Edge | undefined;
  cursor: Edge | undefined;
  compute: ((argument: never) => unknown) | undefined;
  /** The source whose change made the last run, `undefined` for a first run. */
  cause: Node | undefined;
  /**
   * `EMPTY` before a run is kept, `VALUE` while a value is, `ERROR` while an
   * error is, until a source changes. A watch or a reaction that has run is
   * `VALUE`.
   */
  status: number;
  computing: boolean;
  /** A run that added an edge, so the run end reconciles. */
  added: boolean;
  /** Allocated only for a wide run's nested-read membership checks. */
  readIndex: ReadIndex | undefined;

  effect: ((value: unknown, previous: unknown) => void) | undefined;
  /**
   * The next watcher in the queue for the next round, `endOfDue` for the
   * last, or `undefined` while this one is not in it: a watcher is due
   * exactly while this is set.
   */
  nextDue: Node | undefined;
  /**
   * The next watcher of the round being run, `endOfDue` for the last, or
   * `undefined` while this one is not waiting in it.
   */
  nextInRound: Node | undefined;
  /**
   * Two meanings, by kind:
   *
   * - a watch or a reaction: linked, its edges are in its sources' observer
   *   lists; a watch until disposed, a reaction while active. Never set on a
   *   pending node.
   * - a derived value: dirty, a cell or an atom it reads directly took a new
   *   version since its last run, so it recomputes with no walk. Set by
   *   `mark` for a write, cleared by `mark` for a restore, by the end of a
   *   run, and when it loses its last observer, so it is never set on a
   *   value nothing observes. It is read only on a value with one source.
   *   A value that keeps an error outside its own run is never dirty with
   *   one source, since the walk recomputes such a value rather than walk
   *   into it; one with more sources may stay dirty, which stays true: its
   *   edges change only in a run, and the run clears the mark.
   *
   * Every read is behind a kind check: a dirty derived value is never linked.
   */
  linked: boolean;
}

/** A cell or an atom. */
const makeSource = (
  graph: Graph,
  kind: number,
  value: unknown,
  equals: Equals<unknown>,
  label: string | undefined,
): Node =>
  ({
    kind,
    version: 0,
    value,
    equals,
    label,
    volatile: kind === ATOM,
    walkedAt: 0,
    graph,
    readBy: 0,
    observersHead: undefined,
    observersTail: undefined,
    observers: 0,
    staleEdge: undefined,
    staleStamp: 0,
    hooks: undefined,
  }) as Node;

/** A derived value, a watch, a reaction, or a reaction's pending node. */
const makeObserver = (
  graph: Graph,
  kind: number,
  compute: ((argument: never) => unknown) | undefined,
  effect: ((value: unknown, previous: unknown) => void) | undefined,
  equals: Equals<unknown>,
  label: string | undefined,
): Node =>
  ({
    kind,
    version: 0,
    value: undefined,
    equals,
    label,
    volatile: false,
    walkedAt: 0,
    graph,
    readBy: 0,
    observersHead: undefined,
    observersTail: undefined,
    observers: 0,
    staleEdge: undefined,
    staleStamp: 0,
    hooks: undefined,
    checkedAt: -1,
    walkedClock: -1,
    markedAt: -1,
    dependenciesHead: undefined,
    cursor: undefined,
    compute,
    cause: undefined,
    status: EMPTY,
    computing: false,
    added: false,
    readIndex: undefined,
    effect,
    nextDue: undefined,
    nextInRound: undefined,
    linked: kind === WATCH,
  }) as Node;

/* ---------------------------------------------------------------- edges */

const append = (edge: Edge): void => {
  const source = edge.source;
  edge.linked = true;
  edge.previousObserver = source.observersTail;
  edge.nextObserver = undefined;
  if (source.observersTail !== undefined) {
    source.observersTail.nextObserver = edge;
  } else {
    source.observersHead = edge;
  }
  source.observersTail = edge;
};

const detach = (edge: Edge): void => {
  const source = edge.source;
  edge.linked = false;
  const previous = edge.previousObserver;
  const next = edge.nextObserver;
  if (previous !== undefined) {
    previous.nextObserver = next;
  } else {
    source.observersHead = next;
  }
  if (next !== undefined) {
    next.previousObserver = previous;
  } else {
    source.observersTail = previous;
  }
  edge.previousObserver = undefined;
  edge.nextObserver = undefined;
};

/** Queues `node`'s hooks for the settle, once. */
const queueHooks = (graph: Graph, node: Node): void => {
  const hooks = node.hooks as Hooks;
  if (!hooks.due) {
    hooks.due = true;
    graph.hooksDue.push(node);
  }
};

/** A source lost its last observer: the counterpart of `becomeObserved`. */
const becomeUnobserved = (graph: Graph, source: Node): void => {
  if (source.kind === ATOM) {
    // Nothing tells the graph when an unobserved atom changes: every cached
    // value is checked again, and the walk gives the atom a fresh version.
    source.volatile = true;
    graph.clock++;
  }
};

/**
 * Queues the hooks of the sources a link or an unlink reached, from the
 * source up: a value's hooks are due after those of what it reads. The
 * walk visits a value, then its sources from the last; the reverse of that
 * visit is each value after its sources, in read order.
 */
const queueHooksFromSources = (graph: Graph, base: number): void => {
  const order = graph.linkOrder;
  while (order.length > base) {
    queueHooks(graph, order.pop() as Node);
  }
};

/**
 * An atom gained its first observer. Nothing told the graph what it did
 * while unobserved, so unless this walk checked it already, the link is a
 * change: whatever read it before checks it again.
 */
const becomeObserved = (graph: Graph, atom: Node): void => {
  if (atom.volatile) {
    atom.volatile = false;
    if (atom.walkedAt !== graph.walk) {
      atom.walkedAt = graph.walk;
      atom.version = ++graph.versions;
    }
  }
};

/** Links `edge`, and, when its source gains its first observer, the source's own edges, transitively. No user code runs. */
const subscribe = (graph: Graph, edge: Edge): void => {
  // A new observer was not marked by the writes before it: no mark is
  // skipped on its account until the next settle step.
  graph.markFloor = graph.clock;
  graph.lastMarked = undefined;
  // `append`, inline: Hermes does not inline it.
  const source = edge.source;
  edge.linked = true;
  const tail = source.observersTail;
  edge.previousObserver = tail;
  edge.nextObserver = undefined;
  if (tail !== undefined) {
    tail.nextObserver = edge;
  } else {
    source.observersHead = edge;
  }
  source.observersTail = edge;
  if (source.observers++ !== 0) {
    return;
  }
  if (source.kind !== DERIVED) {
    if (source.kind === ATOM) {
      becomeObserved(graph, source);
    }
    if (source.hooks !== undefined) {
      queueHooks(graph, source);
    }
    return;
  }
  const stack = graph.linkStack;
  const order = graph.linkOrder;
  const base = stack.length;
  const orderBase = order.length;
  // The source is handled first without the stack: most links reach no deeper.
  for (
    let node: Node | undefined = source;
    node !== undefined;
    node = stack.length > base ? (stack.pop() as Node) : undefined
  ) {
    if (node.hooks !== undefined) {
      order.push(node);
    }
    if (node.kind !== DERIVED) {
      if (node.kind === ATOM) {
        becomeObserved(graph, node);
      }
      continue;
    }
    for (
      let dependency = node.dependenciesHead;
      dependency !== undefined;
      dependency = dependency.nextDependency
    ) {
      append(dependency);
      const below = dependency.source;
      if (below.observers++ === 0) {
        stack.push(below);
      }
    }
  }
  if (order.length !== orderBase) {
    queueHooksFromSources(graph, orderBase);
  }
};

/** Unlinks `edge`, and, when its source loses its last observer, the source's own edges, transitively. */
const unsubscribe = (graph: Graph, edge: Edge): void => {
  // `detach`, inline: Hermes does not inline it.
  const source = edge.source;
  edge.linked = false;
  const previous = edge.previousObserver;
  const next = edge.nextObserver;
  if (previous !== undefined) {
    previous.nextObserver = next;
  } else {
    source.observersHead = next;
  }
  if (next !== undefined) {
    next.previousObserver = previous;
  } else {
    source.observersTail = previous;
  }
  edge.previousObserver = undefined;
  edge.nextObserver = undefined;
  if (--source.observers !== 0) {
    return;
  }
  if (source.kind !== DERIVED) {
    becomeUnobserved(graph, source);
    if (source.hooks !== undefined) {
      queueHooks(graph, source);
    }
    return;
  }
  const stack = graph.linkStack;
  const order = graph.linkOrder;
  const base = stack.length;
  const orderBase = order.length;
  for (
    let node: Node | undefined = source;
    node !== undefined;
    node = stack.length > base ? (stack.pop() as Node) : undefined
  ) {
    if (node.hooks !== undefined) {
      order.push(node);
    }
    if (node.kind !== DERIVED) {
      becomeUnobserved(graph, node);
      continue;
    }
    // Not dirty (`linked` on a derived value): a value nothing observes
    // hears no mark, so a restore's mark could not clear it.
    node.linked = false;
    for (
      let dependency = node.dependenciesHead;
      dependency !== undefined;
      dependency = dependency.nextDependency
    ) {
      // A run in progress has added this edge and not linked it yet: the
      // node lost its last observer partway through its own run.
      if (!dependency.linked) {
        continue;
      }
      detach(dependency);
      const below = dependency.source;
      if (--below.observers === 0) {
        stack.push(below);
      }
    }
  }
  if (order.length !== orderBase) {
    queueHooksFromSources(graph, orderBase);
  }
};

/* ------------------------------------------------------------ recording */

/**
 * Records a read of `source` by the active run: the hot path. Reuses the edge
 * in place when the run reads what the last one read. `readCell` and
 * `readDerived` hold copies of it; change all three together.
 */
const record = (graph: Graph, source: Node): void => {
  const run = graph.run;
  const readBy = source.readBy;
  if (readBy >= run) {
    if (readBy !== run) {
      cold.recordAfterNested(graph, source);
    }
    return;
  }
  source.readBy = run;
  const observer = graph.active as Node;
  const cursor = observer.cursor;
  const next = cursor === undefined ? observer.dependenciesHead : cursor.nextDependency;
  if (next !== undefined && next.source === source) {
    next.version = source.version;
    observer.cursor = next;
    return;
  }
  recordMiss(observer, source, cursor, next);
};

/**
 * Paths kept out of `record` and `recompute`. A method call keeps hermesc
 * from inlining them into the hot path.
 */
const cold = {
  /** Keeps a suspended cached value for equality, but forces its unfinished compute to retry. */
  passOn(node: Node, value: unknown, cause: Node | undefined): never {
    if (value !== suspension || node.status !== VALUE) {
      node.status = EMPTY;
      node.value = undefined;
    } else {
      // The interrupted run already updated its read versions. Force a retry
      // even if the value it waited for stays equal: its own result is still
      // unfinished. A cached compute has a source that made it stale; a
      // failed run retains that edge even if it stopped reading the source.
      let retry = node.dependenciesHead as Edge;
      for (let edge: Edge | undefined = retry; edge !== undefined; edge = edge.nextDependency) {
        if (edge.source === cause) {
          retry = edge;
          break;
        }
      }
      retry.version = -1;
    }
    if (value === suspension) {
      // An interrupted volatile run was not checked, even within this walk.
      node.walkedAt = 0;
    }
    node.cause = cause;
    throw value;
  },
  /**
   * Records a read of a source that a run begun inside this one read last,
   * so this run may have read it before that run began.
   */
  recordAfterNested(graph: Graph, source: Node): void {
    source.readBy = graph.run;
    const observer = graph.active as Node;
    const cursor = observer.cursor;
    const next = cursor === undefined ? observer.dependenciesHead : cursor.nextDependency;
    // Before an insertion, every dependency occurs once: the next edge
    // cannot be in the prefix. A matching next edge needs no membership check.
    if (!observer.added && next !== undefined && next.source === source) {
      next.version = source.version;
      observer.cursor = next;
      return;
    }
    if (readBeforeIndexed(observer, source, cursor)) {
      return;
    }
    if (next !== undefined && next.source === source) {
      next.version = source.version;
      observer.cursor = next;
      return;
    }
    recordMiss(observer, source, cursor, next);
  },
};

/** Indexes wide prefixes only after a nested read needs a long membership scan. */
const readBeforeIndexed = (observer: Node, source: Node, cursor: Edge | undefined): boolean => {
  if (cursor === undefined) return false;
  let index = observer.readIndex;
  if (index === undefined) {
    let scanned = 0;
    for (let edge = observer.dependenciesHead; edge !== undefined; edge = edge.nextDependency) {
      if (edge.source === source) return true;
      if (edge === cursor) return false;
      if (++scanned === 32) {
        index = { sources: new Set(), through: edge };
        observer.readIndex = index;
        for (let prefix = observer.dependenciesHead; prefix !== edge; ) {
          index.sources.add((prefix as Edge).source);
          prefix = (prefix as Edge).nextDependency;
        }
        index.sources.add(edge.source);
        break;
      }
    }
    if (index === undefined) return false;
  }
  while (index.through !== cursor) {
    index.through = index.through.nextDependency as Edge;
    index.sources.add(index.through.source);
  }
  return index.sources.has(source);
};

/** Whether the run in progress has an edge to `source` up to `cursor`, its last read. */
const readBefore = (observer: Node, source: Node, cursor: Edge | undefined): boolean => {
  if (cursor === undefined) {
    return false;
  }
  for (let edge = observer.dependenciesHead; edge !== undefined; edge = edge.nextDependency) {
    if (edge.source === source) {
      return true;
    }
    if (edge === cursor) {
      return false;
    }
  }
  return false;
};

/** Removes `node`'s edges to `source`, unlinking a linked one. */
const dropSource = (graph: Graph, node: Node, source: Node): void => {
  let previous: Edge | undefined;
  for (let edge = node.dependenciesHead; edge !== undefined; edge = edge.nextDependency) {
    if (edge.source !== source) {
      previous = edge;
      continue;
    }
    if (previous === undefined) {
      node.dependenciesHead = edge.nextDependency;
    } else {
      previous.nextDependency = edge.nextDependency;
    }
    if (edge.linked) {
      unsubscribe(graph, edge);
    }
  }
};

/** Drops each edge of `node` to a value still mid-run. Returns whether it dropped one. */
const dropLinksBack = (graph: Graph, node: Node): boolean => {
  let dropped = false;
  let edge = node.dependenciesHead;
  while (edge !== undefined) {
    const next = edge.nextDependency;
    const source = edge.source;
    if (source.computing || source.cursor !== undefined) {
      dropSource(graph, node, source);
      dropped = true;
    }
    edge = next;
  }
  return dropped;
};

/** Whether the run numbered `run`, now ended at `last`, read `source`. */
const readInRun = (node: Node, source: Node, run: number, last: Edge | undefined): boolean => {
  const readBy = source.readBy;
  return readBy === run || (readBy > run && readBefore(node, source, last));
};

const recordMiss = (
  observer: Node,
  source: Node,
  cursor: Edge | undefined,
  next: Edge | undefined,
): void => {
  const edge: Edge = {
    source,
    observer,
    version: source.version,
    nextDependency: next,
    previousObserver: undefined,
    nextObserver: undefined,
    linked: false,
  };
  if (cursor === undefined) {
    observer.dependenciesHead = edge;
  } else {
    cursor.nextDependency = edge;
  }
  observer.cursor = edge;
  observer.added = true;
};

/** Whether `node`'s edges belong in their sources' observer lists. */
const observed = (node: Node): boolean =>
  node.kind === DERIVED ? node.observers > 0 : node.linked;

/**
 * Ends a run: drops the edges after the last one read, then, only when an
 * observed run added an edge or dropped a linked one, reconciles.
 * `recompute` and `runWatch` hold copies of its case with nothing to drop;
 * change all three together.
 */
const finishRun = (graph: Graph, node: Node): void => {
  const last = node.cursor;
  const stale = last === undefined ? node.dependenciesHead : last.nextDependency;
  if (last === undefined) {
    node.dependenciesHead = undefined;
  } else {
    last.nextDependency = undefined;
  }
  node.cursor = undefined;
  if (stale?.linked) {
    reconcile(graph, node, stale, observed(node));
  } else if (node.added && observed(node)) {
    reconcile(graph, node, stale, true);
  }
  node.added = false;
  node.readIndex = undefined;
};

/**
 * Ends a run numbered `failedRun` that threw. It does not know what it would
 * have read, so it keeps the edges after its last read too, but for sources
 * it read.
 */
const finishFailedRun = (graph: Graph, node: Node, failedRun: number): void => {
  const last = node.cursor;
  const stale = last === undefined ? node.dependenciesHead : last.nextDependency;
  if (stale !== undefined) {
    let kept: Edge | undefined;
    let keptEnd: Edge | undefined;
    let dropped: Edge | undefined;
    let droppedEnd: Edge | undefined;
    for (let edge: Edge | undefined = stale; edge !== undefined; ) {
      const following: Edge | undefined = edge.nextDependency;
      edge.nextDependency = undefined;
      if (readInRun(node, edge.source, failedRun, last)) {
        if (droppedEnd === undefined) {
          dropped = edge;
        } else {
          droppedEnd.nextDependency = edge;
        }
        droppedEnd = edge;
      } else {
        if (keptEnd === undefined) {
          kept = edge;
        } else {
          keptEnd.nextDependency = edge;
        }
        keptEnd = edge;
      }
      edge = following;
    }
    // The kept edges go back in place, the dropped ones after them, and the
    // cursor at the last kept: `finishRun` drops the rest.
    if (keptEnd !== undefined) {
      keptEnd.nextDependency = dropped;
    }
    if (last === undefined) {
      node.dependenciesHead = kept ?? dropped;
    } else {
      last.nextDependency = kept ?? dropped;
    }
    node.cursor = keptEnd ?? last;
  }
  finishRun(graph, node);
};

/**
 * Makes the observer lists match `node`'s edges. A source still read keeps
 * its old edge, and so its place among the source's observers; a source
 * newly read is linked, when `node` is `observing`; a source no longer read
 * is unlinked. The caller passes `observing`, since it often knows it already.
 */
const reconcile = (graph: Graph, node: Node, stale: Edge | undefined, observing: boolean): void => {
  const linked = stale?.linked === true;
  const stamp = linked ? ++graph.stamps : 0;
  if (linked) {
    for (let edge: Edge | undefined = stale; edge !== undefined; edge = edge.nextDependency) {
      edge.source.staleEdge = edge;
      edge.source.staleStamp = stamp;
    }
  }
  if (observing) {
    let previous: Edge | undefined;
    for (
      let edge = node.dependenciesHead;
      edge !== undefined;
      previous = edge, edge = edge.nextDependency
    ) {
      if (edge.linked) {
        continue;
      }
      const source = edge.source;
      if (linked && source.staleStamp === stamp) {
        // The old edge moves into the list, and so out of the stale one the
        // walk below follows: its successor there waits in `staleEdge`, and
        // the negated stamp says so.
        const old = source.staleEdge as Edge;
        source.staleStamp = -stamp;
        source.staleEdge = old.nextDependency;
        old.version = edge.version;
        old.nextDependency = edge.nextDependency;
        if (previous === undefined) {
          node.dependenciesHead = old;
        } else {
          previous.nextDependency = old;
        }
        edge = old;
      } else {
        subscribe(graph, edge);
      }
    }
  }
  if (linked) {
    for (let edge: Edge | undefined = stale; edge !== undefined; ) {
      const source: Node = edge.source;
      let following: Edge | undefined;
      if (source.staleStamp === stamp) {
        following = edge.nextDependency;
        unsubscribe(graph, edge);
      } else {
        // Moved into the list above.
        following = source.staleEdge;
      }
      source.staleStamp = 0;
      source.staleEdge = undefined;
      edge = following;
    }
  }
};

/* ------------------------------------------------------------ computing */

const derivingWriteError = (graph: Graph): Error =>
  new Error(`pinna: ${graph.deriving?.label ?? "a derived value"} cannot write while it computes`);

const isDeriving = (graph: Graph): boolean => graph.deriving !== undefined;

const checkObserving = (graph: Graph): void => {
  const deriving = graph.deriving;
  if (deriving !== undefined) {
    throw new Error(
      `pinna: ${deriving.label ?? "a derived value"} cannot observe or release while it computes`,
    );
  }
};

/**
 * Keeps `error` as `node`'s value until a source changes. It is current as
 * of `clock`: a run's error, as of the clock the run began at, so a write a
 * hook made while it ran leaves the error due for another check.
 */
const keep = (
  graph: Graph,
  node: Node,
  error: unknown,
  cause: Node | undefined,
  clock: number,
): void => {
  node.value = error;
  node.version = ++graph.versions;
  node.status = ERROR;
  node.cause = cause;
  node.walkedAt = graph.walk;
  node.walkedClock = clock;
};

/**
 * Runs a derived value's compute and keeps the result: a value, or an error
 * kept until a source changes. A cycle error from another origin is handed
 * on: the node keeps no value and no link to the origin, and throws.
 */
const recompute = (graph: Graph, node: Node, cause: Node | undefined): void => {
  // Current as of the clock the run began at: a write a hook makes while it
  // runs leaves the value due for another check.
  const clock = graph.clock;
  const outer = graph.active;
  const outerDeriving = graph.deriving;
  const outerRun = graph.run;
  graph.active = node;
  graph.deriving = node;
  const run = ++graph.runs;
  graph.run = run;
  node.cursor = undefined;
  node.added = false;
  node.computing = true;
  let value: unknown;
  let thrown = false;
  let passedOn = false;
  let same = false;
  try {
    value = (node.compute as (argument: unknown) => unknown)(graph.argument);
    if (node.status === VALUE) {
      // Equals is part of the compute, untracked: it cannot observe or write.
      graph.active = undefined;
      same = node.equals(node.value, value);
    }
  } catch (error) {
    // Equals runs with the run set aside; a cycle it hands on is the run's read.
    graph.active = node;
    thrown = true;
    value = error;
    if (error instanceof CycleError && error.origin !== node) {
      passedOn = true;
    }
  } finally {
    // A read inside the run waits: whatever the compute did with that, the
    // run discards its unfinished result and hands the wait on.
    if (graph.suspended !== undefined) {
      passedOn = true;
      value = suspension;
    }
    node.computing = false;
    // Not dirty (`linked` on a derived value): a mark during the run leaves
    // the value stale with its clock, and the walk finds that change by its
    // version.
    node.linked = false;
    graph.active = outer;
    graph.deriving = outerDeriving;
    graph.run = outerRun;
    if (passedOn) {
      finishFailedRun(graph, node, run);
    } else {
      // `finishRun`'s case with nothing to drop, inline: Hermes does not inline it.
      // `finishRun` and `runWatch` hold the same code; change all three together.
      // The run moved the cursor since it was cleared; TypeScript cannot see that.
      const last = node.cursor as Edge | undefined;
      const stale = last === undefined ? node.dependenciesHead : last.nextDependency;
      if (stale === undefined) {
        node.cursor = undefined;
        node.readIndex = undefined;
        if (node.added) {
          // `reconcile` with nothing stale: link each new edge when observed.
          // A first compute is unobserved and links nothing.
          node.added = false;
          if (node.observers > 0) {
            for (let edge = node.dependenciesHead; edge !== undefined; edge = edge.nextDependency) {
              if (!edge.linked) {
                subscribe(graph, edge);
              }
            }
          }
        }
      } else {
        finishRun(graph, node);
      }
    }
  }
  if (passedOn && value !== suspension) {
    // The origin reads this value, so a link back to it would be a cycle of
    // links that keeps both observed. The origin follows this value instead.
    dropSource(graph, node, (value as CycleError).origin);
  }
  // A run that met a cycle, or ran one that did, and caught the error: a link
  // to a value still mid-run would close a cycle of links that keeps both
  // observed, so it goes, and the value computes again at its next read, as
  // one the error passed.
  const linkedBack = graph.cycleRun >= run && !passedOn && dropLinksBack(graph, node);
  node.volatile = graph.volatileRun === run || graph.cycleRun >= run;
  if (node.volatile) {
    node.walkedAt = graph.walk;
    node.walkedClock = clock;
  }
  if (passedOn) {
    cold.passOn(node, value, cause);
  }
  if (thrown) {
    keep(graph, node, value, cause, clock);
    return;
  }
  if (!same) {
    node.value = value;
    node.version = ++graph.versions;
  }
  if (linkedBack) {
    node.status = EMPTY;
    node.cause = cause;
    return;
  }
  node.status = VALUE;
  node.cause = cause;
  if (!node.volatile) {
    node.checkedAt = clock;
  }
};

/**
 * Brings `root` current, iteratively: walks down to the first changed
 * source, recomputes on the way back up. Returns the source whose change
 * made `root` stale, or `undefined`. Depth costs no call stack; only a
 * compute that runs user code recurses, through that code.
 */
const refresh = (graph: Graph, root: Node): Node | undefined => {
  if (root.computing || root.cursor !== undefined) {
    throw meetCycle(graph, root);
  }
  if (graph.walkDepth++ === 0) {
    graph.walk++;
  }
  if (root.status === EMPTY) {
    try {
      // Only a derived value computes here: a watch whose first run threw
      // was unlinked before the settle.
      if (root.kind === DERIVED) {
        recompute(graph, root, undefined);
      }
    } finally {
      graph.walkDepth--;
    }
    return undefined;
  }
  const first = root.dependenciesHead;
  // `linked` on a derived value is its dirty mark.
  if (root.kind === DERIVED && root.linked && first !== undefined) {
    const only = first.source;
    if (first.nextDependency === undefined) {
      // Dirty with one source: that source changed, and no walk is needed.
      try {
        recompute(graph, root, only);
      } finally {
        graph.walkDepth--;
      }
      return only;
    }
  }
  const stack = graph.checkStack;
  const base = stack.length;
  const clock = graph.clock;
  const walk = graph.walk;
  if (first === undefined) {
    if (root.status === ERROR || root.volatile) {
      root.walkedAt = walk;
      root.walkedClock = clock;
    } else {
      root.checkedAt = clock;
    }
    graph.walkDepth--;
    return undefined;
  }
  stack.push(root);
  root.cursor = first;
  let cause: Node | undefined;
  // The node the walk last finished: its parent resumes at the edge to it.
  let finished: Node | undefined;
  try {
    while (stack.length > base) {
      const node = stack[stack.length - 1] as Node;
      let edge = node.cursor;
      let descended = false;
      // A node that resumes takes back what its edges before the walk below showed.
      let volatile = finished !== undefined && node.volatile;
      cause = undefined;
      if (finished !== undefined) {
        // The edge to the source just finished: one current or checked this
        // walk tells by its version alone, with no second visit.
        if (
          finished.checkedAt === clock ||
          (finished.walkedAt === walk && finished.walkedClock === clock)
        ) {
          if (finished.volatile) {
            volatile = true;
          }
          if (finished.version !== (edge as Edge).version) {
            cause = finished;
            edge = undefined;
          } else {
            edge = (edge as Edge).nextDependency;
          }
        }
        finished = undefined;
      }
      while (edge !== undefined) {
        const source = edge.source;
        if (source.kind === DERIVED) {
          if (
            source.checkedAt !== clock &&
            (source.walkedAt !== walk || source.walkedClock !== clock)
          ) {
            if (source.computing || source.cursor !== undefined) {
              // An edge loops back to a value that computes or that this walk
              // is inside: the run that recorded it read something that reads
              // it now. The edge counts as a change, so the run runs again; a
              // run that still reads the value meets the cycle in that read.
              cause = source;
              break;
            }
            const sourceFirst = source.dependenciesHead;
            if (source.status === EMPTY) {
              recompute(graph, source, undefined);
            } else if (
              source.linked &&
              sourceFirst !== undefined &&
              sourceFirst.nextDependency === undefined
            ) {
              // Dirty (`linked` on a derived value) with one source: it
              // recomputes with no walk below.
              recompute(graph, source, sourceFirst.source);
            } else if (sourceFirst !== undefined) {
              node.cursor = edge;
              // Kept across the walk below: a volatile source among the edges
              // before this one keeps the node never current.
              node.volatile = volatile;
              source.cursor = sourceFirst;
              stack.push(source);
              descended = true;
              break;
            } else if (source.status === ERROR || source.volatile) {
              source.walkedAt = walk;
              source.walkedClock = clock;
            } else {
              source.checkedAt = clock;
            }
          }
          if (source.volatile) {
            volatile = true;
          }
        } else if (source.kind === ATOM && source.volatile) {
          if (source.walkedAt !== walk) {
            source.walkedAt = walk;
            source.version = ++graph.versions;
          }
          volatile = true;
        }
        if (source.version !== edge.version) {
          cause = source;
          break;
        }
        edge = edge.nextDependency;
      }
      if (descended) {
        continue;
      }
      stack.pop();
      node.cursor = undefined;
      finished = node;
      if (cause !== undefined) {
        if (node.kind === DERIVED) {
          recompute(graph, node, cause);
        }
      } else {
        node.volatile = volatile;
        if (volatile || node.status === ERROR) {
          node.walkedAt = walk;
          node.walkedClock = clock;
        } else {
          node.checkedAt = clock;
        }
      }
    }
  } catch (error) {
    for (let index = stack.length - 1; index >= base; index--) {
      const node = stack[index] as Node;
      node.cursor = undefined;
      if (error instanceof CycleError && error.origin === node) {
        // The cycle closed on a value mid-walk: it keeps the error, like one
        // that closed mid-compute, as of the clock the walk began at, so a
        // write a hook made during the walk leaves it due for another check.
        keep(graph, node, error, undefined, clock);
      }
    }
    stack.length = base;
    throw error;
  } finally {
    graph.walkDepth--;
  }
  return cause;
};

/**
 * `refresh` for every edge of `node`, with no stop at the first change.
 * Returns whether any source changed since the edge was recorded. A cycle
 * still open is thrown to the caller; one a value keeps is a change.
 */
const refreshAll = (graph: Graph, node: Node): boolean => {
  if (graph.walkDepth++ === 0) {
    graph.walk++;
  }
  const walk = graph.walk;
  try {
    for (let edge = node.dependenciesHead; edge !== undefined; edge = edge.nextDependency) {
      const source = edge.source;
      if (source.kind === DERIVED) {
        if (
          source.checkedAt !== graph.clock &&
          (source.walkedAt !== walk || source.walkedClock !== graph.clock)
        ) {
          refresh(graph, source);
        }
      } else if (source.kind === ATOM && source.volatile && source.walkedAt !== walk) {
        source.walkedAt = walk;
        source.version = ++graph.versions;
      }
      if (source.version !== edge.version) {
        return true;
      }
    }
  } catch (error) {
    if (
      error instanceof CycleError &&
      error.origin.status === ERROR &&
      error.origin.value === error
    ) {
      // The cycle closed and its origin keeps the error as its value: a
      // change like any other, and the observer hears when it resolves.
      return true;
    }
    // A cycle still open, with its origin computing: the caller is inside it.
    throw error;
  } finally {
    graph.walkDepth--;
  }
  return false;
};

/**
 * The outermost stale read: refreshes `node`, and each value a compute
 * inside it stopped at past `maximumComputeDepth`, deepest first, each from
 * this stack. A value that waits counts as computing, so a cycle longer than
 * the limit still meets itself: the value it closes on keeps the error.
 */
const computeBounded = (graph: Graph, node: Node): void => {
  let target = node;
  let waiting: Array<Node> | undefined;
  // One walk for every retry: what a retry finds stamped this walk, such as
  // a value a cycle closed on, it does not walk again.
  if (graph.walkDepth++ === 0) {
    graph.walk++;
  }
  try {
    for (;;) {
      graph.computeDepth = 1;
      try {
        if (target.status === EMPTY) {
          recompute(graph, target, undefined);
        } else {
          refresh(graph, target);
        }
      } catch (error) {
        if (
          waiting !== undefined &&
          error instanceof CycleError &&
          waiting.includes(error.origin)
        ) {
          // The cycle closed on a value that waits: it keeps the error, as
          // one that closed mid-compute, and is settled, so it waits no more.
          error.origin.computing = false;
          keep(graph, error.origin, error, undefined, graph.clock);
          waiting.splice(waiting.indexOf(error.origin), 1);
        } else if (error !== suspension) {
          throw error;
        }
      } finally {
        graph.computeDepth = 0;
      }
      const stopped = graph.suspended;
      graph.suspended = undefined;
      if (stopped !== undefined) {
        target.computing = true;
        if (waiting === undefined) {
          waiting = [];
        }
        waiting.push(target);
        target = stopped;
        continue;
      }
      const next = waiting?.pop();
      if (next === undefined) {
        return;
      }
      next.computing = false;
      target = next;
    }
  } finally {
    graph.walkDepth--;
    graph.suspended = undefined;
    if (waiting !== undefined) {
      for (const waited of waiting) {
        waited.computing = false;
      }
    }
  }
};

/** The slow branch of a derived read: not current. Records the read on the paths that throw, so the reader follows a value that throws. */
const refreshForRead = (graph: Graph, node: Node): void => {
  // Unless the walk this read is inside of checked it already.
  if (node.walkedAt !== graph.walk || node.walkedClock !== graph.clock || graph.walkDepth === 0) {
    // The outermost read is a scope: what its computes make due, write, or
    // release settles once the read is over, never in the middle of it.
    const opened = graph.depth === 0;
    if (opened) {
      graph.depth++;
    }
    let failed = true;
    try {
      if (node.computing || node.cursor !== undefined) {
        throw meetCycle(graph, node);
      } else if (
        node.status !== EMPTY &&
        graph.computeDepth === 0 &&
        graph.deriving === undefined
      ) {
        // A cached outer read keeps the iterative path. Only a stale read
        // reached through a compute needs the bounded retry driver.
        refresh(graph, node);
      } else if (graph.computeDepth === 0) {
        computeBounded(graph, node);
      } else {
        // Only reads reached through user code nest. The iterative freshness
        // walk stays lazy: a changed earlier source may drop a later branch.
        // Once a read waits, every stale read after it waits too: a compute
        // that caught the wait and read on would descend to the limit again,
        // once per catching compute above it.
        if (graph.suspended !== undefined) {
          throw suspension;
        }
        if (graph.computeDepth === maximumComputeDepth) {
          graph.suspended = node;
          throw suspension;
        }
        graph.computeDepth++;
        if (graph.walkDepth++ === 0) {
          graph.walk++;
        }
        try {
          if (node.status === EMPTY) {
            recompute(graph, node, undefined);
          } else {
            refresh(graph, node);
          }
        } finally {
          graph.walkDepth--;
          graph.computeDepth--;
        }
      }
      failed = false;
    } catch (error) {
      if (graph.active !== undefined) {
        record(graph, node);
      }
      throw error;
    } finally {
      if (opened) {
        endObserving(graph, undefined, failed);
      }
    }
  }
  if (node.volatile) {
    graph.volatileRun = graph.run;
  }
  if (node.status === ERROR) {
    if (graph.active !== undefined) {
      record(graph, node);
    }
    throw node.value;
  }
};

/* -------------------------------------------------------------- marking */

/**
 * Marks every observer reachable from `from`, in link order, depth first;
 * schedules watches and active reactions. Calls nothing. A source marked
 * again with no link or settle step since its last mark is skipped: every
 * watch and reaction that mark reached is still scheduled, since only a settle
 * step clears a schedule and only a link adds a path. A computed value's mark
 * only prunes later marks, so one left older costs a later mark a longer walk,
 * never a missed observer.
 *
 * Each derived value that reads `from` directly takes `dirty` as its dirty
 * mark: a write passes `true`, a restore `false`, since the version put back
 * may be the one the reader took. A skipped mark leaves the marks as they
 * were, and a value that is not dirty is walked, so a skip costs a walk,
 * never a missed change.
 */
const mark = (graph: Graph, from: Node, dirty: boolean): void => {
  let edge = from.observersHead;
  if (edge === undefined) {
    return;
  }
  if (from === graph.lastMarked) {
    return;
  }
  const stack = graph.markStack;
  const clock = graph.clock;
  const floor = graph.markFloor;
  let top = 0;
  for (;;) {
    if (edge === undefined) {
      if (top === 0) {
        graph.lastMarked = from;
        return;
      }
      top--;
      edge = stack[top];
      stack[top] = undefined;
      continue;
    }
    const observer = edge.observer;
    const next = edge.nextObserver;
    if (observer.kind === DERIVED) {
      if (edge.source === from) {
        // `linked` on a derived value is its dirty mark.
        observer.linked = dirty;
      }
      const markedAt = observer.markedAt;
      if (markedAt <= observer.checkedAt || markedAt <= floor) {
        observer.markedAt = clock;
        const first = observer.observersHead;
        if (first !== undefined) {
          if (next !== undefined) {
            stack[top++] = next;
          }
          edge = first;
          continue;
        }
      }
    } else if (observer.nextDue === undefined) {
      // Appended to the queue for the next round, written out as in `runWatch`.
      observer.nextDue = endOfDue;
      const tail = graph.dueTail;
      if (tail === undefined) {
        graph.dueHead = observer;
      } else {
        tail.nextDue = observer;
      }
      graph.dueTail = observer;
    }
    edge = next;
  }
};

/** The settle after a write outside a batch. */
const settleIfDue = (graph: Graph): void => {
  if (graph.depth === 0 && (graph.dueHead !== undefined || graph.hooksDue.length !== 0)) {
    settle(graph, false, undefined);
  }
};

/**
 * Closes a batch and settles it. After a run that `failed`, an error the
 * settle throws goes to the host, so the run's error is the one the caller
 * sees.
 */
const endBatch = (graph: Graph, failed: boolean): void => {
  graph.depth--;
  if (graph.depth !== 0 || (graph.dueHead === undefined && graph.hooksDue.length === 0)) {
    return;
  }
  if (!failed) {
    settle(graph, false, undefined);
    return;
  }
  try {
    settle(graph, false, undefined);
  } catch (hidden) {
    reportHidden(hidden);
  }
};

/**
 * Closes an observing call's scope, or a read's, and settles it. A
 * reporter's error goes to the host, except one from `owner`'s own run,
 * which is thrown once the settle is over. When the call `failed`, every one
 * goes to the host, so the call's own error is the one thrown.
 */
const endObserving = (graph: Graph, owner: Node | undefined, failed: boolean): void => {
  graph.depth--;
  if (graph.depth !== 0 || (graph.dueHead === undefined && graph.hooksDue.length === 0)) {
    return;
  }
  settleObserving(graph, owner, failed);
};

/**
 * The settle `endObserving` runs once the outermost scope closes with work
 * due. `watch` and `disposeWatch` make that check themselves and call this
 * only when it is due, which saves a call on every watch made and disposed.
 */
const settleObserving = (graph: Graph, owner: Node | undefined, failed: boolean): void => {
  if (!failed) {
    settle(graph, true, owner);
    return;
  }
  try {
    settle(graph, true, undefined);
  } catch (hidden) {
    reportHidden(hidden);
  }
};

/* ------------------------------------------------------------- watching */

const runWatch = (graph: Graph, watch: Node): void => {
  if (graph.walkDepth++ === 0) {
    graph.walk++;
  }
  const outer = graph.active;
  const outerRun = graph.run;
  const clock = graph.clock;
  graph.active = watch;
  const run = ++graph.runs;
  graph.run = run;
  watch.cursor = undefined;
  watch.added = false;
  let value: unknown;
  let failedRun = run;
  try {
    value = (watch.compute as (argument: unknown) => unknown)(graph.argument);
    failedRun = 0;
  } catch (error) {
    if (error instanceof CycleError && error.origin !== watch) {
      record(graph, error.origin);
    }
    throw error;
  } finally {
    graph.active = outer;
    graph.run = outerRun;
    if (failedRun === 0) {
      // `finishRun`'s case with nothing to drop, inline, as in `recompute`;
      // change all three together.
      // The run moved the cursor since it was cleared; TypeScript cannot see that.
      const last = watch.cursor as Edge | undefined;
      const stale = last === undefined ? watch.dependenciesHead : last.nextDependency;
      if (stale === undefined) {
        watch.cursor = undefined;
        watch.readIndex = undefined;
        if (watch.added) {
          // `reconcile` with nothing stale: a first run links every edge here.
          watch.added = false;
          if (watch.linked) {
            for (
              let edge = watch.dependenciesHead;
              edge !== undefined;
              edge = edge.nextDependency
            ) {
              if (!edge.linked) {
                subscribe(graph, edge);
              }
            }
          }
        }
      } else {
        finishRun(graph, watch);
      }
    } else {
      finishFailedRun(graph, watch, failedRun);
    }
    // The run wrote, as an autorun's body may: a source it read before the
    // write, through an edge linked only now, changed with no mark reaching
    // it. It runs again next round if a source changed, and a run that keeps
    // changing what it read meets the round limit.
    if (graph.clock !== clock && watch.linked && watch.nextDue === undefined) {
      // Appended to the queue for the next round, written out as in `mark`.
      watch.nextDue = endOfDue;
      const tail = graph.dueTail;
      if (tail === undefined) {
        graph.dueHead = watch;
      } else {
        tail.nextDue = watch;
      }
      graph.dueTail = watch;
    }
    graph.walkDepth--;
  }
  const previous = watch.value;
  watch.value = value;
  if (watch.status !== EMPTY) {
    if (watch.linked && watch.effect !== undefined && !watch.equals(previous, value)) {
      watch.effect(value, previous);
    }
  } else {
    watch.status = VALUE;
  }
};

const unlinkAll = (graph: Graph, node: Node): void => {
  for (let edge = node.dependenciesHead; edge !== undefined; edge = edge.nextDependency) {
    if (edge.linked) {
      unsubscribe(graph, edge);
    }
  }
};

const disposeWatch = (graph: Graph, watch: Node): void => {
  if (!watch.linked) {
    return;
  }
  // `checkObserving`, inline: Hermes does not inline it.
  if (graph.deriving !== undefined) {
    checkObserving(graph);
  }
  watch.linked = false;
  graph.depth++;
  let failed = true;
  try {
    unlinkAll(graph, watch);
    watch.dependenciesHead = undefined;
    failed = false;
  } finally {
    if (--graph.depth === 0 && (graph.dueHead !== undefined || graph.hooksDue.length !== 0)) {
      settleObserving(graph, undefined, failed);
    }
  }
};

/* ---------------------------------------------------------------- hooks */

/** Hooks run outside tracking and outside any compute, inside a batch, and may write. */
const runHook = (graph: Graph, hook: () => void): void => {
  const outerActive = graph.active;
  const outerDeriving = graph.deriving;
  const outerUntracked = graph.untrackedActive;
  graph.active = undefined;
  graph.deriving = undefined;
  graph.untrackedActive = undefined;
  try {
    graph.batch(hook);
  } finally {
    graph.active = outerActive;
    graph.deriving = outerDeriving;
    graph.untrackedActive = outerUntracked;
  }
};

/**
 * Marked begun before it runs, so a hook that throws is not run again by
 * every settle. The placeholder is a cleanup that does nothing, made for
 * this run: when the hook ends while it starts, or ends and begins again,
 * the placeholder is gone, and the cleanup this run returns runs at once.
 */
const beginHook = (graph: Graph, hooks: Hooks, start: Start): void => {
  // A hook added again while begun keeps its one begin: a second would
  // replace, and so leak, the cleanup of the first.
  if (hooks.begun.indexOf(start) !== -1) {
    return;
  }
  const placeholder = (): void => {};
  hooks.begun.push(start);
  hooks.cleanups.push(placeholder);
  runHook(graph, () => {
    const cleanup = start();
    const at = hooks.cleanups.indexOf(placeholder);
    if (at !== -1) {
      hooks.cleanups[at] = cleanup;
    } else if (cleanup !== undefined) {
      cleanup();
    }
  });
};

const endHook = (graph: Graph, hooks: Hooks, start: Start): void => {
  const index = hooks.begun.indexOf(start);
  if (index === -1) {
    return;
  }
  const cleanup = hooks.cleanups[index];
  hooks.begun.splice(index, 1);
  hooks.cleanups.splice(index, 1);
  if (cleanup !== undefined) {
    runHook(graph, cleanup);
  }
};

/**
 * Settles one hook: ends it if it was removed or `hasObservers` is false,
 * begins it if it is kept, observed, and not begun.
 */
const settleHook = (graph: Graph, hooks: Hooks, start: Start, hasObservers: boolean): void => {
  if (!hasObservers || hooks.starts.indexOf(start) === -1) {
    endHook(graph, hooks, start);
  } else if (hooks.begun.indexOf(start) === -1) {
    graph.hooksBegun++;
    beginHook(graph, hooks, start);
  }
};

/**
 * Starts the hooks of a source observed at the settle, ending those removed
 * inside a compute; stops every hook of one no longer observed. One that
 * throws does not stop the rest: every error reaches the settle's reporter,
 * and only its first failure is kept. An earlier hook that
 * observes or releases the source only makes it due again: the next pass
 * settles what this one did.
 */
const settleHooksOf = (
  graph: Graph,
  node: Node,
  observing: boolean,
  owner: Node | undefined,
): unknown => {
  const hooks = node.hooks as Hooks;
  hooks.due = false;
  const hasObservers = node.observers > 0;
  hooks.started = hasObservers;
  if (
    hasObservers
      ? hooks.begun.length === hooks.starts.length && !hooks.endsDue
      : hooks.begun.length === 0
  ) {
    hooks.endsDue = false;
    return noFailure;
  }
  hooks.endsDue = false;
  const each = hasObservers ? [...hooks.begun, ...hooks.starts] : [...hooks.begun];
  let firstFailure = noFailure;
  for (let index = 0; index < each.length; index++) {
    try {
      settleHook(graph, hooks, each[index] as Start, hasObservers);
    } catch (error) {
      const failure = reportSettling(graph, error, undefined, observing, owner);
      if (firstFailure === noFailure) {
        firstFailure = failure;
      }
    }
  }
  return firstFailure;
};

/**
 * Adds a hook. On a source observed as of its last settle, it begins at
 * once, or, inside a batch, a settle, or a compute, at the settle, if the
 * source is observed then; `now` begins it at once regardless. The function
 * it returns ends the hook at once, or, inside a compute, at the settle, so
 * a cleanup never runs while a computed value links. A hook or cleanup run
 * here sends its error to the reporter, so the caller still gets the
 * function that removes it.
 */
const addHook = (graph: Graph, node: Node, start: Start, now: boolean): (() => void) => {
  if (node.hooks === undefined) {
    node.hooks = {
      starts: [],
      begun: [],
      cleanups: [],
      started: node.observers > 0,
      endsDue: false,
      due: false,
    };
  }
  const hooks = node.hooks;
  if (hooks.starts.indexOf(start) === -1) {
    hooks.starts.push(start);
  }
  let begin = now;
  if (!now && (hooks.started || node.observers > 0)) {
    if (graph.depth > 0 || isDeriving(graph)) {
      queueHooks(graph, node);
    } else {
      begin = hooks.started && !hooks.due;
    }
  }
  if (begin) {
    try {
      beginHook(graph, hooks, start);
    } catch (error) {
      graph.reportAside(error);
    }
  }
  return () => {
    const index = hooks.starts.indexOf(start);
    if (index !== -1) {
      hooks.starts.splice(index, 1);
    }
    if (isDeriving(graph) && hooks.begun.indexOf(start) !== -1) {
      hooks.endsDue = true;
      queueHooks(graph, node);
      return;
    }
    try {
      endHook(graph, hooks, start);
    } catch (error) {
      graph.reportAside(error);
    }
  };
};

/* ------------------------------------------------------------- settling */

/**
 * Reports an error a settle caught, from the watcher `from` if one threw
 * it. Returns what the reporter threw, when the settle is to throw it once
 * it is over, or `noFailure`. A settle that is not `observing` follows a
 * write, so it throws the reporter's error to the writer; an observing one
 * throws only the error from `owner`'s own run, and sends the rest to the
 * host.
 */
const reportSettling = (
  graph: Graph,
  error: unknown,
  from: Node | undefined,
  observing: boolean,
  owner: Node | undefined,
): unknown => {
  try {
    graph.reporter(error);
  } catch (failure) {
    if (!observing || (from !== undefined && from === owner)) {
      return failure;
    }
    reportHidden(failure);
  }
  return noFailure;
};

/** Settles the hooks due, in one pass. Returns the first error the settle is to throw, or `noFailure`. */
const settleHooksDue = (graph: Graph, observing: boolean, owner: Node | undefined): unknown => {
  const due = graph.hooksDue;
  graph.hooksDue = graph.hooksSpare;
  let first = noFailure;
  try {
    for (let index = 0; index < due.length; index++) {
      const failure = settleHooksOf(graph, due[index] as Node, observing, owner);
      if (first === noFailure) {
        first = failure;
      }
    }
  } finally {
    empty(due);
    graph.hooksSpare = due;
  }
  graph.markFloor = graph.clock;
  graph.lastMarked = undefined;
  return first;
};

/**
 * Empties `array` and keeps its storage. On Hermes, `length = 0` frees the
 * storage, and the next round grows it again from nothing.
 */
const empty = (array: Array<Node>): void => {
  while (array.length !== 0) {
    array.pop();
  }
};

/** Clears `nextDue` on every watcher from `first` to the end of the queue. */
const dropDue = (first: Node | undefined): void => {
  let node = first;
  while (node !== undefined) {
    const after: Node | undefined = node.nextDue;
    node.nextDue = undefined;
    node = after === endOfDue ? undefined : after;
  }
};

/** Clears `nextInRound` on every watcher from `first` to the end of the round. */
const dropInRound = (first: Node | undefined): void => {
  let node = first;
  while (node !== undefined) {
    const after: Node | undefined = node.nextInRound;
    node.nextInRound = undefined;
    node = after === endOfDue ? undefined : after;
  }
};

/**
 * Runs due watchers in rounds, then the hooks due once no watcher is, until
 * nothing is due or a limit is reached. Each error is reported and the rest
 * still run; the first error a reporter threw, or without a reporter the
 * first error, is thrown once the settle is over. An `observing` settle
 * follows an observing call or a read: a reporter's error goes to the host
 * then, except one from `owner`'s own run.
 *
 * The limit on hooks counts the passes that begin one: a pass that only
 * runs cleanups ends hooks begun earlier, so a chain of cleanups settles
 * however long it is. Hooks still due at that limit wait for the next
 * settle. At the watchers' round limit, the hooks due settle without the
 * watchers, and the watchers still due are dropped.
 */
const settle = (graph: Graph, observing: boolean, owner: Node | undefined): void => {
  let unsettled: "watchers" | "hooks" | undefined;
  let watchersDropped = false;
  let firstFailure = noFailure;
  let beginningPasses = 0;
  graph.depth++;
  try {
    let round = 0;
    while (graph.dueHead !== undefined || graph.hooksDue.length !== 0) {
      if (graph.dueHead === undefined) {
        if (beginningPasses >= maximumSettleRounds) {
          unsettled = "hooks";
          break;
        }
        const begunBefore = graph.hooksBegun;
        const failure = settleHooksDue(graph, observing, owner);
        if (firstFailure === noFailure) {
          firstFailure = failure;
        }
        if (graph.hooksBegun !== begunBefore) {
          beginningPasses++;
        }
        continue;
      }
      if (round >= maximumSettleRounds) {
        // The watchers still due are dropped, and the hooks due settle
        // without them; a hook that schedules one again has it dropped too.
        const left = graph.dueHead;
        graph.dueHead = undefined;
        graph.dueTail = undefined;
        dropDue(left);
        graph.markFloor = graph.clock;
        graph.lastMarked = undefined;
        watchersDropped = true;
        continue;
      }
      round++;
      // The round takes the queue and leaves it empty, moving each watcher's
      // `nextDue` into its `nextInRound`. A watcher marked while the round
      // runs joins the queue for the next round, even one still waiting in
      // this round.
      let next: Node | undefined = graph.dueHead;
      graph.dueHead = undefined;
      graph.dueTail = undefined;
      let taken: Node | undefined = next;
      while (taken !== undefined) {
        const after: Node | undefined = taken.nextDue;
        taken.nextDue = undefined;
        taken.nextInRound = after;
        taken = after === endOfDue ? undefined : after;
      }
      graph.markFloor = graph.clock;
      graph.lastMarked = undefined;
      try {
        while (next !== undefined) {
          const node: Node = next;
          const after = node.nextInRound;
          next = after === endOfDue ? undefined : after;
          node.nextInRound = undefined;
          try {
            if (node.linked && refresh(graph, node) !== undefined) {
              if (node.kind === WATCH) {
                runWatch(graph, node);
              } else {
                (node.effect as () => void)();
              }
            }
          } catch (error) {
            const failure = reportSettling(graph, error, node, observing, owner);
            if (firstFailure === noFailure) {
              firstFailure = failure;
            }
          } finally {
            graph.markFloor = graph.clock;
            graph.lastMarked = undefined;
          }
        }
      } finally {
        // After a throw, the watchers of this round not yet run leave it.
        dropInRound(next);
      }
    }
  } finally {
    graph.depth--;
  }
  if (unsettled === undefined && watchersDropped) {
    unsettled = "watchers";
  }
  // Reported once the settle is over, so a write the reporter makes settles in turn.
  if (unsettled !== undefined && !graph.reportingUnsettled) {
    graph.reportingUnsettled = true;
    try {
      const failure = reportSettling(
        graph,
        new Error(
          unsettled === "hooks"
            ? `pinna: onObserved hooks did not settle after ${maximumSettleRounds} passes`
            : `pinna: watchers did not settle after ${maximumSettleRounds} rounds`,
        ),
        undefined,
        observing,
        owner,
      );
      if (firstFailure === noFailure) {
        firstFailure = failure;
      }
    } finally {
      graph.reportingUnsettled = false;
    }
  }
  if (firstFailure !== noFailure) {
    throw firstFailure;
  }
};

/* --------------------------------------------------------------- public */

declare const cellValue: unique symbol;
declare const atomMark: unique symbol;
declare const derivedValue: unique symbol;

/** A cell holding a `Value`. A type only: every node is a plain `Node` object. */
export interface CellNode<Value> extends Node {
  readonly [cellValue]: Value;
}

/** An atom: a source with no value, changed by `touch`. */
export interface AtomNode extends Node {
  readonly [atomMark]: true;
}

/** A derived value computing a `Value`. */
export interface DerivedNode<Value> extends Node {
  readonly [derivedValue]: Value;
}

/** A node another node can read: a cell, an atom, or a derived value. */
export type Source = CellNode<unknown> | AtomNode | DerivedNode<unknown>;

/**
 * Reads a cell and records the read in the active run. Each kind has its own
 * read, so a caller that knows the kind does not branch on it.
 */
export const readCell = <Value>(cell: CellNode<Value>): Value => {
  const graph = cell.graph;
  // `record`, inline: Hermes does not inline it, and this runs on every read.
  // `record` and the other read hold the same code; change all three together.
  const active = graph.active;
  if (active !== undefined) {
    const run = graph.run;
    const readBy = cell.readBy;
    if (readBy < run) {
      cell.readBy = run;
      const cursor = active.cursor;
      const next = cursor === undefined ? active.dependenciesHead : cursor.nextDependency;
      if (next !== undefined && next.source === cell) {
        next.version = cell.version;
        active.cursor = next;
      } else {
        recordMiss(active, cell, cursor, next);
      }
    } else if (readBy !== run) {
      cold.recordAfterNested(graph, cell);
    }
  }
  return cell.value as Value;
};

/** Reads a derived value, refreshing it first if it is not current, and records the read. */
export const readDerived = <Value>(derived: DerivedNode<Value>): Value => {
  const graph = derived.graph;
  if (derived.checkedAt !== graph.clock) {
    refreshForRead(graph, derived);
  }
  // `record`, inline: Hermes does not inline it, and this runs on every read.
  // `record` and the other read hold the same code; change all three together.
  const active = graph.active;
  if (active !== undefined) {
    const run = graph.run;
    const readBy = derived.readBy;
    if (readBy < run) {
      derived.readBy = run;
      const cursor = active.cursor;
      const next = cursor === undefined ? active.dependenciesHead : cursor.nextDependency;
      if (next !== undefined && next.source === derived) {
        next.version = derived.version;
        active.cursor = next;
      } else {
        recordMiss(active, derived, cursor, next);
      }
    } else if (readBy !== run) {
      cold.recordAfterNested(graph, derived);
    }
  }
  return derived.value as Value;
};

/** Records a read of an atom. An atom nothing observes makes the run volatile. */
export const readAtom = (atom: AtomNode): undefined => {
  const graph = atom.graph;
  if (graph.active !== undefined) {
    record(graph, atom);
    if (atom.volatile) {
      graph.volatileRun = graph.run;
    }
  }
  return undefined;
};

/** A cell's value, read without tracking. */
export const peekCell = <Value>(cell: CellNode<Value>): Value => cell.value as Value;

/** A derived value, read without tracking: one that is not current refreshes first. */
export const peekDerived = <Value>(derived: DerivedNode<Value>): Value => {
  const graph = derived.graph;
  const outerActive = graph.active;
  graph.active = undefined;
  try {
    if (derived.checkedAt !== graph.clock) {
      refreshForRead(graph, derived);
    }
    return derived.value as Value;
  } finally {
    graph.active = outerActive;
  }
};

export const writeCell = <Value>(cell: CellNode<Value>, value: Value): void => {
  const graph = cell.graph;
  if (isDeriving(graph)) {
    throw derivingWriteError(graph);
  }
  if (cell.equals(cell.value, value)) {
    return;
  }
  cell.value = value;
  cell.version = ++graph.versions;
  graph.clock++;
  mark(graph, cell, true);
  settleIfDue(graph);
};

/** Puts back a value and the version it had. The version was issued once and is never issued again, so a reader that took it has nothing new. */
export const restoreCell = <Value>(cell: CellNode<Value>, value: Value, version: number): void => {
  const graph = cell.graph;
  if (isDeriving(graph)) {
    throw derivingWriteError(graph);
  }
  cell.value = value;
  cell.version = version;
  graph.clock++;
  // The version put back may be the one its readers took: none of them is
  // dirty, and the walk tells by version. A skip would leave a reader dirty
  // from an earlier write, so every direct reader hears this mark.
  if (graph.lastMarked === cell) {
    graph.lastMarked = undefined;
  }
  mark(graph, cell, false);
  settleIfDue(graph);
};

/** Announces a change: to an atom, or in place to a cell's current value. */
export const touchSource = (source: CellNode<unknown> | AtomNode): void => {
  const graph = source.graph;
  if (isDeriving(graph)) {
    throw derivingWriteError(graph);
  }
  source.version = ++graph.versions;
  graph.clock++;
  mark(graph, source, true);
  settleIfDue(graph);
};

/** How many observe a source: observed derived values and watches, and active reactions. */
export const observerCount = (source: Source): number => source.observers;

export const isAtom = (source: Source): source is AtomNode => source.kind === ATOM;

export const isDerived = (source: Source): source is DerivedNode<unknown> =>
  source.kind === DERIVED;

/** What the last run read, in read order. Runs nothing. */
export const dependenciesOf = (derived: DerivedNode<unknown>): ReadonlyArray<Source> => {
  const sources: Array<Source> = [];
  for (let edge = derived.dependenciesHead; edge !== undefined; edge = edge.nextDependency) {
    sources.push(edge.source as Source);
  }
  return sources;
};

/** Whether a run's value or error is kept. Runs nothing. */
export const hasRun = (derived: DerivedNode<unknown>): boolean => derived.status !== EMPTY;

/**
 * Drops the value or error a derived value nothing observes keeps, so it
 * stops holding what its last run returned; the next read runs it again.
 * Its edges stay, as a run that waited keeps them. An observed or running
 * value is left as it is: an observer is due its change, and a run its
 * result.
 */
export const forgetValue = (derived: DerivedNode<unknown>): void => {
  if (derived.observers !== 0 || derived.computing || derived.status === EMPTY) {
    return;
  }
  derived.status = EMPTY;
  derived.value = undefined;
  // Not current at any clock, nor checked in any walk: a read that found
  // either would return the dropped value without a run.
  derived.checkedAt = -1;
  derived.walkedClock = -1;
};

/** The source whose change made the last run, `undefined` for the first. */
export const lastReason = (derived: DerivedNode<unknown>): Source | undefined =>
  derived.cause as Source | undefined;

/**
 * A renderer's observer. `track` runs a read and follows what it read;
 * `trackPending` runs a read apart, into a pending node, and `adopt` makes
 * the pending reads the followed ones. `activate` links, `deactivate`
 * unlinks; only an active reaction is scheduled.
 */
export class Reaction {
  private readonly node: Node;
  /** The last pending run that returned. Its edges are never linked. */
  private pending: Node | undefined = undefined;
  /** Where the next pending run records, so one that throws leaves `pending` as it was. */
  private spare: Node | undefined = undefined;
  private pendingRan = false;
  /** Mid-track, so a nested track, pending run, or adopt of this reaction is refused. */
  private running = false;

  constructor(
    readonly graph: Graph,
    onChange: () => void,
    label = "reaction",
  ) {
    this.node = makeObserver(
      graph,
      REACTION,
      undefined,
      onChange as (value: unknown, previous: unknown) => void,
      Object.is,
      label,
    );
  }

  track<Result>(read: (argument: never) => Result): Result {
    const graph = this.graph;
    const node = this.node;
    if (node.linked) {
      checkObserving(graph);
    }
    if (this.running) {
      throw new Error(`pinna: ${node.label} cannot track inside its own run`);
    }
    graph.depth++;
    if (graph.walkDepth++ === 0) {
      graph.walk++;
    }
    const outer = graph.active;
    const outerRun = graph.run;
    graph.active = node;
    const run = ++graph.runs;
    graph.run = run;
    node.cursor = undefined;
    node.added = false;
    this.running = true;
    let failed = true;
    try {
      const result = (read as (argument: unknown) => Result)(graph.argument);
      failed = false;
      return result;
    } catch (error) {
      if (error instanceof CycleError) {
        record(graph, error.origin);
      }
      throw error;
    } finally {
      this.running = false;
      graph.active = outer;
      graph.run = outerRun;
      if (failed) {
        finishFailedRun(graph, node, run);
      } else {
        finishRun(graph, node);
      }
      graph.walkDepth--;
      node.status = VALUE;
      endObserving(graph, undefined, failed);
    }
  }

  /**
   * Runs `read` apart from what the reaction follows, for `adopt`. A run that
   * throws leaves the last pending run as it was: a renderer may still keep
   * the render that made it.
   */
  trackPending<Result>(read: (argument: never) => Result): Result {
    const graph = this.graph;
    if (this.running) {
      throw new Error(`pinna: ${this.node.label} cannot track inside its own run`);
    }
    const into =
      this.spare ?? makeObserver(graph, PENDING, undefined, undefined, Object.is, this.node.label);
    this.spare = undefined;
    graph.depth++;
    if (graph.walkDepth++ === 0) {
      graph.walk++;
    }
    const outer = graph.active;
    const outerRun = graph.run;
    graph.active = into;
    graph.run = ++graph.runs;
    into.cursor = undefined;
    into.added = false;
    let failed = true;
    try {
      const result = (read as (argument: unknown) => Result)(graph.argument);
      failed = false;
      return result;
    } finally {
      graph.active = outer;
      graph.run = outerRun;
      finishRun(graph, into);
      if (failed) {
        this.spare = into;
      } else {
        this.spare = this.pending;
        this.pending = into;
        this.pendingRan = true;
      }
      graph.walkDepth--;
      endObserving(graph, undefined, failed);
    }
  }

  /**
   * Follows what the pending run read. Returns whether any of it changed
   * since, while active. A `track` between the pending run and `adopt` does
   * not cancel it: the pending run is the render the caller kept. Like
   * `activate`, it is a walk, so an atom it links counts as changed.
   */
  adopt(): boolean {
    const graph = this.graph;
    const node = this.node;
    const pending = this.pending;
    if (this.running) {
      throw new Error(`pinna: ${node.label} cannot adopt inside its own run`);
    }
    if (!this.pendingRan || pending === undefined) {
      return false;
    }
    this.pendingRan = false;
    if (node.linked) {
      checkObserving(graph);
    }
    // The pending list becomes the node's list.
    const stale = node.dependenciesHead;
    node.dependenciesHead = pending.dependenciesHead;
    pending.dependenciesHead = undefined;
    for (let edge = node.dependenciesHead; edge !== undefined; edge = edge.nextDependency) {
      edge.observer = node;
    }
    if (!node.linked) {
      // Nothing is linked: the list is the one to link.
      node.status = VALUE;
      return false;
    }
    graph.depth++;
    let changed = false;
    let failed = true;
    if (graph.walkDepth++ === 0) {
      graph.walk++;
    }
    try {
      // A source both read keeps its live edge. Same reconcile as a run's end.
      reconcile(graph, node, stale, observed(node));
      changed = refreshAll(graph, node);
      node.status = VALUE;
      graph.markFloor = graph.clock;
      graph.lastMarked = undefined;
      failed = false;
    } finally {
      graph.walkDepth--;
      endObserving(graph, undefined, failed);
    }
    return node.linked && changed;
  }

  /**
   * Links to what the last run read. Returns whether any of it changed
   * since. It is a walk: an atom it links counts as changed, whatever the
   * last walk checked, since nothing reported what the atom did unobserved.
   */
  activate(): boolean {
    const node = this.node;
    if (node.linked) {
      return false;
    }
    const graph = this.graph;
    checkObserving(graph);
    graph.depth++;
    let changed = false;
    let failed = true;
    try {
      node.linked = true;
      node.status = VALUE;
      if (graph.walkDepth++ === 0) {
        graph.walk++;
      }
      try {
        for (let edge = node.dependenciesHead; edge !== undefined; edge = edge.nextDependency) {
          subscribe(graph, edge);
        }
        // Linked first, so the sources are observed when they are brought
        // current: an atom among them is not volatile.
        changed = refreshAll(graph, node);
      } catch (error) {
        // A caller that gets an error holds no release: nothing stays linked.
        node.linked = false;
        unlinkAll(graph, node);
        throw error;
      } finally {
        graph.walkDepth--;
      }
      graph.markFloor = graph.clock;
      graph.lastMarked = undefined;
      failed = false;
    } finally {
      endObserving(graph, undefined, failed);
    }
    // A hook the settle ran may have deactivated it.
    return node.linked && changed;
  }

  deactivate(): void {
    const node = this.node;
    if (!node.linked) {
      return;
    }
    const graph = this.graph;
    checkObserving(graph);
    graph.depth++;
    let failed = true;
    try {
      node.linked = false;
      unlinkAll(graph, node);
      failed = false;
    } finally {
      endObserving(graph, undefined, failed);
    }
  }
}

export class Graph {
  /** Moves on every write: what `checkedAt` compares against. */
  clock = 0;
  /** Issues every version: never the same number twice. */
  versions = 0;
  run = 0;
  runs = 0;
  stamps = 0;
  /** Counts outermost walks: a volatile or thrown node is checked once per walk. */
  walk = 0;
  /**
   * How many walks are entered; the outermost entry starts a new walk, so
   * every stamp taken inside is consistent. Each entry is written out where
   * it happens, `if (walkDepth++ === 0) walk++` paired with `walkDepth--`:
   * Hermes inlines only a function with one caller, and a call per walk is
   * a measured part of a watch's cost.
   */
  walkDepth = 0;
  /** Counts hooks begun: the settle's limit counts the passes that begin one. */
  hooksBegun = 0;
  /** While the settle reports that it did not settle, so that report does not report again. */
  reportingUnsettled = false;
  /** The run that read an unobserved atom, or a value over one, last. */
  volatileRun = 0;
  /** The run that met a cycle last: `meetCycle`. */
  cycleRun = 0;
  active: Node | undefined = undefined;
  /** The enclosing execution whose reads `untracked` suppresses; hooks set it aside. */
  untrackedActive: Node | undefined = undefined;
  /**
   * Handed to every compute and select as its one argument, so a host can
   * give each run what it reads with, without a closure per node.
   */
  argument: unknown = undefined;
  /**
   * The derived value whose compute or equals runs, innermost: while set,
   * nothing writes, observes, or releases, however deep the call. Only a
   * hook's run clears it.
   */
  deriving: Node | undefined = undefined;
  /** Batches, scopes, and the settle: while above zero, nothing settles. */
  depth = 0;
  /** Stale reads nested through user code: `maximumComputeDepth`. */
  computeDepth = 0;
  /** The value a compute stopped at past `maximumComputeDepth`, until the outermost reads it. */
  suspended: Node | undefined = undefined;
  /**
   * A computed value marked at or before this clock is walked again by the
   * next mark that reaches it, even if it looks marked already. Each link and
   * settle step, which can add a path an earlier mark did not walk, moves it
   * to the clock and clears `lastMarked`, written out at each site.
   */
  markFloor = -1;
  /**
   * The last source marked in full since `markFloor` last moved; cleared
   * wherever the floor moves, so it keeps at most one node alive, and only
   * until the floor next moves.
   */
  lastMarked: Node | undefined = undefined;
  /**
   * The queue for the next round: the first and last of the watchers and
   * reactions marked and not yet run, linked through each node's `nextDue`,
   * so scheduling allocates nothing. A scope that ends at depth zero settles
   * when this is set or `hooksDue` is not empty; that check is written out
   * at each scope's end so an empty one costs no call.
   */
  dueHead: Node | undefined = undefined;
  dueTail: Node | undefined = undefined;
  hooksDue: Array<Node> = [];
  hooksSpare: Array<Node> = [];
  readonly markStack: Array<Edge | undefined> = [];
  readonly checkStack: Array<Node> = [];
  readonly linkStack: Array<Node> = [];
  /** The sources with hooks a link or unlink reached, in the order it reached them. */
  readonly linkOrder: Array<Node> = [];
  readonly reporter: (error: unknown) => void;

  constructor(reporter: (error: unknown) => void = reportUncaught) {
    this.reporter = reporter;
  }

  cell<Value>(initial: Value, options?: Options<Value>): CellNode<Value> {
    return makeSource(
      this,
      CELL,
      initial,
      (options?.equals ?? Object.is) as Equals<unknown>,
      options?.label,
    ) as CellNode<Value>;
  }

  /** `cell` with `equals` alone: a host that makes many cells pays no options object per cell. */
  cellComparing<Value>(initial: Value, equals: Equals<Value>): CellNode<Value> {
    return makeSource(this, CELL, initial, equals as Equals<unknown>, undefined) as CellNode<Value>;
  }

  atom(): AtomNode {
    return makeSource(this, ATOM, undefined, Object.is, undefined) as AtomNode;
  }

  derived<Value>(
    compute: (argument: never) => Value,
    options?: Options<Value>,
  ): DerivedNode<Value> {
    return makeObserver(
      this,
      DERIVED,
      compute,
      undefined,
      (options?.equals ?? Object.is) as Equals<unknown>,
      options?.label,
    ) as DerivedNode<Value>;
  }

  watch<Value>(
    select: (argument: never) => Value,
    effect?: (value: Value, previous: Value) => void,
    options?: Options<Value>,
  ): () => void {
    // `checkObserving`, inline: Hermes does not inline it.
    if (this.deriving !== undefined) {
      checkObserving(this);
    }
    const node = makeObserver(
      this,
      WATCH,
      select,
      effect as ((value: unknown, previous: unknown) => void) | undefined,
      (options?.equals ?? Object.is) as Equals<unknown>,
      options?.label ?? "watch",
    );
    // If the first run's settle throws through a reporter, the caller gets no
    // stop function, so nothing stays watched.
    try {
      this.depth++;
      let failed = true;
      try {
        runWatch(this, node);
        failed = false;
      } catch (error) {
        disposeWatch(this, node);
        throw error;
      } finally {
        if (--this.depth === 0 && (this.dueHead !== undefined || this.hooksDue.length !== 0)) {
          settleObserving(this, failed ? undefined : node, failed);
        }
      }
    } catch (error) {
      disposeWatch(this, node);
      throw error;
    }
    return () => disposeWatch(this, node);
  }

  /**
   * Defers watchers and hooks until `write` returns, then settles once. If
   * `write` throws, the settle still runs, its error goes to the host, and
   * `write`'s error is the one thrown.
   */
  batch<Result>(write: () => Result): Result {
    this.depth++;
    let result: Result;
    try {
      result = write();
    } catch (error) {
      endBatch(this, true);
      throw error;
    }
    endBatch(this, false);
    return result;
  }

  /** Batches `beginBatch` opened that `endBatch` has not closed. */
  openBatches = 0;

  beginBatch(): void {
    this.openBatches++;
    this.depth++;
  }

  /**
   * Closes a batch `beginBatch` opened, and throws when none is open. After
   * a run that `failed`, a settle's error goes to the host.
   */
  endBatch(failed: boolean): void {
    if (this.openBatches === 0) {
      throw new Error("pinna: endBatch needs a beginBatch before it");
    }
    this.openBatches--;
    endBatch(this, failed);
  }

  untracked<Result>(read: (argument: never) => Result): Result {
    const outerActive = this.active;
    const outerUntracked = this.untrackedActive;
    this.untrackedActive = outerActive ?? outerUntracked;
    this.active = undefined;
    try {
      return (read as (argument: unknown) => Result)(this.argument);
    } finally {
      this.active = outerActive;
      this.untrackedActive = outerUntracked;
    }
  }

  isTracking(): boolean {
    return this.active !== undefined;
  }

  derivingWriteError(): Error {
    return derivingWriteError(this);
  }

  /** Inside a batch, a scope, a settle, or a compute: a hook added now begins at the settle. */
  defersHooks(): boolean {
    return this.depth > 0;
  }

  /**
   * Sends an error that is not thrown, a hook's or one hidden by another, to
   * the reporter, or to the host's if the reporter throws.
   */
  reportAside(error: unknown): void {
    try {
      this.reporter(error);
    } catch (hidden) {
      reportHidden(hidden);
    }
  }

  /**
   * Runs `start` while `node` is observed and its cleanup once it is not.
   * Inside a batch, a scope, a settle, or a compute, it begins at the settle.
   */
  onObserved(node: Node, start: Start): () => void {
    if (node.graph !== this) {
      throw new Error("pinna: onObserved needs a source from this graph");
    }
    return addHook(this, node, start, false);
  }

  /**
   * Inside a batch, a settle, or a compute, begins `start` at once, as if
   * `node` were observed, and settles it when that scope ends: it ends then
   * if nothing observes `node`. For a cache that must hold an entry from the
   * moment it is made.
   */
  onObservedNow(node: Node, start: Start): () => void {
    if (node.graph !== this || node.kind > DERIVED || !this.defersHooks()) {
      throw new Error("pinna: onObservedNow needs a source from this graph, inside a batch");
    }
    const remove = addHook(this, node, start, true);
    queueHooks(this, node);
    return remove;
  }

  nextCellVersion(): number {
    return ++this.versions;
  }
}
