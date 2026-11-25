/**
 * `View`: views a collection keeps up to date a row at a time. `View.ordered`
 * sorts and filters its keys, `View.grouped` indexes them by group, and
 * `View.totals` keeps a count and a total per group.
 */
import { dispose, grouped, ordered, status, totals } from "../view.ts";

export type {
  GroupedView,
  GroupedViewOptions,
  GroupTotal,
  OrderedView,
  OrderedViewOptions,
  TotalArithmetic,
  TotalsView,
  TotalsViewOptions,
  ViewStatus,
} from "../view.ts";

export interface ViewModule {
  /** Makes a sorted, filtered order of a collection's keys. */
  readonly ordered: typeof ordered;
  /** Makes an index of a collection's keys by group. */
  readonly grouped: typeof grouped;
  /** Makes a count and a total per group of a collection's rows. */
  readonly totals: typeof totals;
  /** Stops keeping a view up to date; disposing twice does nothing. */
  readonly dispose: typeof dispose;
  /** `"open"` or `"disposed"`. */
  readonly status: typeof status;
}

export const View: ViewModule = { ordered, grouped, totals, dispose, status };
