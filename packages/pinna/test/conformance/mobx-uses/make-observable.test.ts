import { describe, expect, test } from "bun:test";
import {
  makeAutoObservable,
  makeObservable,
  autorun as mobxAutorun,
  computed as mobxComputed,
  observable,
} from "mobx";
import { Box, Computed, Realm } from "../../../src/index.ts";

/**
 * An application's `makeAutoObservable` and `makeObservable` uses, each beside
 * its Pinna rewrite: a plain class whose fields are boxes, whose getters are
 * computed values, and whose methods write inside `Realm.update`.
 */

/** A rate book: two fields, a derived mid price, and a method that writes both. */
class MobxQuote {
  bid = 1;
  ask = 3;
  computes = 0;

  constructor() {
    makeAutoObservable(this, { computes: false });
  }

  get mid(): number {
    this.computes++;
    return (this.bid + this.ask) / 2;
  }

  quote(bid: number, ask: number): void {
    this.bid = bid;
    this.ask = ask;
  }
}

class PinnaQuote {
  readonly $bid: Box<number>;
  readonly $ask: Box<number>;
  readonly mid: Computed<number>;
  computes = 0;

  constructor(readonly realm: Realm) {
    this.$bid = Box.make(realm, 1);
    this.$ask = Box.make(realm, 3);
    this.mid = Computed.make(realm, (read) => {
      this.computes++;
      return (read(this.$bid) + read(this.$ask)) / 2;
    });
  }

  quote(bid: number, ask: number): void {
    Realm.update(this.realm, (_read, write) => {
      write(this.$bid, bid);
      write(this.$ask, ask);
    });
  }
}

// The second quote leaves the mid price at 3: it recomputes, and its reader
// does not rerun.
const quoteTrace = { seen: [2, 3], computes: 3 };

describe("makeAutoObservable", () => {
  test("MobX: a method is one batch, and a getter is a cached computed value", () => {
    const model = new MobxQuote();
    const seen: Array<number> = [];
    const stop = mobxAutorun(() => {
      seen.push(model.mid);
    });
    model.quote(2, 4);
    model.quote(1, 5);
    stop();
    expect({ seen, computes: model.computes }).toEqual(quoteTrace);
  });

  test("Pinna: boxes, a computed value, and a method that writes inside update", () => {
    const realm = Realm.make();
    const model = new PinnaQuote(realm);
    const seen: Array<number> = [];
    const stop = Realm.autorun(realm, (read) => {
      seen.push(read(model.mid));
    });
    model.quote(2, 4);
    model.quote(1, 5);
    stop();
    expect({ seen, computes: model.computes }).toEqual(quoteTrace);
  });
});

/** A position valuation: one computed presentation, read twice per run. */
class MobxValuation {
  size = 2;
  price = 10;

  constructor() {
    makeObservable(this, { size: observable, price: observable, presentation: mobxComputed });
  }

  get presentation(): { readonly value: number } {
    return { value: this.size * this.price };
  }
}

describe("makeObservable with a computed getter", () => {
  test("MobX: two reads in one run return the same object", () => {
    const model = new MobxValuation();
    const cached: Array<boolean> = [];
    const values: Array<number> = [];
    const stop = mobxAutorun(() => {
      const first = model.presentation;
      const second = model.presentation;
      values.push(first.value);
      cached.push(first === second);
    });
    stop();
    expect({ values, cached }).toEqual({ values: [20], cached: [true] });
  });

  test("Pinna: two reads of a computed value in one run return the same object", () => {
    const realm = Realm.make();
    const $size = Box.make(realm, 2);
    const $price = Box.make(realm, 10);
    const presentation = Computed.make(realm, (read) => ({ value: read($size) * read($price) }));
    const cached: Array<boolean> = [];
    const values: Array<number> = [];
    const stop = Realm.autorun(realm, (read) => {
      const first = read(presentation);
      const second = read(presentation);
      values.push(first.value);
      cached.push(first === second);
    });
    stop();
    expect({ values, cached }).toEqual({ values: [20], cached: [true] });
  });
});
