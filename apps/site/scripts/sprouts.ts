/**
 * Draws the footer's garden: the `--footer-art` tile in `src/styles/site.css`, rewritten in place.
 * `bun run sprouts`.
 *
 * Every plant is a small copy of the brand mark (`src/components/Brand.astro`): a lime stem with a
 * filled node at its tip and pairs of beams that leave the stem at one point, one to each side,
 * rising 5px for every 8px out as the hero graph's branches do and shortening toward the tip, so a
 * plant reads as a tree. A beam ends bare or, now and then, in a filled node; a node is sometimes
 * cyan and glows, as the mark's tip does. Each plant is drawn at one of three strengths, so the
 * garden has depth without gray. Plants never touch: the run fails when two plants, or the last
 * and the first across the tile's seam, come closer than `clearance`, glow included.
 *
 * The tile is an SVG drawn from a seeded generator, so a run with the same seed writes the same
 * bytes. A data URI cannot read a custom property, so the run reads `--accent` and `--cyan` from
 * the engine's `design-system.css` and fails when one is missing; change a token, then run it
 * again. The tile is 1499px wide, wider than a 1440px window, so its seam does not repeat within
 * one screen.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const stylesheet = resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles/site.css");
const tokens = fileURLToPath(
  import.meta.resolve("@frondruntime/site-kit/styles/design-system.css"),
);

const seed = 11;
const width = 1499;
const height = 28;
/** The fewest pixels between two plants, glow included. */
const clearance = 4;
/** How far a glow reaches past its node, counted in a plant's extent. */
const glowReach = 3;

// As the hero graph's branches do (`rise` in `src/lib/frondGraph.ts`): 5 up for every 8 out.
const run = 8;
const rise = 5;
/** Half a node's size: a filled 3px square, as the brand mark's tip is. */
const nodeHalf = 1.5;
/** A plant's beams and nodes, by strength: dim, middle, and bright. */
const strengths = [
  { beam: 0.22, node: 0.4 },
  { beam: 0.32, node: 0.52 },
  { beam: 0.45, node: 0.65 },
] as const;

type Random = () => number;

/** mulberry32: a small seeded generator, uniform on [0, 1). */
const seeded =
  (state: number): Random =>
  () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };

const between = (random: Random, low: number, high: number): number =>
  low + Math.floor(random() * (high - low + 1));

const number = (value: number): string => String(Number(value.toFixed(4)));

/** A filled node centered on a pixel's center, so its edges fall on whole pixels. */
const node = (x: number, y: number): string =>
  `M${number(x - nodeHalf)} ${number(y - nodeHalf)}h3v3h-3Z`;

const line = (fromX: number, fromY: number, toX: number, toY: number): string =>
  `M${number(fromX)} ${number(fromY)}L${number(toX)} ${number(toY)}`;

/** The tile's strokes: beams and lime nodes by strength, and the glowing cyan nodes. */
interface Strokes {
  readonly beams: Array<string>;
  readonly nodes: Array<string>;
  glowing: string;
}

interface Plant {
  /** How far the plant reaches left and right of its stem, glow included. */
  readonly left: number;
  readonly right: number;
  readonly draw: (x: number, into: Strokes) => void;
}

type Tip = "bare" | "lime" | "cyan";

/** How far past a beam's end its tip reaches. */
const tipReach = (tip: Tip): number =>
  tip === "bare" ? 0.5 : tip === "lime" ? nodeHalf : nodeHalf + glowReach;

const branchTip = (random: Random): Tip => {
  if (random() >= 0.3) return "bare";
  return random() < 0.1 ? "cyan" : "lime";
};

/** A stem `tall` pixels high with `pairs` pairs of beams, widest at the bottom. */
const plant = (random: Random, tall: number, pairs: number): Plant => {
  const strength = between(random, 0, strengths.length - 1);
  const crown: Tip = random() < 0.12 ? "cyan" : "lime";
  const tipY = height - tall - 0.5;
  const lowest = between(random, 3, 4);
  const highest = tall - 3;
  const spacing = pairs > 1 ? (highest - lowest) / (pairs - 1) : 0;
  const widest = between(random, 5, 9);
  const beams = Array.from({ length: pairs }, (_, index) => {
    const footY = height - Math.round(lowest + spacing * index) - 0.5;
    const tips = [branchTip(random), branchTip(random)] as const;
    // Shorter toward the tip, as the mark's upper leaves are, and never so long that a node or its
    // glow leaves the tile's top.
    const room = Math.max(...tips.map(tipReach)) + 1;
    const most = Math.floor(((footY - room) * run) / rise);
    const out = Math.max(2, Math.min(most, Math.round(widest * (1 - index / (pairs + 1)))));
    // The end lands on a pixel's center, so a node there is crisp; the slope stays near 5 to 8.
    const endY = Math.round(footY - (out * rise) / run - 0.5) + 0.5;
    // Now and then one side of a pair is missing, which breaks a plant's symmetry.
    const missing = random() < 0.15 ? (random() < 0.5 ? 0 : 1) : -1;
    return [-1, 1]
      .map((side, sideIndex) => ({ side, footY, out, endY, tip: tips[sideIndex] ?? "bare" }))
      .filter((_, sideIndex) => sideIndex !== missing);
  }).flat();
  const reach = (side: number): number =>
    Math.max(
      tipReach(crown),
      ...beams.filter((beam) => beam.side === side).map((beam) => beam.out + tipReach(beam.tip)),
    );
  return {
    left: reach(-1),
    right: reach(1),
    draw: (x, into) => {
      const paint = (tip: Tip, nodeX: number, nodeY: number): void => {
        if (tip === "cyan") into.glowing += node(nodeX, nodeY);
        else if (tip === "lime") into.nodes[strength] += node(nodeX, nodeY);
      };
      into.beams[strength] += line(x, height, x, tipY);
      for (const beam of beams) {
        // A beam leaves from the stem's edge, so the two never paint the same pixel twice.
        into.beams[strength] += line(
          x + 0.5 * beam.side,
          beam.footY,
          x + beam.out * beam.side,
          beam.endY,
        );
        paint(beam.tip, x + beam.out * beam.side, beam.endY);
      }
      paint(crown, x, tipY);
    },
  };
};

const tree = (random: Random): Plant => {
  const tall = between(random, 9, 16);
  return plant(random, tall, between(random, 2, tall >= 13 ? 3 : 2));
};

const sapling = (random: Random): Plant => {
  const tall = between(random, 4, 8);
  return plant(random, tall, tall >= 6 && random() < 0.7 ? 1 : 0);
};

const color = (css: string, token: string): string => {
  const match = new RegExp(`^  ${token}: (#[0-9a-f]{6});`, "m").exec(css);
  if (match?.[1] === undefined) {
    throw new Error(`${tokens} has no ${token} token in hex on a line of its own`);
  }
  return match[1];
};

const tile = (palette: string): string => {
  const random = seeded(seed);
  const strokes: Strokes = {
    beams: strengths.map(() => ""),
    nodes: strengths.map(() => ""),
    glowing: "",
  };
  const placed: Array<{ readonly left: number; readonly right: number }> = [];
  let edge = 0;
  for (;;) {
    const next = random() < 0.5 ? tree(random) : sapling(random);
    // Most plants stand in small groups; between groups lies bare ground.
    const gap = random() < 0.75 ? between(random, clearance, 14) : between(random, 30, 90);
    const x = Math.floor(edge + gap + next.left) + 0.5;
    if (x + next.right > width - clearance) break;
    next.draw(x, strokes);
    placed.push({ left: x - next.left, right: x + next.right });
    edge = x + next.right;
  }
  const first = placed[0];
  const last = placed.at(-1);
  if (first === undefined || last === undefined) throw new Error("The tile holds no plant");
  for (const [index, current] of placed.entries()) {
    const following = placed[index + 1] ?? { left: first.left + width };
    if (following.left - current.right < clearance) {
      throw new Error(`Two plants stand closer than ${clearance}px at ${current.right}`);
    }
  }
  const accent = color(palette, "--accent");
  const cyan = color(palette, "--cyan");
  const layers = strengths
    .map(
      (strength, index) =>
        `<path d='${strokes.beams[index]}' stroke='${accent}' stroke-opacity='${strength.beam}'/>` +
        `<path d='${strokes.nodes[index]}' fill='${accent}' fill-opacity='${strength.node}'/>`,
    )
    .join("");
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}'>` +
    `<filter id='g' filterUnits='userSpaceOnUse' x='0' y='0' width='${width}' height='${height}'>` +
    `<feGaussianBlur stdDeviation='1.5' result='b'/>` +
    `<feMerge><feMergeNode in='b'/><feMergeNode in='b'/><feMergeNode in='SourceGraphic'/></feMerge>` +
    `</filter>` +
    `<g fill='none'>${layers}</g>` +
    `<path d='${strokes.glowing}' fill='${cyan}' fill-opacity='0.7' filter='url(#g)'/>` +
    `</svg>`;
  const encoded = svg.replace(/[%#<>"]/g, (character) => encodeURIComponent(character));
  return `url("data:image/svg+xml,${encoded}")`;
};

let css = readFileSync(stylesheet, "utf8");
const size = `  --footer-art-size: ${width}px ${height}px;`;
if (!css.includes(size)) {
  throw new Error(`${stylesheet} does not size --footer-art as "${size.trim()}"`);
}
const declaration = /^ {2}--footer-art: url\("[^"]*"\);$/m;
if (!declaration.test(css)) {
  throw new Error(`${stylesheet} has no --footer-art declaration on a line of its own`);
}
css = css.replace(declaration, `  --footer-art: ${tile(readFileSync(tokens, "utf8"))};`);
writeFileSync(stylesheet, css);
console.log(`Wrote --footer-art to ${stylesheet}`);
