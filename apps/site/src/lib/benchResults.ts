// The landing page's bench tables: the numbers measured so far, copied from `docs/performance.md`.
// Each table names the runs it comes from, so a remeasure is an edit here and nowhere else. Only
// raw figures live here; the page derives every color from them.

export const benchLibraries = [
  { key: "pinna", name: "Pinna" },
  { key: "alien", name: "alien-signals" },
  { key: "legend", name: "Legend State (beta)" },
  { key: "mobx", name: "MobX" },
] as const;

export const benchRuntimes = [
  { key: "web", name: "Web" },
  { key: "ios", name: "iOS" },
  { key: "android", name: "Android" },
  { key: "bun", name: "Bun" },
  { key: "node", name: "Node" },
  { key: "hermes", name: "Hermes" },
] as const;

export type BenchLibrary = (typeof benchLibraries)[number]["key"];
export type BenchRuntime = (typeof benchRuntimes)[number]["key"];

const runtimesOf = (...keys: ReadonlyArray<BenchRuntime>) =>
  benchRuntimes.filter((runtime) => keys.includes(runtime.key));

/** A figure, or why the run produced none. A cell left out was not measured. */
export type BenchResult = number | { readonly failure: string };

/** One library's figures, by runtime. */
export type BenchFigures = { readonly [Runtime in BenchRuntime]?: BenchResult | undefined };

export interface BenchRow {
  readonly name: string;
  /** When the row is not in its group's unit. */
  readonly unit?: string;
  readonly results: { readonly [Library in BenchLibrary]?: BenchFigures };
}

export interface BenchGroup {
  readonly title: string;
  readonly unit: string;
  readonly rows: ReadonlyArray<BenchRow>;
}

export interface BenchTable {
  readonly title: string;
  /** A column for each, under every library, whether or not it has a figure yet. */
  readonly runtimes: ReadonlyArray<(typeof benchRuntimes)[number]>;
  readonly groups: ReadonlyArray<BenchGroup>;
}

/** Pinna, alien-signals, Legend State, MobX: the order of `benchLibraries`. */
type LibraryFigures = readonly [BenchResult, BenchResult, BenchResult, BenchResult];

const graphRow = (
  name: string,
  figures: { readonly [Runtime in BenchRuntime]?: LibraryFigures },
): BenchRow => {
  const pick = (index: 0 | 1 | 2 | 3): BenchFigures => ({
    bun: figures.bun?.[index],
    node: figures.node?.[index],
    hermes: figures.hermes?.[index],
  });
  return { name, results: { pinna: pick(0), alien: pick(1), legend: pick(2), mobx: pick(3) } };
};

/** Store figures in the app on iOS, in the order of `benchLibraries`; the web and Android are not measured yet. */
const appRow = (name: string, [pinna, alien, legend, mobx]: LibraryFigures): BenchRow => ({
  name,
  results: {
    pinna: { ios: pinna },
    alien: { ios: alien },
    legend: { ios: legend },
    mobx: { ios: mobx },
  },
});

const overflow = { failure: "overflow" };

export const benchTables: ReadonlyArray<BenchTable> = [
  {
    title: "In a React Native app",
    runtimes: runtimesOf("web", "ios", "android"),
    groups: [
      {
        title: "Speed",
        unit: "ms in the store",
        rows: [
          appRow("Load 10,000 rows", [51, 27, 166, 238]),
          appRow("Merge a refetch into them", [252, 229, 332, 285]),
          appRow("Replace them all", [56, 30, 292, 249]),
          appRow("Insert 100 rows", [14, 13, 31, 2.7]),
          appRow("Remove 100 rows", [15, 20, 43, 11]),
          appRow("60 ticks of 50 price changes", [28, 25, 232, 42]),
        ],
      },
      {
        title: "Memory",
        unit: "MB",
        rows: [
          appRow("Allocated by the load", [8.5, 15.4, 29.1, 115.9]),
          { ...appRow("Garbage collections during the load", [3, 4, 8, 30]), unit: "collections" },
          appRow("Allocated by the 60 ticks", [0.9, 0.9, 31.5, 2.2]),
          appRow("Kept for the rows", [43.5, 42.3, 45.9, 51.9]),
        ],
      },
    ],
  },
  // Pinna and alien-signals on Node and Hermes: Pinna 0.2.0, the median of three interleaved
  // `bun run bench --tier rough` passes on an Apple M1 Pro, Node 26.13.1 and hermes-ios
  // 260318099.0.5 (`docs/performance.md`, "The 0.2.0 core on the graph benches"). MobX and Legend
  // State on Node and Hermes, and every library on Bun, are the 2026-11-11 runs on the same machine.
  {
    title: "The graph alone",
    runtimes: runtimesOf("bun", "node", "hermes"),
    groups: [
      {
        title: "Speed",
        unit: "ms",
        rows: [
          graphRow("Deep chain", {
            node: [4.74, 3.53, overflow, 15.1],
            bun: [4.01, 2.76, 257, 17.8],
            hermes: [75.6, 41.1, overflow, 204],
          }),
          graphRow("Fan-out", {
            node: [8.03, 5.93, 242, 27.8],
            bun: [8.41, 5.91, 269, 28.5],
            hermes: [145, 102, 1836, 507],
          }),
          graphRow("Diamond", {
            node: [6.04, 4.56, 219, 14],
            bun: [6.26, 4.97, 227, 15.8],
            hermes: [108, 56.2, 1585, 230],
          }),
          graphRow("Conditional reads", {
            node: [24.3, 16.7, 546, 62.6],
            bun: [21.8, 17.7, 621, 66],
            hermes: [417, 259, 3416, 1164],
          }),
          graphRow("Make and dispose", {
            node: [2.42, 0.956, 69.8, 21.5],
            bun: [2.04, 1.09, 46.8, 13.6],
            hermes: [27.1, 13.1, 291, 71.1],
          }),
          graphRow("Write 1,000 sources", {
            node: [7.03, 4.24, 96.5, 18.4],
            bun: [6.79, 5.29, 108, 18.6],
            hermes: [114, 85.2, 710, 291],
          }),
          graphRow("Bursty fan-out", {
            node: [8.09, 53.4, 1081, 27.3],
            bun: [9.29, 60.7, 729, 28.1],
            hermes: [147, 494, 4192, 494],
          }),
          graphRow("Increment ×100,000", {
            node: [16.1, 9.88, 317, 38],
            bun: [12.1, 9.13, 356, 38.1],
            hermes: [236, 147, 1948, 579],
          }),
          graphRow("One write among 10,000", {
            node: [0.554, 0.374, 10.2, 1.37],
            bun: [1.17, 0.89, 6.1, 1.94],
            hermes: [2.78, 1.81, 24.9, 6.57],
          }),
        ],
      },
      {
        title: "Memory allocated by one graph run",
        unit: "KB",
        rows: [
          graphRow("Deep chain", {
            node: [10, 3925, overflow, 39240],
            hermes: [14, 7845, overflow, 31353],
          }),
          graphRow("Fan-out", {
            node: [10, 14, 394184, 84890],
            hermes: [14, 7845, 642827, 88380],
          }),
          graphRow("Diamond", {
            node: [10, 18, 373314, 40583],
            hermes: [14, 7852, 652397, 32979],
          }),
          graphRow("Conditional reads", {
            node: [8190, 7836, 898539, 176559],
            hermes: [10957, 42089, 1462496, 178300],
          }),
          graphRow("Make and dispose", {
            node: [11084, 7390, 118060, 48743],
            hermes: [13057, 11652, 156914, 31116],
          }),
          graphRow("Write 1,000 sources", {
            node: [10, 10, 244663, 51471],
            hermes: [14, 17983, 389152, 64935],
          }),
          graphRow("Bursty fan-out", {
            node: [0.8, 4.7, 878987, 76333],
            hermes: [3, 8850, 1753886, 88380],
          }),
          graphRow("Increment ×100,000", {
            node: [9479, 14501, 742693, 125035],
            hermes: [10938, 36722, 1145927, 128911],
          }),
          graphRow("One write among 10,000", {
            node: [178, 217, 8687, 1163],
            hermes: [191, 448, 11987, 1372],
          }),
        ],
      },
    ],
  },
];

/**
 * How a cell compares with the best figure in its row on the same runtime.
 * A figure within the tie limit of the best one is `best` too, so a row can
 * have more than one.
 */
export type BenchTone = "best" | "near" | "behind" | "far" | "farthest" | "beyond" | "off-scale";

export interface BenchCell {
  readonly text: string;
  readonly tone?: BenchTone;
  /** The cell's tooltip: its figure divided by the best one, or why the run gave none. */
  readonly note?: string;
  /** The run gave no figure; the cell's text is the failure. */
  readonly failed?: true;
}

/**
 * Up to these multiples of the best figure, a cell ties with it, then is
 * near, behind, far, farthest, and beyond; past them, off the scale, with a
 * run that gave no figure. The tie limit is an estimate of the spread between
 * runs.
 */
const tieLimit = 1.05;
const nearLimit = 1.5;
const behindLimit = 3;
const farLimit = 10;
const farthestLimit = 100;
const beyondLimit = 1000;

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

const toneOf = (ratio: number): BenchTone =>
  ratio <= tieLimit
    ? "best"
    : ratio <= nearLimit
      ? "near"
      : ratio <= behindLimit
        ? "behind"
        : ratio <= farLimit
          ? "far"
          : ratio <= farthestLimit
            ? "farthest"
            : ratio <= beyondLimit
              ? "beyond"
              : "off-scale";

/** What each color means, in the order of the limits: the legend above the tables. */
export const benchLegend: ReadonlyArray<{ readonly tone: BenchTone; readonly text: string }> = [
  { tone: "best", text: `best, or within ${Math.round((tieLimit - 1) * 100)}% of it` },
  { tone: "near", text: `within ${nearLimit}×` },
  { tone: "behind", text: `within ${behindLimit}×` },
  { tone: "far", text: `within ${farLimit}×` },
  { tone: "farthest", text: `within ${farthestLimit}×` },
  { tone: "beyond", text: `within ${numberFormat.format(beyondLimit)}×` },
  { tone: "off-scale", text: `more than ${numberFormat.format(beyondLimit)}×, or stack overflow` },
];

/** One cell: its figure, and its color when two or more libraries were measured on that runtime. */
export const benchCell = (
  row: BenchRow,
  library: BenchLibrary,
  runtime: BenchRuntime,
): BenchCell => {
  const result = row.results[library]?.[runtime];
  if (result === undefined) {
    return { text: "—" };
  }
  if (typeof result !== "number") {
    return { text: result.failure, tone: "off-scale", note: "stack overflow", failed: true };
  }
  const measured = benchLibraries
    .map(({ key }) => row.results[key]?.[runtime])
    .filter((value): value is number => typeof value === "number");
  const text = numberFormat.format(result);
  if (measured.length < 2) {
    return { text };
  }
  const ratio = result / Math.min(...measured);
  return { text, tone: toneOf(ratio), note: `${numberFormat.format(ratio)}× the best` };
};
