/**
 * The scenarios, each on a freshly mounted screen with a fresh store. Every
 * write starts from wire text: `JSON.parse` and the conversion to plain
 * values are timed apart from the store, so the store column is the
 * library's write alone, and the
 * settle column runs until the first frame after the last render. Each write
 * parses and converts afresh, since a MobX or Legend State store keeps and
 * changes the values it is given.
 */
import { type PlainRow, type PlainTick, toPlainRows, toPlainTicks } from "../data/plain.ts";
import {
  makeDeepRefetch,
  makeRefetch,
  makeRows,
  makeTicks,
  pickRemovals,
  type WireRow,
} from "../data/wire.ts";
import { renderCount, settled } from "./probe.ts";
import type { Store, Variant } from "./store.ts";

export interface Job {
  readonly variant: string;
  readonly size: number;
  readonly round: number;
  /** The scenarios to run besides the load; every one when left out. */
  readonly scenarios?: ReadonlyArray<string>;
}

export interface Measure {
  readonly scenario: string;
  /** `JSON.parse` of the wire text, in milliseconds. */
  readonly parse: number;
  /** The harness's conversion to plain values. */
  readonly convert: number;
  /** The store's write. */
  readonly store: number;
  /**
   * From the start of `JSON.parse` to the first quiet frame: a JS-thread
   * frame (`requestAnimationFrame`) after which no view rendered for three
   * frames. It is render quiescence, not the native commit or paint.
   */
  readonly settle: number;
  readonly renders: number;
  /** The longest gap between frames, for the tick scenario. */
  readonly longestFrame?: number;
  /**
   * Gaps between frames longer than `lateFrame`, for the tick scenario: at
   * 60 Hz, each is at least one frame missed.
   */
  readonly lateFrames?: number;
  /** What the Hermes heap did during the store's write, on Hermes alone. */
  readonly storeHeap?: HeapDelta;
}

/** The change in Hermes's counters across one write. */
export interface HeapDelta {
  /** Bytes allocated. */
  readonly allocated: number;
  /** Collections that ran. */
  readonly collections: number;
  /** Milliseconds the collector spent. */
  readonly collectionTime: number;
}

const heapDelta = (
  before: Record<string, number> | undefined,
  after: Record<string, number> | undefined,
): HeapDelta | undefined => {
  if (before === undefined || after === undefined) {
    return undefined;
  }
  const delta = (name: string): number =>
    (after[name] ?? Number.NaN) - (before[name] ?? Number.NaN);
  return {
    allocated: delta("js_totalAllocatedBytes"),
    collections: delta("js_numGCs"),
    collectionTime: delta("js_gcTime") * 1000,
  };
};

/** Mounts a variant's screen and waits for it to settle. */
export type Mount = (variant: Variant) => Promise<Store>;

const asIds = (json: unknown): ReadonlyArray<string> => json as ReadonlyArray<string>;

const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));

const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Times one write from wire text until the screen settles. */
const timed = async <Value>(
  scenario: string,
  text: string,
  convert: (json: unknown) => Value,
  write: (value: Value) => void,
): Promise<Measure> => {
  await nextFrame();
  const before = renderCount();
  const start = performance.now();
  const json: unknown = JSON.parse(text);
  const parsed = performance.now();
  const value = convert(json);
  // The counters are read outside the timed write.
  const heapBefore = heap();
  const converted = performance.now();
  write(value);
  const written = performance.now();
  const storeHeap = heapDelta(heapBefore, heap());
  const quiet = await settled();
  return {
    scenario,
    parse: parsed - start,
    convert: converted - parsed,
    store: written - converted,
    settle: quiet.at - start,
    renders: quiet.renders - before,
    ...(storeHeap === undefined ? {} : { storeHeap }),
  };
};

const ticks = 60;
const perTick = 50;
/** One and a half frames at 60 Hz, in milliseconds. */
const lateFrame = 1.5 * (1000 / 60);

const addHeap = (sum: HeapDelta | undefined, next: HeapDelta | undefined): HeapDelta | undefined =>
  sum === undefined || next === undefined
    ? next
    : {
        allocated: sum.allocated + next.allocated,
        collections: sum.collections + next.collections,
        collectionTime: sum.collectionTime + next.collectionTime,
      };

/** One tick per frame, then the time until the screen settles. */
const tickScenario = async (
  store: Store,
  convert: (json: unknown) => ReadonlyArray<PlainTick>,
  texts: ReadonlyArray<string>,
): Promise<Measure> => {
  await nextFrame();
  const before = renderCount();
  let parse = 0;
  let conversion = 0;
  let write = 0;
  let longestFrame = 0;
  let lateFrames = 0;
  let storeHeap: HeapDelta | undefined;
  let last = await nextFrame();
  const start = performance.now();
  for (const text of texts) {
    const frameStart = performance.now();
    const json: unknown = JSON.parse(text);
    const parsed = performance.now();
    const updates = convert(json);
    // The counters are read outside the timed write.
    const heapBefore = heap();
    const converted = performance.now();
    store.tick(updates);
    const written = performance.now();
    storeHeap = addHeap(storeHeap, heapDelta(heapBefore, heap()));
    parse += parsed - frameStart;
    conversion += converted - parsed;
    write += written - converted;
    const now = await nextFrame();
    longestFrame = Math.max(longestFrame, now - last);
    if (now - last > lateFrame) {
      lateFrames++;
    }
    last = now;
  }
  const quiet = await settled();
  return {
    scenario: "tick",
    parse,
    convert: conversion,
    store: write,
    settle: quiet.at - start,
    renders: quiet.renders - before,
    longestFrame,
    lateFrames,
    ...(storeHeap === undefined ? {} : { storeHeap }),
  };
};

/** Opens the details of a visible row, then closes them. */
const detailsScenario = async (store: Store): Promise<ReadonlyArray<Measure>> => {
  const id = store.idAt(3);
  const measures: Array<Measure> = [];
  for (const [scenario, selected] of [
    ["details open", id],
    ["details close", undefined],
  ] as const) {
    await nextFrame();
    const before = renderCount();
    const start = performance.now();
    store.select(selected);
    const written = performance.now();
    const quiet = await settled();
    measures.push({
      scenario,
      parse: 0,
      convert: 0,
      store: written - start,
      settle: quiet.at - start,
      renders: quiet.renders - before,
    });
  }
  return measures;
};

interface Data {
  readonly rows: string;
  readonly refetch: string;
  readonly deepRefetch: string;
  readonly added: string;
  readonly removed: ReadonlyArray<string>;
  readonly ticks: ReadonlyArray<string>;
}

const makeData = (size: number): Data => {
  const rows: ReadonlyArray<WireRow> = makeRows(size, 1);
  const change = Math.max(1, Math.round(size / 100));
  return {
    rows: JSON.stringify(rows),
    refetch: JSON.stringify(makeRefetch(rows, 2)),
    deepRefetch: JSON.stringify(makeDeepRefetch(rows, 5)),
    // Past the ids a refetch adds, which start at `size`.
    added: JSON.stringify(makeRows(change, 3, size * 2)),
    removed: pickRemovals(rows, change, 4),
    ticks: makeTicks(rows, ticks, perTick, 6).map((tick) => JSON.stringify(tick)),
  };
};

/** Memory, as Hermes reports it, when the build exposes it. */
export const heap = (): Record<string, number> | undefined => {
  const hermes = (
    globalThis as { HermesInternal?: { getInstrumentedStats?: () => Record<string, number> } }
  ).HermesInternal;
  return hermes?.getInstrumentedStats?.();
};

/** The Hermes heap read right after a full collection. */
export interface CollectedHeap {
  /**
   * Whether a full collection ran right before the reading: Hermes's global
   * `gc` exists and the count of collections grew across the call.
   */
  readonly collected: boolean;
  readonly stats: Record<string, number> | undefined;
}

/**
 * Forces a full collection with Hermes's global `gc`, twice, as the Hermes
 * benches in `packages/pinna/bench` do, then reads the heap. A runtime with
 * no `gc` reads the heap as it is and says so.
 */
const collectedHeap = (): CollectedHeap => {
  const gc = (globalThis as { gc?: unknown }).gc;
  if (typeof gc !== "function") {
    return { collected: false, stats: heap() };
  }
  const before = heap()?.["js_numGCs"];
  gc();
  gc();
  const stats = heap();
  const after = stats?.["js_numGCs"];
  return {
    collected: before !== undefined && after !== undefined && after > before,
    stats,
  };
};

/**
 * The heap after collection with a store mounted empty, then after the same
 * store loaded every row. `loaded` minus `empty` is what the store and its
 * screen retain for the rows: the wire text and the empty screen are in
 * both readings and cancel out.
 */
export interface Memory {
  readonly empty: CollectedHeap;
  readonly loaded: CollectedHeap;
}

/**
 * Reads memory on a fresh screen after every timed scenario, so no forced
 * collection runs before a timed write.
 */
const measureMemory = async (variant: Variant, rows: string, mount: Mount): Promise<Memory> => {
  const store = await mount(variant);
  await pause(100);
  const empty = collectedHeap();
  store.load(toPlainRows(JSON.parse(rows)));
  await settled();
  await pause(100);
  const loaded = collectedHeap();
  return { empty, loaded };
};

/**
 * Runs the load, then every scenario `wanted` names that the variant's store
 * supports, then reads memory (`measureMemory`). `afterLoad` runs once the
 * first load has settled, while its screen is still mounted.
 */
export const runScenarios = async (
  variant: Variant,
  size: number,
  wanted: ReadonlyArray<string> | undefined,
  mount: Mount,
  afterLoad: () => Promise<void>,
): Promise<{ readonly measures: ReadonlyArray<Measure>; readonly memory: Memory }> => {
  const data = makeData(size);
  const convert = { rows: toPlainRows, ticks: toPlainTicks };
  const measures: Array<Measure> = [];
  const wants = (scenario: string): boolean => wanted === undefined || wanted.includes(scenario);
  // A store with no method for a scenario skips it before its load, not after.
  const capable = variant.make().store;

  const loaded = async (): Promise<Store> => {
    const store = await mount(variant);
    store.load(convert.rows(JSON.parse(data.rows)));
    await settled();
    await pause(100);
    return store;
  };

  {
    const store = await mount(variant);
    measures.push(await timed("load", data.rows, convert.rows, (rows) => store.load(rows)));
    await afterLoad();
  }

  const writes: ReadonlyArray<
    readonly [
      string,
      string,
      (store: Store) => ((rows: ReadonlyArray<PlainRow>) => void) | undefined,
    ]
  > = [
    ["merge", data.refetch, (store) => store.merge],
    ["deep merge", data.deepRefetch, (store) => store.merge],
    ["replace", data.refetch, (store) => store.replace],
    ["insert", data.added, (store) => store.insert],
    ["insert each", data.added, (store) => store.insertEach],
  ];
  for (const [scenario, text, pick] of writes) {
    if (!wants(scenario) || pick(capable) === undefined) {
      continue;
    }
    const write = pick(await loaded()) as (rows: ReadonlyArray<PlainRow>) => void;
    measures.push(await timed(scenario, text, convert.rows, write));
  }

  const removals: ReadonlyArray<
    readonly [string, (store: Store) => ((ids: ReadonlyArray<string>) => void) | undefined]
  > = [
    ["remove", (store) => store.remove],
    ["remove each", (store) => store.removeEach],
  ];
  const removedText = JSON.stringify(data.removed);
  for (const [scenario, pick] of removals) {
    if (!wants(scenario) || pick(capable) === undefined) {
      continue;
    }
    const write = pick(await loaded()) as (ids: ReadonlyArray<string>) => void;
    measures.push(await timed(scenario, removedText, asIds, write));
  }

  if (wants("tick")) {
    measures.push(await tickScenario(await loaded(), convert.ticks, data.ticks));
  }
  if (wants("details")) {
    measures.push(...(await detailsScenario(await loaded())));
  }
  return { measures, memory: await measureMemory(variant, data.rows, mount) };
};
