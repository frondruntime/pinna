/**
 * The MobX variant, with `observer` components as MobX's React guide writes
 * them: https://mobx.js.org/react-optimizations.html (use many small
 * components; render lists in dedicated components; dereference values late,
 * so a row gets the object and not its fields) and
 * node_modules/mobx-react-lite/README.md (`observer`, which also memoizes).
 *
 * The list is its own `observer` that renders only the list. A row gets its
 * `Instrument`, never an id to look up, and reads no tick field itself: the
 * price, the change, and the updated time are each a small `observer` that
 * dereferences its field, so a tick rerenders those cells and not the row.
 * Static fields are plain readonly properties, read without tracking.
 */
import { observer } from "mobx-react-lite";
import { ago, compact, day, fixed, historyTexts, percent, statusLabel } from "../data/format.ts";
import { mark } from "../harness/probe.ts";
import type { Variant } from "../harness/store.ts";
import { DetailsView, HistoryView } from "../views/DetailsView.tsx";
import { RowView } from "../views/RowView.tsx";
import { RowList } from "../views/Screen.tsx";
import type { Instrument } from "./model.ts";
import { makeMobxStore } from "./store.ts";

const Price = observer(function Price({ item }: { readonly item: Instrument }) {
  mark();
  return fixed(item.price, 2);
});

const Change = observer(function Change({ item }: { readonly item: Instrument }) {
  mark();
  return percent(item.price, item.diff24);
});

const Updated = observer(function Updated({ item }: { readonly item: Instrument }) {
  mark();
  return ago(item.updatedAt);
});

const History = observer(function History({ item }: { readonly item: Instrument }) {
  return <HistoryView points={historyTexts(item.history)} />;
});

const make = () => {
  const { market, store } = makeMobxStore();

  const Row = observer(function Row({ item }: { readonly item: Instrument }) {
    return (
      <RowView
        fields={{
          ticker: item.ticker,
          name: item.name,
          price: <Price item={item} />,
          change: <Change item={item} />,
          volume: compact(item.volume),
          updated: <Updated item={item} />,
          status: statusLabel(item.status),
        }}
        onPress={() => market.select(item.id)}
      />
    );
  });

  const renderItem = ({ item }: { readonly item: Instrument }) => <Row item={item} />;
  const keyOf = (item: Instrument) => item.id;

  // Reads the list and renders nothing else, as the guide asks of a list.
  const List = observer(function List() {
    return <RowList data={market.items.slice()} renderItem={renderItem} keyExtractor={keyOf} />;
  });

  const Opened = observer(function Opened({ item }: { readonly item: Instrument }) {
    return (
      <DetailsView
        fields={{
          ticker: item.ticker,
          name: item.name,
          status: statusLabel(item.status),
          price: <Price item={item} />,
          change: <Change item={item} />,
          volume: compact(item.volume),
          updated: <Updated item={item} />,
          listed: day(item.listedAt),
          tags: item.tags.join(", "),
          network: item.network.name,
          contract: item.network.contract,
          decimals: String(item.network.decimals),
          limits: `${fixed(item.limits.min, 4)} – ${fixed(item.limits.max, 2)}`,
        }}
        history={<History item={item} />}
        onClose={() => market.select(undefined)}
      />
    );
  });

  const Details = observer(function Details() {
    mark();
    const item = market.selected;
    return item === undefined ? null : <Opened item={item} />;
  });

  const Screen = () => (
    <>
      <List />
      <Details />
    </>
  );

  return { store, Screen };
};

export const mobxVariant: Variant = { name: "mobx", make };
