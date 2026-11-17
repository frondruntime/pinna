/**
 * A small seeded generator (mulberry32). The fuzz never calls `Math.random`:
 * a seed names one program, on every machine and every run.
 */
export class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
    // Spread nearby seeds apart.
    for (let round = 0; round < 4; round++) {
      this.next();
    }
  }

  /** A float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let mixed = this.state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer in [low, high], both ends included. */
  integer(low: number, high: number): number {
    return low + Math.floor(this.next() * (high - low + 1));
  }

  /** True with probability `chance`. */
  chance(chance: number): boolean {
    return this.next() < chance;
  }

  pick<Element>(elements: ReadonlyArray<Element>): Element {
    const element = elements[this.integer(0, elements.length - 1)];
    if (element === undefined) {
      throw new Error("fuzz: pick from an empty list");
    }
    return element;
  }

  /** Picks by weight: `[weight, element]` pairs. */
  weighted<Element>(pairs: ReadonlyArray<readonly [number, Element]>): Element {
    let total = 0;
    for (const [weight] of pairs) {
      total += weight;
    }
    let target = this.next() * total;
    for (const [weight, element] of pairs) {
      target -= weight;
      if (target < 0) {
        return element;
      }
    }
    const last = pairs[pairs.length - 1];
    if (last === undefined) {
      throw new Error("fuzz: weighted pick from an empty list");
    }
    return last[1];
  }
}
