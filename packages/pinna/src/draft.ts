/**
 * Drafts: what `write.modify` hands its recipe. A draft copies an array or a
 * plain object on its first write and leaves everything else read-only; the
 * finished value shares every part the recipe did not touch. Uses nothing of
 * a realm.
 */
import { PinnaUsageError } from "@frondruntime/pinna-core";
import type { Box } from "./modules/box.ts";
import type { Collection } from "./modules/collection.ts";
import type { Computed } from "./modules/computed.ts";

type Primitive = string | number | boolean | bigint | symbol | null | undefined;
type Opaque = Primitive | RegExp | ((...args: never) => unknown);
/** The key that marks a model instance in the types; a value so bundlers can resolve its import. */
export const classInstance: unique symbol = Symbol("pinna.classInstance");

/**
 * Marks a model instance in the types, a `Model` or a pinna-effect
 * `Model.Schema`. A draft leaves a marked value read-only: it is not drafted,
 * so writing its fields would change the shared instance and notify nobody.
 */
export interface ClassInstance {
  readonly [classInstance]: true;
}
/** A `Date` without its `set` methods. */
type ReadonlyDate = {
  readonly [Key in keyof Date as Key extends `set${string}` ? never : Key]: Date[Key];
};

/**
 * A value a draft does not copy, read-only all the way down: a draft hands
 * back the held value itself, so a write in place would change it and notify
 * nobody.
 */
type DeepReadonly<Value> = Value extends Opaque
  ? Value
  : Value extends Date
    ? ReadonlyDate
    : Value extends Box<unknown> | Computed<unknown> | Collection<unknown, unknown> | ClassInstance
      ? Value
      : Value extends ReadonlyMap<infer Key, infer Item>
        ? ReadonlyMap<DeepReadonly<Key>, DeepReadonly<Item>>
        : Value extends ReadonlySet<infer Item>
          ? ReadonlySet<DeepReadonly<Item>>
          : Value extends ReadonlyArray<infer Element>
            ? ReadonlyArray<DeepReadonly<Element>>
            : { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> };

/**
 * What a `modify` recipe may write: arrays and plain objects, drafted down to
 * boxes. A `Date`, `Map` or `Set` is not drafted, so it is read-only; replace
 * it with a new one.
 */
export type Draft<Value> = Value extends Opaque
  ? Value
  : Value extends Box<unknown> | Computed<unknown> | Collection<unknown, unknown> | ClassInstance
    ? Value
    : Value extends Date | ReadonlyMap<unknown, unknown> | ReadonlySet<unknown>
      ? DeepReadonly<Value>
      : Value extends ReadonlyArray<infer Element>
        ? Array<Draft<Element>>
        : { -readonly [Key in keyof Value]: Draft<Value[Key]> };
// Walking values

const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** The named properties of the arrays `RegExp.prototype.exec` and `String.prototype.match` return. */
const matchKeys = ["index", "input", "groups"] as const;

/**
 * Visits each key a draft's copy holds (`copyContainer`): an object's own
 * enumerable keys, symbols too; an array's indexes, a match array's
 * `index`, `input`, and `groups`, and its enumerable symbol keys. Arrays by
 * index: `Object.keys` on a large array is ten times slower in
 * JavaScriptCore.
 */
const forEachKey = (value: object, visit: (key: PropertyKey) => void): void => {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      visit(index);
    }
    if (Object.hasOwn(value, "index")) {
      for (const key of matchKeys) {
        if (Object.hasOwn(value, key)) {
          visit(key);
        }
      }
    }
  } else {
    for (const key of Object.keys(value)) {
      visit(key);
    }
  }
  for (const key of Object.getOwnPropertySymbols(value)) {
    if (Object.prototype.propertyIsEnumerable.call(value, key)) {
      visit(key);
    }
  }
};

// Drafts

const draftKey: unique symbol = Symbol("pinna.draft");

/** One recipe's drafts share it; they are revoked when the recipe returns. */
interface DraftSession {
  open: boolean;
}

interface DraftState {
  readonly base: Record<PropertyKey, unknown>;
  copy: Record<PropertyKey, unknown> | undefined;
  /** Read children stay here until a write needs the parent copy. */
  children: Map<PropertyKey, Record<PropertyKey, unknown>> | undefined;
  readonly parent: DraftState | undefined;
  readonly session: DraftSession;
  /** Assigned containers can hold drafts even at keys never read or written. */
  readonly supplied: boolean;
  modified: boolean;
  /** Keys written or drafted in the copy; only these can differ from the base. */
  readonly touched: Set<PropertyKey>;
}

const isDraftable = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" &&
  value !== null &&
  (Array.isArray(value) || isPlainObject(value)) &&
  !(draftKey in value);

const latest = (state: DraftState): Record<PropertyKey, unknown> => state.copy ?? state.base;

/**
 * A shallow copy of an accepted array or plain object, as the value it
 * copies: a plain object keeps its prototype, `null` included, and its
 * enumerable symbol keys; an array keeps its elements, its enumerable symbol
 * keys, and a match array's `index`, `input`, and `groups`. An array's other
 * named properties are not kept: finding them costs `Object.keys` over every
 * index, sixty times a `slice` on 10,000 elements.
 */
const copyContainer = (value: Record<PropertyKey, unknown>): Record<PropertyKey, unknown> => {
  if (!Array.isArray(value)) {
    return Object.getPrototypeOf(value) === null
      ? Object.assign(Object.create(null) as Record<PropertyKey, unknown>, value)
      : { ...value };
  }
  const copy = value.slice() as unknown as Record<PropertyKey, unknown>;
  if (Object.hasOwn(value, "index")) {
    for (const key of matchKeys) {
      if (Object.hasOwn(value, key)) {
        copy[key] = value[key];
      }
    }
  }
  for (const key of Object.getOwnPropertySymbols(value)) {
    if (Object.prototype.propertyIsEnumerable.call(value, key)) {
      copy[key] = value[key];
    }
  }
  return copy;
};

const ensureCopy = (state: DraftState): Record<PropertyKey, unknown> => {
  if (state.copy === undefined) {
    state.copy = copyContainer(state.base);
    if (state.children !== undefined) {
      for (const [key, child] of state.children) {
        state.copy[key] = child;
      }
      state.children = undefined;
    }
  }
  return state.copy;
};

const markModified = (start: DraftState): void => {
  for (let state: DraftState | undefined = start; state !== undefined && !state.modified; ) {
    state.modified = true;
    state = state.parent;
  }
};

/**
 * The draft of `value`, a child of `parent`. The value is a tree, so every key
 * that reaches an object gets its own draft, whether the base held the object
 * or the recipe assigned it.
 */
const draftChild = (
  value: Record<PropertyKey, unknown>,
  parent: DraftState,
  supplied: boolean,
): Record<PropertyKey, unknown> => createDraft(value, parent, parent.session, supplied);

const assertDraftOpen = (state: DraftState): void => {
  if (!state.session.open) {
    throw new PinnaUsageError(
      "pinna/draft-kept",
      "pinna: a draft is used after its recipe returned",
    );
  }
};

/** A draft's state, or `undefined` when `value` is not a draft. */
const draftStateOf = (value: unknown): DraftState | undefined =>
  typeof value === "object" && value !== null
    ? (value as { [draftKey]?: DraftState })[draftKey]
    : undefined;

const indexOfKey = (key: PropertyKey): number | undefined =>
  typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) : undefined;

/**
 * Runs `move` on the copy itself and shifts the touched keys with the
 * elements, so the elements it moves stay undrafted: a read drafts them
 * wherever they now sit. `move` removes `removed` elements at `start` and
 * inserts `inserted`. The removed ones come back as a read would give them.
 */
const moveElements = (
  state: DraftState,
  start: number,
  removed: number,
  inserted: number,
  move: (copy: Array<unknown>) => Array<unknown>,
): Array<unknown> => {
  const copy = ensureCopy(state) as unknown as Array<unknown>;
  const removedOrigins: Array<"base" | "supplied" | undefined> = [];
  for (let index = start; index < start + removed; index++) {
    removedOrigins.push(
      isDraftable(copy[index])
        ? state.supplied || state.touched.has(String(index))
          ? "supplied"
          : "base"
        : undefined,
    );
  }
  const out = move(copy);
  const touched = [...state.touched];
  state.touched.clear();
  for (const key of touched) {
    const index = indexOfKey(key);
    if (index === undefined || index < start) {
      state.touched.add(key);
    } else if (index >= start + removed) {
      state.touched.add(String(index - removed + inserted));
    }
  }
  for (let index = start; index < start + inserted; index++) {
    state.touched.add(String(index));
  }
  if (removed > 0 || inserted > 0) {
    markModified(state);
  }
  return out.map((value, index) =>
    removedOrigins[index] !== undefined
      ? draftChild(
          value as Record<PropertyKey, unknown>,
          state,
          removedOrigins[index] === "supplied",
        )
      : value,
  );
};

/** `Array.prototype` turns a start or count argument into an integer this way. */
const toInteger = (value: unknown): number => Math.trunc(Number(value)) || 0;

/**
 * `shift`, `unshift`, and `splice` for a draft array. The native methods read
 * every element after the change through the draft, which drafts each one: a
 * shift of 5,000 rows made 5,000 drafts. These run on the copy instead. Called
 * on anything but a draft array, they are the native methods.
 */
const arrayMoves = {
  shift(this: unknown): unknown {
    const state = draftStateOf(this);
    if (state === undefined || !Array.isArray(state.base)) {
      return Array.prototype.shift.call(this);
    }
    assertDraftOpen(state);
    if ((latest(state) as unknown as Array<unknown>).length === 0) {
      return undefined;
    }
    return moveElements(state, 0, 1, 0, (copy) => [copy.shift()])[0];
  },
  unshift(this: unknown, ...items: Array<unknown>): number {
    const state = draftStateOf(this);
    if (state === undefined || !Array.isArray(state.base)) {
      return Array.prototype.unshift.apply(this, items);
    }
    assertDraftOpen(state);
    moveElements(state, 0, 0, items.length, (copy) => {
      copy.unshift(...items);
      return [];
    });
    return (latest(state) as unknown as Array<unknown>).length;
  },
  splice(this: unknown, ...args: Array<unknown>): Array<unknown> {
    const state = draftStateOf(this);
    if (state === undefined || !Array.isArray(state.base)) {
      return Array.prototype.splice.apply(this, args as [number, number, ...Array<unknown>]);
    }
    assertDraftOpen(state);
    const length = (latest(state) as unknown as Array<unknown>).length;
    const relative = toInteger(args[0]);
    const start = relative < 0 ? Math.max(length + relative, 0) : Math.min(relative, length);
    const removed =
      args.length === 0
        ? 0
        : args.length === 1
          ? length - start
          : Math.min(Math.max(toInteger(args[1]), 0), length - start);
    const items = args.slice(2);
    return moveElements(state, start, removed, items.length, (copy) =>
      copy.splice(start, removed, ...items),
    );
  },
};

/**
 * The value at an own `key` of `source`, the latest of `state`, as the draft
 * hands it out: an array or plain object as its child draft, made once and
 * cached, so every read of the key gives the same draft and its writes.
 */
const childOf = (
  state: DraftState,
  source: Record<PropertyKey, unknown>,
  key: PropertyKey,
): unknown => {
  const value = source[key];
  if (!isDraftable(value)) {
    return value;
  }
  const cached = state.children?.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const child = draftChild(value, state, state.supplied || state.touched.has(key));
  if (state.copy === undefined) {
    state.children ??= new Map();
    state.children.set(key, child);
  } else {
    state.copy[key] = child;
  }
  state.touched.add(key);
  return child;
};

const draftHandler: ProxyHandler<object> = {
  get(target, key) {
    const state = (target as { [draftKey]: DraftState })[draftKey];
    if (key === draftKey) {
      return state;
    }
    assertDraftOpen(state);
    const source = latest(state);
    if (!Object.hasOwn(source, key)) {
      if (Array.isArray(state.base) && typeof key === "string" && Object.hasOwn(arrayMoves, key)) {
        return arrayMoves[key as keyof typeof arrayMoves];
      }
      return Reflect.get(source, key);
    }
    return childOf(state, source, key);
  },
  set(target, key, value) {
    const state = (target as { [draftKey]: DraftState })[draftKey];
    assertDraftOpen(state);
    const copy = ensureCopy(state);
    if (Object.hasOwn(copy, key) && Object.is(copy[key], value)) {
      return true;
    }
    copy[key] = value;
    state.touched.add(key);
    markModified(state);
    return true;
  },
  deleteProperty(target, key) {
    const state = (target as { [draftKey]: DraftState })[draftKey];
    assertDraftOpen(state);
    delete ensureCopy(state)[key];
    markModified(state);
    return true;
  },
  has(target, key) {
    return key === draftKey || key in latest((target as { [draftKey]: DraftState })[draftKey]);
  },
  ownKeys(target) {
    return Reflect.ownKeys(latest((target as { [draftKey]: DraftState })[draftKey]));
  },
  getOwnPropertyDescriptor(target, key) {
    const state = (target as { [draftKey]: DraftState })[draftKey];
    const source = latest(state);
    const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined) {
      return undefined;
    }
    const isLength = Array.isArray(state.base) && key === "length";
    return {
      writable: true,
      configurable: !isLength,
      enumerable: descriptor.enumerable ?? false,
      // The child a read gives, so a write through the descriptor's value
      // lands in the draft and rolls back with it. A recipe that returned
      // gets a draft that refuses writes, never the committed object.
      value: state.session.open
        ? childOf(state, source, key)
        : isDraftable(source[key])
          ? createDraft(source[key], state, state.session)
          : source[key],
    };
  },
  defineProperty() {
    throw new PinnaUsageError(
      "pinna/draft-unsupported",
      "pinna: a draft does not take defineProperty; assign instead",
    );
  },
  getPrototypeOf(target) {
    return Object.getPrototypeOf((target as { [draftKey]: DraftState })[draftKey].base);
  },
  setPrototypeOf() {
    throw new PinnaUsageError(
      "pinna/draft-unsupported",
      "pinna: a draft cannot change its prototype",
    );
  },
};

/**
 * The proxy target holds the state under `draftKey`. It is a fresh array or
 * object, never the base, so writes cannot reach the base. The key is
 * configurable so `ownKeys` and `getOwnPropertyDescriptor` may leave it out.
 */
const createDraft = (
  base: Record<PropertyKey, unknown>,
  parent: DraftState | undefined,
  session: DraftSession,
  supplied = false,
): Record<PropertyKey, unknown> => {
  const state: DraftState = {
    base,
    copy: undefined,
    children: undefined,
    parent,
    session,
    supplied,
    modified: false,
    touched: new Set(),
  };
  const target: object = Array.isArray(base) ? [] : {};
  Object.defineProperty(target, draftKey, { value: state, configurable: true });
  return new Proxy(target, draftHandler) as Record<PropertyKey, unknown>;
};

interface FinalizedValue {
  value: Record<PropertyKey, unknown>;
  /** The value is, or holds, a draft the recipe wrote. */
  written: boolean;
  /** Finalization reached the value again before its walk ended. */
  revisited?: boolean;
  /** Supplied containers notify back-references if finalization copies them. */
  readonly onCopy?: Array<(copy: Record<PropertyKey, unknown>) => void>;
}

/**
 * Replaces drafts with their values, inside supplied arrays and objects too.
 * Draft outputs are recorded before descending, so a back-reference resolves
 * to the output. Supplied containers copy only when a child needs replacing.
 * Drafts over supplied containers walk every child; base drafts walk touched keys.
 */
const twoKeys = (): Error =>
  new PinnaUsageError(
    "pinna/draft-at-two-keys",
    "pinna: write.modify left an object it wrote under two keys; a box's value is a tree, so refer to the object by a key instead",
  );

/** The `write.modify` recipes running now, across realms. */
let openSessions = 0;

/**
 * Throws when `value`, or an array or plain object inside it, is a draft of
 * `write.modify`: a recipe still open can change it after a check accepted
 * it, and one already returned leaves a value every read refuses. A
 * schema box runs it beside its check, on the parts the check reads; a
 * recipe's own drafts are replaced with values before that, so only a draft
 * handed to a plain `write`, or to another recipe, reaches it. With no
 * recipe open no draft is live, and it returns at once.
 */
export const assertNoDraft = (value: unknown): void => {
  if (openSessions === 0 || typeof value !== "object" || value === null) {
    return;
  }
  const state = draftStateOf(value);
  if (state !== undefined) {
    assertDraftOpen(state);
    throw new PinnaUsageError(
      "pinna/draft-in-write",
      "pinna: a checked box was given a draft of an open write.modify; the recipe can still change it after the check, so write the box inside the recipe or pass a value read with read($box)",
    );
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    return;
  }
  const object = value as Record<PropertyKey, unknown>;
  forEachKey(object, (key) => {
    assertNoDraft(object[key]);
  });
};

const writtenElsewhere = (): Error =>
  new PinnaUsageError(
    "pinna/draft-of-another-recipe",
    "pinna: write.modify was given a draft another recipe wrote; that recipe can still change it, so read the value with read($box) or write it in that recipe",
  );

const finalize = (
  value: unknown,
  visited: WeakMap<object, FinalizedValue>,
  session: DraftSession,
): unknown => {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const state = (value as { [draftKey]?: DraftState })[draftKey];
  if (state !== undefined && state.session !== session) {
    // Another recipe's draft: an outer `write.modify`'s, still open, or one
    // kept past its recipe. Unwritten, it is the value it drafts. Written,
    // its copy is that recipe's to change after this box's check, so the
    // value is refused rather than copied: a copy would hide the later write.
    // A supplied one drafts a container that recipe assigned, which can hold
    // that recipe's drafts, so its base is finalized the same way.
    if (!state.session.open) {
      assertDraftOpen(state);
    }
    if (state.modified) {
      throw writtenElsewhere();
    }
    return state.supplied ? finalize(state.base, visited, session) : state.base;
  }
  const previous = visited.get(value);
  if (previous !== undefined) {
    // A written draft at a second key, or inside itself, would make the
    // value a graph: the next call drafts each key apart and splits it. A
    // supplied container at two keys carries a written draft it holds there
    // too; one still being walked is checked when its walk ends.
    if (state?.modified === true || previous.written) {
      throw twoKeys();
    }
    previous.revisited = true;
    return previous.value;
  }
  if (state !== undefined && !state.supplied) {
    if (!state.modified) {
      return state.base;
    }
    const copy = ensureCopy(state);
    visited.set(value, { value: copy, written: true });
    const base = state.base;
    for (const key of state.touched) {
      if (Object.hasOwn(copy, key) && copy[key] !== base[key]) {
        const child = copy[key];
        copy[key] = finalize(child, visited, session);
        // The child may be a draft that finalized to a supplied container,
        // which copies later if one of its own children needs replacing.
        const finalized =
          typeof child === "object" && child !== null ? visited.get(child) : undefined;
        if (finalized !== undefined && copy[key] === finalized.value) {
          finalized.onCopy?.push((replacement) => {
            copy[key] = replacement;
          });
        }
      }
    }
    return copy;
  }
  const source = state === undefined ? value : state.modified ? ensureCopy(state) : state.base;
  if (Array.isArray(source) || isPlainObject(source)) {
    const object = source as Record<PropertyKey, unknown>;
    const existing = visited.get(object);
    if (existing !== undefined) {
      if (existing.written) {
        throw twoKeys();
      }
      existing.revisited = true;
      visited.set(value, existing);
      return existing.value;
    }
    const entry: FinalizedValue = { value: object, written: state?.modified === true, onCopy: [] };
    visited.set(value, entry);
    visited.set(object, entry);
    const replace = (key: PropertyKey, child: unknown): void => {
      if (Object.is(entry.value[key], child)) {
        return;
      }
      if (entry.value === object && state?.modified !== true) {
        const copy = copyContainer(object);
        copy[key] = child;
        entry.value = copy;
        for (const notify of entry.onCopy as NonNullable<FinalizedValue["onCopy"]>) {
          notify(copy);
        }
        return;
      }
      entry.value[key] = child;
    };
    forEachKey(object, (key) => {
      const child = object[key];
      const value = finalize(child, visited, session);
      // Registered before the replace, which can copy this very container
      // when the child is a back-reference to it.
      const finalized =
        typeof child === "object" && child !== null ? visited.get(child) : undefined;
      if (finalized !== undefined) {
        entry.written ||= finalized.written;
        if (value === finalized.value) {
          finalized.onCopy?.push((replacement) => replace(key, replacement));
        }
      }
      replace(key, value);
    });
    if (entry.written && entry.revisited === true) {
      throw twoKeys();
    }
    return entry.value;
  }
  return value;
};

export const produce = <Value>(base: Value, recipe: (draft: Draft<Value>) => undefined): Value => {
  if (!isDraftable(base)) {
    throw new PinnaUsageError(
      "pinna/modify-not-draftable",
      "pinna: write.modify drafts arrays and plain objects; write other values whole with write($box, value)",
    );
  }
  const session: DraftSession = { open: true };
  const draft = createDraft(base, undefined, session);
  openSessions++;
  try {
    const result: unknown = recipe(draft as Draft<Value>);
    if (result !== undefined) {
      throw new PinnaUsageError(
        "pinna/recipe-returns-value",
        "pinna: a modify recipe returns nothing; write through the draft",
      );
    }
    return finalize(draft, new WeakMap(), session) as Value;
  } finally {
    session.open = false;
    openSessions--;
  }
};
