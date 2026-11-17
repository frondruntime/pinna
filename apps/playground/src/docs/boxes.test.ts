/// <reference types="bun" />
// Backs the claims docs/public/state/boxes.md and README.md make about the
// samples in `boxes.ts`.
import { expect, test } from "bun:test";
import {
  box,
  computed,
  createRealm,
  inspect,
  Model,
  observe,
  type Realm,
  untracked,
  update,
} from "@frondruntime/pinna";
import { held } from "@frondruntime/pinna/testing";
import { Shelf } from "./boxes.ts";

test("an option made in the constructor body reads the constructor's parameter", () => {
  const realm = createRealm();
  const shelf = new Shelf(realm, "Books");
  expect(inspect(shelf.$label).name).toBe("Books.label");
  expect(untracked(realm, (read) => read(shelf.$label))).toBe("Books: 0");
});

test("a field initializer's option runs before a parameter property is set", () => {
  const compared: Array<string> = [];
  class Early extends Model {
    readonly $count = box(this.realm, 0);
    // @ts-expect-error TS2729: Property 'title' is used before its initialization.
    readonly $title = box(this.realm, this.title);
    readonly $same = computed(this.realm, (read) => read(this.$count), {
      equals: (previous, next) => {
        compared.push(this.title);
        return previous === next;
      },
    });
    // A field initializer's function reads `title` later, once it is set.
    readonly $label = computed(this.realm, (read) => `${this.title}: ${read(this.$count)}`, {
      // @ts-expect-error TS2729: Property 'title' is used before its initialization.
      name: this.title,
    });

    constructor(
      realm: Realm,
      readonly title: string,
    ) {
      super(realm);
    }
  }
  const realm = createRealm();
  const early = new Early(realm, "Books");
  expect(inspect(early.$label).name).toBeUndefined();
  expect(untracked(realm, (read) => read(early.$title))).toBeUndefined();
  expect(untracked(realm, (read) => read(early.$label))).toBe("Books: 0");
  // `equals` is a function, so it reads `title` when it compares, once it is set.
  using _ = held(observe(early.$same));
  update(realm, (_read, write) => write(early.$count, 1));
  expect(untracked(realm, (read) => read(early.$same))).toBe(1);
  expect(compared).toEqual(["Books"]);
});

test("an equals that is itself a parameter property is read as the field is made", () => {
  class Compared extends Model {
    readonly $count = box<number>(this.realm, 0, {
      // @ts-expect-error TS2729: Property 'compare' is used before its initialization.
      equals: this.compare,
    });

    constructor(
      realm: Realm,
      readonly compare: (previous: number, next: number) => boolean,
    ) {
      super(realm);
    }
  }
  const realm = createRealm();
  let compared = 0;
  const model = new Compared(realm, (previous, next) => {
    compared += 1;
    return previous === next;
  });
  update(realm, (_read, write) => write(model.$count, 1));
  expect(compared).toBe(0);
});
