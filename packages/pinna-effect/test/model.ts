/**
 * A positions model: rows of quotes from the wire, a value per row, and a
 * total, with numbers for prices. Counters record how often each computed
 * value runs.
 */
import { Schema } from "effect";
import { Box, Computed, Model, Realm } from "../src/index.ts";

export const runs = { value: 0, total: 0 };

/** A plain value: it holds no observables, so it needs no realm. */
export class Quote extends Schema.Class<Quote>("Quote")({
  price: Schema.Number,
  at: Schema.String,
}) {}

export class Position extends Model.Schema<Position>("Position")({
  id: Schema.String,
  ticker: Schema.String,
  amount: Schema.Number,
  $quote: Model.boxField(Quote),
}) {
  readonly $value = Computed.make(this.realm, (read) => {
    runs.value++;
    return this.amount * read(this.$quote).price;
  });

  get label(): string {
    return `${this.amount} ${this.ticker}`;
  }
}

export class PositionsResponse extends Model.Schema<PositionsResponse>("PositionsResponse")({
  items: Schema.Array(Position),
}) {
  get byId(): ReadonlyMap<string, Position> {
    return new Map(this.items.map((position) => [position.id, position]));
  }

  readonly $total = Computed.make(this.realm, (read) => {
    runs.total++;
    return this.items.reduce((sum, position) => sum + read(position.$value), 0);
  });
}

export interface Tick {
  readonly id: string;
  readonly price: number;
}

/** A model with no wire shape of its own: it is never decoded, so it extends Model. */
export class Portfolio extends Model.Class {
  readonly $response = Box.schema(
    this.realm,
    PositionsResponse,
    PositionsResponse.make({ items: [], realm: this.realm }),
  );
  readonly $currency = Box.schema(this.realm, Schema.Literals(["USD", "EUR"]), "USD");
  readonly $totalLabel = Computed.make(
    this.realm,
    (read) => `${read(read(this.$response).$total)} ${read(this.$currency)}`,
  );

  load(json: unknown): void {
    Realm.update(this.realm, (_read, write) => {
      write(this.$response, Model.decode(this.realm, PositionsResponse)(json));
    });
  }

  tick(tick: Tick): void {
    Realm.update(this.realm, (read, write) => {
      const position = read(this.$response).byId.get(tick.id);
      if (position !== undefined) {
        write(position.$quote, Quote.make({ price: tick.price, at: "2026-10-27T10:00:01Z" }));
      }
    });
  }

  close(id: string): void {
    Realm.update(this.realm, (read, write) => {
      const current = read(this.$response);
      write(
        this.$response,
        PositionsResponse.make({
          items: current.items.filter((position) => position.id !== id),
          realm: this.realm,
        }),
      );
    });
  }
}

export const positionsJson = (count: number) => ({
  items: Array.from({ length: count }, (_, index) => ({
    id: `p${index}`,
    ticker: `T${index}`,
    amount: index + 1,
    quote: { price: 10, at: "2026-10-27T10:00:00Z" },
  })),
});
