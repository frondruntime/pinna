/**
 * The MobX store: a `Market` of `Instrument`s whose writes are actions, so a
 * write notifies once, when the outer-most action ends.
 *
 * Followed: https://mobx.js.org/observable-state.html (what to annotate),
 * https://mobx.js.org/actions.html (writes in actions), and the model's notes
 * in `model.ts`. Nothing is formatted here: a component formats what it
 * reads, and `shownRow` and `shownDetails` read as the components do.
 */
import { detailsTexts, rowTexts } from "../data/format.ts";
import type { Store } from "../harness/store.ts";
import { Market } from "./model.ts";

export const makeMobxStore = () => {
  const market = new Market();

  const store: Store = {
    load: (rows) => market.load(rows),
    tick: (ticks) => market.tick(ticks),
    replace: (rows) => market.load(rows),
    merge: (rows) => market.merge(rows),
    insert: (rows) => market.insert(rows),
    remove: (ids) => market.remove(ids),
    select: (id) => market.select(id),
    size: () => market.items.length,
    idAt: (index) => (market.items[index] as { readonly id: string }).id,
    shownRow: (id) => {
      const item = market.byId.get(id);
      return item === undefined ? undefined : rowTexts(item);
    },
    shownDetails: (id) => {
      const item = market.byId.get(id);
      return item === undefined ? undefined : detailsTexts(item);
    },
  };

  return { market, store };
};
