// The flash a write leaves on text it changed, as a vector display's phosphor leaves it: cyan that
// decays fast, over a lime afterglow that settles back into the text's own color. The curve is
// sampled into 32 keyframes and every frame is mixed in oklab, so cyan bleeds into lime and lime
// into the text's color without a visible step; four stops mixed in sRGB read as a switch in a
// sketch. The settled values: cyan at 70% decaying with a 110 ms
// constant, lime at 35% over 800 ms, no white strike, and a text shadow of 5px at 35% in the
// text's own changing color. Code samples never take it, and the caller skips it under reduced
// motion.

const duration = 800;
const frames = 32;
const cyanStrength = 0.7;
const cyanDecay = 110;
const limeStrength = 0.35;
// The afterglow's decay constant: it falls to about 1% by the end of the flash.
const limeDecay = duration / 4.5;
// The afterglow rises over this many milliseconds, so the cyan reads first.
const limeRise = 60;
const shadowSize = 5;
const shadowStrength = 0.35;

let probe: HTMLElement | undefined;

/**
 * Resolves a CSS color to the color the browser computes for it, so each keyframe holds one
 * resolved color and the animation does not mix nested `color-mix()` on every frame.
 */
const resolve = (css: string): string => {
  if (probe === undefined || !probe.isConnected) {
    probe = document.createElement("span");
    probe.style.display = "none";
    probe.setAttribute("aria-hidden", "true");
    document.body.append(probe);
  }
  probe.style.color = css;
  return getComputedStyle(probe).color;
};

/** Flashes `target`'s text after `delay` milliseconds; a flash already running restarts. */
export const flashPhosphor = (target: HTMLElement, delay = 0): void => {
  // A flash still running is replaced; the page's own CSS animations and transitions stay.
  for (const animation of target.getAnimations()) {
    if (!(animation instanceof CSSAnimation || animation instanceof CSSTransition)) {
      animation.cancel();
    }
  }
  // A change that started a color transition on the text leaves the computed color at the one the
  // text is leaving; read with transitions off, it is the color the text settles into.
  const transition = target.style.transition;
  target.style.transition = "none";
  const own = getComputedStyle(target).color;
  target.style.transition = transition;
  const root = getComputedStyle(document.documentElement);
  const cyan = root.getPropertyValue("--cyan").trim();
  const lime = root.getPropertyValue("--accent").trim();
  const keyframes: Array<Keyframe> = [];
  for (let index = 0; index <= frames; index++) {
    const offset = index / frames;
    const elapsed = offset * duration;
    const last = index === frames;
    const c = last ? 0 : cyanStrength * Math.exp(-elapsed / cyanDecay);
    const g = last
      ? 0
      : limeStrength * Math.exp(-elapsed / limeDecay) * Math.min(1, elapsed / limeRise);
    const lit = resolve(
      `color-mix(in oklab, ${cyan} ${(c * 100).toFixed(1)}%, color-mix(in oklab, ${lime} ${(g * 100).toFixed(1)}%, ${own}))`,
    );
    const glow = Math.min(1, c + g * 0.6);
    const shadow = resolve(
      `color-mix(in oklab, ${lit} ${(glow * shadowStrength * 100).toFixed(1)}%, transparent)`,
    );
    keyframes.push({
      offset,
      ...(last ? {} : { color: lit }),
      textShadow: `0 0 ${(glow * shadowSize).toFixed(2)}px ${shadow}`,
    });
  }
  // The last frame leaves the color out, so the flash ends on the text's live color: a color that
  // still moves, as a new row's fading lime does, is met where it is, not where it was. No fill:
  // a backwards fill held the first, brightest frame through the delay, so a label due 400 ms
  // after the write lit with it and the text lost the order the graph shows.
  target.animate(keyframes, { duration, delay });
};
