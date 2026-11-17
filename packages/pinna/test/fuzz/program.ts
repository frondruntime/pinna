import { Random } from "./random.ts";

/**
 * A program is plain data: nodes made up front, then operations over them.
 * A node is named by its index in `nodes`, so removing an operation never
 * breaks a reference (the shrinker relies on it).
 */

/** What a computed value, a watch's select, an autorun, or an untracked run computes. */
export type Compute =
  | { readonly kind: "sum"; readonly dependencies: ReadonlyArray<number> }
  /** Reads `whenEven` while `test` is even, `whenOdd` while it is odd. */
  | {
      readonly kind: "conditional";
      readonly test: number;
      readonly whenEven: number;
      readonly whenOdd: number;
    }
  | { readonly kind: "modulo"; readonly dependency: number; readonly divisor: number }
  /** Throws while the dependency is a multiple of `divisor`, then stops throwing. */
  | { readonly kind: "throwWhen"; readonly dependency: number; readonly divisor: number }
  /** `tracked` read in the place, `peeked` through `untracked`. */
  | { readonly kind: "peek"; readonly tracked: number; readonly peeked: number }
  /** Reads a dependency that may throw, returns -1 when it does. */
  | { readonly kind: "recover"; readonly dependency: number }
  | { readonly kind: "atom"; readonly atom: number; readonly dependency: number }
  | { readonly kind: "row"; readonly collection: number; readonly key: number }
  | { readonly kind: "keys"; readonly collection: number }
  | { readonly kind: "rows"; readonly collection: number };

export type NodeSpecification =
  | { readonly kind: "box"; readonly initial: number; readonly equalsModulo: number | undefined }
  | { readonly kind: "atom" }
  | { readonly kind: "collection" }
  | {
      readonly kind: "computed";
      readonly compute: Compute;
      readonly equalsModulo: number | undefined;
    };

export type Effect =
  | { readonly kind: "log" }
  /** Logs, then writes `(value + add) % 4` to a box: a watch effect that writes. */
  | { readonly kind: "write"; readonly box: number; readonly add: number }
  /** Logs, then throws when the value is a multiple of `divisor`. */
  | { readonly kind: "throw"; readonly divisor: number };

export type Operation =
  | { readonly kind: "read"; readonly node: number }
  | { readonly kind: "write"; readonly node: number; readonly value: number }
  | { readonly kind: "changed"; readonly node: number }
  | {
      readonly kind: "upsert";
      readonly node: number;
      readonly key: number;
      readonly value: number;
      readonly at: "start" | "end";
    }
  | { readonly kind: "remove"; readonly node: number; readonly key: number }
  | {
      readonly kind: "replaceAll";
      readonly node: number;
      readonly rows: ReadonlyArray<readonly [number, number]>;
    }
  | { readonly kind: "throw"; readonly message: string }
  | {
      readonly kind: "update";
      readonly items: ReadonlyArray<Operation>;
      readonly catchInner: boolean;
    }
  | { readonly kind: "untracked"; readonly compute: Compute }
  | {
      readonly kind: "watch";
      readonly slot: number;
      readonly select: Compute;
      readonly effect: Effect;
      readonly equalsModulo: number | undefined;
    }
  | { readonly kind: "unwatch"; readonly slot: number }
  | { readonly kind: "observe"; readonly slot: number; readonly node: number }
  | { readonly kind: "release"; readonly slot: number }
  | { readonly kind: "hook"; readonly slot: number; readonly node: number; readonly fails: boolean }
  | { readonly kind: "unhook"; readonly slot: number }
  | {
      readonly kind: "autorun";
      readonly slot: number;
      readonly compute: Compute;
      readonly cleanup: boolean;
    }
  | { readonly kind: "stopAutorun"; readonly slot: number }
  | { readonly kind: "inspect"; readonly node: number };

export interface Program {
  readonly seed: number;
  readonly nodes: ReadonlyArray<NodeSpecification>;
  readonly operations: ReadonlyArray<Operation>;
}

const slotCount = 4;

/** Turns a seed into a program. The same seed gives the same program. */
export const generate = (seed: number): Program => {
  const random = new Random(seed);
  const nodes: Array<NodeSpecification> = [];
  const boxes: Array<number> = [];
  const atoms: Array<number> = [];
  const collections: Array<number> = [];
  const values: Array<number> = [];

  const boxCount = random.integer(2, 5);
  for (let index = 0; index < boxCount; index++) {
    boxes.push(nodes.length);
    values.push(nodes.length);
    nodes.push({
      kind: "box",
      initial: random.integer(0, 5),
      equalsModulo: random.chance(0.15) ? 2 : undefined,
    });
  }
  const atomCount = random.integer(0, 2);
  for (let index = 0; index < atomCount; index++) {
    atoms.push(nodes.length);
    nodes.push({ kind: "atom" });
  }
  if (random.chance(0.4)) {
    collections.push(nodes.length);
    nodes.push({ kind: "collection" });
  }

  const computedCount = random.integer(3, 10);
  const firstComputed = nodes.length;
  // A dependency of a computed value is an earlier value; rarely, any
  // computed value, which can close a cycle. A place (self < 0) reads any value.
  const compute = (self: number): Compute => {
    const pickDependency = (): number => {
      if (self < 0) {
        return random.pick(values);
      }
      if (random.chance(0.03)) {
        return random.integer(firstComputed, firstComputed + computedCount - 1);
      }
      return random.pick(values.filter((value) => value < self));
    };
    const kinds: Array<readonly [number, Compute["kind"]]> = [
      [4, "sum"],
      [3, "conditional"],
      [2, "modulo"],
      [2, "throwWhen"],
      [1, "peek"],
      [1, "recover"],
    ];
    if (atoms.length > 0) {
      kinds.push([1, "atom"]);
    }
    if (collections.length > 0) {
      kinds.push([1, "row"], [1, "keys"], [1, "rows"]);
    }
    switch (random.weighted(kinds)) {
      case "sum":
        return {
          kind: "sum",
          dependencies: Array.from({ length: random.integer(1, 3) }, pickDependency),
        };
      case "conditional":
        return {
          kind: "conditional",
          test: pickDependency(),
          whenEven: pickDependency(),
          whenOdd: pickDependency(),
        };
      case "modulo":
        return { kind: "modulo", dependency: pickDependency(), divisor: random.integer(2, 3) };
      case "throwWhen":
        return { kind: "throwWhen", dependency: pickDependency(), divisor: random.integer(2, 4) };
      case "peek":
        return { kind: "peek", tracked: pickDependency(), peeked: pickDependency() };
      case "recover":
        return { kind: "recover", dependency: pickDependency() };
      case "atom":
        return { kind: "atom", atom: random.pick(atoms), dependency: pickDependency() };
      case "row":
        return { kind: "row", collection: random.pick(collections), key: random.integer(0, 3) };
      case "keys":
        return { kind: "keys", collection: random.pick(collections) };
      default:
        return { kind: "rows", collection: random.pick(collections) };
    }
  };

  for (let index = 0; index < computedCount; index++) {
    const self = nodes.length;
    nodes.push({
      kind: "computed",
      compute: compute(self),
      equalsModulo: random.chance(0.15) ? 2 : undefined,
    });
    values.push(self);
  }

  const effect = (): Effect =>
    random.weighted<Effect>([
      [6, { kind: "log" }],
      [2, { kind: "write", box: random.pick(boxes), add: random.integer(0, 3) }],
      [1, { kind: "throw", divisor: random.integer(2, 3) }],
    ]);

  const operation = (depth: number, inUpdate: boolean): Operation => {
    const kinds: Array<readonly [number, Operation["kind"]]> = [
      [6, "read"],
      [3, "watch"],
      [2, "unwatch"],
      [2, "observe"],
      [2, "release"],
      [1, "hook"],
      [1, "unhook"],
      [1, "autorun"],
      [1, "stopAutorun"],
      [1, "untracked"],
      [1, "inspect"],
    ];
    if (depth < 3) {
      kinds.push([inUpdate ? 2 : 6, "update"]);
    }
    if (inUpdate) {
      kinds.push([8, "write"], [1, "throw"]);
      if (atoms.length > 0) {
        kinds.push([2, "changed"]);
      }
      if (collections.length > 0) {
        kinds.push([2, "upsert"], [1, "remove"], [1, "replaceAll"]);
      }
    }
    const slot = (): number => random.integer(0, slotCount - 1);
    switch (random.weighted(kinds)) {
      case "read":
        return { kind: "read", node: random.integer(0, nodes.length - 1) };
      case "write":
        return { kind: "write", node: random.pick(boxes), value: random.integer(0, 5) };
      case "changed":
        return { kind: "changed", node: random.pick(atoms) };
      case "upsert":
        return {
          kind: "upsert",
          node: random.pick(collections),
          key: random.integer(0, 3),
          value: random.integer(0, 3),
          at: random.pick(["start", "end"] as const),
        };
      case "remove":
        return { kind: "remove", node: random.pick(collections), key: random.integer(0, 3) };
      case "replaceAll":
        return {
          kind: "replaceAll",
          node: random.pick(collections),
          rows: [0, 1, 2, 3]
            .filter(() => random.chance(0.5))
            .map((key) => [key, random.integer(0, 3)] as const),
        };
      case "throw":
        return { kind: "throw", message: `midway-${random.integer(0, 9)}` };
      case "update":
        return {
          kind: "update",
          items: Array.from({ length: random.integer(1, 5) }, () => operation(depth + 1, true)),
          catchInner: random.chance(0.4),
        };
      case "untracked":
        return { kind: "untracked", compute: compute(-1) };
      case "watch":
        return {
          kind: "watch",
          slot: slot(),
          select: compute(-1),
          effect: effect(),
          equalsModulo: random.chance(0.15) ? 2 : undefined,
        };
      case "unwatch":
        return { kind: "unwatch", slot: slot() };
      case "observe":
        return { kind: "observe", slot: slot(), node: random.pick(values) };
      case "release":
        return { kind: "release", slot: slot() };
      case "hook":
        return {
          kind: "hook",
          slot: slot(),
          node: random.chance(0.2) && atoms.length > 0 ? random.pick(atoms) : random.pick(values),
          fails: random.chance(0.1),
        };
      case "unhook":
        return { kind: "unhook", slot: slot() };
      case "autorun":
        return {
          kind: "autorun",
          slot: slot(),
          compute: compute(-1),
          cleanup: random.chance(0.5),
        };
      case "stopAutorun":
        return { kind: "stopAutorun", slot: slot() };
      default:
        return { kind: "inspect", node: random.integer(0, nodes.length - 1) };
    }
  };

  const operations = Array.from({ length: random.integer(15, 60) }, () => operation(0, false));
  return { seed, nodes, operations };
};
