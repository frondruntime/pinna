import type { Atom, Box, Collection, Computed, Read, Realm, Write } from "../../src/index.ts";
import type { Compute, Effect, Operation, Program } from "./program.ts";

/** The public layer, as a module namespace: this worktree's, or a reference's. */
export type Api = typeof import("../../src/index.ts");

/** One row of a collection. */
interface Row {
  readonly key: number;
  readonly value: number;
}

type Handle =
  | { readonly kind: "box"; readonly box: Box<number> }
  | { readonly kind: "atom"; readonly atom: Atom }
  | { readonly kind: "collection"; readonly collection: Collection<number, Row> }
  | { readonly kind: "computed"; readonly computed: Computed<number> };

/** What an error looks like in a trace: its class name and message. */
export const describeError = (error: unknown): string =>
  error instanceof Error
    ? `${error.constructor.name}: ${error.message}`
    : `non-error ${String(error)}`;

/** The place an operation runs in: an update's verbs, or none at the top level. */
interface Place {
  readonly read: Read | undefined;
  readonly write: Write | undefined;
}

const topLevel: Place = { read: undefined, write: undefined };

/**
 * Runs one program against one implementation and returns its trace: every
 * value a watch or autorun received, every value a read returned, every
 * error thrown or reported, every compute run, every `Source.onObserved` call, and
 * the end state. Entries are strings, so a trace compares by equality.
 */
export const execute = (program: Program, api: Api, check?: Check): Array<string> => {
  const trace: Array<string> = [];
  const log = (entry: string): void => {
    trace.push(entry);
  };
  try {
    run(program, api, log, check);
  } catch (error) {
    log(`crash ${describeError(error)}`);
  }
  return trace;
};

/**
 * Checks the graph at rest, after each top-level operation and teardown:
 * handed the program's boxes, computed values, and atoms. The graph checker
 * of `pinna-core` (`graphCheck` in `test/internal/graph-check.ts`); only this checkout's API is
 * checked, since a reference's nodes are another copy's.
 */
export type Check = (observables: ReadonlyArray<Box<number> | Computed<number> | Atom>) => void;

const run = (
  program: Program,
  api: Api,
  log: (entry: string) => void,
  check: Check | undefined,
): void => {
  const {
    Atom: { make: atom },
    Realm: { autorun, make: createRealm },
    Box: { make: box },
    Collection: { make: collection },
    Computed: { make: computed },
    Source: { inspect },
  } = api;
  const {
    Source: { observe, onObserved },
    Realm: { untracked, update, watch },
  } = api;
  const realm: Realm = createRealm({ onError: (error) => log(`onError ${describeError(error)}`) });

  const handles: Array<Handle> = [];
  const handle = (index: number): Handle => {
    const found = handles[index];
    if (found === undefined) {
      throw new Error(`fuzz: no node ${index}`);
    }
    return found;
  };
  /** The node at `index` as a value to read: a box or a computed value. */
  const computedOf = (index: number): Computed<number> => {
    const found = handle(index);
    if (found.kind === "box") {
      return found.box;
    }
    if (found.kind === "computed") {
      return found.computed;
    }
    throw new Error(`fuzz: node ${index} has no value`);
  };
  const collectionOf = (index: number): Collection<number, Row> => {
    const found = handle(index);
    if (found.kind !== "collection") {
      throw new Error(`fuzz: node ${index} is no collection`);
    }
    return found.collection;
  };

  /** Evaluates a compute inside a place that hands out `read`. */
  const evaluate = (specification: Compute, read: Read, label: string): number => {
    switch (specification.kind) {
      case "sum": {
        let total = 0;
        for (const dependency of specification.dependencies) {
          total += read(computedOf(dependency));
        }
        return total;
      }
      case "conditional":
        return read(computedOf(specification.test)) % 2 === 0
          ? read(computedOf(specification.whenEven))
          : read(computedOf(specification.whenOdd));
      case "modulo":
        return read(computedOf(specification.dependency)) % specification.divisor;
      case "throwWhen": {
        const value = read(computedOf(specification.dependency));
        if (value % specification.divisor === 0) {
          throw new Error(`${label} fails on ${value}`);
        }
        return value;
      }
      case "peek": {
        const tracked = read(computedOf(specification.tracked));
        const peeked = untracked(realm, (peek) => peek(computedOf(specification.peeked)));
        return tracked * 10 + peeked;
      }
      case "recover":
        try {
          return read(computedOf(specification.dependency));
        } catch (error) {
          log(`${label} recovered from ${describeError(error)}`);
          return -1;
        }
      case "atom": {
        const handleOfAtom = handle(specification.atom);
        if (handleOfAtom.kind === "atom") {
          read(handleOfAtom.atom);
        }
        return read(computedOf(specification.dependency));
      }
      case "row": {
        const row = read(collectionOf(specification.collection).row(specification.key));
        return row === undefined ? -1 : row.value;
      }
      case "keys":
        return read(collectionOf(specification.collection).keys).reduce(
          (total, key) => total * 7 + key + 1,
          0,
        );
      case "rows":
        return read(collectionOf(specification.collection).rows).reduce(
          (total, row) => total * 7 + row.value + 1,
          0,
        );
    }
  };

  for (const [index, specification] of program.nodes.entries()) {
    const name = `n${index}`;
    switch (specification.kind) {
      case "box": {
        const modulo = specification.equalsModulo;
        handles.push({
          kind: "box",
          box: box(realm, specification.initial, {
            name,
            ...(modulo === undefined
              ? {}
              : { equals: (left: number, right: number) => left % modulo === right % modulo }),
          }),
        });
        break;
      }
      case "atom":
        handles.push({ kind: "atom", atom: atom(realm) });
        break;
      case "collection":
        handles.push({
          kind: "collection",
          collection: collection(realm, { keyOf: (row: Row) => row.key }),
        });
        break;
      case "computed": {
        const modulo = specification.equalsModulo;
        handles.push({
          kind: "computed",
          computed: computed(
            realm,
            (read) => {
              log(`run ${name}`);
              return evaluate(specification.compute, read, name);
            },
            {
              name,
              ...(modulo === undefined
                ? {}
                : { equals: (left: number, right: number) => left % modulo === right % modulo }),
            },
          ),
        });
        break;
      }
    }
  }

  const watches: Array<(() => void) | undefined> = [];
  const observed: Array<(() => void) | undefined> = [];
  const hooks: Array<(() => void) | undefined> = [];
  const autoruns: Array<(() => void) | undefined> = [];
  let generation = 0;

  const readNode = (place: Place, node: number): void => {
    const found = handle(node);
    try {
      const read = (verb: Read): string => {
        switch (found.kind) {
          case "box":
            return String(verb(found.box));
          case "computed":
            return String(verb(found.computed));
          case "atom":
            return String(verb(found.atom));
          case "collection":
            return `${verb(found.collection.keys).join(",")}|${verb(found.collection.rows)
              .map((row) => `${row.key}:${row.value}`)
              .join(",")}`;
        }
      };
      const text =
        place.read === undefined ? untracked(realm, (verb) => read(verb)) : read(place.read);
      log(`read n${node} = ${text}`);
    } catch (error) {
      log(`read n${node} threw ${describeError(error)}`);
    }
  };

  const effectOf = (label: string, effect: Effect) => (value: number, previous: number) => {
    log(`${label} ${value} (was ${previous})`);
    if (effect.kind === "write") {
      const target = handle(effect.box);
      if (target.kind === "box") {
        const next = (value + effect.add) % 4;
        update(realm, (_read, write) => {
          write(target.box, next);
        });
      }
    } else if (effect.kind === "throw" && value % effect.divisor === 0) {
      throw new Error(`${label} effect fails on ${value}`);
    }
    return undefined;
  };

  const step = (operation: Operation, place: Place): void => {
    switch (operation.kind) {
      case "read":
        readNode(place, operation.node);
        return;
      case "write": {
        const target = handle(operation.node);
        if (target.kind === "box") {
          place.write?.(target.box, operation.value);
        }
        return;
      }
      case "changed": {
        const target = handle(operation.node);
        if (target.kind === "atom") {
          place.write?.changed(target.atom);
        }
        return;
      }
      case "upsert":
        place.write?.upsert(
          collectionOf(operation.node),
          { key: operation.key, value: operation.value },
          { at: operation.at },
        );
        return;
      case "remove":
        place.write?.remove(collectionOf(operation.node), operation.key);
        return;
      case "replaceAll":
        place.write?.replaceAll(
          collectionOf(operation.node),
          operation.rows.map(([key, value]) => ({ key, value })),
        );
        return;
      case "throw":
        throw new Error(operation.message);
      case "update": {
        const body = (): void => {
          update(realm, (read, write) => {
            const inner: Place = { read, write };
            for (const item of operation.items) {
              step(item, inner);
            }
          });
        };
        if (place.write !== undefined && operation.catchInner) {
          try {
            body();
          } catch (error) {
            log(`caught ${describeError(error)}`);
          }
        } else {
          body();
        }
        return;
      }
      case "untracked": {
        const label = `untracked@${operation.compute.kind}`;
        try {
          log(`${label} = ${untracked(realm, (read) => evaluate(operation.compute, read, label))}`);
        } catch (error) {
          log(`${label} threw ${describeError(error)}`);
        }
        return;
      }
      case "watch": {
        const label = `watch${operation.slot}.${generation++}`;
        const modulo = operation.equalsModulo;
        watches[operation.slot] = watch(
          realm,
          (read) => evaluate(operation.select, read, label),
          effectOf(label, operation.effect),
          modulo === undefined
            ? undefined
            : { equals: (left, right) => left % modulo === right % modulo },
        );
        log(`${label} started`);
        return;
      }
      case "unwatch":
        watches[operation.slot]?.();
        watches[operation.slot] = undefined;
        return;
      case "observe": {
        const found = handle(operation.node);
        const target = found.kind === "box" ? found.box : computedOf(operation.node);
        observed[operation.slot] = observe(target);
        return;
      }
      case "release":
        observed[operation.slot]?.();
        observed[operation.slot] = undefined;
        return;
      case "hook": {
        const found = handle(operation.node);
        const label = `hook${operation.slot}.${generation++}@n${operation.node}`;
        const target = found.kind === "atom" ? found.atom : computedOf(operation.node);
        hooks[operation.slot] = onObserved(target, () => {
          log(`${label} start`);
          if (operation.fails) {
            throw new Error(`${label} fails`);
          }
          return () => {
            log(`${label} stop`);
          };
        });
        return;
      }
      case "unhook":
        hooks[operation.slot]?.();
        hooks[operation.slot] = undefined;
        return;
      case "autorun": {
        const label = `autorun${operation.slot}.${generation++}`;
        autoruns[operation.slot] = autorun(realm, (read) => {
          log(`${label} = ${evaluate(operation.compute, read, label)}`);
          return operation.cleanup ? () => log(`${label} cleanup`) : undefined;
        });
        log(`${label} started`);
        return;
      }
      case "stopAutorun":
        autoruns[operation.slot]?.();
        autoruns[operation.slot] = undefined;
        return;
      case "inspect": {
        const found = handle(operation.node);
        const target =
          found.kind === "box"
            ? found.box
            : found.kind === "atom"
              ? found.atom
              : found.kind === "computed"
                ? found.computed
                : undefined;
        if (target === undefined) {
          return;
        }
        const report = inspect(target);
        log(
          `inspect n${operation.node} dependencies=[${report.dependencies.join(",")}] observers=${report.observers} reason=${report.lastReason}`,
        );
        return;
      }
    }
  };

  const snapshot = (tag: string): void => {
    log(`-- ${tag}`);
    for (const index of program.nodes.keys()) {
      readNode(topLevel, index);
      step({ kind: "inspect", node: index }, topLevel);
    }
  };

  const observables = (): ReadonlyArray<Box<number> | Computed<number> | Atom> => {
    const found: Array<Box<number> | Computed<number> | Atom> = [];
    for (const each of handles) {
      if (each.kind === "box") found.push(each.box);
      else if (each.kind === "computed") found.push(each.computed);
      else if (each.kind === "atom") found.push(each.atom);
    }
    return found;
  };

  for (const [index, operation] of program.operations.entries()) {
    log(`-- operation ${index}`);
    try {
      step(operation, topLevel);
    } catch (error) {
      log(`operation ${index} (${operation.kind}) threw ${describeError(error)}`);
    }
    check?.(observables());
  }

  snapshot("end");
  for (const stops of [watches, observed, hooks, autoruns]) {
    for (const [slot, stop] of stops.entries()) {
      try {
        stop?.();
      } catch (error) {
        log(`teardown threw ${describeError(error)}`);
      }
      stops[slot] = undefined;
    }
  }
  check?.(observables());
  snapshot("stopped");
};
