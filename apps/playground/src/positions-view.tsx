import { Box, Model, Realm } from "@frondruntime/pinna-effect";
import { useSelect, useValue } from "@frondruntime/pinna-react";
import { BigDecimal, Context, Schema } from "effect";
import { memo, useEffect, useRef, useState } from "react";
import {
  DateFormatting,
  Dates,
  livePositionJson,
  locales,
  type Position,
  Positions,
  PositionUpdate,
  positionsJson,
  Rates,
  ratesJson,
} from "./positions.ts";
import { Renders, useRenders } from "./renders.tsx";

const decimal = (value: BigDecimal.BigDecimal, digits: number): string =>
  Number(BigDecimal.format(value)).toFixed(digits);

const Locales = ({ dates }: { readonly dates: DateFormatting }) => {
  const current = useValue(dates.$locale);
  return (
    <p>
      dates:{" "}
      {locales.map((locale) => (
        <button
          key={locale}
          type="button"
          aria-pressed={current === locale}
          onClick={() => dates.setLocale(locale)}
        >
          {locale}
        </button>
      ))}
    </p>
  );
};

const Price = memo(function Price({ $rates }: { readonly $rates: Box<Rates> }) {
  const renders = useRenders();
  const price = useSelect((read) => read($rates)["BTC"]?.["USDT"]?.price);
  return (
    <p>
      BTC/USDT <strong>{price?.toFixed(2)}</strong> <Renders count={renders} />
    </p>
  );
});

/** Memoized: renders again only for a new position instance or a change it reads. */
const PositionRow = memo(function PositionRow({
  position,
  $rates,
}: {
  readonly position: Position;
  readonly $rates: Box<Rates>;
}) {
  const renders = useRenders();
  const openedAt = useSelect((read) => position.openedAtFormatted(read));
  const nextOrFinished = useSelect((read) =>
    position.isOpen
      ? `next funding ${position.nextFundingAtFormatted(read)}`
      : `closed ${position.closedAtFormatted(read)}`,
  );
  const pnl = useSelect((read) => {
    const projection = position.calculate(read($rates));
    return projection === undefined
      ? "—"
      : `${decimal(projection.profit, 2)} ${position.collateralTicker} (${decimal(projection.percent, 2)}%)`;
  });
  return (
    <li>
      <span>
        <strong>{position.id}</strong> · {position.isShort ? "short" : "long"} ×{position.leverage}{" "}
        · from {decimal(position.entryPrice, 2)}
        <br />
        <span className="muted">
          opened {openedAt} · {nextOrFinished}
        </span>
      </span>
      <span>
        {pnl} <Renders count={renders} />
      </span>
    </li>
  );
});

/**
 * One key of the collection: re-renders when that key's position is replaced
 * or removed, and on no other key's change.
 */
const PositionById = memo(function PositionById({
  positions,
  id,
  $rates,
}: {
  readonly positions: Positions;
  readonly id: string;
  readonly $rates: Box<Rates>;
}) {
  const position = useValue(positions.getById(id));
  return position === undefined ? null : <PositionRow position={position} $rates={$rates} />;
});

/** Reads only the keys: re-renders when a position is added, removed, or moved. */
const PositionList = memo(function PositionList({
  positions,
  $rates,
}: {
  readonly positions: Positions;
  readonly $rates: Box<Rates>;
}) {
  const renders = useRenders();
  const ids = useValue(positions.$items.keys);
  return (
    <>
      <p className="muted">
        list <Renders count={renders} />
      </p>
      <ul>
        {ids.map((id) => (
          <PositionById key={id} positions={positions} id={id} $rates={$rates} />
        ))}
      </ul>
    </>
  );
});

export const PositionsExample = ({ realm }: { readonly realm: Realm }) => {
  // The host builds the context once; the list and every update decode with it.
  const [dates] = useState(() => new DateFormatting(realm));
  const [context] = useState(() => Context.make(Dates, dates));
  const [positions] = useState(() => Model.decode(realm, Positions, context)(positionsJson));
  const [$rates] = useState(() =>
    Box.schema(realm, Rates, Model.decode(realm, Rates)(ratesJson(101))),
  );
  const [live, setLive] = useState(true);
  const next = useRef(1);
  const [encoded, setEncoded] = useState<string>();

  // The mocked rate feed: a random walk, decoded like any server message.
  useEffect(() => {
    if (!live) {
      return;
    }
    const timer = setInterval(() => {
      const price = Realm.untracked(realm, (read) => read($rates)["BTC"]?.["USDT"]?.price ?? 101);
      const rates = Model.decode(
        realm,
        Rates,
      )(ratesJson(Math.round((price + Math.random() - 0.5) * 100) / 100));
      Realm.update(realm, (_read, write) => {
        write($rates, rates);
      });
    }, 500);
    return () => clearInterval(timer);
  }, [live, realm, $rates]);

  /** What a host does with one message of the update stream. */
  const apply = (message: unknown): void => {
    const update = Model.decode(realm, PositionUpdate, context)(message);
    if (update.type === "upsert") {
      positions.upsert(update.position);
    } else {
      positions.remove(update.id);
    }
  };

  const first = () => Realm.untracked(realm, (read) => read(positions.$items.keys)[0]);

  return (
    <section>
      <h2>Positions · a keyed list from the server</h2>
      <p className="muted">
        <code>decode(realm, Positions, Context.make(Dates, dates))(json)</code>: decimals and dates
        decode from strings, every position formats its dates with the caller's formatter, and PnL
        follows the rate feed.
      </p>
      <Locales dates={dates} />
      <Price $rates={$rates} />
      <p>
        <button type="button" aria-pressed={live} onClick={() => setLive(!live)}>
          rate feed {live ? "on" : "off"}
        </button>{" "}
        <button
          type="button"
          onClick={() =>
            apply({
              type: "upsert",
              position: livePositionJson({
                id: `position-new-${next.current++}`,
                openedAt: new Date().toISOString(),
              }),
            })
          }
        >
          server: open
        </button>{" "}
        <button
          type="button"
          onClick={() => {
            const id = first();
            if (id !== undefined) {
              apply({ type: "upsert", position: livePositionJson({ id, leverage: 5 }) });
            }
          }}
        >
          server: update first ×5
        </button>{" "}
        <button
          type="button"
          onClick={() => {
            const id = first();
            if (id !== undefined) {
              apply({ type: "delete", id });
            }
          }}
        >
          server: delete first
        </button>{" "}
        <button
          type="button"
          onClick={() =>
            setEncoded(JSON.stringify(Schema.encodeSync(Positions)(positions), null, 2))
          }
        >
          encode
        </button>
      </p>
      <PositionList positions={positions} $rates={$rates} />
      <details>
        <summary>wire JSON in</summary>
        <pre>{JSON.stringify(positionsJson, null, 2)}</pre>
      </details>
      {encoded !== undefined && (
        <>
          <p className="muted">encoded out: no dates field</p>
          <pre>{encoded}</pre>
        </>
      )}
    </section>
  );
};
