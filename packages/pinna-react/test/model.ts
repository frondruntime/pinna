/**
 * A positions model: rows of quotes from the wire, a value per row, and a
 * total, with numbers for prices.
 */
import {
  BoxField,
  computed,
  decode,
  Model,
  SchemaModel,
  schemaBox,
  update,
} from "@frondruntime/pinna-effect";
import { Schema } from "effect";

/** A plain value: it holds no observables, so it needs no realm. */
export class Quote extends Schema.Class<Quote>("Quote")({
  price: Schema.Number,
  at: Schema.String,
}) {}

export class Position extends SchemaModel<Position>("Position")({
  id: Schema.String,
  ticker: Schema.String,
  amount: Schema.Number,
  $quote: BoxField(Quote),
}) {
  readonly $value = computed(this.realm, (read) => this.amount * read(this.$quote).price);

  get label(): string {
    return `${this.amount} ${this.ticker}`;
  }
}

export class PositionsResponse extends SchemaModel<PositionsResponse>("PositionsResponse")({
  items: Schema.Array(Position),
}) {
  get byId(): ReadonlyMap<string, Position> {
    return new Map(this.items.map((position) => [position.id, position]));
  }

  readonly $total = computed(this.realm, (read) =>
    this.items.reduce((sum, position) => sum + read(position.$value), 0),
  );
}

export interface Tick {
  readonly id: string;
  readonly price: number;
}

/** A model with no wire shape of its own: it is never decoded, so it extends Model. */
export class Portfolio extends Model {
  readonly $response = schemaBox(
    this.realm,
    PositionsResponse,
    PositionsResponse.make({ items: [], realm: this.realm }),
  );
  readonly $currency = schemaBox(this.realm, Schema.Literals(["USD", "EUR"]), "USD");
  readonly $totalLabel = computed(
    this.realm,
    (read) => `${read(read(this.$response).$total)} ${read(this.$currency)}`,
  );

  load(json: unknown): void {
    update(this.realm, (_read, write) => {
      write(this.$response, decode(this.realm, PositionsResponse)(json));
    });
  }

  tick(tick: Tick): void {
    update(this.realm, (read, write) => {
      const $quote = read(this.$response).byId.get(tick.id)?.$quote;
      if ($quote !== undefined) {
        write($quote, Quote.make({ price: tick.price, at: "2026-10-27T10:00:01Z" }));
      }
    });
  }

  close(id: string): void {
    update(this.realm, (read, write) => {
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
