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
  {
    title: "The graph alone",
    runtimes: runtimesOf("bun", "node", "hermes"),
    groups: [
      {
        title: "Speed",
        unit: "ms",
        rows: [
          graphRow("Deep chain", {
            node: [4.43, 3.74, overflow, 15.1],
            bun: [3.86, 3.01, 251, 15.5],
            hermes: [75, 43.1, overflow, 197],
          }),
          graphRow("Fan-out", {
            node: [8.36, 6.1, 242, 28.3],
            bun: [7.79, 5.7, 246, 27.7],
            hermes: [138, 95.5, 1599, 495],
          }),
          graphRow("Diamond", {
            node: [5.79, 4.73, 221, 14.2],
            bun: [6.12, 4.38, 219, 14.3],
            hermes: [90.7, 57.9, 1504, 229],
          }),
          graphRow("Conditional reads", {
            node: [26.7, 16.5, 569, 60.6],
            bun: [21, 16.4, 596, 66],
            hermes: [404, 243, 3462, 1152],
          }),
          graphRow("Make and dispose", {
            node: [2.39, 0.965, 70.9, 20.5],
            bun: [1.9, 1.41, 43.6, 13.4],
            hermes: [24.9, 13.5, 295, 71.6],
          }),
          graphRow("Write 1,000 sources", {
            node: [7.06, 3.7, 90.2, 17.8],
            bun: [6.06, 4.28, 106, 18.3],
            hermes: [113, 77.4, 706, 294],
          }),
          graphRow("Bursty fan-out", {
            node: [8.78, 88.3, 1081, 27.3],
            bun: [8.95, 59.3, 698, 27.3],
            hermes: [143, 498, 4354, 499],
          }),
          graphRow("Increment ×100,000", {
            node: [13.7, 7.87, 288, 38],
            bun: [11.7, 8.56, 327, 39],
            hermes: [225, 153, 1966, 585],
          }),
          graphRow("One write among 10,000", {
            node: [0.569, 0.419, 10.4, 1.37],
            bun: [1.08, 0.81, 5.34, 1.91],
            hermes: [2.67, 1.8, 24.7, 6.67],
          }),
        ],
      },
      {
        title: "Memory allocated by one graph run",
        unit: "KB",
        rows: [
          graphRow("Deep chain", {
            node: [10, 3934, overflow, 39301],
            hermes: [14, 7856, overflow, 31353],
          }),
          graphRow("Fan-out", {
            node: [10, 14, 394208, 76597],
            hermes: [14, 7845, 642827, 88380],
          }),
          graphRow("Diamond", {
            node: [10, 27, 373307, 40248],
            hermes: [14, 7863, 652398, 32979],
          }),
          graphRow("Conditional reads", {
            node: [8091, 8201, 898583, 159546],
            hermes: [10959, 42089, 1462493, 178300],
          }),
          graphRow("Make and dispose", {
            node: [10927, 8015, 117077, 48822],
            hermes: [13059, 12511, 156914, 31116],
          }),
          graphRow("Write 1,000 sources", {
            node: [10, 10, 244601, 51448],
            hermes: [14, 17983, 389153, 64935],
          }),
          graphRow("Bursty fan-out", {
            node: [261, 9690, 878898, 76297],
            hermes: [14, 19788, 1753884, 88380],
          }),
          graphRow("Increment ×100,000", {
            node: [9748, 23298, 742695, 125031],
            hermes: [10941, 47659, 1145927, 128911],
          }),
          graphRow("One write among 10,000", {
            node: [178, 217, 8651, 1163],
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
