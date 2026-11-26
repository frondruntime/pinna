/**
 * Views a collection keeps up to date: an ordered view, a group index, and
 * totals per group. Each listens with `Collection.onRowChange` and keeps
 * its state in a box or a collection of the same realm, so a failed update
 * puts the view back with the rows, a stage sees the view over its staged
 * rows, and nothing here reaches into `Realm.update` (ruling 63).
 */
import { PinnaUsageError } from "@frondruntime/pinna-core";
import {
  AtomCell,
  acceptAll,
  type BoxCell,
  CollectionCell,
  type ComputedValue,
  computed,
  computedFunction,
  nameSource,
} from "./box.ts";
import { collection, type KeyedCollection, listenRows } from "./collection.ts";
import type { Box } from "./modules/box.ts";
import type { Collection } from "./modules/collection.ts";
import type { Computed } from "./modules/computed.ts";
import { type ObservableRealm, realmStatus } from "./realm.ts";
import { inWindow } from "./stack.ts";
import { stageWritingCollection } from "./stage.ts";
import type { Read, Write } from "./verbs.ts";
import * as Tree from "./view-tree.ts";

/** `"open"` while the view is kept up to date; `"disposed"` after `View.dispose` or `Realm.dispose`. */
export type ViewStatus = "open" | "disposed";

const sameKeys = <Key>(left: ReadonlyArray<Key>, right: ReadonlyArray<Key>): boolean => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (!Object.is(left[index], right[index])) return false;
  }
  return true;
};

/** Map's key equality: `Object.is`, except that `0` and `-0` are one key. */
const sameKey = (left: unknown, right: unknown): boolean =>
  left === right || Object.is(left, right);

const empty: ReadonlyArray<never> = Object.freeze([]);

/** `{ name: "<name>.<part>" }` for a named view, else no name. */
const partName = (name: string | undefined, part: string): { readonly name?: string } =>
  name === undefined ? {} : { name: `${name}.${part}` };

/** What every view shares: its listener, its name, and its lifecycle. */
abstract class View {
  /**
   * Set once the view's listener is removed: by `View.dispose`, by a
   * rollback of the update that made the view, or by `Realm.dispose`.
   */
  protected stopped = false;
  private stop: () => void = () => undefined;

  constructor(
    readonly realm: ObservableRealm,
    /** The call that made it, such as `View.ordered`. */
    readonly call: string,
    readonly name: string | undefined,
  ) {}

  /** The view as errors name it: `View.ordered "trades"`, or `View.ordered`. */
  get label(): string {
    return this.name === undefined ? this.call : `${this.call} "${this.name}"`;
  }

  protected listen<Key, Row>(
    source: Collection<Key, Row>,
    listener: (
      key: Key,
      before: Row | undefined,
      after: Row | undefined,
      read: Read,
      write: Write,
    ) => void,
  ): void {
    const staged = stageWritingCollection(
      this.realm,
      source as unknown as KeyedCollection<unknown, unknown>,
    );
    if (staged !== undefined) {
      // A listener hears the realm's rows, not a stage's: it would miss what
      // the stage wrote, and fail on the stage's next write of those rows.
      throw new PinnaUsageError(
        "pinna/view-staged-rows",
        `pinna: ${this.call} cannot start while ${staged} holds writes to its collection; make the view before the stage writes it, or after the stage is applied or dropped`,
      );
    }
    this.stop = listenRows(
      source,
      (change, read, write) => {
        listener(change.key, change.before, change.after, read, write);
        return undefined;
      },
      this.call,
      this.label,
      () => {
        this.stopped = true;
        this.onStopped();
      },
      true,
    );
  }

  /** Runs once, as the view stops: an ordered view keeps its committed state there. */
  protected onStopped(): void {}

  get status(): ViewStatus {
    return this.stopped || realmStatus(this.realm) === "disposed" ? "disposed" : "open";
  }

  /** Throws for a read through a disposed view: it is no longer kept up to date. */
  assertOpen(what: string): void {
    if (this.status === "disposed") {
      throw new PinnaUsageError(
        "pinna/view-disposed",
        `pinna: ${this.label} is disposed, so its ${what} is no longer kept up to date`,
      );
    }
  }

  dispose(): void {
    if (this.stopped) return;
    this.stop();
    if (!this.stopped) {
      this.stopped = true;
      this.onStopped();
    }
  }

  /** A row the view placed is not where its callbacks now put it. */
  outOfStep(key: unknown, callbacks: string): PinnaUsageError {
    return new PinnaUsageError(
      "pinna/view-out-of-step",
      `pinna: ${this.label} did not find the row of key ${String(key)} where ${callbacks} placed it; ${callbacks} must be deterministic and rows must not change after they are written`,
    );
  }
}

// Ordered view

/** How an ordered view sorts and filters, read again when what the factories read changes. */
export interface OrderedViewOptions<Key, Row> {
  /**
   * Returns the comparator. It is tracked: `read` here makes the view sort
   * again when what it reads changes. The comparator itself reads no
   * observable, and returns a negative number, zero, or a positive number.
   */
  readonly compare: (read: Read) => (left: Row, right: Row) => number;
  /**
   * Returns the predicate a row must pass to be in the view, or `undefined`
   * for every row. Tracked, as `compare` is.
   */
  readonly filter?: (read: Read) => ((row: Row, key: Key) => boolean) | undefined;
  /** Names the view in errors, in `testRealm`, and its computed values (`<name>.size`). */
  readonly name?: string;
}

/** A sorted, filtered order of a collection's keys, kept up to date a row at a time. */
export interface OrderedView<Key> extends Disposable {
  /** How many rows pass the filter. */
  readonly size: Computed<number>;
  /** How many rows the collection holds, filtered or not. */
  readonly totalSize: Computed<number>;
  /** Every key that passes the filter, in order. Its reader reruns on any change to the order. */
  readonly keys: Computed<ReadonlyArray<Key>>;
  /**
   * The keys at ranks `start` up to, not including, `end`, clamped to
   * `size`. Its reader reruns only when those keys change. Returns the same
   * computed value for the same arguments while something observes it.
   */
  range(start: number, end: number): Computed<ReadonlyArray<Key>>;
}

interface Config<Key, Row> {
  readonly compare: (left: Row, right: Row) => number;
  readonly filter: ((row: Row, key: Key) => boolean) | undefined;
}

interface OrderedState<Key, Row> {
  /** The config the trees were built with; `undefined` before the first build. */
  readonly config: Config<Key, Row> | undefined;
  readonly order: Tree.Compare<Row>;
  readonly all: Tree.Tree<Row> | undefined;
  readonly matching: Tree.Tree<Row> | undefined;
}

const keyRank: Record<string, true> = { string: true, number: true, bigint: true };

class OrderedViewImpl<Key, Row> extends View implements OrderedView<Key> {
  /**
   * The state the view held as it stopped: the realm's confirmed state box,
   * never a value `current` answered on the way, for a listener mid-update
   * or a stage, which read the same computed value.
   */
  private frozen: OrderedState<Key, Row> | undefined;
  /**
   * Marked as the view stops, so `current` and the handles read from it
   * compute again and answer `frozen`, whatever they cached before.
   */
  private readonly stopMark: AtomCell;
  private readonly state: Box<OrderedState<Key, Row>>;
  /** The last rebuild and the box value it started from; see `current`. */
  private lastRebuild:
    | { readonly from: OrderedState<Key, Row>; readonly result: OrderedState<Key, Row> }
    | undefined;
  /** The comparator and the filter: a disposal at rest reads their confirmed values. */
  private readonly config: Computed<Config<Key, Row>>;
  private readonly current: Computed<OrderedState<Key, Row>>;
  /** The source's key of a row: the trees hold rows, and a key is asked for only on a tie or a read. */
  private readonly keyOf: (row: Row) => Key;
  private readonly sizeValue: Computed<number>;
  private readonly totalSizeValue: Computed<number>;
  private readonly keysValue: Computed<ReadonlyArray<Key>>;
  private readonly rangeOf: (start: number, end: number) => Computed<ReadonlyArray<Key>>;

  constructor(
    realm: ObservableRealm,
    source: Collection<Key, Row>,
    options: OrderedViewOptions<Key, Row>,
  ) {
    super(realm, "View.ordered", options.name);
    const name = options.name;
    const keyOf = (source as KeyedCollection<Key, Row>).keyOf;
    this.keyOf = keyOf;
    // Two computed values, so a box only `filter` reads keeps the comparator,
    // and a filter change filters the sorted rows without sorting them.
    const compare = computed(realm, (read) => options.compare(read), partName(name, "compare"));
    const filterOption = options.filter;
    const filter = computed(
      realm,
      (read) => (filterOption === undefined ? undefined : filterOption(read)),
      partName(name, "filter"),
    );
    this.config = computed(realm, (read) => ({ compare: read(compare), filter: read(filter) }));
    // A `CollectionCell`, so no record lists it: the view follows the rows
    // on every restore (ruling 74).
    const state = new CollectionCell<OrderedState<Key, Row>>(
      realm,
      acceptAll,
      { config: undefined, order: () => 0, all: undefined, matching: undefined },
      Object.is,
    );
    if (name !== undefined) {
      nameSource(state.source, `${name}.state`);
    }
    this.state = state;
    const stopMark = new AtomCell(realm);
    this.stopMark = stopMark;
    // The state as of the current config: the box when its trees were built
    // with it, else a rebuild from the box's trees. A listener reads it as
    // its base, so a config change rebuilds once, and the next row change
    // stores the rebuild.
    this.current = computed(
      realm,
      (read) => {
        read(stopMark);
        // A disposed view keeps its last value: a box its factories read
        // still changes, and would rebuild an order nothing keeps up to date.
        if (this.stopped) {
          if (this.frozen !== undefined) {
            return this.frozen;
          }
          // Stopped inside an update: the state box is tracked, so a rollback
          // of a row write made before the disposal reaches the handles.
          read(state);
          return this.baseState();
        }
        const held = read(state);
        const now = { compare: read(compare), filter: read(filter) };
        // A rebuild since the box last changed is the base for the next
        // one: two config changes with no row write between sort once each,
        // from the trees the last one built. Keyed by the box's value, so a
        // rollback or a stage's own value starts from that value.
        const last = this.lastRebuild;
        const base = last !== undefined && last.from === held ? last.result : held;
        const built = base.config;
        if (built !== undefined && built.compare === now.compare && built.filter === now.filter) {
          return base;
        }
        const result = this.rebuild(base, now);
        this.lastRebuild = { from: held, result };
        return result;
      },
      { ...partName(name, "current") },
    );
    this.sizeValue = computed(realm, (read) => Tree.size(read(this.current).matching), {
      ...partName(name, "size"),
    });
    this.totalSizeValue = computed(realm, (read) => Tree.size(read(this.current).all), {
      ...partName(name, "totalSize"),
    });
    this.keysValue = computed(
      realm,
      (read) => Tree.entries(read(this.current).matching).map(keyOf),
      { equals: sameKeys, ...partName(name, "keys") },
    );
    this.rangeOf = computedFunction(
      realm,
      (read, start: number, end: number) =>
        Tree.range(read(this.current).matching, start, end).map(keyOf),
      { equals: sameKeys, ...partName(name, "range") },
    );
    this.listen(source, (key, before, after, read, write) => {
      const held = read(this.current);
      const order = held.order;
      const filter = held.config?.filter;
      let all = held.all;
      let matching = held.matching;
      if (before !== undefined) {
        const entry = before;
        all = this.removeFound(all, entry, order, "compare");
        if (filter !== undefined) {
          if (filter(before, key)) {
            matching = this.removeFound(matching, entry, order, "compare and filter");
          } else if (Tree.has(matching, entry, order)) {
            // The filter dropped a row it kept: left in place, the row would
            // stay in the view after it is gone.
            throw this.outOfStep(key, "filter");
          }
        }
      }
      if (after !== undefined) {
        const entry = after;
        all = Tree.insert(all, entry, order);
        if (filter?.(after, key)) {
          matching = Tree.insert(matching, entry, order);
        }
      }
      write(state, {
        config: held.config,
        order,
        all,
        matching: filter === undefined ? all : matching,
      });
    });
  }

  /**
   * Keeps the confirmed state, read through the visible stack's base, with
   * the rebuild made from it when the factories changed since its last row
   * write. A disposed view answers it from then on.
   */
  protected override onStopped(): void {
    // Inside an update the state box can still roll back, so `current`
    // answers from the box, tracked, with the order its last row write
    // built: the factories' values in the update can roll back too.
    if (this.realm.updateDepth === 0) {
      this.frozen = this.confirmedState();
    }
    this.stopMark.mark();
  }

  /** The state box's base value: the realm's, never a stage's or a showing stage's. */
  private baseState(): OrderedState<Key, Row> {
    const cell = this.state as unknown as BoxCell<OrderedState<Key, Row>>;
    const stack = this.realm.stack;
    return (
      stack === undefined ? cell.peek() : stack.baseOf(cell as BoxCell<unknown>).value
    ) as OrderedState<Key, Row>;
  }

  /**
   * The base state, sorted and filtered by the factories' confirmed values,
   * read where the realm's cells hold the base. A rebuild `current` made
   * may come from a stage's values, so none is reused. A factory or a
   * comparator that throws leaves the order its last row write built.
   */
  private confirmedState(): OrderedState<Key, Row> {
    const held = this.baseState();
    try {
      const config = (this.config as ComputedValue<Config<Key, Row>>).source;
      const now = inWindow(this.realm, () => this.realm.peekDerived(config));
      const built = held.config;
      return built !== undefined && built.compare === now.compare && built.filter === now.filter
        ? held
        : this.rebuild(held, now);
    } catch {
      return held;
    }
  }

  private removeFound(
    tree: Tree.Tree<Row> | undefined,
    entry: Row,
    order: Tree.Compare<Row>,
    callbacks: string,
  ): Tree.Tree<Row> | undefined {
    const next = Tree.remove(tree, entry, order);
    if (Tree.size(next) === Tree.size(tree)) {
      throw this.outOfStep(this.keyOf(entry), callbacks);
    }
    return next;
  }

  /** Rows ordered by `compare`, ties broken by key. */
  private orderOf(compare: (left: Row, right: Row) => number): Tree.Compare<Row> {
    return (left, right) => {
      const result = compare(left, right);
      if (result !== 0) {
        if (typeof result !== "number" || Number.isNaN(result)) {
          throw new PinnaUsageError(
            "pinna/view-compare-result",
            `pinna: ${this.label}'s compare returned ${String(result)}; it returns a negative number, zero, or a positive number`,
          );
        }
        return result;
      }
      if (left === right) return 0;
      const leftKey = this.keyOf(left) as unknown;
      const rightKey = this.keyOf(right) as unknown;
      if (sameKey(leftKey, rightKey)) return 0;
      const kind = typeof leftKey;
      if (kind !== typeof rightKey || keyRank[kind] !== true) {
        throw new PinnaUsageError(
          "pinna/view-tie",
          `pinna: ${this.label}'s compare finds the rows of keys ${String(leftKey)} and ${String(rightKey)} equal, and keys that are not both strings, numbers, or bigints cannot break the tie; break it in compare`,
        );
      }
      // NaN after every other number, so the order stays antisymmetric.
      if (Number.isNaN(leftKey)) return 1;
      if (Number.isNaN(rightKey)) return -1;
      return (leftKey as string) < (rightKey as string) ? -1 : 1;
    };
  }

  private rebuild(held: OrderedState<Key, Row>, now: Config<Key, Row>): OrderedState<Key, Row> {
    const resort = held.config === undefined || held.config.compare !== now.compare;
    const order = resort ? this.orderOf(now.compare) : held.order;
    let all = held.all;
    if (resort) {
      const sorted = Tree.entries(all).sort(order);
      all = Tree.fromSorted(sorted);
    }
    const filter = now.filter;
    let matching = all;
    if (filter !== undefined) {
      const keyOf = this.keyOf;
      matching = Tree.fromSorted(Tree.entries(all).filter((row) => filter(row, keyOf(row))));
    }
    return { config: now, order, all, matching };
  }

  get size(): Computed<number> {
    this.assertOpen("size");
    return this.sizeValue;
  }

  get totalSize(): Computed<number> {
    this.assertOpen("totalSize");
    return this.totalSizeValue;
  }

  get keys(): Computed<ReadonlyArray<Key>> {
    this.assertOpen("keys");
    return this.keysValue;
  }

  range(start: number, end: number): Computed<ReadonlyArray<Key>> {
    this.assertOpen("range");
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end < 0) {
      throw new PinnaUsageError(
        "pinna/view-range",
        `pinna: ${this.label}.range takes whole numbers from 0, not ${String(start)} and ${String(end)}`,
      );
    }
    return this.rangeOf(start, Math.max(start, end));
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Makes an ordered view of `source`: its keys sorted by `compare` and kept by `filter`. */
export const ordered = <Key, Row>(
  source: Collection<Key, Row>,
  options: OrderedViewOptions<Key, Row>,
): OrderedView<Key> => new OrderedViewImpl(realmOf(source, "View.ordered"), source, options);

// Group index

/** How a group index places a row. */
export interface GroupedViewOptions<Key, Row, Group> {
  /**
   * The group of a row, or `undefined` to leave the row out. Reads no
   * observable. Groups are compared as a `Map` compares keys.
   */
  readonly groupOf: (row: Row, key: Key) => Group | undefined;
  /** Names the view in errors, in `testRealm`, and its collection of groups. */
  readonly name?: string;
}

/** The keys of each group, kept up to date a row at a time. */
export interface GroupedView<Key, Group> extends Disposable {
  /**
   * The keys in `group`, in the order they joined it; an empty array for a
   * group with none. Tracks that group alone.
   */
  group(group: Group): Computed<ReadonlyArray<Key>>;
  /** The groups that hold a key, in the order each was first filled. */
  readonly groups: Computed<ReadonlyArray<Group>>;
}

interface GroupKeys<Key, Group> {
  readonly group: Group;
  readonly keys: ReadonlyArray<Key>;
}

class GroupedViewImpl<Key, Row, Group> extends View implements GroupedView<Key, Group> {
  private readonly held: Collection<Group, GroupKeys<Key, Group>>;
  private readonly groupOf: (group: Group) => Computed<ReadonlyArray<Key>>;

  constructor(
    realm: ObservableRealm,
    source: Collection<Key, Row>,
    options: GroupedViewOptions<Key, Row, Group>,
  ) {
    super(realm, "View.grouped", options.name);
    const name = options.name;
    const held = collection<Group, GroupKeys<Key, Group>>(realm, {
      keyOf: (entry) => entry.group,
      ...partName(name, "groups"),
    });
    // Left out of every record: the view follows the rows on every restore.
    (held as KeyedCollection<Group, unknown>).inRecord = false;
    this.held = held;
    this.groupOf = computedFunction(
      realm,
      (read, group: Group) => read.row(held, group)?.keys ?? (empty as ReadonlyArray<Key>),
      { ...partName(name, "group") },
    );
    const place = options.groupOf;
    this.listen(source, (key, before, after, read, write) => {
      const left = before === undefined ? undefined : place(before, key);
      const joined = after === undefined ? undefined : place(after, key);
      if (before !== undefined && after !== undefined && sameKey(left, joined)) return;
      if (left !== undefined) {
        const entry = read.row(held, left);
        const keys = entry?.keys.filter((kept) => !sameKey(kept, key));
        if (entry === undefined || keys === undefined || keys.length === entry.keys.length) {
          throw this.outOfStep(key, "groupOf");
        }
        if (keys.length === 0) {
          write.remove(held, left);
        } else {
          write.upsert(held, { group: left, keys });
        }
      }
      if (joined !== undefined) {
        const entry = read.row(held, joined);
        write.upsert(
          held,
          { group: joined, keys: entry === undefined ? [key] : [...entry.keys, key] },
          { at: "end" },
        );
      }
    });
  }

  group(group: Group): Computed<ReadonlyArray<Key>> {
    this.assertOpen("group");
    return this.groupOf(group);
  }

  get groups(): Computed<ReadonlyArray<Group>> {
    this.assertOpen("groups");
    return this.held.keys;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Makes a group index of `source`: the keys of each group `groupOf` names. */
export const grouped = <Key, Row, Group>(
  source: Collection<Key, Row>,
  options: GroupedViewOptions<Key, Row, Group>,
): GroupedView<Key, Group> => new GroupedViewImpl(realmOf(source, "View.grouped"), source, options);

// Totals per group

/**
 * Exact arithmetic on totals: `add` and `subtract` undo each other, so a
 * total kept a row at a time equals the sum of its rows. Floating-point
 * numbers round on each add and subtract and drift; integers, bigints, or
 * decimals kept as integers do not.
 */
export interface TotalArithmetic<Total> {
  readonly zero: Total;
  readonly add: (total: Total, value: Total) => Total;
  readonly subtract: (total: Total, value: Total) => Total;
  /** Whether two totals are the same; `Object.is` without it. */
  readonly equals?: (left: Total, right: Total) => boolean;
}

/** How totals place and weigh a row. */
export interface TotalsViewOptions<Key, Row, Group, Total> {
  /**
   * The group a row counts in and what it adds there, or `undefined` to
   * leave the row out. Reads no observable.
   */
  readonly project: (
    row: Row,
    key: Key,
  ) => { readonly group: Group; readonly value: Total } | undefined;
  readonly arithmetic: TotalArithmetic<Total>;
  /** Names the view in errors, in `testRealm`, and its collection of groups. */
  readonly name?: string;
}

/** A group's count of rows and the total of their values. */
export interface GroupTotal<Total> {
  readonly count: number;
  readonly total: Total;
}

/** The count and total of each group, kept up to date a row at a time. */
export interface TotalsView<Group, Total> extends Disposable {
  /** `group`'s count and total; `{ count: 0, total: zero }` for a group with no row. Tracks that group alone. */
  group(group: Group): Computed<GroupTotal<Total>>;
  /** The groups that count a row, in the order each was first filled. */
  readonly groups: Computed<ReadonlyArray<Group>>;
}

interface HeldTotal<Group, Total> {
  readonly group: Group;
  readonly count: number;
  readonly total: Total;
}

class TotalsViewImpl<Key, Row, Group, Total> extends View implements TotalsView<Group, Total> {
  private readonly held: Collection<Group, HeldTotal<Group, Total>>;
  private readonly groupOf: (group: Group) => Computed<GroupTotal<Total>>;

  constructor(
    realm: ObservableRealm,
    source: Collection<Key, Row>,
    options: TotalsViewOptions<Key, Row, Group, Total>,
  ) {
    super(realm, "View.totals", options.name);
    const name = options.name;
    const { zero, add, subtract } = options.arithmetic;
    const same = options.arithmetic.equals ?? Object.is;
    const held = collection<Group, HeldTotal<Group, Total>>(realm, {
      keyOf: (entry) => entry.group,
      ...partName(name, "groups"),
    });
    // Left out of every record: the view follows the rows on every restore.
    (held as KeyedCollection<Group, unknown>).inRecord = false;
    this.held = held;
    const none: GroupTotal<Total> = Object.freeze({ count: 0, total: zero });
    this.groupOf = computedFunction(
      realm,
      (read, group: Group): GroupTotal<Total> => {
        const entry = read.row(held, group);
        return entry === undefined ? none : { count: entry.count, total: entry.total };
      },
      {
        equals: (left, right) => left.count === right.count && same(left.total, right.total),
        ...partName(name, "group"),
      },
    );
    const project = options.project;
    this.listen(source, (key, before, after, read, write) => {
      const left = before === undefined ? undefined : project(before, key);
      const joined = after === undefined ? undefined : project(after, key);
      if (
        left !== undefined &&
        joined !== undefined &&
        sameKey(left.group, joined.group) &&
        same(left.value, joined.value)
      ) {
        return;
      }
      if (left !== undefined && joined !== undefined && sameKey(left.group, joined.group)) {
        // A new value in the same group: replaced in place, so the group
        // keeps its place in `groups` even when it holds this row alone.
        const entry = read.row(held, left.group);
        if (entry === undefined) throw this.outOfStep(key, "project");
        write.upsert(held, {
          group: left.group,
          count: entry.count,
          total: add(subtract(entry.total, left.value), joined.value),
        });
        return;
      }
      if (left !== undefined) {
        const entry = read.row(held, left.group);
        if (entry === undefined) throw this.outOfStep(key, "project");
        if (entry.count === 1) {
          write.remove(held, left.group);
        } else {
          write.upsert(held, {
            group: left.group,
            count: entry.count - 1,
            total: subtract(entry.total, left.value),
          });
        }
      }
      if (joined !== undefined) {
        const entry = read.row(held, joined.group);
        write.upsert(
          held,
          {
            group: joined.group,
            count: (entry?.count ?? 0) + 1,
            total: add(entry?.total ?? zero, joined.value),
          },
          { at: "end" },
        );
      }
    });
  }

  group(group: Group): Computed<GroupTotal<Total>> {
    this.assertOpen("group");
    return this.groupOf(group);
  }

  get groups(): Computed<ReadonlyArray<Group>> {
    this.assertOpen("groups");
    return this.held.keys;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Makes totals of `source`: the count and total of each group `project` names. */
export const totals = <Key, Row, Group, Total>(
  source: Collection<Key, Row>,
  options: TotalsViewOptions<Key, Row, Group, Total>,
): TotalsView<Group, Total> => new TotalsViewImpl(realmOf(source, "View.totals"), source, options);

// Lifecycle

type AnyView = OrderedView<unknown> | GroupedView<unknown, unknown> | TotalsView<unknown, unknown>;

const ownView = (call: string, view: AnyView): View => {
  if (!(view instanceof View)) {
    throw new PinnaUsageError(
      "pinna/not-made-by-pinna",
      `pinna: ${call} needs a view made by Pinna`,
    );
  }
  return view;
};

/** Stops keeping `view` up to date. Disposing twice does nothing. */
export const dispose = (view: AnyView): void => ownView("View.dispose", view).dispose();

/** `"open"` while `view` is kept up to date, `"disposed"` after `View.dispose` or `Realm.dispose`. */
export const status = (view: AnyView): ViewStatus => ownView("View.status", view).status;

const realmOf = <Key, Row>(source: Collection<Key, Row>, call: string): ObservableRealm => {
  const realm = (source as { readonly realm?: ObservableRealm }).realm;
  if (realm === undefined) {
    throw new PinnaUsageError(
      "pinna/not-made-by-pinna",
      `pinna: ${call} needs a collection made by Pinna`,
    );
  }
  return realm;
};
