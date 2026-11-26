/**
 * The graph checker: walks every node reachable from the ones given, through
 * dependency and observer edges, and lists each invariant the graph breaks
 * at rest. `docs/design.md`, "What the code assumes and nothing checks",
 * names the invariants; this is the check it asks for. A port runs the same
 * checks over its own nodes.
 *
 * Only meaningful at rest: no run, walk, batch, or settle open. Mid-run, a
 * cursor is set, a tail may be unlinked, and counts move.
 */
import { expect } from "bun:test";
import { Graph, kindOf, type Node } from "../src/graph.ts";

/** The edge fields the checker reads; `Node` keeps its `Edge` type private. */
interface EdgeView {
  readonly source: Node;
  readonly observer: Node;
  readonly nextDependency: EdgeView | undefined;
  readonly previousObserver: EdgeView | undefined;
  readonly nextObserver: EdgeView | undefined;
  readonly linked: boolean;
}

const dependencies = (node: Node): EdgeView | undefined =>
  node.dependenciesHead as EdgeView | undefined;
const observerHead = (node: Node): EdgeView | undefined =>
  node.observersHead as EdgeView | undefined;

const isSource = (node: Node): boolean => {
  const kind = kindOf(node);
  return kind === "cell" || kind === "atom" || kind === "derived";
};

/** Whether `node` reads anything: a derived value, a watch, or a reaction. */
const isObserver = (node: Node): boolean => !(kindOf(node) === "cell" || kindOf(node) === "atom");

/** Whether `node`'s edges are in its sources' observer lists, by kind. */
const isObserved = (node: Node): boolean =>
  kindOf(node) === "derived" ? node.observers > 0 : node.linked;

const describe = (node: Node): string => `${kindOf(node)} ${node.label ?? "(no label)"}`;

/** Every node reachable from `roots` through either kind of edge. */
export const reachable = (roots: Iterable<Node>): Set<Node> => {
  const seen = new Set<Node>();
  const stack: Array<Node> = [];
  for (const root of roots) {
    if (!seen.has(root)) {
      seen.add(root);
      stack.push(root);
    }
  }
  const visit = (node: Node): void => {
    if (!seen.has(node)) {
      seen.add(node);
      stack.push(node);
    }
  };
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if (isObserver(node)) {
      for (let edge = dependencies(node); edge !== undefined; edge = edge.nextDependency) {
        visit(edge.source);
      }
    }
    if (isSource(node)) {
      for (let edge = observerHead(node); edge !== undefined; edge = edge.nextObserver) {
        visit(edge.observer);
      }
    }
  }
  return seen;
};

/**
 * The invariants the graph breaks at rest among the nodes reachable from
 * `roots`, one line each; empty when it breaks none.
 */
export const checkGraph = (roots: Iterable<Node>): Array<string> => {
  const problems: Array<string> = [];
  const nodes = reachable(roots);
  /** Every edge in some source's observer list. */
  const listed = new Set<EdgeView>();
  for (const node of nodes) {
    if (!isSource(node)) {
      continue;
    }
    let count = 0;
    let previous: EdgeView | undefined;
    for (let edge = observerHead(node); edge !== undefined; edge = edge.nextObserver) {
      count++;
      listed.add(edge);
      if (edge.source !== node) {
        problems.push(`${describe(node)}: an edge in its observer list has another source`);
      }
      if (!edge.linked) {
        problems.push(`${describe(node)}: an edge in its observer list is not linked`);
      }
      if (edge.previousObserver !== previous) {
        problems.push(`${describe(node)}: its observer list's back links are broken`);
      }
      previous = edge;
    }
    if ((node.observersTail as EdgeView | undefined) !== previous) {
      problems.push(`${describe(node)}: its observer tail is not the list's last edge`);
    }
    if (count !== node.observers) {
      problems.push(`${describe(node)}: observers is ${node.observers}, its list holds ${count}`);
    }
    if (kindOf(node) === "atom" && node.volatile !== (node.observers === 0)) {
      problems.push(
        `${describe(node)}: volatile is ${node.volatile} with ${node.observers} observers`,
      );
    }
    const hooks = node.hooks as
      | { begun: ReadonlyArray<unknown>; cleanups: ReadonlyArray<unknown>; due: boolean }
      | undefined;
    if (hooks !== undefined) {
      if (hooks.begun.length !== hooks.cleanups.length) {
        problems.push(
          `${describe(node)}: ${hooks.begun.length} hooks begun, ${hooks.cleanups.length} cleanups`,
        );
      }
      if (hooks.due) {
        problems.push(`${describe(node)}: its hooks are due at rest`);
      }
    }
  }
  for (const node of nodes) {
    if (!isObserver(node)) {
      continue;
    }
    if (node.computing) {
      problems.push(`${describe(node)}: computing at rest`);
    }
    if (node.cursor !== undefined) {
      problems.push(`${describe(node)}: a cursor at rest`);
    }
    if (kindOf(node) === "derived" && node.linked && node.observers === 0) {
      problems.push(`${describe(node)}: dirty with no observer`);
    }
    const observed = isObserved(node);
    const sources = new Set<Node>();
    for (let edge = dependencies(node); edge !== undefined; edge = edge.nextDependency) {
      if (edge.observer !== node) {
        problems.push(`${describe(node)}: a dependency edge has another observer`);
      }
      if (sources.has(edge.source)) {
        problems.push(`${describe(node)}: reads ${describe(edge.source)} through two edges`);
      }
      sources.add(edge.source);
      if (edge.linked !== listed.has(edge)) {
        problems.push(
          `${describe(node)}: an edge to ${describe(edge.source)} is ${edge.linked ? "linked and not listed" : "listed and not linked"}`,
        );
      }
      if (edge.linked !== observed) {
        problems.push(
          `${describe(node)}: ${observed ? "observed" : "not observed"} with an edge to ${describe(edge.source)} ${edge.linked ? "linked" : "not linked"}`,
        );
      }
    }
  }
  /** Every edge in some observer's dependency list. */
  const held = new Set<EdgeView>();
  for (const node of nodes) {
    if (isObserver(node)) {
      for (let edge = dependencies(node); edge !== undefined; edge = edge.nextDependency) {
        held.add(edge);
      }
    }
  }
  for (const edge of listed) {
    if (!held.has(edge)) {
      problems.push(
        `${describe(edge.source)}: an edge in its observer list is absent from the dependencies of ${describe(edge.observer)}`,
      );
    }
  }
  return problems;
};

/** Fails with every invariant the graph breaks among the nodes reachable from `roots`. */
export const expectGraphSound = (roots: Iterable<Node>): void => {
  expect(checkGraph(roots)).toEqual([]);
};

/**
 * The nodes each graph made through `cell`, `cellComparing`, `atom`, and
 * `derived`, once `recordNodes` ran. Watches and reactions are reached
 * through their sources' observer lists while they are linked.
 */
const made = new WeakMap<Graph, Set<Node>>();

/** The nodes `graph` made, for `checkGraph`; empty before `recordNodes`. */
export const madeNodes = (graph: Graph): ReadonlySet<Node> => made.get(graph) ?? new Set();

let recording = false;

/**
 * Makes every graph keep the nodes it makes, for the checker: patches the
 * four factories on `Graph.prototype`. Test support only; the preload of
 * `pinna-core`'s tests calls it.
 */
export const recordNodes = (): void => {
  if (recording) {
    return;
  }
  recording = true;
  const prototype = Graph.prototype as unknown as Record<string, (...args: Array<never>) => Node>;
  for (const name of ["cell", "cellComparing", "atom", "derived"]) {
    const original = prototype[name] as (...args: Array<never>) => Node;
    prototype[name] = function (this: Graph, ...args: Array<never>): Node {
      const node = original.apply(this, args);
      let nodes = made.get(this);
      if (nodes === undefined) {
        nodes = new Set();
        made.set(this, nodes);
      }
      nodes.add(node);
      return node;
    };
  }
};
