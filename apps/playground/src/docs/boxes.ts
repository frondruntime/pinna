// The site's docs print the regions of this file (docs/public/state/boxes.md), so
// `bun run typecheck` compiles what the pages show.
import {
  box,
  type Computed,
  computed,
  computedFunction,
  createRealm,
  Model,
  type Realm,
  update,
} from "@frondruntime/pinna";

// #region box
const realm = createRealm();

const $price = box(realm, 10, { name: "price" });
const $tags = box(realm, ["sale"], { name: "tags" });
// #endregion

// #region equals
// A write within a cent of the current value notifies nobody.
const $total = box(realm, 0, {
  equals: (previous, next) => Math.abs(previous - next) < 0.01,
});
// #endregion

// #region computed
const $count = computed(realm, (read) => read($tags).length, { name: "count" });

// A computed value reads other computed values the same way.
const $label = computed(realm, (read) => `${read($count)} tags at ${read($price)}`);
// #endregion

// #region computedFunction
const hasTag = computedFunction(realm, (read, tag: string) => read($tags).includes(tag));

// While something observes hasTag("sale"), a call with "sale" returns that same
// computed value; nothing observes this one, so a later call makes a new one.
const $onSale = hasTag("sale");
// #endregion

// #region model
// A model groups boxes and the methods that write them. `Model` checks
// nothing and gives field initializers `this.realm`.
class Basket extends Model {
  readonly $quantity = box(this.realm, 1, { name: "quantity" });
  readonly $unitPrice = box(this.realm, 10, { name: "unitPrice" });
  readonly $total = computed(this.realm, (read) => read(this.$quantity) * read(this.$unitPrice));

  add(count: number): void {
    update(this.realm, (read, write) => write(this.$quantity, read(this.$quantity) + count));
  }
}

const basket = new Basket(realm);
basket.add(2);
// #endregion

// #region constructorInput
class Shelf extends Model {
  readonly $count = box(this.realm, 0);
  // An option is read as the computed value is made. A field initializer runs
  // before `title` is set, so this field is made in the constructor body.
  readonly $label: Computed<string>;

  constructor(
    realm: Realm,
    readonly title: string,
  ) {
    super(realm);
    // The function runs on the first read, after the constructor, so a field
    // initializer's function may read `this.title` too.
    this.$label = computed(realm, (read) => `${this.title}: ${read(this.$count)}`, {
      name: `${title}.label`,
    });
  }
}

const shelf = new Shelf(realm, "Books");

// #endregion

export { $label, $onSale, $total, basket, Shelf, shelf };
