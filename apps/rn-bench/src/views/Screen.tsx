/**
 * The list every variant renders: a LegendList with the same props in each,
 * so the virtualization is the same and only the items differ. A variant
 * builds its own row and details components, as its library's documentation
 * writes them, over the shared views in `RowView.tsx` and `DetailsView.tsx`,
 * so the pixels are the same.
 *
 * Every component that renders a value from the store calls `mark()` from
 * `../harness/probe.ts` in its render, down to the smallest reactive leaf:
 * the harness finds when a screen settles by counting those calls, and a
 * leaf that updates without one would end the measure early.
 */
import { LegendList } from "@legendapp/list/react-native";
import type { ReactElement } from "react";
import { mark } from "../harness/probe.ts";
import { rowHeight } from "./RowView.tsx";

export function RowList<Item>({
  data,
  renderItem,
  keyExtractor,
}: {
  readonly data: ReadonlyArray<Item>;
  readonly renderItem: (props: { readonly item: Item }) => ReactElement | null;
  readonly keyExtractor: (item: Item) => string;
}) {
  // The list counts its own renders, so a list write that mounts no row in
  // view still holds the settle open, the same in every variant.
  mark();
  return (
    <LegendList
      data={data}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      estimatedItemSize={rowHeight}
    />
  );
}
