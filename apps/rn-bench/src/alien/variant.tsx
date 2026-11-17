/**
 * The alien-signals variant. alien-signals has no React binding (README,
 * "Derived Projects", lists third-party ones; none is installed), so a small
 * hook wraps a component's read in a `computed` and subscribes to it with an
 * `effect` through `useSyncExternalStore`: the read reruns only when a signal
 * it read changed, and the component rerenders only when the result is a new
 * value.
 *
 * Followed:
 * - README "Basic APIs": `computed(() => ...)` is a cached derived value read
 *   by calling it; `effect(() => ...)` runs now and again when a signal it
 *   read changes, and returns the function that stops it.
 * - README "Effect Scope": not used. Each effect is stopped by the function
 *   `effect` returns, in the `useSyncExternalStore` unsubscribe; no scope
 *   groups them.
 * - Row, Details, and History are `memo` components over the shared views, so
 *   a row rerenders when its own row is replaced, not when the list does.
 * - The hook tracks raw values and the component formats them in its render,
 *   so a write does no formatting. The fields a tick writes are each read by
 *   a small cell, so a tick rerenders the cell and not the row, the same
 *   granularity as the MobX and Legend State variants.
 * - Upstream: https://github.com/stackblitz/alien-signals
 */
import { computed, effect } from "alien-signals";
import { memo, useCallback, useMemo, useSyncExternalStore } from "react";
import { ago, compact, day, fixed, historyTexts, percent, statusLabel } from "../data/format.ts";
import { mark } from "../harness/probe.ts";
import type { Variant } from "../harness/store.ts";
import { DetailsView, HistoryView } from "../views/DetailsView.tsx";
import { RowView } from "../views/RowView.tsx";
import { RowList } from "../views/Screen.tsx";
import { type AlienRow, makeAlienStore } from "./store.ts";

/** The value of `read`, rerendering when it changes. `source` is what `read` closes over. */
const useTracked = <Value,>(read: () => Value, source: unknown): Value => {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `source` is what `read` closes over.
  const value = useMemo(() => computed(read), [source]);
  const subscribe = useCallback(
    (notify: () => void) => {
      let first = true;
      return effect(() => {
        value();
        if (first) {
          first = false;
        } else {
          notify();
        }
      });
    },
    [value],
  );
  return useSyncExternalStore(subscribe, value, value);
};

const Price = memo(function Price({ row }: { readonly row: AlienRow }) {
  mark();
  return fixed(
    useTracked(() => row.price(), row),
    2,
  );
});

const Change = memo(function Change({ row }: { readonly row: AlienRow }) {
  mark();
  const price = useTracked(() => row.price(), row);
  const diff24 = useTracked(() => row.diff24(), row);
  return percent(price, diff24);
});

const Updated = memo(function Updated({ row }: { readonly row: AlienRow }) {
  mark();
  return ago(useTracked(() => row.updatedAt(), row));
});

const History = memo(function History({ row }: { readonly row: AlienRow }) {
  return <HistoryView points={historyTexts(row.history)} />;
});

const make = () => {
  const { keys, selected, slotOf, store } = makeAlienStore();

  const Row = memo(function Row({ id }: { readonly id: string }) {
    mark();
    const row = useTracked(() => slotOf(id)(), id);
    return row === undefined ? null : (
      <RowView
        fields={{
          ticker: row.ticker,
          name: row.name,
          price: <Price row={row} />,
          change: <Change row={row} />,
          volume: compact(row.volume),
          updated: <Updated row={row} />,
          status: statusLabel(row.status),
        }}
        onPress={() => store.select(id)}
      />
    );
  });

  const renderItem = ({ item }: { readonly item: string }) => <Row id={item} />;
  const keyOf = (id: string) => id;

  const List = memo(function List() {
    return (
      <RowList data={useTracked(() => keys(), keys)} renderItem={renderItem} keyExtractor={keyOf} />
    );
  });

  const Opened = memo(function Opened({ id }: { readonly id: string }) {
    mark();
    const row = useTracked(() => slotOf(id)(), id);
    return row === undefined ? null : (
      <DetailsView
        fields={{
          ticker: row.ticker,
          name: row.name,
          status: statusLabel(row.status),
          price: <Price row={row} />,
          change: <Change row={row} />,
          volume: compact(row.volume),
          updated: <Updated row={row} />,
          listed: day(row.listedAt),
          tags: row.tags.join(", "),
          network: row.network.name,
          contract: row.network.contract,
          decimals: String(row.network.decimals),
          limits: `${fixed(row.limits.min, 4)} – ${fixed(row.limits.max, 2)}`,
        }}
        history={<History row={row} />}
        onClose={() => store.select(undefined)}
      />
    );
  });

  const Details = memo(function Details() {
    mark();
    const id = useTracked(() => selected(), selected);
    return id === undefined ? null : <Opened id={id} />;
  });

  const Screen = () => (
    <>
      <List />
      <Details />
    </>
  );
  return { store, Screen };
};

export const alienVariant: Variant = { name: "alien", make };
