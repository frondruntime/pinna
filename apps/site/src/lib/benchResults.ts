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
            node: [4.71, 3.94, overflow, 16.1],
            bun: [4.01, 2.95, 254, 16.4],
            hermes: [78.7, 42.9, overflow, 201],
          }),
          graphRow("Fan-out", {
            node: [8.64, 6.35, 281, 29.5],
            bun: [7.94, 5.57, 265, 29.5],
            hermes: [140, 95.8, 1750, 505],
          }),
          graphRow("Diamond", {
            node: [6.01, 4.87, 271, 14.6],
            bun: [6.04, 4.3, 221, 15.2],
            hermes: [90.8, 58.8, 1531, 229],
          }),
          graphRow("Conditional reads", {
            node: [24.8, 17, 615, 59.8],
            bun: [21.3, 16.4, 630, 66.7],
            hermes: [406, 252, 4117, 1176],
          }),
          graphRow("Make and dispose", {
            node: [2.53, 0.987, 77, 17.6],
            bun: [1.82, 1.46, 46.9, 13.2],
            hermes: [25.4, 13.9, 324, 77.2],
          }),
          graphRow("Write 1,000 sources", {
            node: [7.09, 3.89, 99, 19],
            bun: [6.05, 4.59, 112, 19.2],
            hermes: [115, 78.4, 765, 301],
          }),
          graphRow("Bursty fan-out", {
            node: [8.82, 89.2, 1123, 29],
            bun: [9.15, 62.4, 730, 28.7],
            hermes: [145, 507, 4618, 513],
          }),
          graphRow("Increment ×100,000", {
            node: [15.3, 8.16, 302, 38.3],
            bun: [11.8, 8.76, 331, 41.4],
            hermes: [230, 156, 2050, 611],
          }),
          graphRow("One write among 10,000", {
            node: [0.569, 0.485, 10.7, 1.5],
            bun: [1.02, 1.05, 6.08, 2.13],
            hermes: [3.1, 2.03, 27.2, 7.32],
          }),
        ],
      },
      {
        title: "Memory allocated by one graph run",
        unit: "KB",
        rows: [
          graphRow("Deep chain", {
            node: [10, 3934, overflow, 39266],
            hermes: [14, 7856, overflow, 31353],
          }),
          graphRow("Fan-out", {
            node: [10, 14, 394178, 84888],
            hermes: [14, 7845, 642827, 88380],
          }),
          graphRow("Diamond", {
            node: [10, 27, 374041, 40558],
            hermes: [14, 7863, 652398, 32979],
          }),
          graphRow("Conditional reads", {
            node: [8117, 8200, 898680, 159507],
            hermes: [10959, 42089, 1462495, 178300],
          }),
          graphRow("Make and dispose", {
            node: [10896, 8015, 116982, 49010],
            hermes: [13059, 12511, 156914, 31116],
          }),
          graphRow("Write 1,000 sources", {
            node: [10, 10, 244607, 51393],
            hermes: [14, 17983, 389153, 64935],
          }),
          graphRow("Bursty fan-out", {
            node: [145, 9482, 878910, 76293],
            hermes: [14, 19788, 1753889, 88380],
          }),
          graphRow("Increment ×100,000", {
            node: [9681, 23037, 742650, 125030],
            hermes: [10941, 47659, 1145927, 128911],
          }),
          graphRow("One write among 10,000", {
            node: [178, 217, 8696, 1163],
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
export type BenchTone = "best" | "near" | "behind" | "far" | "farthest" | "beyond" | "failed";

export interface BenchCell {
  readonly text: string;
  readonly tone?: BenchTone;
  /** The cell's figure divided by the best one, for the cell's tooltip. */
  readonly ratio?: string;
}

/**
 * Up to these multiples of the best figure, a cell ties with it, then is
 * near, behind, far, and farthest; past them, beyond. The tie limit is an
 * estimate of the spread between runs.
 */
const tieLimit = 1.05;
const nearLimit = 1.5;
const behindLimit = 3;
const farLimit = 10;
const farthestLimit = 100;

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
            : "beyond";

/** What each color means, in the order of the limits: the legend above the tables. */
export const benchLegend: ReadonlyArray<{ readonly tone: BenchTone; readonly text: string }> = [
  { tone: "best", text: `best, or within ${Math.round((tieLimit - 1) * 100)}% of it` },
  { tone: "near", text: `within ${nearLimit}×` },
  { tone: "behind", text: `within ${behindLimit}×` },
  { tone: "far", text: `within ${farLimit}×` },
  { tone: "farthest", text: `within ${farthestLimit}×` },
  { tone: "beyond", text: `more than ${farthestLimit}×` },
  { tone: "failed", text: "stack overflow" },
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
    return { text: result.failure, tone: "failed" };
  }
  const measured = benchLibraries
    .map(({ key }) => row.results[key]?.[runtime])
    .filter((value): value is number => typeof value === "number");
  const text = numberFormat.format(result);
  if (measured.length < 2) {
    return { text };
  }
  const ratio = result / Math.min(...measured);
  return { text, tone: toneOf(ratio), ratio: `${numberFormat.format(ratio)}× the best` };
};
