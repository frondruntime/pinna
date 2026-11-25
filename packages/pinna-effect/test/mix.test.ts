import { describe, expect, test } from "bun:test";
import * as Plain from "@frondruntime/pinna";
import { Schema, SchemaIssue } from "effect";
import { Box, Collection, Computed, Model, Realm } from "../src/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * Plain and schema names side by side, imported from this package alone: a
 * plain `Box.make` or `Model` checks nothing, a `Box.schema` or `Model.Schema`
 * checks its schema, and either kind holds the other.
 */

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

class Row extends Model.Schema<Row>("MixRow")({
  id: Schema.String,
  $price: Model.boxField(Schema.Number.check(Schema.isGreaterThan(0))),
}) {
  readonly $double = Computed.make(this.realm, (read) => read(this.$price) * 2);
}

class Book extends Model.Schema<Book>("MixBook")({
  name: Schema.String,
  $rows: Model.collectionField(Row, { keyOf: (row) => row.id }),
}) {}

/** A plain model: one box that checks nothing, one that checks a schema, and a collection of rows. */
class Desk extends Model.Class {
  readonly $note = Box.make(this.realm, "");
  readonly $limit = Box.schema(this.realm, Schema.Number.check(Schema.isGreaterThan(0)), 10);
  readonly $rows = Collection.make<string, Row>(this.realm, { keyOf: (row) => row.id });
}

const readOf = <Value>(realm: Realm, $box: Box<Value>): Value =>
  Realm.untracked(realm, (read) => read($box));

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
    expect(Box.make).toBe(Plain.Box.make);
    expect(Collection.make).toBe(Plain.Collection.make);
    expect(Model.Class).toBe(Plain.Model.Class);
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
    const desk = new Desk(Realm.make());
    const { realm } = desk;
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write(desk.$note, "edited");
        write(desk.$limit, -1);
      }),
    ).toThrow();
    expect(readOf(realm, desk.$note)).toBe("");
    expect(readOf(realm, desk.$limit)).toBe(10);
    expectRealmAtRest(realm);
  });

  test("an update that writes both kinds runs a watcher once", () => {
    const desk = new Desk(Realm.make());
    const { realm } = desk;
    const seen: Array<string> = [];
    const stop = Realm.watch(
      realm,
      (read) => `${read(desk.$note)} ${read(desk.$limit)}`,
      (value) => {
        seen.push(value);
      },
    );
    Realm.update(realm, (_read, write) => {
      write(desk.$note, "a");
      write(desk.$limit, 20);
    });
    expect(seen).toEqual(["a 20"]);
    stop();
  });

  test("its plain collection holds decoded rows, whose boxes still check their schema", () => {
    const desk = new Desk(Realm.make());
    const { realm } = desk;
    const [first] = Model.decode(realm, Schema.Array(Row))([{ id: "a", price: 1 }]);
    const row = first as Row;
    Realm.update(realm, (_read, write) => {
      write.upsert(desk.$rows, row);
    });
    expect(Realm.untracked(realm, (read) => read(desk.$rows.row("a"))?.id)).toBe("a");
    expect(() =>
      Realm.update(realm, (_read, write) => {
        write(row.$price, 0);
      }),
    ).toThrow();
    expect(readOf(realm, row.$price)).toBe(1);
  });

  test("a schemaBox compares with its schema, a plain box with Object.is", () => {
    const realm = Realm.make();
    const $plain = Box.make(realm, { at: 1 });
    const $checked = Box.schema(realm, Schema.Struct({ at: Schema.Number }), { at: 1 });
    const seen: Array<string> = [];
    const stops = [
      Realm.watch(
        realm,
        (read) => read($plain),
        () => {
          seen.push("plain");
        },
      ),
      Realm.watch(
        realm,
        (read) => read($checked),
        () => {
          seen.push("checked");
        },
      ),
    ];
    Realm.update(realm, (_read, write) => {
      write($plain, { at: 1 });
      write($checked, { at: 1 });
    });
    expect(seen).toEqual(["plain"]);
    for (const stop of stops) {
      stop();
    }
  });

  test("a draft leaves a model instance read-only", () => {
    const realm = Realm.make();
    const desk = new Desk(realm);
    const $desks = Box.make(realm, [desk]);
    Realm.update(realm, (_read, write) => {
      write.modify($desks, (desks) => {
        // @ts-expect-error A model's fields are read-only in a draft.
        desks[0].realm = Realm.make();
        return undefined;
      });
    });
  });
});

describe("a schema model holding plain values", () => {
  test("a plain box holds a schema model instance and compares it by identity", () => {
    const realm = Realm.make();
    const row = Row.make({ id: "a", price: 1, realm });
    const $current = Box.make(realm, row);
    let runs = 0;
    const stop = Realm.watch(
      realm,
      (read) => read($current),
      () => {
        runs++;
      },
    );
    Realm.update(realm, (_read, write) => {
      write($current, Row.make({ id: "a", price: 1, realm }));
    });
    expect(runs).toBe(1);
    stop();
  });

  test("a plain box in the class body checks nothing, beside a BoxField that checks, and stays off the wire", () => {
    class Quote extends Model.Schema<Quote>("MixQuote")({
      id: Schema.String,
      $price: Model.boxField(Schema.Number.check(Schema.isGreaterThan(0))),
    }) {
      readonly $last = Box.make(this.realm, 0);
    }
    const realm = Realm.make();
    const made = Quote.make({ id: "a", price: 1, realm });
    const decoded = Model.decode(realm, Quote)({ id: "b", price: 2 });
    for (const quote of [made, decoded]) {
      Realm.update(realm, (_read, write) => {
        write(quote.$last, -5);
      });
      expect(readOf(realm, quote.$last)).toBe(-5);
      const before = readOf(realm, quote.$price);
      expect(
        thrownBy(() =>
          Realm.update(realm, (_read, write) => {
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
    class Offer extends Model.Schema<Offer>("MixOffer")({
      id: Schema.String,
      price: Schema.Number.check(Schema.isGreaterThan(0)),
    }) {
      readonly $price = Box.make(this.realm, this.price);
    }
    const realm = Realm.make();
    expect(() => Model.decode(realm, Offer)({ id: "a", price: -1 })).toThrow();
    const offer = Model.decode(realm, Offer)({ id: "a", price: 2 });
    expect(readOf(realm, offer.$price)).toBe(2);
    Realm.update(realm, (_read, write) => {
      write(offer.$price, -5);
    });
    expect(readOf(realm, offer.$price)).toBe(-5);
    expect(offer.price).toBe(2);
    expect(Schema.encodeSync(Offer)(offer)).toEqual({ id: "a", price: 2 });
  });

  test("a schema collection holds rows of another realm: the check is per instance", () => {
    const realm = Realm.make();
    const other = Realm.make();
    const foreign = Row.make({ id: "a", price: 1, realm: other });
    const book = Book.make({ name: "b", rows: [foreign], realm });
    expect(Realm.untracked(realm, (read) => read(book.$rows.row("a")))).toBe(foreign);
    expect(foreign.realm).toBe(other);
  });
});

describe("a schema model's own rules", () => {
  test("make takes values under wire keys: a box is rejected under either key", () => {
    const realm = Realm.make();
    const $price = Box.make(realm, 1);
    // @ts-expect-error price takes a number, not a box.
    expect(() => Row.make({ id: "a", price: $price, realm })).toThrow("Schema validation failed");
    // @ts-expect-error $price is not an input of make.
    expect(() => Row.make({ id: "a", price: 1, $price, realm })).toThrow(
      'MixRow.make takes the value of $price under "price"',
    );
  });

  test("a $ field cannot be reassigned", () => {
    const realm = Realm.make();
    const row = Row.make({ id: "a", price: 1, realm });
    expect(() => {
      // @ts-expect-error A $ field is read-only.
      row.$price = Box.make(realm, 2);
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
    const realm = Realm.make();
    const wire = { name: "b", rows: [{ id: "a", price: 1 }] };
    const book = Model.decode(realm, Book)(wire);
    const row = Realm.untracked(realm, (read) => read(book.$rows.row("a"))) as Row;
    Realm.update(realm, (_read, write) => {
      write(row.$price, 3);
    });
    expect(Realm.untracked(realm, (read) => read(row.$double))).toBe(6);
    expect(Schema.encodeSync(Book)(book)).toEqual({ name: "b", rows: [{ id: "a", price: 3 }] });
  });

  test("another schema's make throws for a plain object holding a box of another realm", () => {
    const realm = Realm.make();
    const $price = Box.schema(Realm.make(), Schema.Number, 1);
    const Holder = Schema.Struct({ row: Row });
    const row = { id: "a", $price, realm } as unknown as Row;
    const failure = thrownBy(() => Holder.make({ row }));
    expect(SchemaIssue.makeFormatterDefault()(failure.cause as SchemaIssue.Issue)).toContain(
      "a MixRow field of another schema takes an instance",
    );
  });

  test("make checks a box's first value under disableChecks, which skips only plain fields' checks", () => {
    const realm = Realm.make();
    expect(() => Row.make({ id: "a", price: -1, realm }, { disableChecks: true })).toThrow(
      "Schema validation failed",
    );
    const Checked = Schema.String.check(Schema.isMinLength(2));
    class Tagged extends Model.Schema<Tagged>("MixTagged")({
      tag: Checked,
      $price: Model.boxField(Schema.Number.check(Schema.isGreaterThan(0))),
    }) {}
    const tagged = Tagged.make({ tag: "x", price: 1, realm }, { disableChecks: true });
    expect(tagged.tag).toBe("x");
    expect(Realm.untracked(realm, (read) => read(tagged.$price))).toBe(1);
  });
});
