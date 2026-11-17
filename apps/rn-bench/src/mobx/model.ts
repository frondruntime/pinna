/**
 * The MobX model, written as MobX's documentation asks.
 *
 * - https://mobx.js.org/observable-state.html: "only annotated members are
 *   affected", so only state that changes is annotated; a value treated as
 *   immutable (a big.js decimal, a date) takes `observableRef`, which tracks
 *   reassignment and leaves the value alone; a collection of objects that
 *   are observable on their own takes `observable.array(..., { deep: false })`
 *   (`observableShallow`'s option form).
 * - https://mobx.js.org/actions.html: code that changes state is an action,
 *   and "no reactions will be run until the outer-most action has finished".
 * - https://mobx.js.org/computeds.html: read for the decision not to add a
 *   `computed` per row. A computed outside a reaction is not cached, and a
 *   cell reads two fields at most, so the formatters run in the component.
 *
 * Installed API checked in node_modules/mobx/src/api/observable.ts
 * (`observableRef`, `observable.array`, `deep: false`) and
 * node_modules/mobx/src/api/makeObservable.ts.
 *
 * What changes is observable: the three tick fields of an `Instrument`, the
 * list, and the selection. Everything else an instrument holds never changes
 * for that instance (a refetch that changes it makes a new instance), so it
 * is a plain readonly property, and the nested network, limits, and history
 * stay the plain values they arrive as, never wrapped.
 */
import type Big from "big.js";
import { action, makeObservable, observable, observableRef } from "mobx";
import {
  equalBig,
  equalDate,
  type PlainLimits,
  type PlainNetwork,
  type PlainPoint,
  type PlainRow,
  type PlainTick,
  sameRest,
} from "../data/plain.ts";
import type { Status } from "../data/wire.ts";

export class Instrument {
  readonly id: string;
  readonly ticker: string;
  readonly name: string;
  readonly status: Status;
  readonly tags: ReadonlyArray<string>;
  readonly volume: Big;
  readonly listedAt: Date;
  readonly network: PlainNetwork;
  readonly limits: PlainLimits;
  readonly history: ReadonlyArray<PlainPoint>;
  // What a tick writes: reassigned, never mutated, so `observableRef`.
  price: Big;
  diff24: Big;
  updatedAt: Date;

  constructor(plain: PlainRow) {
    this.id = plain.id;
    this.ticker = plain.ticker;
    this.name = plain.name;
    this.status = plain.status;
    this.tags = plain.tags;
    this.volume = plain.volume;
    this.listedAt = plain.listedAt;
    this.network = plain.network;
    this.limits = plain.limits;
    this.history = plain.history;
    this.price = plain.price;
    this.diff24 = plain.diff24;
    this.updatedAt = plain.updatedAt;
    makeObservable(this, {
      price: observableRef,
      diff24: observableRef,
      updatedAt: observableRef,
      writeTick: action,
    });
  }

  /** Writes a field only where its value changed: a big.js or date compares by value. */
  writeTick(next: PlainTick): void {
    if (!equalBig(this.price, next.price)) {
      this.price = next.price;
    }
    if (!equalBig(this.diff24, next.diff24)) {
      this.diff24 = next.diff24;
    }
    if (!equalDate(this.updatedAt, next.updatedAt)) {
      this.updatedAt = next.updatedAt;
    }
  }
}

export class Market {
  /** The rows in order: an array of observable objects, so `deep: false`. */
  readonly items = observable.array<Instrument>([], { deep: false });
  /**
   * The open row. Held as the instance, so the details screen reads it
   * without a lookup; a write to the list keeps it current.
   */
  selected: Instrument | undefined = undefined;
  /**
   * The keyed lookup a tick or a merge reads by id. Only actions read it, so
   * it is a plain `Map`: nothing observes it.
   */
  readonly byId = new Map<string, Instrument>();

  constructor() {
    makeObservable(this, {
      selected: observableRef,
      load: action,
      merge: action,
      insert: action,
      remove: action,
      tick: action,
      select: action,
    });
  }

  /** A first fetch, or a refetch swapped in whole: every row is new. */
  load(rows: ReadonlyArray<PlainRow>): void {
    this.hold(rows.map((row) => new Instrument(row)));
  }

  /** Rows whose other fields are unchanged stay, with their tick fields written. */
  merge(rows: ReadonlyArray<PlainRow>): void {
    this.hold(
      rows.map((next) => {
        const item = this.byId.get(next.id);
        if (item === undefined || !sameRest(item, next)) {
          return new Instrument(next);
        }
        item.writeTick(next);
        return item;
      }),
    );
  }

  insert(rows: ReadonlyArray<PlainRow>): void {
    const added = rows.map((row) => new Instrument(row));
    for (const item of added) {
      this.byId.set(item.id, item);
    }
    this.items.unshift(...added);
  }

  remove(ids: ReadonlyArray<string>): void {
    const gone = new Set(ids);
    for (const id of gone) {
      this.byId.delete(id);
    }
    this.items.replace(this.items.filter((item) => !gone.has(item.id)));
    this.follow();
  }

  tick(ticks: ReadonlyArray<PlainTick>): void {
    for (const next of ticks) {
      this.byId.get(next.id)?.writeTick(next);
    }
  }

  select(id: string | undefined): void {
    this.selected = id === undefined ? undefined : this.byId.get(id);
  }

  /** Holds `next` as the list, leaving the list alone when it is the same rows in the same order. */
  private hold(next: Array<Instrument>): void {
    this.byId.clear();
    for (const item of next) {
      this.byId.set(item.id, item);
    }
    const unchanged =
      next.length === this.items.length && next.every((item, index) => this.items[index] === item);
    if (!unchanged) {
      this.items.replace(next);
    }
    this.follow();
  }

  /** The open row follows its id into a new instance, or closes when the row is gone. */
  private follow(): void {
    if (this.selected !== undefined) {
      this.selected = this.byId.get(this.selected.id);
    }
  }
}
