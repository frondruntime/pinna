/**
 * The scoped views: `View.orderedScoped`, `View.groupedScoped`, and
 * `View.totalsScoped` make a view and dispose it when the scope closes.
 */
import {
  type Collection,
  type GroupedView,
  type GroupedViewOptions,
  type OrderedView,
  type OrderedViewOptions,
  type TotalsView,
  type TotalsViewOptions,
  View,
} from "@frondruntime/pinna";
import { Effect, type Scope } from "effect";

/** `View.ordered` for the scope's length: closing the scope disposes the view. */
export const orderedScoped = <Key, Row>(
  source: Collection<Key, Row>,
  options: OrderedViewOptions<Key, Row>,
): Effect.Effect<OrderedView<Key>, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => View.ordered(source, options)),
    (view) => Effect.sync(() => View.dispose(view)),
  );

/** `View.grouped` for the scope's length: closing the scope disposes the view. */
export const groupedScoped = <Key, Row, Group>(
  source: Collection<Key, Row>,
  options: GroupedViewOptions<Key, Row, Group>,
): Effect.Effect<GroupedView<Key, Group>, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => View.grouped(source, options)),
    (view) => Effect.sync(() => View.dispose(view)),
  );

/** `View.totals` for the scope's length: closing the scope disposes the view. */
export const totalsScoped = <Key, Row, Group, Total>(
  source: Collection<Key, Row>,
  options: TotalsViewOptions<Key, Row, Group, Total>,
): Effect.Effect<TotalsView<Group, Total>, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => View.totals(source, options)),
    (view) => Effect.sync(() => View.dispose(view)),
  );
