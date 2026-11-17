/**
 * The Legend State variant, written with the React tools Legend State 3
 * documents:
 *
 * - `useValue` for a component's read, "the default way to consume
 *   observables" since `useSelector` was renamed,
 *   https://legendapp.com/open-source/state/v3/react/react-api/ and
 *   https://legendapp.com/open-source/state/v3/other/migrating/. The list
 *   reads the ids, a row reads its rest, the details read the open id.
 * - `Memo` for each tick cell: a function child in its own tracking context,
 *   so a tick renders the cell and not the row, "when children are truly
 *   independent from the parent component",
 *   https://legendapp.com/open-source/state/v3/react/fine-grained-reactivity/.
 *   A `Memo` cell is chosen over a reactive `$Text` because the shared
 *   `RowView` already wraps each field in a `Text`; the cell's string lands
 *   in it with no second text node.
 * - The history is never written, so it stays in the opaque rest and renders
 *   through `HistoryView` with the details. `For` (with `optimized`) renders
 *   an observable array item by item; the history would have to leave the
 *   opaque rest to become one, making reactive what the app never writes.
 *   The history is replaced only with its row, which renders the details
 *   again anyway.
 * - No global configuration: reactive components are imported per
 *   component on React Native rather than enabled globally (migrating
 *   guide), and none is needed here.
 *
 * Every component that reads the store calls `mark()`, and so does each
 * `Memo` function; `RowList`, `RowView`, `DetailsView`, and `HistoryView`
 * count their own renders too, so a row's render counts twice, the list's
 * read and its `RowList` count twice, and a close that renders nothing still
 * counts. A row's component holds one id for life: `RowList` does not
 * recycle items (`recycleItems` defaults to false in
 * `node_modules/@legendapp/list`), so a cell's function, fixed when the cell
 * mounts, always reads its own row.
 */
import type { Observable } from "@legendapp/state";
import { Memo, useValue } from "@legendapp/state/react";
import { memo } from "react";
import { ago, compact, day, fixed, historyTexts, percent, statusLabel } from "../data/format.ts";
import { mark } from "../harness/probe.ts";
import type { Variant } from "../harness/store.ts";
import { DetailsView, HistoryView } from "../views/DetailsView.tsx";
import { RowView } from "../views/RowView.tsx";
import { RowList } from "../views/Screen.tsx";
import { type LegendRow, makeLegendStore } from "./store.ts";

type Row$ = Observable<LegendRow> | undefined;

function Price({ row$ }: { readonly row$: Row$ }) {
  return (
    <Memo>
      {() => {
        mark();
        const price = row$?.price.get();
        return price === undefined ? null : fixed(price, 2);
      }}
    </Memo>
  );
}

function Change({ row$ }: { readonly row$: Row$ }) {
  return (
    <Memo>
      {() => {
        mark();
        const price = row$?.price.get();
        const diff24 = row$?.diff24.get();
        return price === undefined || diff24 === undefined ? null : percent(price, diff24);
      }}
    </Memo>
  );
}

function Updated({ row$ }: { readonly row$: Row$ }) {
  return (
    <Memo>
      {() => {
        mark();
        const updatedAt = row$?.updatedAt.get();
        return updatedAt === undefined ? null : ago(updatedAt);
      }}
    </Memo>
  );
}

const make = () => {
  const { ids$, rows$, selected$, store } = makeLegendStore();

  const Row = memo(function Row({ id }: { readonly id: string }) {
    mark();
    const row$ = rows$[id];
    const rest = useValue(() => row$?.rest.get());
    if (rest === undefined) {
      return null;
    }
    return (
      <RowView
        fields={{
          ticker: rest.ticker,
          name: rest.name,
          price: <Price row$={row$} />,
          change: <Change row$={row$} />,
          volume: compact(rest.volume),
          updated: <Updated row$={row$} />,
          status: statusLabel(rest.status),
        }}
        onPress={() => store.select(id)}
      />
    );
  });

  const renderItem = ({ item }: { readonly item: string }) => <Row id={item} />;
  const keyOf = (id: string) => id;

  // Reads the list and renders nothing else.
  function List() {
    mark();
    const ids = useValue(ids$);
    return <RowList data={ids} renderItem={renderItem} keyExtractor={keyOf} />;
  }

  function Opened({ id }: { readonly id: string }) {
    mark();
    const row$ = rows$[id];
    const rest = useValue(() => row$?.rest.get());
    if (rest === undefined) {
      return null;
    }
    return (
      <DetailsView
        fields={{
          ticker: rest.ticker,
          name: rest.name,
          status: statusLabel(rest.status),
          price: <Price row$={row$} />,
          change: <Change row$={row$} />,
          volume: compact(rest.volume),
          updated: <Updated row$={row$} />,
          listed: day(rest.listedAt),
          tags: rest.tags.join(", "),
          network: rest.network.name,
          contract: rest.network.contract,
          decimals: String(rest.network.decimals),
          limits: `${fixed(rest.limits.min, 4)} – ${fixed(rest.limits.max, 2)}`,
        }}
        history={<HistoryView points={historyTexts(rest.history)} />}
        onClose={() => store.select(undefined)}
      />
    );
  }

  function Details() {
    mark();
    const id = useValue(selected$);
    return id === undefined ? null : <Opened key={id} id={id} />;
  }

  const Screen = () => (
    <>
      <List />
      <Details />
    </>
  );

  return { store, Screen };
};

export const legendVariant: Variant = { name: "legend", make };
