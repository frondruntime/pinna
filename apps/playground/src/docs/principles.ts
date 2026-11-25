// The site's docs print the region of this file (docs/public/start/principles.md), so
// `bun run typecheck` compiles what the page shows. The comment on `$broken` names the error
// `bun run typecheck` reports for it once its `@ts-expect-error` is removed.
import { Box, Computed, Realm } from "@frondruntime/pinna";

// #region read
const realm = Realm.make();
const $price = Box.make(realm, 12);
const $quantity = Box.make(realm, 3);

// Each read(...) returns the value and subscribes $total to that box.
const $total = Computed.make(realm, (read) => read($price) * read($quantity));

// The same value without read does not compile. A box is not a number:
// error TS2362, the left-hand side of an arithmetic operation must be a number.
// @ts-expect-error the page prints this error
const $broken = Computed.make(realm, () => $price * $quantity);

// #endregion

export { $broken, $total };
