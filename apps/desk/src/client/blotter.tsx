import { useValue, useValues } from "@frondruntime/pinna-react";
import { memo, useLayoutEffect, useRef } from "react";
import { columns, rowHeight } from "./trade-index.ts";
import type { TradeBook } from "./trades.ts";

const labels = {
  time: "Time",
  pair: "Pair",
  direction: "Direction",
  notional: "Notional",
  rate: "Rate",
  status: "Status",
  desk: "Desk",
};

const TradeRow = memo(function TradeRow({
  book,
  id,
  onRender,
}: {
  readonly book: TradeBook;
  readonly id: string;
  readonly onRender: ((id: string) => void) | undefined;
}) {
  onRender?.(id);
  const trade = useValue(book.$trades.row(id));
  const selected = useValue(book.$isSelected(id));
  if (trade === undefined) return null;
  return (
    <tr
      data-trade-id={trade.id}
      aria-selected={selected}
      tabIndex={0}
      onClick={(event) => book.select(id, event.metaKey || event.ctrlKey)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          book.select(id, event.metaKey || event.ctrlKey);
        }
      }}
    >
      <td>
        <time dateTime={trade.createdAt}>{trade.createdAt.slice(11, 23)}</time>
      </td>
      <td>{trade.symbol}</td>
      <td>{trade.direction}</td>
      <td>{trade.notional}</td>
      <td>{trade.rate}</td>
      <td>{trade.status}</td>
      <td>{trade.desk}</td>
    </tr>
  );
});

const Controls = memo(function Controls({ book }: { readonly book: TradeBook }) {
  const [filter, matching, held, summary] = useValues([
    book.$filter,
    book.$matchingCount,
    book.$heldCount,
    book.$selectionSummary,
  ]);
  return (
    <>
      <label>
        Filter trades
        <input
          type="search"
          value={filter}
          onInput={(event) => book.setFilter(event.currentTarget.value)}
        />
      </label>
      <p aria-live="polite">
        {matching} of {held} trades
      </p>
      <output aria-label="Selection summary">
        {summary.count} selected · Buy {summary.buy} · Sell {summary.sell}
      </output>
    </>
  );
});

const Headers = memo(function Headers({ book }: { readonly book: TradeBook }) {
  const sort = useValue(book.$sort);
  return (
    <table className="trade-head">
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column} aria-sort={sort.column === column ? sort.direction : "none"}>
              <button
                type="button"
                onClick={() =>
                  book.setSort({
                    column,
                    direction:
                      sort.column === column && sort.direction === "ascending"
                        ? "descending"
                        : "ascending",
                  })
                }
              >
                {labels[column]}
                {sort.column === column ? (sort.direction === "ascending" ? " ↑" : " ↓") : ""}
              </button>
            </th>
          ))}
        </tr>
      </thead>
    </table>
  );
});

export const Blotter = memo(function Blotter({
  book,
  onRowRender,
  onRender,
}: {
  readonly book: TradeBook;
  readonly onRowRender?: (id: string) => void;
  readonly onRender?: () => void;
}) {
  onRender?.();
  const window = useValue(book.$window);
  const [scrollTop, viewportHeight] = useValues([book.$scrollTop, book.$viewportHeight]);
  const viewport = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (element)
      element.scrollTop = Math.min(
        scrollTop,
        Math.max(0, window.count * rowHeight - viewportHeight),
      );
  }, [scrollTop, viewportHeight, window.count]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (element.clientHeight > 0) book.setViewportHeight(element.clientHeight);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [book]);
  const before = window.start * rowHeight;
  const after = Math.max(0, window.count - window.start - window.ids.length) * rowHeight;
  return (
    <section className="blotter" aria-label="Trade blotter">
      <h2>Trades</h2>
      <Controls book={book} />
      <Headers book={book} />
      <div
        className="trade-table"
        ref={viewport}
        style={{ height: viewportHeight }}
        onScroll={(event) => book.setScrollTop(event.currentTarget.scrollTop)}
      >
        <table aria-label="Trades">
          <tbody>
            {before > 0 && (
              <tr className="trade-spacer" style={{ height: before }}>
                <td colSpan={7} />
              </tr>
            )}
            {window.ids.map((id) => (
              <TradeRow key={id} book={book} id={id} onRender={onRowRender} />
            ))}
            {after > 0 && (
              <tr className="trade-spacer" style={{ height: after }}>
                <td colSpan={7} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {window.count === 0 && <p>No matching trades</p>}
    </section>
  );
});
