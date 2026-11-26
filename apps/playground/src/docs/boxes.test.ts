/// <reference types="bun" />
// Backs the claims docs/public/state/boxes.md and README.md make about the
// samples in `boxes.ts`.
import { expect, test } from "bun:test";
import { Box, Computed, Model, Realm, Source } from "@frondruntime/pinna";
import { held } from "@frondruntime/pinna/testing";
import { Shelf } from "./boxes.ts";

test("an option made in the constructor body reads the constructor's parameter", () => {
  const realm = Realm.make();
  const shelf = new Shelf(realm, "Books");
  expect(Source.inspect(shelf.$label).name).toBe("Books.label");
  expect(Realm.untracked(realm, (read) => read(shelf.$label))).toBe("Books: 0");
});

test("a field initializer's option runs before a parameter property is set", () => {
  const compared: Array<string> = [];
  class Early extends Model.Class {
    readonly $count = Box.make(this.realm, 0);
    // @ts-expect-error TS2729: Property 'title' is used before its initialization.
    readonly $title = Box.make(this.realm, this.title);
    readonly $same = Computed.make(this.realm, (read) => read(this.$count), {
      equals: (previous, next) => {
        compared.push(this.title);
        return previous === next;
      },
    });
    // A field initializer's function reads `title` later, once it is set.
    readonly $label = Computed.make(this.realm, (read) => `${this.title}: ${read(this.$count)}`, {
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
  const realm = Realm.make();
  const early = new Early(realm, "Books");
  expect(Source.inspect(early.$label).name).toBeUndefined();
  expect(Realm.untracked(realm, (read) => read(early.$title))).toBeUndefined();
  expect(Realm.untracked(realm, (read) => read(early.$label))).toBe("Books: 0");
  // `equals` is a function, so it reads `title` when it compares, once it is set.
  using _ = held(Source.observe(early.$same));
  Realm.update(realm, (_read, write) => write(early.$count, 1));
  expect(Realm.untracked(realm, (read) => read(early.$same))).toBe(1);
  expect(compared).toEqual(["Books"]);
});

test("an equals that is itself a parameter property is read as the field is made", () => {
  class Compared extends Model.Class {
    readonly $count = Box.make<number>(this.realm, 0, {
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
  const realm = Realm.make();
  let compared = 0;
  const model = new Compared(realm, (previous, next) => {
    compared += 1;
    return previous === next;
  });
  Realm.update(realm, (_read, write) => write(model.$count, 1));
  expect(compared).toBe(0);
});
