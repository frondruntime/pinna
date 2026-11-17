import {
  box,
  type Collection,
  Model,
  onRowChange,
  type Read,
  type Realm,
  type Write,
} from "@frondruntime/pinna";
import { add, type Decimal, decimal, multiply, negate, zero } from "./decimal.ts";
import { type PairSymbol, symbols, type Trade } from "./wire.ts";

export interface Aggregate {
  readonly count: number;
  readonly net: Decimal;
  readonly cost: Decimal;
}
const empty: Aggregate = { count: 0, net: zero, cost: zero };
export class PositionLedger extends Model {
  readonly $aggregate = box(this.realm, empty);
  constructor(
    realm: Realm,
    readonly symbol: PairSymbol,
  ) {
    super(realm);
  }
}

/** Maintain signed quantity and signed cost in the same transaction as the trade. */
export class PositionBook implements Disposable {
  readonly ledgers: readonly PositionLedger[];
  private readonly stop: () => void;
  constructor(realm: Realm, $trades: Collection<string, Trade>) {
    this.ledgers = symbols.map((symbol) => new PositionLedger(realm, symbol));
    this.stop = onRowChange($trades, ({ before, after }, read, write) => {
      this.change(read, write, before, after);
    });
  }
  [Symbol.dispose]() {
    this.stop();
  }
  ledger(symbol: PairSymbol) {
    const ledger = this.ledgers.find((ledger) => ledger.symbol === symbol);
    if (!ledger) throw new Error(`unknown position ${symbol}`);
    return ledger;
  }
  private change(read: Read, write: Write, previous?: Trade, next?: Trade) {
    for (const [trade, multiplier] of [
      [previous, -1],
      [next, 1],
    ] as const) {
      if (trade?.status !== "done") continue;
      const ledger = this.ledger(trade.symbol);
      const aggregate = read(ledger.$aggregate);
      const amount = decimal(trade.notional);
      const signed =
        (trade.direction === "buy" ? 1 : -1) * multiplier === 1 ? amount : negate(amount);
      write(ledger.$aggregate, {
        count: aggregate.count + multiplier,
        net: add(aggregate.net, signed),
        cost: add(aggregate.cost, multiply(signed, decimal(trade.rate))),
      });
    }
  }
}
