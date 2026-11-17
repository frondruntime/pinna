import { useValue, useValues } from "@frondruntime/pinna-react";
import { memo, useEffect } from "react";
import type { Desk } from "./desk.ts";

const markers = { up: "↑", down: "↓", unchanged: "→" } as const;

const Price = memo(function Price({
  desk,
  onRender,
}: {
  readonly desk: Desk;
  readonly onRender: (() => void) | undefined;
}) {
  onRender?.();
  const display = useValue(desk.$display);
  return (
    <div className="price">
      <div className="quotes">
        <div>
          <span>Bid</span>
          <strong>{display.bid}</strong>
        </div>
        <div>
          <span>Ask</span>
          <strong>{display.ask}</strong>
        </div>
      </div>
      <p className="spread">
        Spread <b>{display.spreadPips}</b> pips
        <span
          className={`movement ${display.movement}`}
          role="img"
          aria-label={`Price ${display.movement}`}
        >
          {markers[display.movement]}
        </span>
      </p>
      {display.error !== null && <p role="alert">Price feed failed: {display.error}</p>}
    </div>
  );
});

export const SpotTile = memo(function SpotTile({
  desk,
  onPriceRender,
  onClose,
  onLimitOrder,
  onRender,
}: {
  readonly desk: Desk;
  readonly onPriceRender?: () => void;
  readonly onLimitOrder?: () => void;
  readonly onClose?: () => void;
  readonly onRender?: () => void;
}) {
  onRender?.();
  const [notional, execution, canExecute, display] = useValues([
    desk.$notional,
    desk.$execution,
    desk.$canExecute,
    desk.$display,
  ]);
  useEffect(() => () => desk.cancelExecution(), [desk]);
  return (
    <article
      className="spot-tile"
      aria-label={`${desk.pair.baseCurrency}/${desk.pair.termsCurrency} spot`}
    >
      <header>
        <h2>
          {desk.pair.baseCurrency} / {desk.pair.termsCurrency}
        </h2>
        <span>SPOT</span>
        {onClose && (
          <button type="button" aria-label={`Close ${desk.pair.symbol}`} onClick={onClose}>
            Close
          </button>
        )}
      </header>
      <Price desk={desk} onRender={onPriceRender} />
      <label>
        Notional ({desk.pair.baseCurrency})
        <input
          aria-label="Notional amount"
          inputMode="decimal"
          value={notional}
          onInput={(event) => desk.setNotional(event.currentTarget.value)}
        />
      </label>
      <div className="execution-buttons">
        <button
          type="button"
          disabled={!canExecute}
          onClick={() => desk.startExecution("buy", display.ask)}
        >
          Buy {desk.pair.baseCurrency}
        </button>
        <button
          type="button"
          disabled={!canExecute}
          onClick={() => desk.startExecution("sell", display.bid)}
        >
          Sell {desk.pair.baseCurrency}
        </button>
      </div>
      <p role="status">{execution}</p>
      <MarketConfirmation desk={desk} />
      {onLimitOrder && (
        <button type="button" onClick={onLimitOrder}>
          Limit order
        </button>
      )}
    </article>
  );
});

const MarketConfirmation = memo(function MarketConfirmation({ desk }: { readonly desk: Desk }) {
  const direction = useValue(desk.$confirmation);
  return direction ? (
    <div role="alert">
      Confirm this market {direction} above your account threshold.
      <button type="button" onClick={() => desk.confirmExecution()}>
        Confirm market order
      </button>
      <button type="button" onClick={() => desk.dismissConfirmation()}>
        Cancel market order
      </button>
    </div>
  ) : null;
});
