import { describe, expect, test } from "bun:test";
import * as Plain from "@frondruntime/pinna";
import { Schema, SchemaIssue } from "effect";
import {
  type Box,
  BoxField,
  box,
  type Collection,
  CollectionField,
  collection,
  computed,
  createRealm,
  decode,
  Model,
  type Realm,
  SchemaModel,
  schemaBox,
  untracked,
  update,
  watch,
} from "../src/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * Plain and schema names side by side, imported from this package alone: a
 * plain `box` or `Model` checks nothing, a `schemaBox` or `SchemaModel`
 * checks its schema, and either kind holds the other.
 */

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

class Row extends SchemaModel<Row>("MixRow")({
  id: Schema.String,
  $price: BoxField(Schema.Number.check(Schema.isGreaterThan(0))),
}) {
  readonly $double = computed(this.realm, (read) => read(this.$price) * 2);
}

class Book extends SchemaModel<Book>("MixBook")({
  name: Schema.String,
  $rows: CollectionField(Row, { keyOf: (row) => row.id }),
}) {}

/** A plain model: one box that checks nothing, one that checks a schema, and a collection of rows. */
class Desk extends Model {
  readonly $note = box(this.realm, "");
  readonly $limit = schemaBox(this.realm, Schema.Number.check(Schema.isGreaterThan(0)), 10);
  readonly $rows = collection<string, Row>(this.realm, { keyOf: (row) => row.id });
}

const readOf = <Value>(realm: Realm, $box: Box<Value>): Value =>
  untracked(realm, (read) => read($box));

const thrownBy = (run: () => unknown): Error => {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a throw");
};

describe("one import", () => {
  test("a name pinna exports is pinna's own value, and its type is pinna's type", () => {
    expect(box).toBe(Plain.box);
    expect(collection).toBe(Plain.collection);
    expect(Model).toBe(Plain.Model);
    const sameTypes: [
      Same<Box<number>, Plain.Box<number>>,
      Same<Collection<string, Row>, Plain.Collection<string, Row>>,
      Same<Realm, Plain.Realm>,
    ] = [true, true, true];
    expect(sameTypes).toEqual([true, true, true]);
  });
});

describe("a plain model holding schema values", () => {
  test("its schemaBox rejects a write and rolls back the plain write in the same update", () => {
    const desk = new Desk(createRealm());
    const { realm } = desk;
    expect(() =>
      update(realm, (_read, write) => {
        write(desk.$note, "edited");
        write(desk.$limit, -1);
      }),
    ).toThrow();
    expect(readOf(realm, desk.$note)).toBe("");
    expect(readOf(realm, desk.$limit)).toBe(10);
    expectRealmAtRest(realm);
  });

  test("an update that writes both kinds runs a watcher once", () => {
    const desk = new Desk(createRealm());
    const { realm } = desk;
    const seen: Array<string> = [];
    const stop = watch(
      realm,
      (read) => `${read(desk.$note)} ${read(desk.$limit)}`,
      (value) => {
        seen.push(value);
      },
    );
    update(realm, (_read, write) => {
      write(desk.$note, "a");
      write(desk.$limit, 20);
    });
    expect(seen).toEqual(["a 20"]);
    stop();
  });

  test("its plain collection holds decoded rows, whose boxes still check their schema", () => {
    const desk = new Desk(createRealm());
    const { realm } = desk;
    const [first] = decode(realm, Schema.Array(Row))([{ id: "a", price: 1 }]);
    const row = first as Row;
    update(realm, (_read, write) => {
      write.upsert(desk.$rows, row);
    });
    expect(untracked(realm, (read) => read(desk.$rows.row("a"))?.id)).toBe("a");
    expect(() =>
      update(realm, (_read, write) => {
        write(row.$price, 0);
      }),
    ).toThrow();
    expect(readOf(realm, row.$price)).toBe(1);
  });

  test("a schemaBox compares with its schema, a plain box with Object.is", () => {
    const realm = createRealm();
    const $plain = box(realm, { at: 1 });
    const $checked = schemaBox(realm, Schema.Struct({ at: Schema.Number }), { at: 1 });
    const seen: Array<string> = [];
    const stops = [
      watch(
        realm,
        (read) => read($plain),
        () => {
          seen.push("plain");
        },
      ),
      watch(
        realm,
        (read) => read($checked),
        () => {
          seen.push("checked");
        },
      ),
    ];
    update(realm, (_read, write) => {
      write($plain, { at: 1 });
      write($checked, { at: 1 });
    });
    expect(seen).toEqual(["plain"]);
    for (const stop of stops) {
      stop();
    }
  });

  test("a draft leaves a model instance read-only", () => {
    const realm = createRealm();
    const desk = new Desk(realm);
    const $desks = box(realm, [desk]);
    update(realm, (_read, write) => {
      write.modify($desks, (desks) => {
        // @ts-expect-error A model's fields are read-only in a draft.
        desks[0].realm = createRealm();
        return undefined;
      });
    });
  });
});

describe("a schema model holding plain values", () => {
  test("a plain box holds a schema model instance and compares it by identity", () => {
    const realm = createRealm();
    const row = Row.make({ id: "a", price: 1, realm });
    const $current = box(realm, row);
    let runs = 0;
    const stop = watch(
      realm,
      (read) => read($current),
      () => {
        runs++;
      },
    );
    update(realm, (_read, write) => {
      write($current, Row.make({ id: "a", price: 1, realm }));
    });
    expect(runs).toBe(1);
    stop();
  });

  test("a plain box in the class body checks nothing, beside a BoxField that checks, and stays off the wire", () => {
    class Quote extends SchemaModel<Quote>("MixQuote")({
      id: Schema.String,
      $price: BoxField(Schema.Number.check(Schema.isGreaterThan(0))),
    }) {
      readonly $last = box(this.realm, 0);
    }
    const realm = createRealm();
    const made = Quote.make({ id: "a", price: 1, realm });
    const decoded = decode(realm, Quote)({ id: "b", price: 2 });
    for (const quote of [made, decoded]) {
      update(realm, (_read, write) => {
        write(quote.$last, -5);
      });
      expect(readOf(realm, quote.$last)).toBe(-5);
      const before = readOf(realm, quote.$price);
      expect(
        thrownBy(() =>
          update(realm, (_read, write) => {
            write(quote.$price, -5);
          }),
        ).message,
      ).toContain("the box rejects this value");
      expect(readOf(realm, quote.$price)).toBe(before);
      expect(Schema.encodeSync(Quote)(quote)).toEqual({ id: quote.id, price: before });
    }
    expectRealmAtRest(realm);
  });

  test("a plain box seeded from a decoded field: the field is checked once, the box never", () => {
    class Offer extends SchemaModel<Offer>("MixOffer")({
      id: Schema.String,
      price: Schema.Number.check(Schema.isGreaterThan(0)),
    }) {
      readonly $price = box(this.realm, this.price);
    }
    const realm = createRealm();
    expect(() => decode(realm, Offer)({ id: "a", price: -1 })).toThrow();
    const offer = decode(realm, Offer)({ id: "a", price: 2 });
    expect(readOf(realm, offer.$price)).toBe(2);
    update(realm, (_read, write) => {
      write(offer.$price, -5);
    });
    expect(readOf(realm, offer.$price)).toBe(-5);
    expect(offer.price).toBe(2);
    expect(Schema.encodeSync(Offer)(offer)).toEqual({ id: "a", price: 2 });
  });

  test("a schema collection holds rows of another realm: the check is per instance", () => {
    const realm = createRealm();
    const other = createRealm();
    const foreign = Row.make({ id: "a", price: 1, realm: other });
    const book = Book.make({ name: "b", rows: [foreign], realm });
    expect(untracked(realm, (read) => read(book.$rows.row("a")))).toBe(foreign);
    expect(foreign.realm).toBe(other);
  });
});

describe("a schema model's own rules", () => {
  test("make takes values under wire keys: a box is rejected under either key", () => {
    const realm = createRealm();
    const $price = box(realm, 1);
    // @ts-expect-error price takes a number, not a box.
    expect(() => Row.make({ id: "a", price: $price, realm })).toThrow("Schema validation failed");
    // @ts-expect-error $price is not an input of make.
    expect(() => Row.make({ id: "a", price: 1, $price, realm })).toThrow(
      'MixRow.make takes the value of $price under "price"',
    );
  });

  test("a $ field cannot be reassigned", () => {
    const realm = createRealm();
    const row = Row.make({ id: "a", price: 1, realm });
    expect(() => {
      // @ts-expect-error A $ field is read-only.
      row.$price = box(realm, 2);
    }).toThrow();
  });

  test("a schema model takes no extend, mapFields, makeOption, or makeEffect", () => {
    // @ts-expect-error extend is not supported.
    expect(() => Row.extend("More")({})).toThrow("MixRow.extend is not supported");
    // @ts-expect-error mapFields is not supported.
    expect(() => Row.mapFields((fields: unknown) => fields)).toThrow(
      "MixRow.mapFields is not supported",
    );
    // @ts-expect-error makeOption is not supported.
    expect(() => Row.makeOption({})).toThrow("MixRow.makeOption is not supported");
    // @ts-expect-error makeEffect is not supported.
    expect(() => Row.makeEffect({})).toThrow("MixRow.makeEffect is not supported");
  });

  test("decode, write, and encode round-trip through both kinds of field", () => {
    const realm = createRealm();
    const wire = { name: "b", rows: [{ id: "a", price: 1 }] };
    const book = decode(realm, Book)(wire);
    const row = untracked(realm, (read) => read(book.$rows.row("a"))) as Row;
    update(realm, (_read, write) => {
      write(row.$price, 3);
    });
    expect(untracked(realm, (read) => read(row.$double))).toBe(6);
    expect(Schema.encodeSync(Book)(book)).toEqual({ name: "b", rows: [{ id: "a", price: 3 }] });
  });

  test("another schema's make throws for a plain object holding a box of another realm", () => {
    const realm = createRealm();
    const $price = schemaBox(createRealm(), Schema.Number, 1);
    const Holder = Schema.Struct({ row: Row });
    const row = { id: "a", $price, realm } as unknown as Row;
    const failure = thrownBy(() => Holder.make({ row }));
    expect(SchemaIssue.makeFormatterDefault()(failure.cause as SchemaIssue.Issue)).toContain(
      "a MixRow field of another schema takes an instance",
    );
  });

  test("make checks a box's first value under disableChecks, which skips only plain fields' checks", () => {
    const realm = createRealm();
    expect(() => Row.make({ id: "a", price: -1, realm }, { disableChecks: true })).toThrow(
      "Schema validation failed",
    );
    const Checked = Schema.String.check(Schema.isMinLength(2));
    class Tagged extends SchemaModel<Tagged>("MixTagged")({
      tag: Checked,
      $price: BoxField(Schema.Number.check(Schema.isGreaterThan(0))),
    }) {}
    const tagged = Tagged.make({ tag: "x", price: 1, realm }, { disableChecks: true });
    expect(tagged.tag).toBe("x");
    expect(untracked(realm, (read) => read(tagged.$price))).toBe(1);
  });
});
