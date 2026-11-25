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
 * The component rerenders when the result changes (`Object.is`).
 * A render only reads, so a render React throws away, a first one or a later
 * one, holds nothing and changes nothing the mounted component follows:
 *
 * - `useValue` and `useValues` know what they read before the render. The
 *   render reads it untracked, and the subscription React keeps follows it.
 * - `useSelect` learns what it reads by running the function, so a render
 *   records the reads apart, and a layout effect links them once React keeps
 *   the render. That effect runs on every render: it is the price of a read
 *   whose sources are not known before it runs.
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
import { type Graph, PinnaUsageError, Reaction } from "@frondruntime/pinna-core";
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

const unset: unique symbol = Symbol("unset");

/** The store of `useSelect`: what a render read is linked once React keeps the render. */
class SelectStore<Result> {
  private version = 0;
  private listener: (() => void) | undefined;
  /** The read and the result of the render React kept last. */
  private read: (read: Read) => Result;
  private result: Result | typeof unset = unset;
  /** Numbers each render; the reaction holds the last one's run pending. */
  private renders = 0;
  private keptRender = 0;
  readonly reaction: Reaction;

  constructor(
    readonly graph: Graph,
    read: (read: Read) => Result,
  ) {
    this.read = read;
    this.reaction = new Reaction(
      graph,
      () => {
        let changed: boolean;
        try {
          changed = this.keepResult(this.reaction.track(this.run));
        } catch {
          // A render is the read's caller: the render reads again and throws
          // the error to the component's error boundary.
          this.result = unset;
          changed = true;
        }
        if (changed) {
          this.notify();
        }
      },
      "useSelect",
    );
  }

  private readonly run = (read: Read): Result => this.read(read);

  private notify(): void {
    this.version++;
    this.listener?.();
  }

  /** Stores `next` unless it equals the current result; returns whether it changed. */
  private keepResult(next: Result): boolean {
    if (this.result !== unset && Object.is(this.result, next)) {
      return false;
    }
    this.result = next;
    return true;
  }

  /**
   * Runs `read` for a render, apart from what the kept render follows, and
   * returns the kept result when the new one equals it.
   */
  render(read: (read: Read) => Result): Result {
    const next = this.reaction.trackPending(read);
    this.renders++;
    const result = this.result;
    return result !== unset && Object.is(result, next) ? result : next;
  }

  /** The number of the last render. */
  get lastRender(): number {
    return this.renders;
  }

  /**
   * Follows what render `rendered` read, once React keeps it. When a later
   * render that React threw away replaced its pending run, the read runs
   * again here.
   */
  keep(rendered: number, read: (read: Read) => Result, value: Result): void {
    if (rendered === this.keptRender) {
      return;
    }
    this.keptRender = rendered;
    this.read = read;
    this.result = value;
    let changed: boolean;
    if (rendered === this.renders) {
      changed = this.reaction.adopt();
    } else {
      try {
        changed = this.keepResult(this.reaction.track(this.run));
      } catch {
        this.result = unset;
        changed = true;
      }
    }
    if (changed) {
      this.notify();
    }
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listener = listener;
    if (this.reaction.activate()) {
      this.notify();
    }
    return () => {
      this.listener = undefined;
      this.reaction.deactivate();
    };
  };

  readonly getSnapshot = (): number => this.version;
}

/**
 * Runs `select`, tracked, in the realm the nearest `RealmProvider` gives,
 * handing it a `read`, and rerenders when its result changes (`Object.is`).
 * Throws without a provider.
 */
export function useSelect<Value>(select: (read: Read) => Value): Value {
  const graph = graphOf(useRealm());
  const store = useRef<SelectStore<Value> | null>(null);
  // A new graph means a new realm: React drops the old store's subscription
  // when it sees the new `subscribe`.
  if (store.current === null || store.current.graph !== graph) {
    store.current = new SelectStore(graph, select);
  }
  const current = store.current;
  useSyncExternalStore(current.subscribe, current.getSnapshot, current.getSnapshot);
  const value = current.render(select);
  const rendered = current.lastRender;
  // A layout effect runs before the subscription's passive one, so a first
  // render's sources are in place when the reaction activates.
  useLayoutEffect(() => {
    current.keep(rendered, select, value);
  });
  return value;
}

/**
 * The store of `useValue` and `useValues`, for one list of observables known
 * before the render. The render and React read the result untracked; the
 * reaction follows the observables while React keeps the subscription.
 */
class SourceStore<Result> {
  private listener: (() => void) | undefined;
  private readonly reaction: Reaction | undefined;

  constructor(
    readonly observables: ReadonlyArray<Computed<unknown>>,
    private readonly read: () => Result,
    private readonly track: (read: Read) => unknown,
  ) {
    const first = observables[0];
    if (first === undefined) {
      this.reaction = undefined;
      return;
    }
    const realm = realmOf(first);
    // The reaction follows the first one's realm, whose `read` takes nothing of another.
    for (const observable of observables) {
      const theirs = realmOf(observable);
      if (theirs !== realm) {
        throw new PinnaUsageError(
          "pinna-react/mixed-realms",
          `pinna: useValues takes observables of one realm${realmsOf(theirs, realm)}`,
        );
      }
    }
    this.reaction = new Reaction(realmGraph(realm), () => this.follow(), "useValue");
  }

  /** Reads again, tracked, so the reaction stays linked to what changed, and tells React. */
  private follow(): void {
    try {
      this.reaction?.track(this.track);
    } catch {
      // React reads the result again and throws the error to the
      // component's error boundary.
    }
    this.listener?.();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    const reaction = this.reaction;
    if (reaction === undefined) {
      return () => {};
    }
    this.listener = listener;
    let failed = false;
    try {
      reaction.track(this.track);
    } catch {
      failed = true;
    }
    // React compares the result with the rendered one once it subscribes, so
    // a write between the render and here needs no notice. A hook that
    // activating starts may write what was just read, and that one does.
    if (reaction.activate() || failed) {
      listener();
    }
    return () => {
      this.listener = undefined;
      reaction.deactivate();
    };
  };

  readonly getSnapshot = (): Result => this.read();
}

/**
 * Whether `store` follows exactly `observables`, in the same order. An indexed
 * loop, since every render asks and a callback is a closure on Hermes.
 */
const follows = (
  store: SourceStore<unknown> | null,
  observables: ReadonlyArray<Computed<unknown>>,
): store is SourceStore<unknown> => {
  if (store === null || store.observables.length !== observables.length) {
    return false;
  }
  for (let index = 0; index < observables.length; index++) {
    if (store.observables[index] !== observables[index]) {
      return false;
    }
  }
  return true;
};

/**
 * Reads `observable` and rerenders when its value changes (`Object.is`).
 *
 * A render that reads another observable makes a new store; the subscription
 * moves to it only when React keeps that render.
 */
export function useValue<Value>(observable: Computed<Value>): Value {
  const store = useRef<SourceStore<Value> | null>(null);
  let current = store.current;
  if (current === null || current.observables[0] !== observable) {
    current = new SourceStore(
      [observable],
      () => peek(observable),
      (read) => read(observable),
    );
    store.current = current;
  }
  return useSyncExternalStore(current.subscribe, current.getSnapshot, current.getSnapshot);
}

type ValueOf<Observable> = Observable extends Computed<infer Value> ? Value : never;

/**
 * Reads each observable, in the realm of the first, and rerenders when any
 * value changes. The array keeps its identity until an element changes.
 */
export function useValues<const Observables extends ReadonlyArray<Computed<unknown>>>(
  observables: Observables,
): { readonly [Index in keyof Observables]: ValueOf<Observables[Index]> } {
  const store = useRef<SourceStore<ReadonlyArray<unknown>> | null>(null);
  let current = store.current;
  if (!follows(current, observables)) {
    // Own the list so a caller's mutation cannot change what this store reads
    // while its subscription still follows the previous observables.
    const sources = observables.slice();
    let values: ReadonlyArray<unknown> = [];
    current = new SourceStore(
      sources,
      // Every value is read; a new array starts only at the first that differs
      // (`Object.is`), so a read where nothing changed allocates nothing.
      () => {
        let next: Array<unknown> | undefined;
        for (let index = 0; index < sources.length; index++) {
          const value = peek(sources[index] as Computed<unknown>);
          if (next === undefined) {
            if (index < values.length && Object.is(values[index], value)) {
              continue;
            }
            next = values.slice(0, index);
          }
          next.push(value);
        }
        if (next !== undefined) {
          values = next;
        }
        return values;
      },
      (read) => {
        for (let index = 0; index < sources.length; index++) {
          read(sources[index] as Computed<unknown>);
        }
      },
    );
    store.current = current;
  }
  return useSyncExternalStore(
    current.subscribe,
    current.getSnapshot,
    current.getSnapshot,
  ) as unknown as { readonly [Index in keyof Observables]: ValueOf<Observables[Index]> };
}
