/**
 * The React adapter. A component reads observables in three ways:
 *
 * - `useValue($x)` reads one observable: `useValue(position.$value)`.
 * - `useValues([$a, $b])` reads several observables into a typed array that
 *   keeps its identity until an element changes.
 * - `useSelect((read) => ...)` reads whatever the function reads with `read`:
 *   `useSelect((read) => read(portfolio.$response).items.length)`. The function
 *   runs in the realm a `RealmProvider` above the component gives.
 *
 * The component rerenders when the result changes (`Object.is`). Every hook
 * keeps one protocol, so a render React throws away, a first one or a later
 * one, holds nothing and changes nothing the mounted component follows:
 *
 * 1. What `useSyncExternalStore` returns is what the component renders: the
 *    render's `getSnapshot` returns its capture's result, and the hook reads
 *    nothing else. React's own checks, before a concurrent commit and after
 *    one, then compare the value shown.
 * 2. Each render has its own capture: the result and what it read, taken
 *    with no observation and no `onObserved` hook started. `useValue` and
 *    `useValues` read their observables untracked, and a render that reads
 *    the committed observables reuses the committed capture; `useSelect`
 *    runs the function into a `Capture` of pinna-core, which records each
 *    source's version. `getSnapshot` returns the cached result until a source
 *    moved, so two calls with nothing written return the same reference.
 * 3. Only a committed render moves the subscriptions. Its layout effect
 *    adopts its capture: the hook's reaction follows what it read, keeps the
 *    sources both captures read, and tells React when one moved between the
 *    render and the adopt. A render React throws away is never adopted.
 *    `useValue` adopts in React's own `subscribe` instead, which React runs
 *    only for a committed render: two captures of one observable are one
 *    capture, so none shares a source with another, and no render of it
 *    runs a layout effect. `useValues` and `useSelect` keep the effect,
 *    since two of their captures can share a source.
 * 4. When a followed source changes, the committed capture runs again and
 *    the reaction follows what that run read, even when the result is equal
 *    and no render follows.
 *
 * A write replaces a box's value rather than changing it in place, so a
 * memoized child or the React Compiler sees a new identity exactly when the
 * value changed.
 */
import type { Computed, Read, Realm } from "@frondruntime/pinna";
import {
  ObservableRealm,
  peek,
  graphOf as realmGraph,
  realmOf,
  realmsOf,
} from "@frondruntime/pinna/internal";
import { Capture, type Graph, PinnaUsageError, Reaction } from "@frondruntime/pinna-core";
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";

const RealmContext = createContext<Realm | null>(null);

/** Gives the components below it `realm`, for `useRealm` and `useSelect`. */
export function RealmProvider({
  realm,
  children,
}: {
  readonly realm: Realm;
  readonly children?: ReactNode;
}): ReactNode {
  return createElement(RealmContext, { value: realm }, children);
}

/** The realm the nearest `RealmProvider` gives. Throws without one. */
export function useRealm(): Realm {
  const realm = useContext(RealmContext);
  if (realm === null) {
    throw new PinnaUsageError(
      "pinna-react/no-provider",
      "pinna: useRealm and useSelect need a RealmProvider above the component",
    );
  }
  return realm;
}

/** The graph of a realm `Realm.make` made. */
const graphOf = (realm: Realm): Graph => {
  if (!(realm instanceof ObservableRealm)) {
    throw new PinnaUsageError(
      "pinna-react/not-a-realm",
      "pinna: expected a realm made by Realm.make()",
    );
  }
  return realmGraph(realm);
};

/**
 * One render's capture: the result the render shows and what it read,
 * taken with no observation and no hook started. `getSnapshot` is the
 * render's own: it returns the cached result while nothing the capture read
 * moved, and captures again when something did, so React's checks before and
 * after a commit compare the value the render showed.
 */
interface HookCapture<Result> {
  /** The graph of the realm it read, `undefined` for a list of no observables. */
  readonly graph: Graph | undefined;
  readonly getSnapshot: () => Result;
  /** Captures again, after a change the reaction found; a throw is kept for `getSnapshot`. */
  refresh(): void;
  /**
   * Makes `reaction` follow what the capture read. Returns whether a source
   * moved since the capture read it.
   */
  follow(reaction: Reaction): boolean;
}

/** The capture of `useSelect`: the function's result, and the graph's record of what it read. */
class SelectCapture<Result> implements HookCapture<Result> {
  private readonly capture: Capture;
  private result: Result;
  /** The last run threw: `getSnapshot` runs again, and throws to the render. */
  private failed = false;

  constructor(
    readonly graph: Graph,
    readonly select: (read: Read) => Result,
  ) {
    this.capture = new Capture(graph, "useSelect");
    this.result = this.capture.run(select);
  }

  readonly getSnapshot = (): Result => {
    if (this.failed || this.capture.changed()) {
      this.runAgain();
    }
    return this.result;
  };

  /** Runs the function again; an equal result (`Object.is`) keeps the cached one. */
  private runAgain(): void {
    let next: Result;
    try {
      next = this.capture.run(this.select);
    } catch (error) {
      this.failed = true;
      throw error;
    }
    this.failed = false;
    if (!Object.is(this.result, next)) {
      this.result = next;
    }
  }

  refresh(): void {
    try {
      this.runAgain();
    } catch {
      // The render runs the function again and throws the error to the
      // component's error boundary.
    }
  }

  follow(reaction: Reaction): boolean {
    return reaction.follow(this.capture);
  }
}

/**
 * The capture of `useValue` and `useValues`: the values of observables known
 * before the render, read untracked. While the realm's clock stays, nothing
 * was written and the cached result stands; once it moved, every value is
 * read again, and a result whose values all equal the cached ones
 * (`Object.is`) keeps the cached one.
 */
class SourceCapture<Result> implements HookCapture<Result> {
  readonly graph: Graph | undefined;
  /** `useValue`'s subscribe, which adopts this capture: set once, by the render that made it. */
  subscribe: ((listener: () => void) => () => void) | undefined = undefined;
  /** The clock the result was read at, -1 once a read threw. */
  private clock = -1;
  private result: Result;

  constructor(
    readonly observables: ReadonlyArray<Computed<unknown>>,
    /**
     * Reads the values through `get`: `peek` in a render, the reaction's
     * tracked `read` in `follow`. Returns `previous` when every value equals
     * its own.
     */
    private readonly read: (get: Get, previous: Result | typeof unset) => Result,
    previous: Result | typeof unset,
  ) {
    const first = observables[0];
    if (first === undefined) {
      this.graph = undefined;
    } else {
      const realm = realmOf(first);
      // The reaction follows the first one's realm, whose `read` takes nothing of another.
      for (let index = 1; index < observables.length; index++) {
        const theirs = realmOf(observables[index] as Computed<unknown>);
        if (theirs !== realm) {
          throw new PinnaUsageError(
            "pinna-react/mixed-realms",
            `pinna: useValues takes observables of one realm${realmsOf(theirs, realm)}`,
          );
        }
      }
      this.graph = realmGraph(realm);
    }
    this.result = read(peek, previous);
    this.clock = this.graph === undefined ? 0 : this.graph.clock;
  }

  /** The result last read, without reading again. */
  get cached(): Result {
    return this.result;
  }

  readonly getSnapshot = (): Result => {
    const graph = this.graph;
    if (graph !== undefined && graph.clock !== this.clock) {
      this.clock = -1;
      this.result = this.read(peek, this.result);
      this.clock = graph.clock;
    }
    return this.result;
  };

  /** Nothing: `follow` reads the values again, tracked, and keeps them. */
  refresh(): void {}

  private readonly track = (read: Read): Result => this.read(read, this.result);

  /**
   * Reads the values again, tracked, and keeps what that read: a value over
   * an atom nothing observed can change with no write, so the clock alone
   * would keep the render's value.
   */
  follow(reaction: Reaction): boolean {
    let next: Result;
    try {
      next = reaction.track(this.track);
    } catch {
      // React reads the result again and throws the error to the
      // component's error boundary.
      this.clock = -1;
      return true;
    }
    const graph = this.graph;
    this.clock = graph === undefined ? 0 : graph.clock;
    if (next === this.result) {
      return false;
    }
    this.result = next;
    return true;
  }
}

const unset: unique symbol = Symbol("unset");

/** How a capture reads one observable: `peek`, or a tracked `read`. */
type Get = (observable: Computed<unknown>) => unknown;

/**
 * The store of one hook. It owns the subscriptions, and only the capture of
 * a render React committed moves them: a layout effect adopts it, so a
 * render React throws away never unsubscribes what the mounted component
 * follows.
 */
class HookStore<Result> {
  /** The capture of the render React committed last. */
  committed: HookCapture<Result> | undefined = undefined;
  private reaction: Reaction | undefined = undefined;
  private listener: (() => void) | undefined = undefined;

  constructor(private readonly label: string) {}

  /**
   * A source the committed capture read changed: it captures again and
   * follows what that read, even when the result is equal and no render
   * follows, then tells React, which compares the result.
   */
  private readonly changed = (): void => {
    const committed = this.committed;
    const reaction = this.reaction;
    if (committed === undefined || reaction === undefined) {
      return;
    }
    committed.refresh();
    try {
      committed.follow(reaction);
    } catch {
      // The render reads again and throws the error to the component's
      // error boundary.
    }
    this.listener?.();
  };

  /**
   * Adopts the capture of the render React committed: the reaction follows
   * what it read, keeping the sources both captures read, and a source that
   * moved since the render tells React to read again.
   */
  adopt(capture: HookCapture<Result>): void {
    if (capture === this.committed) {
      return;
    }
    this.committed = capture;
    const graph = capture.graph;
    let reaction = this.reaction;
    if (reaction !== undefined && reaction.graph !== graph) {
      // Another realm: nothing is shared, and the old reaction lets go.
      reaction.deactivate();
      reaction = undefined;
      this.reaction = undefined;
    }
    if (graph === undefined) {
      return;
    }
    let moved: boolean;
    if (reaction === undefined) {
      reaction = new Reaction(graph, this.changed, this.label);
      this.reaction = reaction;
      moved = capture.follow(reaction);
      if (this.listener !== undefined && reaction.activate()) {
        moved = true;
      }
    } else {
      moved = capture.follow(reaction);
    }
    if (moved) {
      this.changed();
    }
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listener = listener;
    // A hook that activating starts may write what was just read. React
    // compares the result once it subscribes, so a write between the render
    // and here needs no notice.
    if (this.reaction?.activate() === true) {
      this.changed();
    }
    return () => {
      this.listener = undefined;
      this.reaction?.deactivate();
    };
  };

  /**
   * `subscribe` for a capture whose sources no other capture of this hook
   * shares, as `useValue`'s one observable: React subscribes only for a
   * render it commits, and unsubscribes the last capture first, so the
   * capture is adopted here and the render needs no layout effect.
   */
  subscribeTo(capture: HookCapture<Result>, listener: () => void): () => void {
    this.adopt(capture);
    return this.subscribe(listener);
  }
}

/** The store of a hook, made by its first render. */
const useStore = <Result>(label: string): HookStore<Result> => {
  const store = useRef<HookStore<Result> | null>(null);
  let current = store.current;
  if (current === null) {
    // A first render React throws away throws its store away with it.
    current = new HookStore<Result>(label);
    store.current = current;
  }
  return current;
};

/**
 * The hook's protocol, once the render has its capture: React reads the
 * capture's result, and the layout effect of a committed render adopts it.
 * A layout effect runs before the subscription's passive one, so a first
 * render's sources are in place when the reaction activates.
 */
const useCapture = <Result>(store: HookStore<Result>, capture: HookCapture<Result>): Result => {
  const value = useSyncExternalStore(store.subscribe, capture.getSnapshot, capture.getSnapshot);
  useLayoutEffect(() => {
    store.adopt(capture);
  }, [store, capture]);
  return value;
};

/**
 * Runs `select`, tracked, in the realm the nearest `RealmProvider` gives,
 * handing it a `read`, and rerenders when its result changes (`Object.is`).
 * Throws without a provider.
 */
export function useSelect<Value>(select: (read: Read) => Value): Value {
  const graph = graphOf(useRealm());
  const store = useStore<Value>("useSelect");
  const committed = store.committed as SelectCapture<Value> | undefined;
  // A render runs the function again unless it is the committed one, in
  // the committed realm: a new function may read what the last did not.
  const capture =
    committed !== undefined && committed.select === select && committed.graph === graph
      ? committed
      : new SelectCapture(graph, select);
  return useCapture(store, capture);
}

/**
 * Whether `capture` reads exactly `observables`, in the same order. An
 * indexed loop, since every render asks and a callback is a closure on Hermes.
 */
const reads = (
  capture: SourceCapture<ReadonlyArray<unknown>> | undefined,
  observables: ReadonlyArray<Computed<unknown>>,
): boolean => {
  if (capture === undefined || capture.observables.length !== observables.length) {
    return false;
  }
  for (let index = 0; index < observables.length; index++) {
    if (capture.observables[index] !== observables[index]) {
      return false;
    }
  }
  return true;
};

/**
 * Reads `observable` and rerenders when its value changes (`Object.is`).
 *
 * A render that reads another observable makes a new capture; the
 * subscription moves to it only when React commits that render.
 */
export function useValue<Value>(observable: Computed<Value>): Value {
  const store = useStore<Value>("useValue");
  const committed = store.committed as SourceCapture<Value> | undefined;
  let capture: SourceCapture<Value>;
  if (committed !== undefined && committed.observables[0] === observable) {
    capture = committed;
  } else {
    capture = new SourceCapture<Value>([observable], (get) => get(observable) as Value, unset);
    capture.subscribe = (listener) => store.subscribeTo(capture, listener);
  }
  // Two captures of one observable are one capture, so no source is shared
  // between them and React's own subscribe adopts the committed one: no
  // layout effect on any render.
  return useSyncExternalStore(
    capture.subscribe as (listener: () => void) => () => void,
    capture.getSnapshot,
    capture.getSnapshot,
  );
}

type ValueOf<Observable> = Observable extends Computed<infer Value> ? Value : never;

/**
 * The values of `sources`, read untracked: `previous` when every value equals
 * its own (`Object.is`), so a read where nothing changed allocates nothing.
 */
const readValues = (
  get: Get,
  sources: ReadonlyArray<Computed<unknown>>,
  previous: ReadonlyArray<unknown> | typeof unset,
): ReadonlyArray<unknown> => {
  let next: Array<unknown> | undefined;
  const kept = previous !== unset && previous.length === sources.length ? previous : undefined;
  for (let index = 0; index < sources.length; index++) {
    const value = get(sources[index] as Computed<unknown>);
    if (next === undefined) {
      if (kept !== undefined && Object.is(kept[index], value)) {
        continue;
      }
      next = kept === undefined ? [] : kept.slice(0, index);
    }
    next.push(value);
  }
  return next ?? kept ?? [];
};

/**
 * Reads each observable, in the realm of the first, and rerenders when any
 * value changes. The array keeps its identity until an element changes,
 * also when equal values move to other observables.
 */
export function useValues<const Observables extends ReadonlyArray<Computed<unknown>>>(
  observables: Observables,
): { readonly [Index in keyof Observables]: ValueOf<Observables[Index]> } {
  const store = useStore<ReadonlyArray<unknown>>("useValue");
  const committed = store.committed as SourceCapture<ReadonlyArray<unknown>> | undefined;
  let capture: SourceCapture<ReadonlyArray<unknown>>;
  if (committed !== undefined && reads(committed, observables)) {
    capture = committed;
  } else {
    // Own the list so a caller's mutation cannot change what this capture
    // reads while the committed one still follows the previous observables.
    const sources = observables.slice();
    capture = new SourceCapture<ReadonlyArray<unknown>>(
      sources,
      (get, previous) => readValues(get, sources, previous),
      committed === undefined ? unset : committed.cached,
    );
  }
  return useCapture(store, capture) as unknown as {
    readonly [Index in keyof Observables]: ValueOf<Observables[Index]>;
  };
}
