// The site's docs print the regions of this file (docs/public/start/index.md), so
// `bun run typecheck` compiles what the pages show.
import { box, computed, createRealm, Model, untracked, update } from "@frondruntime/pinna";
import { useValue } from "@frondruntime/pinna-react";

// #region realm
const realm = createRealm();
// #endregion

// #region box
const $count = box(realm, 0, { name: "count" });
const $double = computed(realm, (read) => read($count) * 2, { name: "double" });
// #endregion

// #region update
const increment = () => {
  update(realm, (read, write) => {
    write($count, read($count) + 1);
  });
};
// #endregion

// #region component
function CounterButton() {
  const double = useValue($double);
  return (
    <button type="button" onClick={increment}>
      {double}
    </button>
  );
}
// #endregion

// #region model
class Counter extends Model {
  readonly $count = box(this.realm, 0, { name: "count" });
  readonly $double = computed(this.realm, (read) => read(this.$count) * 2, { name: "double" });

  increment(): void {
    update(this.realm, (read, write) => {
      write(this.$count, read(this.$count) + 1);
    });
  }
}
// #endregion

// #region test
const counter = new Counter(createRealm());
counter.increment();
const double = untracked(counter.realm, (read) => read(counter.$double)); // 2

// #endregion

export { CounterButton, double };
