// The hero's frond in 3D, drawn with OGL (https://github.com/oframe/ogl). The flat drawing in
// `frondGraph.ts` stays the server's picture and the fallback; this one replaces it in a browser
// with WebGL2.
//
// One world unit is one pixel on the plane through the stem, and heights are measured from the
// canvas's top as in the flat drawing, so `frondBranchLayout` places both. Each pair of leaves
// turns a little around the stem, the other way from the pair below, so the frond has
// depth. Labels and buttons are HTML laid over the canvas at each pad's projected position, so
// text stays crisp and the controls stay buttons.
//
// The frond is drawn like a vector display: thin traces, and pads as wireframes. Nothing glows
// at rest. A value that just changed flashes cyan and fades to its own color, the lime of a done
// todo or the gray of one not done, and the flash runs from the write to what it reached, one
// step every 100 ms, so an update reads in order: `$done`, then `$label`, then `<Row>`.
//
// Nothing moves on its own. A frame is drawn when something eases: a part flashing as an update
// reaches it, a branch growing or moving. The camera holds still, so the labels laid over the
// canvas keep their pixels. With reduced motion every change is drawn at once, with no flash.

import { Camera, Geometry, Mesh, Polyline, Program, Renderer, Transform, Vec3 } from "ogl";
import {
  type FrondLeafLayout,
  type FrondPicture,
  fitLabel,
  frondBranchLayout,
  frondHeight,
  frondMeasures,
  frondTotalLeaves,
  frondTotalNames,
} from "./frondGraph";

/** What an action wrote and which rows it reached, so the update can travel the frond. */
export interface FrondSignal {
  /** A todo's id when the action wrote its `$done`; `root` when it wrote `$todos`. */
  readonly from: string;
  /** The todos whose `<Row>` rendered. */
  readonly reached: ReadonlyArray<string>;
}

export interface FrondScene {
  readonly set: (picture: FrondPicture, signal: FrondSignal | undefined) => void;
  readonly resize: () => void;
  /** Stops drawing, gives the WebGL context back, and takes the drawing off the page. */
  readonly dispose: () => void;
}

type Rgb = readonly [number, number, number];

interface Palette {
  readonly accent: Rgb;
  readonly cyan: Rgb;
  readonly dim: Rgb;
  readonly edge: Rgb;
  readonly muted: Rgb;
  readonly background: Rgb;
}

// ── Timing ────────────────────────────────────────────────────────────────

const fieldOfView = 36;
/**
 * How far each pair of leaves turns around the stem, in radians, one pair toward the camera and
 * the next away. The turn only moves a leaf nearer or farther: every point is placed
 * where it lands on the flat drawing's spot on screen, so the frond keeps the mark's shape.
 */
const pairTurn = 0.7;

/** A leaf's angle around the stem: its side, turned toward the camera or away by its pair. */
const leafAngle = ({ side, pair }: FrondLeafLayout): number =>
  (side === 1 ? 0 : Math.PI) + (pair % 2 === 0 ? pairTurn : -pairTurn);

const restYaw = -0.14;
const restPitch = 0.14;
/** Room kept clear at the canvas's sides when the camera backs away to fit the frond. */
const sideMargin = 14;
/** The closest the camera comes, as a share of the distance where one unit is one pixel: the
 * frond never draws larger than its flat layout, so a wide canvas leaves it compact. */
const nearest = 1;

const lightDuration = 300;
const moveDuration = 450;
const growDuration = 380;
/** How long a flash takes to fade from cyan to the part's own color. */
const flashDuration = 700;
/**
 * From one part of a branch to the next, a read and then the value it reaches, so 100 ms from a
 * write to its recompute and again to the render: slower, and the steps blur into one flash.
 */
const flashStep = 50;
const hoverDuration = 150;
/** How near the pointer must come to a branch's traces, in pixels, to pick it. */
const hitReach = 18;

const easeOut = (progress: number): number => 1 - (1 - progress) ** 3;

/** A number that eases from one value to the next, starting after a delay. */
class Tween {
  private from: number;
  private to: number;
  private start = 0;
  private duration = 0;

  constructor(value: number) {
    this.from = value;
    this.to = value;
  }

  value(now: number): number {
    if (this.duration <= 0 || now >= this.start + this.duration) {
      return this.to;
    }
    if (now <= this.start) {
      return this.from;
    }
    return this.from + (this.to - this.from) * easeOut((now - this.start) / this.duration);
  }

  get target(): number {
    return this.to;
  }

  set(to: number, now: number, duration: number, delay = 0): void {
    if (to === this.to) {
      return;
    }
    this.from = this.value(now);
    this.to = to;
    this.start = now + delay;
    this.duration = duration;
  }

  settled(now: number): boolean {
    return this.duration <= 0 || now >= this.start + this.duration;
  }
}

/** A flash: full when it starts, after a delay, then fading fast and slowing, like phosphor. */
class Flash {
  private start = Number.NEGATIVE_INFINITY;

  value(now: number): number {
    const elapsed = now - this.start;
    return elapsed < 0 || elapsed >= flashDuration ? 0 : (1 - elapsed / flashDuration) ** 2;
  }

  fire(now: number, delay = 0): void {
    this.start = now + delay;
  }

  settled(now: number): boolean {
    return now >= this.start + flashDuration;
  }
}

// ── Colors ────────────────────────────────────────────────────────────────

/** Reads `rgb(…)` or `color(srgb …)`, as `getComputedStyle` reports a color. */
const parseColor = (text: string): Rgb => {
  const numbers = (text.match(/[\d.]+/g) ?? []).map(Number);
  const [red = 0, green = 0, blue = 0] = text.startsWith("color(")
    ? numbers
    : numbers.map((value) => value / 255);
  return [red, green, blue];
};

const readPalette = (host: HTMLElement): Palette => {
  const probe = document.createElement("span");
  host.append(probe);
  const token = (name: string): Rgb => {
    probe.style.color = `var(${name})`;
    return parseColor(getComputedStyle(probe).color);
  };
  const palette = {
    accent: token("--accent"),
    cyan: token("--cyan"),
    dim: token("--dim"),
    edge: token("--edge"),
    muted: token("--muted"),
    background: token("--bg"),
  };
  probe.remove();
  return palette;
};

const mix = (into: Float32Array, from: Rgb, to: Rgb, amount: number): Float32Array => {
  for (let channel = 0; channel < 3; channel++) {
    into[channel] = from[channel]! + (to[channel]! - from[channel]!) * amount;
  }
  return into;
};

// ── Shaders ───────────────────────────────────────────────────────────────

// Pads: wireframes, every true edge drawn 1px wide, the far ones too, and the faces left clear.
// `bary` is each triangle's barycentric coordinate, raised on the diagonal a face was split along
// so only the face's own edges are drawn. The color is premultiplied, as the canvas is.
const padVertex = /* glsl */ `#version 300 es
in vec3 position;
in vec3 bary;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
out vec3 vBary;
out float vDepth;
void main() {
  vec4 viewed = modelViewMatrix * vec4(position, 1.0);
  vBary = bary;
  vDepth = -viewed.z;
  gl_Position = projectionMatrix * viewed;
}`;

const padFragment = /* glsl */ `#version 300 es
precision highp float;
in vec3 vBary;
in float vDepth;
uniform vec3 uStroke;
uniform vec3 uBackground;
uniform float uFogNear;
uniform float uFogFar;
out vec4 color;
void main() {
  vec3 width = fwidth(vBary);
  vec3 inside = smoothstep(vec3(0.0), width * 1.2, vBary);
  float edge = 1.0 - min(min(inside.x, inside.y), inside.z);
  if (edge < 0.01) {
    discard;
  }
  float fog = smoothstep(uFogNear, uFogFar, vDepth) * 0.7;
  color = vec4(mix(uStroke, uBackground, fog) * edge, edge);
}`;

// Traces: OGL's polyline, which keeps a line `uThickness` pixels wide at any depth, with fog.
const traceVertex = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec3 next;
attribute vec3 prev;
attribute vec2 uv;
attribute float side;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec2 uResolution;
uniform float uDPR;
uniform float uThickness;
uniform float uMiter;
varying float vDepth;
void main() {
  mat4 transform = projectionMatrix * modelViewMatrix;
  vec4 current = transform * vec4(position, 1.0);
  vec4 following = transform * vec4(next, 1.0);
  vec4 preceding = transform * vec4(prev, 1.0);
  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 currentScreen = current.xy / current.w * aspect;
  vec2 followingScreen = following.xy / following.w * aspect;
  vec2 precedingScreen = preceding.xy / preceding.w * aspect;
  vec2 incoming = normalize(currentScreen - precedingScreen);
  vec2 outgoing = normalize(followingScreen - currentScreen);
  vec2 direction = normalize(incoming + outgoing);
  vec2 across = vec2(-direction.y, direction.x);
  across /= mix(1.0, max(0.3, dot(across, vec2(-incoming.y, incoming.x))), uMiter);
  across /= aspect;
  across *= current.w / (uResolution.y / uDPR) * uThickness;
  current.xy -= across * side;
  vDepth = current.w;
  gl_Position = current;
}`;

const traceFragment = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform vec3 uBackground;
uniform float uFogNear;
uniform float uFogFar;
varying float vDepth;
void main() {
  float fog = smoothstep(uFogNear, uFogFar, vDepth) * 0.7;
  gl_FragColor = vec4(mix(uColor, uBackground, fog), 1.0);
}`;

// Glows: soft cyan points added onto a part while it flashes.
const glowVertex = /* glsl */ `#version 300 es
in vec3 position;
in float size;
in float strength;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uPixelRatio;
uniform float uFogNear;
uniform float uFogFar;
out float vStrength;
void main() {
  vec4 viewed = modelViewMatrix * vec4(position, 1.0);
  vStrength = strength * (1.0 - smoothstep(uFogNear, uFogFar, -viewed.z) * 0.7);
  gl_PointSize = size * uPixelRatio;
  gl_Position = projectionMatrix * viewed;
}`;

const glowFragment = /* glsl */ `#version 300 es
precision highp float;
in float vStrength;
uniform vec3 uColor;
out vec4 color;
void main() {
  vec2 offset = gl_PointCoord * 2.0 - 1.0;
  float glow = exp(-dot(offset, offset) * 5.0) * vStrength;
  color = vec4(uColor * glow, glow);
}`;

// ── Geometry ──────────────────────────────────────────────────────────────

type Point = readonly [number, number, number];

/** Convex faces, fanned into triangles, with barycentric coordinates that mark the true edges. */
const faceted = (context: Renderer["gl"], faces: ReadonlyArray<ReadonlyArray<Point>>): Geometry => {
  const positions: Array<number> = [];
  const barys: Array<number> = [];
  for (const face of faces) {
    const first = face[0]!;
    for (let index = 1; index < face.length - 1; index++) {
      const second = face[index]!;
      const third = face[index + 1]!;
      // The edge across from each corner is drawn only if it is one of the face's own sides.
      const hidden: Point = [0, index + 1 === face.length - 1 ? 0 : 1, index === 1 ? 0 : 1];
      const corners: ReadonlyArray<Point> = [first, second, third];
      corners.forEach((corner, cornerIndex) => {
        positions.push(...corner);
        barys.push(
          (cornerIndex === 0 ? 1 : 0) + hidden[0],
          (cornerIndex === 1 ? 1 : 0) + hidden[1],
          (cornerIndex === 2 ? 1 : 0) + hidden[2],
        );
      });
    }
  }
  return new Geometry(context, {
    position: { size: 3, data: new Float32Array(positions) },
    bary: { size: 3, data: new Float32Array(barys) },
  });
};

const cube = (context: Renderer["gl"], half: number): Geometry => {
  const corner = (x: number, y: number, z: number): Point => [x * half, y * half, z * half];
  return faceted(context, [
    [corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1)],
    [corner(1, -1, -1), corner(-1, -1, -1), corner(-1, 1, -1), corner(1, 1, -1)],
    [corner(1, -1, 1), corner(1, -1, -1), corner(1, 1, -1), corner(1, 1, 1)],
    [corner(-1, -1, -1), corner(-1, -1, 1), corner(-1, 1, 1), corner(-1, 1, -1)],
    [corner(-1, 1, 1), corner(1, 1, 1), corner(1, 1, -1), corner(-1, 1, -1)],
    [corner(-1, -1, -1), corner(1, -1, -1), corner(1, -1, 1), corner(-1, -1, 1)],
  ]);
};

/** The computed value's diamond, turned into a solid: it reads as a diamond from the front. */
const octahedron = (context: Renderer["gl"], radius: number): Geometry => {
  const faces: Array<ReadonlyArray<Point>> = [];
  for (const x of [radius, -radius]) {
    for (const y of [radius, -radius]) {
      for (const z of [radius, -radius]) {
        faces.push([
          [x, 0, 0],
          [0, y, 0],
          [0, 0, z],
        ]);
      }
    }
  }
  return faceted(context, faces);
};

// ── The scene ─────────────────────────────────────────────────────────────

interface Branch {
  readonly id: string;
  readonly overlay: HTMLElement;
  readonly names: {
    readonly done: HTMLElement;
    readonly label: HTMLElement;
    readonly row: HTMLElement;
  };
  readonly text: HTMLButtonElement;
  readonly remove: HTMLButtonElement;
  readonly traces: { readonly base: Polyline; readonly first: Polyline; readonly second: Polyline };
  readonly pads: { readonly done: Mesh; readonly label: Mesh; readonly row: Mesh };
  /** Height from the canvas's top, distance of the `<Row>` from the stem, angle around the stem. */
  readonly y: Tween;
  readonly length: Tween;
  readonly angle: Tween;
  readonly grow: Tween;
  /** How lit each part is, from the stem out: `$done`, a read, `$label`, a read, `<Row>`. */
  readonly lit: readonly [Tween, Tween, Tween, Tween, Tween];
  /** How far each part, in the same order, still shows the cyan of a value that just changed. */
  readonly flash: readonly [Flash, Flash, Flash, Flash, Flash];
  /** How far the branch is raised while the pointer is over it. */
  readonly hover: Tween;
  readonly points: {
    readonly foot: Vec3;
    readonly bend: Vec3;
    readonly done: Vec3;
    readonly label: Vec3;
    readonly row: Vec3;
    readonly remove: Vec3;
    /** Where the rendered row starts, just past the bend, reading away from the stem. */
    readonly text: Vec3;
  };
  done: boolean;
  leaving: boolean;
}

const element = <Name extends keyof HTMLElementTagNameMap>(
  name: Name,
  className: string,
  text = "",
): HTMLElementTagNameMap[Name] => {
  const made = document.createElement(name);
  made.className = className;
  made.textContent = text;
  return made;
};

const check = "✓";

// IBM Plex Mono has no ✓, and the system font that stands in for it draws one thin and low. A
// done row keeps the character, so it reads and measures the same, and the page draws the mark
// over it (`.frond-scene-check`).
const showRow = (row: HTMLElement, text: string): void => {
  if (text.startsWith(check)) {
    row.replaceChildren(element("span", "frond-scene-check", check), text.slice(check.length));
  } else row.textContent = text;
};

/**
 * Draws the frond in 3D inside `host`, the canvas's frame, in place of `svg`. Returns undefined,
 * and leaves the flat drawing, when the browser has no WebGL2.
 */
export const createFrondScene = (host: HTMLElement, svg: SVGSVGElement): FrondScene | undefined => {
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const root = element("div", "frond-scene");
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", svg.getAttribute("aria-label") ?? "");
  const canvas = element("canvas", "frond-scene-canvas");
  canvas.setAttribute("aria-hidden", "true");
  const overlay = element("div", "frond-scene-overlay");
  root.append(canvas, overlay);

  let renderer: Renderer;
  try {
    renderer = new Renderer({
      canvas,
      dpr: Math.min(window.devicePixelRatio, 2),
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
      webgl: 2,
    });
  } catch {
    return undefined;
  }
  if (!renderer.isWebgl2) {
    return undefined;
  }
  const context = renderer.gl;
  context.clearColor(0, 0, 0, 0);

  const palette = readPalette(host);
  const cssCyan = `rgb(${palette.cyan.map((channel) => Math.round(channel * 255)).join(" ")})`;
  host.append(root);
  svg.style.display = "none";

  const camera = new Camera(context, { fov: fieldOfView, near: 1, far: 10000 });
  const world = new Transform();

  // Fog and background, shared by every program.
  const fogNear = { value: 0 };
  const fogFar = { value: 1 };
  const background = { value: new Float32Array(palette.background) };

  const padProgram = new Program(context, {
    vertex: padVertex,
    fragment: padFragment,
    cullFace: false,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uStroke: { value: new Float32Array(3) },
      uBackground: background,
      uFogNear: fogNear,
      uFogFar: fogFar,
    },
  });
  const boxShape = cube(context, 6);
  const rowShape = cube(context, 8);
  const computedShape = octahedron(context, 9);

  /** A pad whose edges take the color `paint` gives each frame. */
  const pad = (shape: Geometry, paint: () => Float32Array): Mesh => {
    const mesh = new Mesh(context, { geometry: shape, program: padProgram });
    mesh.onBeforeRender(() => {
      padProgram.uniforms["uStroke"]!.value = paint();
    });
    mesh.setParent(world);
    return mesh;
  };

  const trace = (points: ReadonlyArray<Vec3>, color: Float32Array): Polyline => {
    const line = new Polyline(context, {
      points: [...points],
      vertex: traceVertex,
      fragment: traceFragment,
      uniforms: {
        uColor: { value: color },
        uBackground: background,
        uFogNear: fogNear,
        uFogFar: fogFar,
      },
    });
    line.mesh.frustumCulled = false;
    line.mesh.setParent(world);
    return line;
  };

  // The glows share one buffer of points, refilled each frame.
  const glowCapacity = 96;
  const glowPositions = new Float32Array(glowCapacity * 3);
  const glowSizes = new Float32Array(glowCapacity);
  const glowStrengths = new Float32Array(glowCapacity);
  const glowShape = new Geometry(context, {
    position: { size: 3, data: glowPositions },
    size: { size: 1, data: glowSizes },
    strength: { size: 1, data: glowStrengths },
  });
  const glowProgram = new Program(context, {
    vertex: glowVertex,
    fragment: glowFragment,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uColor: { value: new Float32Array(palette.cyan) },
      uPixelRatio: { value: renderer.dpr },
      uFogNear: fogNear,
      uFogFar: fogFar,
    },
  });
  glowProgram.setBlendFunc(context.ONE, context.ONE);
  const glows = new Mesh(context, {
    geometry: glowShape,
    program: glowProgram,
    mode: context.POINTS,
    frustumCulled: false,
  });
  glows.setParent(world);
  let glowCount = 0;
  const glow = (at: Vec3, size: number, strength: number): void => {
    if (strength <= 0.002 || glowCount >= glowCapacity) {
      return;
    }
    at.toArray(glowPositions, glowCount * 3);
    glowSizes[glowCount] = size;
    glowStrengths[glowCount] = strength;
    glowCount++;
  };

  /** `into` set to `color`, raised toward cyan as far as `flash` still shows. */
  const flashed = (into: Float32Array, color: Rgb | Float32Array, flash: Flash): Float32Array => {
    const amount = flash.value(clock);
    for (let channel = 0; channel < 3; channel++) {
      into[channel] = color[channel]! + (palette.cyan[channel]! - color[channel]!) * amount;
    }
    return into;
  };

  // The stem, its tip, and its root, `$todos`.
  const stemLit = new Tween(0);
  const tipLit = new Tween(0);
  const stemFlash = new Flash();
  const tipFlash = new Flash();
  const rootY = new Tween(0);
  const stemRoot = new Vec3();
  const stemTip = new Vec3();
  const stemColor = new Float32Array(3);
  const stem = trace([stemRoot, stemTip], stemColor);
  const stemStroke = new Float32Array(3);
  const tipStroke = new Float32Array(3);
  const rootPad = pad(boxShape, () => stemStroke);
  const tipPad = pad(boxShape, () => tipStroke);
  const rootName = element("span", "frond-scene-name frond-scene-root-name", "$todos");
  const realmName = element("span", "frond-scene-name frond-scene-realm-name", "realm");
  overlay.append(rootName, realmName);

  // The totals past the last todo, which taper the frond to its tip: each a leaf in the stem's
  // color that ends in its computed value's diamond, named above it, its value beside it.
  const totalLeaves = frondTotalNames.map((name) => {
    const foot = new Vec3();
    const end = new Vec3();
    const flash = new Flash();
    const stroke = new Float32Array(3);
    const leafOverlay = element("div", "frond-scene-branch frond-scene-total");
    const label = element("span", "frond-scene-name", name);
    const value = element("span", "frond-scene-value");
    leafOverlay.append(label, value);
    overlay.append(leafOverlay);
    return {
      y: new Tween(0),
      length: new Tween(0),
      angle: new Tween(0),
      flash,
      foot,
      end,
      line: trace([foot, end], stemColor),
      pad: pad(computedShape, () => flashed(stroke, stemStroke, flash)),
      overlay: leafOverlay,
      label,
      value,
    };
  });
  let totalsShown = false;

  const branches = new Map<string, Branch>();
  let width = 0;
  let height = 0;
  let count = 0;

  const makeBranch = (id: string, y: number, now: number, grown: boolean): Branch => {
    const points = {
      foot: new Vec3(),
      bend: new Vec3(),
      done: new Vec3(),
      label: new Vec3(),
      row: new Vec3(),
      remove: new Vec3(),
      text: new Vec3(),
    };
    const lit = [new Tween(0), new Tween(0), new Tween(0), new Tween(0), new Tween(0)] as const;
    const flash = [new Flash(), new Flash(), new Flash(), new Flash(), new Flash()] as const;
    const hover = new Tween(0);
    // A part's color: gray, raised toward `hovered` while the pointer is over the branch, lit
    // toward the accent as far as the part holds a done todo, then raised toward cyan as far as
    // its flash still shows.
    const shade = (into: Float32Array, unlit: Rgb, hovered: Rgb, step: number): Float32Array => {
      const raised = hover.value(clock);
      const share = lit[step]!.value(clock);
      for (let channel = 0; channel < 3; channel++) {
        const gray = unlit[channel]! + (hovered[channel]! - unlit[channel]!) * raised;
        into[channel] = gray + (palette.accent[channel]! - gray) * share;
      }
      return flashed(into, into, flash[step]!);
    };
    const [doneStroke, labelStroke, rowStroke, firstColor, secondColor] = Array.from(
      { length: 5 },
      () => new Float32Array(3),
    ) as [Float32Array, Float32Array, Float32Array, Float32Array, Float32Array];
    const paint = (stroke: Float32Array, step: number) => (): Float32Array =>
      shade(stroke, palette.dim, palette.muted, step);
    const branchOverlay = element("div", "frond-scene-branch");
    const names = {
      done: element("span", "frond-scene-name", "$done"),
      label: element("span", "frond-scene-name", "$label"),
      row: element("span", "frond-scene-name frond-scene-row-name", "<Row>"),
    };
    const text = element("button", "frond-scene-row");
    text.type = "button";
    text.dataset["id"] = id;
    text.dataset["action"] = "toggle";
    const remove = element("button", "frond-scene-remove", "×");
    remove.type = "button";
    remove.dataset["id"] = id;
    remove.dataset["action"] = "remove";
    branchOverlay.append(names.done, names.label, names.row, text, remove);
    overlay.append(branchOverlay);
    const baseColor = new Float32Array(palette.edge);
    const branch: Branch = {
      id,
      overlay: branchOverlay,
      names,
      text,
      remove,
      traces: {
        base: trace([points.foot, points.bend, points.done], baseColor),
        first: trace([points.done, points.label], firstColor),
        second: trace([points.label, points.row], secondColor),
      },
      pads: {
        done: pad(boxShape, paint(doneStroke, 0)),
        label: pad(computedShape, paint(labelStroke, 2)),
        row: pad(rowShape, paint(rowStroke, 4)),
      },
      y: new Tween(y),
      length: new Tween(0),
      angle: new Tween(0),
      grow: new Tween(grown ? 1 : 0),
      lit,
      flash,
      hover,
      points,
      done: false,
      leaving: false,
    };
    // The reads' colors follow their own parts of the branch, and the elbow from the stem lights
    // with `$done`, the pad it leads to.
    branch.traces.base.mesh.onBeforeRender(() => {
      shade(baseColor, palette.edge, palette.muted, 0);
    });
    branch.traces.first.mesh.onBeforeRender(() => {
      shade(firstColor, palette.dim, palette.muted, 1);
    });
    branch.traces.second.mesh.onBeforeRender(() => {
      shade(secondColor, palette.dim, palette.muted, 3);
    });
    if (!grown) {
      branch.grow.set(1, now, growDuration, flashStep * 2);
    }
    return branch;
  };

  const disposeBranch = (branch: Branch): void => {
    for (const line of Object.values(branch.traces)) {
      line.mesh.setParent(null);
      line.geometry.remove();
      line.program.remove();
    }
    for (const mesh of Object.values(branch.pads)) {
      mesh.setParent(null);
    }
    branch.overlay.remove();
    branches.delete(branch.id);
  };

  /** The canvas's top-down height as a world height, with the plane's middle at zero. */
  /** The frond's own height, as the flat drawing lays it out; its middle sits at the origin. */
  const extent = new Tween(0);
  const worldY = (fromTop: number, span = extent.value(clock)): number => span / 2 - fromTop;

  const place = (branch: Branch, now: number): void => {
    const grow = branch.grow.value(now);
    const angle = branch.angle.value(now);
    const length = branch.length.value(now);
    const y = worldY(branch.y.value(now));
    // Which side of the stem the branch reads on, easing through zero as it swings across.
    const side = Math.cos(angle) / Math.cos(pairTurn);
    const { rise, doneDistance, removeDistance, textDistance } = frondMeasures;
    // A branch is one straight line that rises as it leaves the stem, like the mark's leaves: on
    // screen, exactly the flat drawing's line, and in depth, turned `angle` around the stem.
    const out = (into: Vec3, distance: number): void => {
      const reach = distance * grow;
      lift(into, side * reach, y + rise * reach, angle);
    };
    out(branch.points.foot, 0);
    out(branch.points.bend, doneDistance / 2);
    out(branch.points.done, doneDistance);
    out(branch.points.label, (doneDistance + length) / 2);
    out(branch.points.row, length);
    out(branch.points.remove, length + removeDistance);
    out(branch.points.text, textDistance);
    for (const line of Object.values(branch.traces)) {
      line.updateGeometry();
    }
    const turn = -angle;
    for (const [mesh, at] of [
      [branch.pads.done, branch.points.done],
      [branch.pads.label, branch.points.label],
      [branch.pads.row, branch.points.row],
    ] as const) {
      mesh.position.copy(at);
      mesh.rotation.y = turn;
      mesh.scale.set(Math.max(grow, 0.001));
    }
  };

  /** The distance at which one world unit on the stem's plane is one pixel. */
  let pixelDistance = 1;
  /** How much farther than that the camera stands, so the whole frond fits the canvas. */
  const zoom = new Tween(1);
  const origin = new Vec3(0, 0, 0);

  const pose = (atYaw: number, atPitch: number, distance: number): void => {
    camera.position.set(
      distance * Math.sin(atYaw) * Math.cos(atPitch),
      distance * Math.sin(atPitch),
      distance * Math.cos(atYaw) * Math.cos(atPitch),
    );
    camera.lookAt(origin);
    camera.updateMatrixWorld();
  };

  /**
   * `into` set to the point the flat drawing puts at (`across`, `up`) from the stem's middle,
   * moved along the camera's ray onto the plane through the stem turned `angle` toward the
   * camera. On screen it lands where the flat drawing does; only its depth changes.
   */
  const lift = (into: Vec3, across: number, up: number, angle: number): void => {
    const matrix = camera.worldMatrix;
    const position = camera.position;
    // The camera's right, up, and back, so the flat drawing's plane faces it.
    const [rx, ry, rz] = [matrix[0]!, matrix[1]!, matrix[2]!];
    const [ux, uy, uz] = [matrix[4]!, matrix[5]!, matrix[6]!];
    const [bx, by, bz] = [matrix[8]!, matrix[9]!, matrix[10]!];
    const fx = across * rx + up * ux;
    const fy = across * ry + up * uy;
    const fz = across * rz + up * uz;
    // The branch's plane holds the stem, along the camera's up, and the branch's heading.
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const hx = cos * rx + sin * bx;
    const hy = cos * ry + sin * by;
    const hz = cos * rz + sin * bz;
    const nx = uy * hz - uz * hy;
    const ny = uz * hx - ux * hz;
    const nz = ux * hy - uy * hx;
    const toCamera = nx * position.x + ny * position.y + nz * position.z;
    const denominator = toCamera - (nx * fx + ny * fy + nz * fz);
    const along = Math.abs(denominator) < 1e-6 ? 1 : toCamera / denominator;
    into.set(
      position.x + along * (fx - position.x),
      position.y + along * (fy - position.y),
      position.z + along * (fz - position.z),
    );
  };

  /** Poses the camera at rest, at the current zoom; whether the zoom is still easing. */
  const aim = (now: number): boolean => {
    const distance = pixelDistance * zoom.value(now);
    pose(restYaw, restPitch, distance);
    fogNear.value = distance - 60;
    fogFar.value = distance + 320;
    return !zoom.settled(now);
  };

  /**
   * The least zoom at which the flat drawing, which the frond matches on screen, fits the canvas:
   * its height, and its width out to the farthest remove mark.
   */
  const fitZoom = (): number => {
    let reach = 0;
    for (const branch of branches.values()) {
      if (!branch.leaving) {
        reach = Math.max(reach, branch.length.target + frondMeasures.removeDistance + 16);
      }
    }
    const scale = Math.min(
      (width / 2 - sideMargin) / Math.max(reach, 1),
      (height - 16) / Math.max(extent.target, 1),
    );
    return Math.max(nearest, 1 / scale);
  };

  // Projection of world points to the overlay's pixels.
  const projected = new Vec3();
  const viewed = new Vec3();
  const screen = (at: Vec3): { readonly x: number; readonly y: number; readonly fog: number } => {
    projected.copy(at);
    camera.project(projected);
    viewed.copy(at).applyMatrix4(camera.viewMatrix);
    const depth = -viewed.z;
    const fog = Math.min(Math.max((depth - fogNear.value) / (fogFar.value - fogNear.value), 0), 1);
    return {
      x: Math.round(((projected.x + 1) / 2) * width),
      y: Math.round(((1 - projected.y) / 2) * height),
      fog,
    };
  };

  const put = (target: HTMLElement, at: Vec3): { readonly x: number; readonly fog: number } => {
    const spot = screen(at);
    target.style.translate = `${spot.x}px ${spot.y}px`;
    return spot;
  };

  let clock = 0;
  let frameRequest = 0;

  const render = (now: number): boolean => {
    clock = now;
    let moving = aim(now);

    // The stem.
    const stemAmount = stemLit.value(now);
    const tipAmount = tipLit.value(now);
    lift(stemRoot, 0, worldY(rootY.value(now)), 0);
    lift(stemTip, 0, worldY(frondMeasures.tipY), 0);
    stem.updateGeometry();
    flashed(stemColor, mix(stemColor, palette.edge, palette.accent, stemAmount), stemFlash);
    flashed(stemStroke, mix(stemStroke, palette.dim, palette.accent, stemAmount), stemFlash);
    flashed(tipStroke, mix(tipStroke, palette.dim, palette.cyan, tipAmount), tipFlash);
    rootPad.position.copy(stemRoot);
    tipPad.position.copy(stemTip);
    for (const leaf of totalLeaves) {
      const angle = leaf.angle.value(now);
      const length = leaf.length.value(now);
      const y = worldY(leaf.y.value(now));
      const side = Math.cos(angle) / Math.cos(pairTurn);
      lift(leaf.foot, 0, y, angle);
      lift(leaf.end, side * length, y + frondMeasures.rise * length, angle);
      leaf.line.updateGeometry();
      leaf.pad.position.copy(leaf.end);
      leaf.pad.rotation.y = -angle;
      moving ||=
        !leaf.y.settled(now) ||
        !leaf.length.settled(now) ||
        !leaf.angle.settled(now) ||
        !leaf.flash.settled(now);
    }
    moving ||=
      !stemLit.settled(now) ||
      !tipLit.settled(now) ||
      !stemFlash.settled(now) ||
      !tipFlash.settled(now) ||
      !rootY.settled(now) ||
      !extent.settled(now);

    // Only a flash glows.
    glowCount = 0;
    glow(stemRoot, 30, stemFlash.value(now) * 0.6);
    glow(stemTip, 30, tipFlash.value(now) * 0.6);
    for (const leaf of totalLeaves) {
      glow(leaf.end, 30, leaf.flash.value(now) * 0.6);
    }

    for (const branch of [...branches.values()]) {
      place(branch, now);
      const settled =
        branch.y.settled(now) &&
        branch.length.settled(now) &&
        branch.angle.settled(now) &&
        branch.grow.settled(now) &&
        branch.hover.settled(now) &&
        branch.lit.every((part) => part.settled(now)) &&
        branch.flash.every((part) => part.settled(now));
      if (branch.leaving && settled) {
        disposeBranch(branch);
        continue;
      }
      moving ||= !settled;
      const grow = branch.grow.value(now);
      glow(branch.points.done, 26, branch.flash[0].value(now) * 0.6 * grow);
      glow(branch.points.label, 30, branch.flash[2].value(now) * 0.6 * grow);
      glow(branch.points.row, 34, branch.flash[4].value(now) * 0.6 * grow);
    }

    glowShape.attributes["position"]!.needsUpdate = true;
    glowShape.attributes["size"]!.needsUpdate = true;
    glowShape.attributes["strength"]!.needsUpdate = true;
    glowShape.setDrawRange(0, glowCount);

    renderer.render({ scene: world, camera });

    // The overlay follows the pads.
    put(rootName, stemRoot);
    put(realmName, stemRoot);
    for (const leaf of totalLeaves) {
      const near = put(leaf.label, leaf.end);
      put(leaf.value, leaf.end);
      const foot = screen(leaf.foot);
      const readsLeft = near.x < foot.x;
      const turn =
        Math.atan2(screen(leaf.end).y - foot.y, near.x - foot.x) + (readsLeft ? Math.PI : 0);
      leaf.overlay.style.setProperty("--leaf", `${turn.toFixed(4)}rad`);
      leaf.value.classList.toggle("reads-left", readsLeft);
      leaf.overlay.style.opacity = String(1 - near.fog * 0.6);
    }
    for (const branch of branches.values()) {
      const near = put(branch.names.done, branch.points.done);
      put(branch.names.label, branch.points.label);
      put(branch.names.row, branch.points.row);
      put(branch.text, branch.points.text);
      put(branch.remove, branch.points.remove);
      // Names and the row turn with their branch on screen; a row starts at the stem and reads out
      // along it, upright, so a branch left of the stem reads toward the stem.
      const foot = screen(branch.points.foot);
      const end = screen(branch.points.row);
      const readsLeft = end.x < foot.x;
      const turn = Math.atan2(end.y - foot.y, end.x - foot.x) + (readsLeft ? Math.PI : 0);
      branch.overlay.style.setProperty("--leaf", `${turn.toFixed(4)}rad`);
      branch.text.classList.toggle("reads-left", readsLeft);
      branch.overlay.style.opacity = String((1 - near.fog * 0.6) * branch.grow.value(now));
      branch.overlay.style.zIndex = String(Math.round((1 - near.fog) * 100));
    }
    return moving;
  };

  const frame = (now: number): void => {
    frameRequest = 0;
    if (render(now)) {
      frameRequest = requestAnimationFrame(frame);
    }
  };

  const requestFrame = (): void => {
    if (frameRequest === 0) {
      frameRequest = requestAnimationFrame(frame);
    }
  };

  const measure = (): void => {
    const measuredWidth = Math.round(root.getBoundingClientRect().width);
    const measuredHeight = Math.round(root.getBoundingClientRect().height);
    if (measuredWidth === width && measuredHeight === height) {
      return;
    }
    width = measuredWidth;
    height = measuredHeight;
    renderer.setSize(width, height);
    camera.perspective({ aspect: width / Math.max(height, 1) });
    pixelDistance = height / 2 / Math.tan((fieldOfView / 2) * (Math.PI / 180));
    stem.resize();
    for (const leaf of totalLeaves) {
      leaf.line.resize();
    }
    for (const branch of branches.values()) {
      for (const line of Object.values(branch.traces)) {
        line.resize();
      }
    }
  };

  // The whole branch toggles its todo, not only its row: the pointer picks the branch whose traces
  // pass nearest it on screen, and the branch rises toward lit while the pointer is over it.
  const segmentDistance = (
    x: number,
    y: number,
    from: { x: number; y: number },
    to: { x: number; y: number },
  ): number => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = dx * dx + dy * dy;
    const along =
      length === 0 ? 0 : Math.min(Math.max(((x - from.x) * dx + (y - from.y) * dy) / length, 0), 1);
    return Math.hypot(x - (from.x + along * dx), y - (from.y + along * dy));
  };

  const branchAt = (x: number, y: number): Branch | undefined => {
    let picked: Branch | undefined;
    let best = hitReach;
    for (const branch of branches.values()) {
      if (branch.leaving) {
        continue;
      }
      const { foot, bend, done, label, row } = branch.points;
      const spots = [foot, bend, done, label, row].map(screen);
      for (let index = 1; index < spots.length; index++) {
        const distance = segmentDistance(x, y, spots[index - 1]!, spots[index]!);
        if (distance < best) {
          best = distance;
          picked = branch;
        }
      }
    }
    return picked;
  };

  const branchFor = (event: MouseEvent): Branch | undefined => {
    const control = event.target instanceof Element ? event.target.closest("[data-action]") : null;
    if (control !== null) {
      const id = control.getAttribute("data-id");
      return control.getAttribute("data-action") === "toggle" && id !== null
        ? branches.get(id)
        : undefined;
    }
    const box = root.getBoundingClientRect();
    return branchAt(event.clientX - box.left, event.clientY - box.top);
  };

  let hovered: Branch | undefined;
  const hover = (branch: Branch | undefined): void => {
    if (branch === hovered) {
      return;
    }
    const now = performance.now();
    for (const [target, to] of [
      [hovered, 0],
      [branch, 1],
    ] as const) {
      if (target !== undefined) {
        target.hover.set(to, now, still ? 0 : hoverDuration);
        target.overlay.classList.toggle("is-hovered", to === 1);
      }
    }
    hovered = branch;
    root.classList.toggle("is-picking", branch !== undefined);
    requestFrame();
  };

  root.addEventListener("pointermove", (event) =>
    hover(event.pointerType === "touch" ? undefined : branchFor(event)),
  );
  root.addEventListener("pointerleave", () => hover(undefined));
  // A press on a trace or pad clicks the branch's row, which the canvas's own listener toggles.
  root.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("[data-action]") !== null) {
      return;
    }
    branchFor(event)?.text.click();
  });

  let last: FrondPicture | undefined;

  const set = (picture: FrondPicture, signal: FrondSignal | undefined): void => {
    const now = performance.now();
    const animate = signal !== undefined && !still;
    const light = animate ? lightDuration : 0;
    const move = animate ? moveDuration : 0;
    count = picture.todos.length;
    measure();
    const present = new Set(picture.todos.map((todo) => todo.id));

    for (const branch of branches.values()) {
      if (!present.has(branch.id) && !branch.leaving) {
        branch.leaving = true;
        if (branch === hovered) {
          hover(undefined);
        }
        branch.grow.set(0, now, animate ? growDuration : 0);
        // Its controls go at once, so focus and the tab order skip it.
        branch.overlay.replaceChildren();
      }
    }

    picture.todos.forEach((todo, index) => {
      const layout = frondBranchLayout(index, count, width);
      const angle = leafAngle(layout);
      let branch = branches.get(todo.id);
      if (branch === undefined) {
        branch = makeBranch(todo.id, layout.y, now, !animate);
        branches.set(todo.id, branch);
        branch.length.set(layout.length, now, 0);
        branch.angle.set(angle, now, 0);
      }
      // A branch that changes side when another goes swings around the stem to its new place.
      branch.angle.set(angle, now, move);
      branch.y.set(layout.y, now, move);
      branch.length.set(layout.length, now, move);

      if (todo.done !== branch.done) {
        branch.done = todo.done;
        const target = todo.done ? 1 : 0;
        const travels = animate && signal.from === todo.id;
        // Each part settles as the write reaches it, a step apart.
        branch.lit.forEach((part, step) => {
          part.set(target, now, light, travels ? step * flashStep : 0);
        });
      }
      branch.overlay.classList.toggle("is-done", todo.done);
      showRow(branch.text, fitLabel(todo.label, layout.characters));
      branch.text.setAttribute("aria-pressed", String(todo.done));
      branch.text.setAttribute("aria-label", `Toggle ${todo.title}`);
      branch.remove.setAttribute("aria-label", `Remove ${todo.title}`);
    });

    const complete = count > 0 && picture.todos.every((todo) => todo.done);
    root.classList.toggle("has-todos", count > 0);
    root.classList.toggle("is-complete", complete);
    stemLit.set(count > 0 ? 1 : 0, now, light);
    const tipChanged = complete !== (tipLit.target === 1);
    tipLit.set(complete ? 1 : 0, now, light, animate ? flashStep * 4 : 0);
    // A total whose value changed flashes as its recompute does, after the write that reached it.
    const changedTotals: Array<(typeof totalLeaves)[number]> = [];
    frondTotalLeaves(count, width).forEach((layout, index) => {
      const leaf = totalLeaves[index]!;
      const duration = totalsShown ? move : 0;
      leaf.angle.set(leafAngle(layout), now, duration);
      leaf.y.set(layout.y, now, duration);
      leaf.length.set(layout.length, now, duration);
      const value = picture.totals[index] ?? "";
      if (leaf.value.textContent !== value) {
        if (totalsShown) {
          changedTotals.push(leaf);
        }
        leaf.value.textContent = value;
      }
    });
    totalsShown = true;
    rootY.set(frondMeasures.rootY(count), now, move);
    extent.set(frondHeight(count), now, move);
    zoom.set(fitZoom(), now, move);

    if (animate) {
      // The parts a write changed flash cyan a step apart, as the write, the computed values it
      // invalidated, and the rows that re-rendered each take it.
      const flashText = (elements: ReadonlyArray<HTMLElement>, delay: number): void => {
        for (const target of elements) {
          target.animate([{ color: cssCyan, offset: 0 }], {
            duration: flashDuration,
            delay,
            easing: "ease-out",
          });
        }
      };
      if (signal.from === "root") {
        stemFlash.fire(now);
        flashText([rootName], 0);
      } else {
        const written = branches.get(signal.from);
        if (written !== undefined) {
          // It stops at `$label` when the row did not re-render.
          const farthest = signal.reached.includes(written.id) ? 4 : 2;
          written.flash.forEach((part, step) => {
            if (step <= farthest) {
              part.fire(now, step * flashStep);
            }
          });
          flashText([written.names.done], 0);
          flashText([written.names.label], 2 * flashStep);
          if (farthest === 4) {
            flashText([written.names.row, written.text], 4 * flashStep);
          }
        }
      }
      for (const id of signal.reached) {
        const branch = branches.get(id);
        if (branch !== undefined && id !== signal.from) {
          const delay = 2 * flashStep;
          branch.flash.forEach((part, step) => {
            part.fire(now, delay + step * flashStep);
          });
          flashText([branch.names.done], delay);
          flashText([branch.names.label], delay + 2 * flashStep);
          flashText([branch.names.row, branch.text], delay + 4 * flashStep);
        }
      }
      for (const leaf of changedTotals) {
        leaf.flash.fire(now, 2 * flashStep);
        flashText([leaf.label, leaf.value], 2 * flashStep);
      }
      if (tipChanged) {
        tipFlash.fire(now, 4 * flashStep);
      }
    }

    last = picture;
    if (render(now)) {
      requestFrame();
    }
  };

  // A new width redraws the last picture at once; what is easing keeps easing.
  const resize = (): void => {
    if (last !== undefined) {
      set(last, undefined);
    }
  };

  const dispose = (): void => {
    cancelAnimationFrame(frameRequest);
    frameRequest = 0;
    context.getExtension("WEBGL_lose_context")?.loseContext();
    root.remove();
  };

  return { set, resize, dispose };
};
