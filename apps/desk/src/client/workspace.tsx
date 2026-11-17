import { useValue } from "@frondruntime/pinna-react";
import { memo } from "react";
import { format, fraction } from "./decimal.ts";
import type { Workspace } from "./desk.ts";
import type { PositionRow, Positions } from "./positions.ts";
import { SpotTile } from "./spot-tile.tsx";
import type { PairSymbol } from "./wire.ts";

export const Position = memo(function Position({
  row,
  onRender,
}: {
  readonly row: PositionRow;
  readonly onRender?: ((symbol: PairSymbol) => void) | undefined;
}) {
  onRender?.(row.tile.pair.symbol);
  const value = useValue(row.$value);
  if (!value) return null;
  return (
    <tr data-position={value.symbol}>
      <td>{value.symbol}</td>
      <td>
        {format(value.net, 2)} {row.tile.pair.baseCurrency}
      </td>
      <td>{format(value.average, row.tile.pair.pricePrecision)}</td>
      <td>{format(value.mark, row.tile.pair.pricePrecision + 1)}</td>
      <td>
        {format(value.profitLoss, 2)} {row.tile.pair.termsCurrency}
      </td>
      <td>{value.dollars === null ? "—" : format(fraction(value.dollars, 100n), 2)}</td>
    </tr>
  );
});

export const Total = memo(function Total({
  positions,
  onRender,
}: {
  readonly positions: Positions;
  readonly onRender?: (() => void) | undefined;
}) {
  onRender?.();
  const total = useValue(positions.$total);
  return (
    <p role="status" aria-label="Total profit and loss">
      Total: {format(fraction(total.cents, 100n), 2)} USD{!total.complete && " (incomplete)"}
    </p>
  );
});

export const PositionsPanel = memo(function PositionsPanel({
  positions,
  onRowRender,
  onTotalRender,
}: {
  readonly positions: Positions;
  readonly onRowRender?: (symbol: PairSymbol) => void;
  readonly onTotalRender?: () => void;
}) {
  const symbols = useValue(positions.$symbols);
  return (
    <section aria-label="Positions">
      <h2>Positions</h2>
      <div className="trade-table">
        <table>
          <thead>
            <tr>
              <th>Pair</th>
              <th>Net position</th>
              <th>Average rate</th>
              <th>Mark</th>
              <th>Profit / loss</th>
              <th>USD</th>
            </tr>
          </thead>
          <tbody>
            {symbols.map((symbol) => (
              <Position key={symbol} row={positions.row(symbol)} onRender={onRowRender} />
            ))}
          </tbody>
        </table>
      </div>
      <Total positions={positions} onRender={onTotalRender} />
    </section>
  );
});

const WorkspaceTile = memo(function WorkspaceTile({
  workspace,
  symbol,
  onRender,
}: {
  readonly workspace: Workspace;
  readonly symbol: PairSymbol;
  readonly onRender?: ((symbol: PairSymbol) => void) | undefined;
}) {
  return (
    <SpotTile
      desk={workspace.tile(symbol)}
      onClose={() => workspace.closeTile(symbol)}
      onLimitOrder={() => workspace.orders.open(workspace.tile(symbol))}
      {...(onRender ? { onRender: () => onRender(symbol) } : {})}
    />
  );
});

export const WorkspaceView = memo(function WorkspaceView({
  workspace,
  onTileRender,
}: {
  readonly workspace: Workspace;
  readonly onTileRender?: (symbol: PairSymbol) => void;
}) {
  const open = useValue(workspace.$openSymbols);
  const shown = useValue(workspace.$panelShown);
  return (
    <>
      <nav aria-label="Pairs">
        {workspace.tiles.map((tile) => (
          <button
            key={tile.pair.symbol}
            type="button"
            disabled={open.includes(tile.pair.symbol)}
            onClick={() => workspace.openTile(tile.pair.symbol)}
          >
            Open {tile.pair.symbol}
          </button>
        ))}
      </nav>
      <div className="tiles">
        {open.map((symbol) => (
          <WorkspaceTile
            key={symbol}
            workspace={workspace}
            symbol={symbol}
            onRender={onTileRender}
          />
        ))}
      </div>
      <button type="button" aria-expanded={shown} onClick={() => workspace.showPositions(!shown)}>
        {shown ? "Hide" : "Show"} positions
      </button>
      {shown && <PositionsPanel positions={workspace.positions} />}
    </>
  );
});
