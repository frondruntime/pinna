/** pinna's `View` module, with the scoped forms: `View.orderedScoped`, `View.groupedScoped`, and `View.totalsScoped`. */
import { View as PlainView, type ViewModule as PlainViewModule } from "@frondruntime/pinna";
import { groupedScoped, orderedScoped, totalsScoped } from "../view.ts";

export interface ViewModule extends PlainViewModule {
  /** `View.ordered`, disposed when the scope closes. */
  readonly orderedScoped: typeof orderedScoped;
  /** `View.grouped`, disposed when the scope closes. */
  readonly groupedScoped: typeof groupedScoped;
  /** `View.totals`, disposed when the scope closes. */
  readonly totalsScoped: typeof totalsScoped;
}

export const View: ViewModule = { ...PlainView, orderedScoped, groupedScoped, totalsScoped };
