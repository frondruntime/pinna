// The hero's frond: todos drawn as branches of a stem, in the brand mark's circuit style. The stem
// is the realm and its root pad the `$todos` box; each todo is a branch whose pads are its `$done`
// box, its `$label` computed value, and its `<Row>`, and each trace between two pads is a read. A
// done todo's branch and its pads' outlines are lit, since all three hold its done state. The stem and
// its root are lit while the realm holds a todo, and the tip turns cyan, as the mark's is, once every
// todo is done. Leaves alternate sides up the stem like a fern's. Past the last todo, shorter leaves
// end in the realm's totals, computed values that read `$todos` and every `$done`, and taper the
// frond to its tip.
//
// One drawing for the server and the browser. The browser draws at the canvas's own pixel width,
// so one unit is one pixel: every line is 1px like the page's borders, and text keeps its size at
// any width. Centers sit on half pixels, so a 1px line covers one pixel row instead of two.

export interface FrondTodo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
  /** What the todo's `<Row>` last rendered. */
  readonly label: string;
}

export interface FrondPicture {
  readonly todos: ReadonlyArray<FrondTodo>;
  /** A todo the last action added: its branch fades in. */
  readonly added: string | undefined;
  /** The totals' values, in the order of `frondTotalNames`. */
  readonly totals: ReadonlyArray<string>;
}

/** The computed values past the last todo, from the lowest leaf up. */
export const frondTotalNames = ["$count", "$left", "$allDone"] as const;

/** The parts a press explains instead of acting on: the totals, `$todos`, the stem, and its tip. */
export type FrondPart = (typeof frondTotalNames)[number] | "$todos" | "realm" | "tip";

/**
 * The event the drawing sends, bubbling, when a press lands on a part that holds no todo; its
 * `detail` is the `FrondPart`. Here and not in `frondScene.ts`, so the page reads it without
 * loading the 3D drawing.
 */
export const frondExplain = "frond-explain";

/** The totals' values: how many todos, how many not done, and whether every one is done. */
export const frondTotals = (
  count: number,
  left: number,
  allDone: boolean,
): ReadonlyArray<string> => [String(count), String(left), String(allDone)];

/** Eight leaves for todos, one after another up the stem. */
export const frondMaximum = 8;

// Leaves grow one at a time, each on the other side of the stem from the one below and this far
// above it, as a fern's do; a todo's leaf is one of them.
const step = 60;
const pad = 6;
const doneDistance = 52;
// Room past the outer `<Row>` pad for the remove mark.
const edge = 30;
const tipY = 14.5;
// Between the tip and the foot of the highest leaf, so its diamond stays under the tip.
const tipGap = 64;
// Past the last todo, the totals' leaves, each this share of the highest todo leaf's length from
// the lowest up, taper the frond to its tip. They sit closer than the todo leaves.
const totalShares = [0.62, 0.46, 0.32] as const;
const totalStep = 40;
const rootGap = 58;
const bottom = 30;
// A branch rises from the stem like a leaf of the brand mark: 5 up for every 8 out, about 32°.
const rise = 0.625;
// Each todo leaf is this share of the lowest one's length shorter than the leaf below, so the
// frond narrows toward its tip as the mark does.
const taper = 0.06;
// A row starts this far out from the stem.
const textDistance = 14;

const center = (value: number): number => Math.round(value) + 0.5;

// A row is 13px IBM Plex Mono, whose characters are 0.6em wide; it stops 10px short of the stem.
const rowAdvance = 13 * 0.6;
const stemGap = 10;

/** `label` cut to `characters`, with an ellipsis when it does not fit. */
export const fitLabel = (label: string, characters: number): string =>
  label.length <= characters ? label : `${label.slice(0, Math.max(characters - 1, 1))}…`;

const reachAt = (width: number): number => Math.min(width / 2 - edge, 300);

const lengthAt = (index: number, width: number): number => reachAt(width) * (1 - index * taper);

// Where the highest todo leaf's foot sits, under the totals' leaves, whether or not there is one.
const topY = tipY + tipGap + (totalShares.length - 1) * totalStep + step;

// The lowest todo leaf's foot.
const baseY = (count: number): number => topY + Math.max(count - 1, 0) * step;

const rootY = (count: number): number => baseY(count) + rootGap;

export const frondHeight = (count: number): number => Math.ceil(rootY(count) + bottom);

const escapeMarkup = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const classes = (...names: ReadonlyArray<string | false>): string =>
  names.filter((name) => name !== false).join(" ");

interface Geometry {
  readonly side: -1 | 1;
  readonly length: number;
  /** The point `distance` out along the branch, which rises as it goes. */
  readonly at: (distance: number) => readonly [number, number];
  /** The branch's direction, in degrees, turned so text along it reads upright. */
  readonly turn: number;
  readonly characters: number;
}

/**
 * Where a leaf sits, for the flat drawing and the 3D one alike: its pair up the stem (two leaves
 * after one another, which the 3D drawing turns together), its side, the height of its foot from
 * the top of the canvas, and its length from the stem.
 */
export interface FrondLeafLayout {
  readonly pair: number;
  readonly side: -1 | 1;
  readonly y: number;
  readonly length: number;
}

/** A todo's leaf, and how many characters of its row fit along it. */
export interface FrondBranchLayout extends FrondLeafLayout {
  readonly characters: number;
}

// The leaf at `position` up the stem: the todo leaves first, then the totals'.
const leafAt = (position: number, length: number, y: number): FrondLeafLayout => ({
  pair: Math.floor(position / 2),
  side: position % 2 === 0 ? -1 : 1,
  y: center(y),
  length,
});

export const frondBranchLayout = (
  index: number,
  count: number,
  width: number,
): FrondBranchLayout => {
  const length = lengthAt(index, width);
  return {
    ...leafAt(index, length, baseY(count) - index * step),
    characters: Math.floor((length - textDistance - stemGap) / rowAdvance),
  };
};

/** The totals' leaves past the last todo, from the lowest up. */
export const frondTotalLeaves = (count: number, width: number): ReadonlyArray<FrondLeafLayout> => {
  const highest = count > 0 ? lengthAt(count - 1, width) : reachAt(width);
  return totalShares.map((share, index) =>
    leafAt(count + index, highest * share, topY - step - index * totalStep),
  );
};

/** The distances along a branch, and the stem's ends, that the 3D drawing shares. */
export const frondMeasures = {
  rise,
  doneDistance,
  removeDistance: 20,
  textDistance,
  tipY,
  rootY: (count: number): number => center(rootY(count)),
} as const;

const geometry = (index: number, count: number, width: number): Geometry => {
  const { side, y, length, characters } = frondBranchLayout(index, count, width);
  const stemX = center(width / 2);
  return {
    side,
    length,
    at: (distance) => [stemX + side * distance, y - rise * distance],
    turn: (side * -Math.atan(rise) * 180) / Math.PI,
    characters,
  };
};

const square = (className: string, x: number, y: number, half: number): string =>
  `<rect class="${className}" x="${x - half}" y="${y - half}" width="${half * 2}" height="${half * 2}"/>`;

const point = ([x, y]: readonly [number, number]): string => `${x} ${y}`;

// Text along a branch, at `[x, y]` and turned with it; `dy` moves it off the branch.
const along = (
  className: string,
  [x, y]: readonly [number, number],
  turn: number,
  dy: number,
  text: string,
  extra = "",
): string =>
  `<text class="${className}" transform="translate(${x} ${y}) rotate(${turn})" y="${dy}"${extra}>${escapeMarkup(text)}</text>`;

const branch = (todo: FrondTodo, index: number, picture: FrondPicture, width: number): string => {
  const { side, length, at, turn, characters } = geometry(index, picture.todos.length, width);
  const foot = at(0);
  const done = at(doneDistance);
  const label = at((doneDistance + length) / 2);
  const row = at(length);
  const remove = at(length + frondMeasures.removeDistance);
  const title = escapeMarkup(todo.title);
  // The hit area is the branch's own band, turned with it.
  const heading = side === 1 ? turn : turn + 180;
  return [
    `<g class="${classes(
      "frond-branch",
      todo.done && "is-done",
      picture.added === todo.id && "is-added",
    )}" data-id="${escapeMarkup(todo.id)}">`,
    `<g class="frond-toggle" role="button" tabindex="0" data-action="toggle" aria-pressed="${todo.done}" aria-label="Toggle ${title}">`,
    `<rect class="frond-hit" transform="translate(${point(foot)}) rotate(${heading})" y="-30" width="${length}" height="60"/>`,
    `<path class="frond-base" d="M${point(foot)}L${point(done)}"/>`,
    `<path class="frond-read" d="M${point(done)}L${point(label)}"/>`,
    `<path class="frond-read" d="M${point(label)}L${point(row)}"/>`,
    square("frond-box", done[0], done[1], pad),
    `<path class="frond-computed" d="M${label[0]} ${label[1] - 8}l8 8l-8 8l-8 -8Z"/>`,
    square("frond-pad", row[0], row[1], 8),
    along("frond-name", done, turn, -13, "$done"),
    along("frond-name", label, turn, -13, "$label"),
    along("frond-name", row, turn, -15, "<Row>"),
    // The rendered row starts by the stem and reads out along its branch, under it.
    along(
      "frond-row",
      at(textDistance),
      turn,
      26,
      fitLabel(todo.label, characters),
      ` text-anchor="${side === 1 ? "start" : "end"}" data-characters="${characters}"`,
    ),
    "</g>",
    `<g class="frond-remove" role="button" tabindex="0" data-action="remove" aria-label="Remove ${title}">`,
    square("frond-hit", remove[0], remove[1], 10),
    `<text class="frond-remove-mark" x="${remove[0]}" y="${remove[1] + 4}">×</text>`,
    "</g>",
    "</g>",
  ].join("");
};

/** The classes of the frond's `<svg>`: whether it holds a todo, and whether every todo is done. */
export const frondClasses = (picture: FrondPicture): string =>
  classes(
    "frond-graph",
    picture.todos.length > 0 && "has-todos",
    picture.todos.length > 0 && picture.todos.every((todo) => todo.done) && "is-complete",
  );

/** The frond's contents at `width` pixels, for an `<svg>` whose viewBox is `frondViewBox`. */
export const frondMarkup = (picture: FrondPicture, width: number): string => {
  const count = picture.todos.length;
  const stemX = center(width / 2);
  const root = center(rootY(count));
  // A total's leaf ends in its computed value's diamond, named above it, its value beside it.
  const totals = frondTotalLeaves(count, width).map(({ side, y, length }, index) => {
    const [x, top] = [stemX + side * length, y - rise * length];
    const turn = (side * -Math.atan(rise) * 180) / Math.PI;
    return [
      `<g class="frond-total">`,
      `<path class="frond-leaf" d="M${point([stemX, y])}L${point([x, top])}"/>`,
      `<path class="frond-computed" d="M${x} ${top - 8}l8 8l-8 8l-8 -8Z"/>`,
      along("frond-name", [x, top], turn, -13, frondTotalNames[index] ?? ""),
      `<text class="frond-total-value" x="${x + side * 16}" y="${top + 4}" text-anchor="${side === 1 ? "start" : "end"}">${escapeMarkup(picture.totals[index] ?? "")}</text>`,
      "</g>",
    ].join("");
  });
  return [
    ...picture.todos.map((todo, index) => branch(todo, index, picture, width)),
    ...totals,
    // After the branches, so the lit stem is drawn over the gray ends that meet it.
    `<path class="frond-stem" d="M${stemX} ${root}V${tipY + pad}"/>`,
    square("frond-tip", stemX, tipY, pad),
    `<g class="frond-root">`,
    square("frond-box", stemX, root, pad),
    `<text class="frond-name frond-root-name" x="${stemX + 14}" y="${root + 4}">$todos</text>`,
    "</g>",
    `<text class="frond-name frond-realm-name" x="${stemX}" y="${root + 24}">realm</text>`,
  ].join("");
};

export const frondViewBox = (count: number, width: number): string =>
  `0 0 ${width} ${frondHeight(count)}`;
