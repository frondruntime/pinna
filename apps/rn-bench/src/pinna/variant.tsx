/**
 * The Pinna screen: each component reads the observables it shows with
 * `useValue` or `useValues`, under `memo`, so a write rerenders only the
 * components that read what changed.
 *
 * Followed:
 * - packages/pinna/AGENTS.md, "In a component": `useValue($x)` for one
 *   observable, `useValues([$a, $b])` for several, `useSelect` only for view
 *   logic over several observables since it costs a layout effect per
 *   render; no `observer`; to rerender less, move the read into a small
 *   component under `memo`.
 * - docs/public/react/hooks.md: `useValues` returns a typed array that
 *   keeps its identity until a value changes; `RealmProvider` gives
 *   components a realm.
 * - apps/playground/src/positions-view.tsx, the official example of a keyed
 *   list: the list reads `$items.keys` alone, one memoized component per key
 *   reads `getById(id)` (a collection's `row(key)`) and hands the instance
 *   to a memoized row component.
 */
import { RealmProvider, useValue, useValues } from "@frondruntime/pinna-react";
import { memo, useCallback } from "react";
import { ago, compact, day, fixed, historyTexts, percent, statusLabel } from "../data/format.ts";
import { mark } from "../harness/probe.ts";
import type { Variant } from "../harness/store.ts";
import { DetailsView, HistoryView } from "../views/DetailsView.tsx";
import { RowView } from "../views/RowView.tsx";
import { RowList } from "../views/Screen.tsx";
import { type Instrument, type Market, makePinnaStore } from "./store.ts";

// The fields a tick writes, each read by its own small component under
// `memo`, so a tick rerenders the cell that shows it and not the row.

const Price = memo(function Price({ instrument }: { readonly instrument: Instrument }) {
  mark();
  return fixed(useValue(instrument.$price), 2);
});

const Change = memo(function Change({ instrument }: { readonly instrument: Instrument }) {
  mark();
  const [price, diff24] = useValues([instrument.$price, instrument.$diff24]);
  return percent(price, diff24);
});

const Updated = memo(function Updated({ instrument }: { readonly instrument: Instrument }) {
  mark();
  return ago(useValue(instrument.$updatedAt));
});

/** One row: renders once per instance; its tick cells rerender on a tick. */
const InstrumentRow = memo(function InstrumentRow({
  market,
  instrument,
}: {
  readonly market: Market;
  readonly instrument: Instrument;
}) {
  return (
    <RowView
      fields={{
        ticker: instrument.ticker,
        name: instrument.name,
        price: <Price instrument={instrument} />,
        change: <Change instrument={instrument} />,
        volume: compact(instrument.volume),
        updated: <Updated instrument={instrument} />,
        status: statusLabel(instrument.status),
      }}
      onPress={() => market.select(instrument.id)}
    />
  );
});

/** One key of the list: rerenders when its row is replaced or removed. */
const RowById = memo(function RowById({
  market,
  id,
}: {
  readonly market: Market;
  readonly id: string;
}) {
  mark();
  const instrument = useValue(market.$rows.row(id));
  return instrument === undefined ? null : (
    <InstrumentRow market={market} instrument={instrument} />
  );
});

const keyOf = (id: string): string => id;

/** Reads only the keys: rerenders when a row is added, removed, or moved. */
const List = memo(function List({ market }: { readonly market: Market }) {
  const ids = useValue(market.$rows.keys);
  const renderItem = useCallback(
    ({ item }: { readonly item: string }) => <RowById market={market} id={item} />,
    [market],
  );
  return <RowList data={ids} renderItem={renderItem} keyExtractor={keyOf} />;
});

/** The history a tick never writes: renders once per row instance. */
const History = memo(function History({ instrument }: { readonly instrument: Instrument }) {
  return <HistoryView points={historyTexts(instrument.history)} />;
});

const InstrumentDetails = memo(function InstrumentDetails({
  market,
  instrument,
}: {
  readonly market: Market;
  readonly instrument: Instrument;
}) {
  return (
    <DetailsView
      fields={{
        ticker: instrument.ticker,
        name: instrument.name,
        status: statusLabel(instrument.status),
        price: <Price instrument={instrument} />,
        change: <Change instrument={instrument} />,
        volume: compact(instrument.volume),
        updated: <Updated instrument={instrument} />,
        listed: day(instrument.listedAt),
        tags: instrument.tags.join(", "),
        network: instrument.network.name,
        contract: instrument.network.contract,
        decimals: String(instrument.network.decimals),
        limits: `${fixed(instrument.limits.min, 4)} – ${fixed(instrument.limits.max, 2)}`,
      }}
      history={<History instrument={instrument} />}
      onClose={() => market.select(undefined)}
    />
  );
});

const SelectedById = memo(function SelectedById({
  market,
  id,
}: {
  readonly market: Market;
  readonly id: string;
}) {
  mark();
  const instrument = useValue(market.$rows.row(id));
  return instrument === undefined ? null : (
    <InstrumentDetails market={market} instrument={instrument} />
  );
});

/** Reads only the open id. */
const Details = memo(function Details({ market }: { readonly market: Market }) {
  mark();
  const id = useValue(market.$selected);
  return id === undefined ? null : <SelectedById market={market} id={id} />;
});

const make = () => {
  const { market, store } = makePinnaStore();
  const Screen = () => (
    <RealmProvider realm={market.realm}>
      <List market={market} />
      <Details market={market} />
    </RealmProvider>
  );
  return { store, Screen };
};

export const pinnaVariant: Variant = { name: "pinna", make };
