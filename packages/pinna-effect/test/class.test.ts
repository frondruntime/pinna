import { beforeEach, describe, expect, test } from "bun:test";
import { realmOf } from "@frondruntime/pinna/internal";
import {
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  SchemaGetter,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import {
  BoxField,
  box,
  CollectionField,
  computed,
  createRealm,
  decode,
  FromContext,
  RealmService,
  SchemaModel,
  schemaBox,
  untracked,
  update,
  watch,
} from "../src/index.ts";
import { Portfolio, Position, PositionsResponse, positionsJson, Quote, runs } from "./model.ts";

const thrownBy = (run: () => unknown): Error => {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a throw");
};

beforeEach(() => {
  runs.value = 0;
  runs.total = 0;
});

describe("SchemaModel", () => {
  test("a $ field decodes from its wire key into a box and encodes back", () => {
    const realm = createRealm();
    const json = positionsJson(2);
    const response = decode(realm, PositionsResponse)(json);
    const first = response.items[0];
    expect(
      untracked(realm, (read) => (first === undefined ? undefined : read(first.$quote))),
    ).toBeInstanceOf(Quote);
    expect(
      untracked(realm, (read) => (first === undefined ? undefined : read(first.$quote).price)),
    ).toBe(10);
    expect(Schema.encodeSync(PositionsResponse)(response)).toEqual(json);
  });

  test("the encoded type names the wire key and leaves out the realm", () => {
    const encoded: typeof Position.Encoded = {
      id: "m",
      ticker: "M",
      amount: 2,
      quote: { price: 10, at: "t0" },
    };
    // @ts-expect-error The wire key of $quote is quote.
    const boxKey: typeof Position.Encoded = { ...encoded, $quote: encoded.quote };
    // @ts-expect-error The realm is never on the wire.
    const realmKey: typeof Position.Encoded = { ...encoded, realm: createRealm() };
    const realm = createRealm();
    const position = decode(realm, Position)(encoded);
    expect(Schema.encodeSync(Position)(position)).toEqual(encoded);
    expect([boxKey, realmKey]).toHaveLength(2);
  });

  test("a $ field that is not a box, or a box without $, is rejected", () => {
    expect(() => SchemaModel("Bad")({ $count: Schema.Number })).toThrow(
      "Bad.$count is named as a box",
    );
    expect(() => SchemaModel("Bad")({ count: BoxField(Schema.Number) })).toThrow(
      "Bad.count holds a box; name it $count",
    );
  });

  test("a field named realm is rejected", () => {
    expect(() => SchemaModel("Bad")({ realm: Schema.String })).toThrow(
      'Bad.realm reads "realm", the realm the instance belongs to',
    );
    expect(() => SchemaModel("Bad")({ $realm: BoxField(Schema.Number) })).toThrow(
      'Bad.$realm reads "realm", the realm the instance belongs to',
    );
  });

  test("two fields that read the same wire key are rejected", () => {
    expect(() =>
      SchemaModel("Bad")({ $count: BoxField(Schema.Number), count: Schema.String }),
    ).toThrow('Bad.$count and Bad.count both read "count"; rename one');
  });

  test("an instance is not frozen when it enters a box", () => {
    const portfolio = new Portfolio(createRealm());
    portfolio.load(positionsJson(1));
    const response = untracked(portfolio.realm, (read) => read(portfolio.$response));
    expect(Object.isFrozen(response)).toBe(false);
    expect(Object.isFrozen(response.items)).toBe(false);
  });
});

describe("the realm of a decoded instance", () => {
  test("every nested instance and box belongs to the realm that decoded it", () => {
    const realm = createRealm();
    const response = decode(realm, PositionsResponse)(positionsJson(2));
    expect(response.realm).toBe(realm);
    expect(response.items.map((position) => position.realm)).toEqual([realm, realm]);
    const first = response.items[0];
    expect(first === undefined ? undefined : realmOf(first.$quote)).toBe(realm as never);
  });

  test("a decode of thousands of rows finishes in one call and keeps the realm", () => {
    const realm = createRealm();
    const response = decode(realm, PositionsResponse)(positionsJson(5000));
    expect(response.items).toHaveLength(5000);
    expect(response.items.every((position) => position.realm === realm)).toBe(true);
    const last = response.items[4999];
    expect(last === undefined ? undefined : realmOf(last.$quote)).toBe(realm as never);
  });

  test("a computed field made from this.realm tracks the decoded boxes", () => {
    const realm = createRealm();
    const response = decode(realm, PositionsResponse)(positionsJson(2));
    const totals: Array<number> = [];
    watch(
      realm,
      (read) => read(response.$total),
      (total) => {
        totals.push(total);
      },
    );
    update(realm, (_read, write) => {
      const second = response.items[1];
      if (second !== undefined) {
        write(second.$quote, Quote.make({ price: 20, at: "t1" }));
      }
    });
    expect(totals).toEqual([50]);
  });

  test("the same JSON decoded into two realms gives two sets of instances", () => {
    const first = createRealm();
    const second = createRealm();
    const json = positionsJson(1);
    const a = decode(first, PositionsResponse)(json);
    const b = decode(second, PositionsResponse)(json);
    expect(a.items[0]?.realm).toBe(first);
    expect(b.items[0]?.realm).toBe(second);
    expect(a.items[0]?.$quote).not.toBe(b.items[0]?.$quote as never);
  });

  test("encoding leaves the realm out", () => {
    const realm = createRealm();
    const position = decode(realm, Position)(positionsJson(1).items[0]);
    expect(Object.keys(Schema.encodeSync(Position)(position))).toEqual([
      "id",
      "ticker",
      "amount",
      "quote",
    ]);
  });

  test("a realm key on the wire is rejected", () => {
    const realm = createRealm();
    const row = { ...positionsJson(1).items[0], realm: "not a realm" };
    expect(() => decode(realm, Position)(row)).toThrow("the realm is never on the wire");
  });

  test("a decode that does not go through a realm fails", () => {
    // @ts-expect-error A SchemaModel needs a realm to decode; use decode.
    expect(() => Schema.decodeUnknownSync(PositionsResponse)(positionsJson(1))).toThrow();
  });

  test("make takes each $ field's value under its wire key and the realm, and builds the box", () => {
    const realm = createRealm();
    const quote = Quote.make({ price: 10, at: "t0" });
    const position = Position.make({ id: "m", ticker: "M", amount: 2, quote, realm });
    expect(position.realm).toBe(realm);
    expect(realmOf(position.$quote)).toBe(realm as never);
    expect(untracked(realm, (read) => read(position.$value))).toBe(20);
    // @ts-expect-error make needs the realm.
    expect(() => Position.make({ id: "m", ticker: "M", amount: 2, quote })).toThrow();
  });

  test("make reports a value that fails its schema at the wire key", () => {
    const realm = createRealm();
    const failure = thrownBy(() =>
      // @ts-expect-error quote takes a Quote.
      Position.make({ id: "m", ticker: "M", amount: 2, quote: 10, realm }),
    );
    expect(String(SchemaIssue.makeFormatterDefault()(failure.cause as never))).toContain(
      'at ["quote"]',
    );
  });

  test("make rejects a box under the $ key", () => {
    const realm = createRealm();
    const $quote = schemaBox(realm, Quote, Quote.make({ price: 10, at: "t0" }));
    const quote = Quote.make({ price: 10, at: "t0" });
    expect(() =>
      // @ts-expect-error $quote is not an input of make.
      Position.make({ id: "m", ticker: "M", amount: 2, quote, $quote, realm }),
    ).toThrow('Position.make takes the value of $quote under "quote", never a box under "$quote"');
  });

  test("make from a spread instance throws instead of sharing its box", () => {
    const realm = createRealm();
    const quote = Quote.make({ price: 10, at: "t0" });
    const position = Position.make({ id: "m", ticker: "M", amount: 2, quote, realm });
    // @ts-expect-error a spread instance carries $quote, not quote.
    expect(() => Position.make({ ...position, id: "n" })).toThrow(
      'Position.make takes the value of $quote under "quote"',
    );
  });

  test("make takes the realm as a realm", () => {
    const quote = Quote.make({ price: 10, at: "t0" });
    // @ts-expect-error realm takes a Realm.
    expect(() => Position.make({ id: "m", ticker: "M", amount: 2, quote, realm: 42 })).toThrow();
  });

  test("make builds a plain value into the field's class", () => {
    const realm = createRealm();
    const position = Position.make({
      id: "m",
      ticker: "M",
      amount: 2,
      quote: { price: 10, at: "t0" },
      realm,
    });
    expect(untracked(realm, (read) => read(position.$quote))).toBeInstanceOf(Quote);
  });

  test("make of a model with no nested model takes what encode gives, plus the realm", () => {
    const realm = createRealm();
    const position = decode(realm, Position)(positionsJson(1).items[0]);
    const wire = Schema.encodeSync(Position)(position);
    const made = Position.make({ ...wire, realm });
    expect(Schema.encodeSync(Position)(made)).toEqual(wire);
    expect(made.$quote).not.toBe(position.$quote);
  });

  test("make of a model with a nested model takes instances, so the wire goes through decode", () => {
    const realm = createRealm();
    const response = decode(realm, PositionsResponse)(positionsJson(1));
    const wire = Schema.encodeSync(PositionsResponse)(response);
    // @ts-expect-error items takes Position instances, not their wire values.
    expect(() => PositionsResponse.make({ ...wire, realm })).toThrow("Schema validation failed");
    const decoded = decode(realm, PositionsResponse)(wire);
    expect(Schema.encodeSync(PositionsResponse)(decoded)).toEqual(wire);
  });

  test("another schema's make keeps the instance it is given", () => {
    const realm = createRealm();
    const quote = Quote.make({ price: 10, at: "t0" });
    const position = Position.make({ id: "m", ticker: "M", amount: 2, quote, realm });
    const Holder = Schema.Struct({ position: Position });
    expect(Holder.make({ position }).position).toBe(position);
  });

  test("another schema's make throws for a plain object in place of an instance", () => {
    const realm = createRealm();
    const quote = Quote.make({ price: 10, at: "t0" });
    const owner = Position.make({ id: "m", ticker: "M", amount: 2, quote, realm });
    const Holder = Schema.Struct({ position: Position });
    const base = { id: "m", ticker: "M", amount: 2, realm };
    const boxes = {
      "another instance's box": owner.$quote,
      "a box of another realm": schemaBox(createRealm(), Quote, quote),
      "a box that checks nothing": box(realm, 42),
      "a box of another schema": schemaBox(realm, Schema.String, "x"),
    };
    const messageOf = (position: unknown): string => {
      const failure = thrownBy(() => Holder.make({ position: position as Position }));
      return SchemaIssue.makeFormatterDefault()(failure.cause as SchemaIssue.Issue);
    };
    const takesAnInstance =
      'pinna: a Position field of another schema takes an instance; build it with Position.make or decode\n  at ["position"]';
    for (const $quote of Object.values(boxes)) {
      expect(messageOf({ ...base, $quote })).toBe(takesAnInstance);
    }
    // Under wire keys too: the error names the instance, not the $ field the struct has.
    expect(messageOf({ ...base, quote })).toBe(takesAnInstance);
  });

  test("a decode that fails throws the schema error", () => {
    const realm = createRealm();
    expect(() => decode(realm, PositionsResponse)({ items: [{ id: 1 }] })).toThrow(
      Schema.SchemaError,
    );
  });
});

describe("decoding with a context", () => {
  interface Greeting {
    readonly greet: (name: string) => string;
  }

  class GreetingService extends Context.Service<GreetingService, Greeting>()("test/Greeting") {}

  class Clock extends Context.Service<Clock, { readonly now: () => number }>()("test/Clock") {}

  class Person extends SchemaModel<Person>("Person")({
    $name: BoxField(Schema.String),
    greeting: FromContext(GreetingService),
  }) {
    readonly $greeting = computed(this.realm, (read) => this.greeting.greet(read(this.$name)));
  }

  class Team extends SchemaModel<Team>("Team")({
    $members: BoxField(Schema.Array(Person)),
  }) {}

  const english: Greeting = { greet: (name) => `Hello, ${name}` };
  const french: Greeting = { greet: (name) => `Bonjour, ${name}` };
  const inEnglish = Context.make(GreetingService, english);
  const inFrench = Context.make(GreetingService, french);

  test("a context field holds the caller's own value and stays off the wire", () => {
    const realm = createRealm();
    const person = decode(realm, Person, inEnglish)({ name: "Ada" });
    expect(person.greeting).toBe(english);
    expect(untracked(realm, (read) => read(person.$greeting))).toBe("Hello, Ada");
    expect(Schema.encodeSync(Person)(person)).toEqual({ name: "Ada" });
  });

  test("the context reaches every nested instance", () => {
    const realm = createRealm();
    const team = decode(realm, Team, inEnglish)({ members: [{ name: "Ada" }, { name: "Grace" }] });
    const greetings = untracked(realm, (read) =>
      read(team.$members).map((member) => read(member.$greeting)),
    );
    expect(greetings).toEqual(["Hello, Ada", "Hello, Grace"]);
  });

  test("a decode without the context, or with one that lacks the tag, does not compile", () => {
    const realm = createRealm();
    // @ts-expect-error Team needs GreetingService, through Person.
    expect(() => decode(realm, Team)({ members: [{ name: "Ada" }] })).toThrow("test/Greeting");
    expect(() =>
      // @ts-expect-error the context holds a Clock, not a GreetingService.
      decode(realm, Person, Context.make(Clock, { now: () => 0 }))({ name: "Ada" }),
    ).toThrow("test/Greeting");
  });

  test("a context may hold more services than the schema needs", () => {
    const realm = createRealm();
    const wide = inEnglish.pipe(Context.add(Clock, { now: () => 0 }));
    expect(decode(realm, Person, wide)({ name: "Ada" }).greeting).toBe(english);
  });

  test("a schema with no context field takes no context", () => {
    const realm = createRealm();
    // @ts-expect-error PositionsResponse needs no service.
    expect(() => decode(realm, PositionsResponse, inEnglish)).not.toThrow();
  });

  test("a schema that reads any Effect service takes it in the context", () => {
    const Stamped = Schema.Struct({
      at: Schema.Number.pipe(
        Schema.withDecodingDefaultTypeKey(Effect.map(Clock, (clock) => clock.now())),
      ),
    });
    const stamped = decode(createRealm(), Stamped, Context.make(Clock, { now: () => 7 }))({});
    expect(stamped.at).toBe(7);
  });

  test("a transformation inside decode reads the context's services from Effect", () => {
    const Greeted = Schema.Struct({
      name: Schema.String.pipe(
        Schema.decodeTo(
          Schema.String,
          SchemaTransformation.transformEffect({
            decode: (name) => Effect.map(GreetingService, (greeting) => greeting.greet(name)),
            encode: (greeted) => Effect.succeed(greeted),
          }),
        ),
      ),
    });
    expect(decode(createRealm(), Greeted, inFrench)({ name: "Ada" }).name).toBe("Bonjour, Ada");
  });

  test("a context field on the wire is rejected", () => {
    const realm = createRealm();
    expect(() => decode(realm, Person, inEnglish)({ name: "Ada", greeting: english })).toThrow(
      Schema.SchemaError,
    );
  });

  test("a context field decodes only with its service", () => {
    const Greeted = Schema.Struct({ greeting: FromContext(GreetingService) });
    // @ts-expect-error Greeted needs GreetingService, which decodeUnknownSync cannot take.
    expect(() => Schema.decodeUnknownSync(Greeted)({})).toThrow();
  });

  test("a decode inside a decode has its own context, and the outer one comes back", () => {
    const realm = createRealm();
    const Pair = Schema.Struct({
      inner: Schema.String.pipe(
        Schema.decodeTo(
          Schema.String,
          SchemaTransformation.transform({
            decode: (name) =>
              untracked(realm, (read) => read(decode(realm, Person, inFrench)({ name }).$greeting)),
            encode: (greeting) => greeting,
          }),
        ),
      ),
      greeting: FromContext(GreetingService),
    });
    const pair = decode(realm, Pair, inEnglish)({ inner: "Ada" });
    expect(pair.inner).toBe("Bonjour, Ada");
    expect(pair.greeting).toBe(english);
  });
});

describe("an Effect decode with a context", () => {
  interface Greeting {
    readonly greet: (name: string) => string;
  }

  class GreetingService extends Context.Service<GreetingService, Greeting>()("test/Greeting") {}

  class Person extends SchemaModel<Person>("Person")({
    $name: BoxField(Schema.String),
    greeting: FromContext(GreetingService),
  }) {
    readonly $greeting = computed(this.realm, (read) => this.greeting.greet(read(this.$name)));
  }

  class Team extends SchemaModel<Team>("Team")({
    $members: BoxField(Schema.Array(Person)),
  }) {}

  const english: Greeting = { greet: (name) => `Hello, ${name}` };
  const french: Greeting = { greet: (name) => `Bonjour, ${name}` };

  const greetingOf = (person: Person) => untracked(person.realm, (read) => read(person.$greeting));

  test("Effect.provideService gives every nested instance the service", async () => {
    const realm = createRealm();
    const team = await Effect.runPromise(
      Schema.decodeUnknownEffect(Team)({ members: [{ name: "Ada" }, { name: "Grace" }] }).pipe(
        Effect.provideService(GreetingService, english),
        Effect.provideService(RealmService, realm),
      ),
    );
    const members = untracked(realm, (read) => read(team.$members));
    expect(members.map(greetingOf)).toEqual(["Hello, Ada", "Hello, Grace"]);
  });

  test("a Layer gives the service", async () => {
    const person = await Effect.runPromise(
      Schema.decodeUnknownEffect(Person)({ name: "Ada" }).pipe(
        Effect.provide(Layer.succeed(GreetingService, french)),
        Effect.provideService(RealmService, createRealm()),
      ),
    );
    expect(greetingOf(person)).toBe("Bonjour, Ada");
  });

  test("a missing service stays a requirement, and the decode dies", async () => {
    const missing = Schema.decodeUnknownEffect(Person)({ name: "Ada" }).pipe(
      Effect.provideService(RealmService, createRealm()),
    );
    // @ts-expect-error nothing provides GreetingService.
    const exit = await Effect.runPromiseExit(missing);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("test/Greeting");
  });

  test("a decode inside an Effect decode reads its own context, and the provided one comes back", async () => {
    const realm = createRealm();
    const Pair = Schema.Struct({
      inner: Schema.String.pipe(
        Schema.decodeTo(
          Schema.String,
          SchemaTransformation.transform({
            decode: (name) =>
              greetingOf(decode(realm, Person, Context.make(GreetingService, french))({ name })),
            encode: (greeting) => greeting,
          }),
        ),
      ),
      greeting: FromContext(GreetingService),
    });
    const pair = await Effect.runPromise(
      Schema.decodeUnknownEffect(Pair)({ inner: "Ada" }).pipe(
        Effect.provideService(GreetingService, english),
      ),
    );
    expect(pair.inner).toBe("Bonjour, Ada");
    expect(pair.greeting).toBe(english);
  });

  test("an Effect decode inside a decode reads the service it provides, over the decode's", () => {
    const realm = createRealm();
    const Pair = Schema.Struct({
      inner: Schema.String.pipe(
        Schema.decodeTo(
          Schema.String,
          new SchemaTransformation.Transformation<string, string, RealmService>(
            SchemaGetter.transformOptionalEffect((input) =>
              Schema.decodeUnknownEffect(Person)({ name: Option.getOrElse(input, () => "") }).pipe(
                Effect.provideService(GreetingService, french),
                Effect.map((person) => Option.some(greetingOf(person))),
                Effect.mapError((error) => error.issue),
              ),
            ),
            SchemaGetter.transformOptional((output) => output),
          ),
        ),
      ),
      greeting: FromContext(GreetingService),
    });
    const pair = decode(realm, Pair, Context.make(GreetingService, english))({ inner: "Ada" });
    expect(pair.inner).toBe("Bonjour, Ada");
    expect(pair.greeting).toBe(english);
  });
});

describe("the event table", () => {
  const setup = () => {
    const portfolio = new Portfolio(createRealm());
    const { realm } = portfolio;
    portfolio.load(positionsJson(3));
    const rows = untracked(realm, (read) => read(portfolio.$response).items);
    const rowValues = rows.map((position) => {
      const seen: Array<number> = [];
      const stop = watch(
        realm,
        (read) => read(position.$value),
        (value) => {
          seen.push(value);
        },
      );
      return { seen, stop };
    });
    const totals: Array<string> = [];
    const stopTotal = watch(
      realm,
      (read) => read(portfolio.$totalLabel),
      (value) => {
        totals.push(value);
      },
    );
    runs.value = 0;
    runs.total = 0;
    return { portfolio, realm, rows, rowValues, totals, stopTotal };
  };

  test("a tick recomputes one row and the total", () => {
    const { portfolio, rowValues, totals } = setup();
    portfolio.tick({ id: "p1", price: 20 });
    expect(rowValues.map((row) => row.seen)).toEqual([[], [40], []]);
    expect(totals).toEqual(["80 USD"]);
    expect(runs).toEqual({ value: 1, total: 1 });
  });

  test("a tick with the same price stops at the row's cutoff", () => {
    const { portfolio, rowValues, totals } = setup();
    portfolio.tick({ id: "p1", price: 10 });
    expect(rowValues.map((row) => row.seen)).toEqual([[], [], []]);
    expect(totals).toEqual([]);
    expect(runs).toEqual({ value: 1, total: 0 });
  });

  test("closing a position keeps the other instances", () => {
    const { portfolio, realm, rows, totals } = setup();
    portfolio.close("p1");
    const after = untracked(realm, (read) => read(portfolio.$response).items);
    expect(after).toEqual([rows[0], rows[2]].filter((row) => row !== undefined));
    expect(after[0]).toBe(rows[0] as never);
    expect(totals).toEqual(["40 USD"]);
    expect(runs.value).toBe(0);
  });

  test("a currency change recomputes only the label", () => {
    const { portfolio, realm, totals } = setup();
    update(realm, (_read, write) => {
      write(portfolio.$currency, "EUR");
    });
    expect(totals).toEqual(["60 EUR"]);
    expect(runs).toEqual({ value: 0, total: 0 });
  });

  test("a tick of the wrong shape changes nothing", () => {
    const { portfolio, rowValues, totals } = setup();
    expect(() => portfolio.tick({ id: "p1", price: "high" as unknown as number })).toThrow();
    expect(rowValues.map((row) => row.seen)).toEqual([[], [], []]);
    expect(totals).toEqual([]);
  });
});

describe("SchemaModel decode", () => {
  test("runs a field's check once, as a plain struct decode does", () => {
    let checks = 0;
    const Counted = Schema.Number.check(
      Schema.makeFilter(() => {
        checks++;
        return true;
      }),
    );
    const Point = Schema.Struct({ x: Counted });
    const fields = { id: Schema.String, size: Counted, points: Schema.Array(Point) };
    const wire = { id: "a", size: 1, points: [{ x: 1 }, { x: 2 }] };
    Schema.decodeUnknownSync(Schema.Struct(fields))(wire);
    expect(checks).toBe(3);
    class Plain extends SchemaModel<Plain>("Plain")(fields) {}
    class Boxed extends SchemaModel<Boxed>("Boxed")({
      id: Schema.String,
      $size: BoxField(Counted),
      points: Schema.Array(Point),
    }) {}
    const realm = createRealm();
    checks = 0;
    decode(realm, Plain)(wire);
    expect(checks).toBe(3);
    checks = 0;
    decode(realm, Boxed)(wire);
    expect(checks).toBe(3);
  });

  test("reports a failed field at its wire key", () => {
    class Row extends SchemaModel<Row>("Row")({
      id: Schema.String,
      note: Schema.optionalKey(Schema.String),
      $price: BoxField(Schema.Number.check(Schema.isGreaterThan(0))),
    }) {}
    const realm = createRealm();
    const messageOf = (input: unknown): string => {
      try {
        decode(realm, Row)(input);
        return "decoded";
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(messageOf({ id: "a", price: 1 })).toBe("decoded");
    expect(messageOf({ id: "a", price: -1 })).toBe(
      'Expected a value greater than 0\n  at ["price"]',
    );
    expect(messageOf({ id: "a", price: "x" })).toBe('Expected number\n  at ["price"]');
    expect(messageOf({ id: "a" })).toBe('Missing key\n  at ["price"]');
    expect(messageOf({ id: "a", $price: 1 })).toBe('Missing key\n  at ["price"]');
    expect(messageOf({ id: 1, price: 1 })).toBe('Expected string\n  at ["id"]');
    expect(messageOf({ id: "a", note: 1, price: 1 })).toBe('Expected string\n  at ["note"]');
  });

  test("encodes only the fields, under their wire keys", () => {
    class Row extends SchemaModel<Row>("Row")({
      id: Schema.String,
      note: Schema.optionalKey(Schema.String),
      $price: BoxField(Schema.Number),
    }) {
      readonly label = `row ${this.id}`;
    }
    const realm = createRealm();
    const row = decode(realm, Row)({ id: "a", price: 2 });
    expect(row.label).toBe("row a");
    expect(Schema.encodeSync(Row)(row)).toEqual({ id: "a", price: 2 });
    expect(Object.keys(Schema.encodeSync(Row)(row))).toEqual(["id", "price"]);
    const noted = decode(realm, Row)({ id: "b", note: "n", price: 3 });
    expect(Schema.encodeSync(Row)(noted)).toEqual({ id: "b", note: "n", price: 3 });
  });

  test("puts boxes and collections in the decoding realm, and encodes their values", () => {
    class Item extends SchemaModel<Item>("Item")({ id: Schema.String, price: Schema.Number }) {}
    class Basket extends SchemaModel<Basket>("Basket")({
      $size: BoxField(Schema.Number.check(Schema.isGreaterThan(0))),
      $items: CollectionField(Item, { keyOf: (item) => item.id }),
    }) {}
    const realm = createRealm();
    const messageOf = (input: unknown): string => {
      try {
        decode(realm, Basket)(input);
        return "decoded";
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(messageOf({ size: 0, items: [] })).toBe(
      'Expected a value greater than 0\n  at ["size"]',
    );
    expect(
      messageOf({
        size: 1,
        items: [
          { id: "a", price: 1 },
          { id: "a", price: 2 },
        ],
      }),
    ).toBe('pinna: the collection key a appears twice\n  at ["items"]');
    expect(messageOf({ size: 1, items: [{ id: "a" }] })).toBe(
      'Missing key\n  at ["items"][0]["price"]',
    );

    const wire = { size: 2, items: [{ id: "a", price: 1 }] };
    const basket = decode(realm, Basket)(wire);
    expect(realmOf(basket.$size)).toBe(realm as never);
    expect(untracked(realm, (read) => read(basket.$size))).toBe(2);
    expect(untracked(realm, (read) => read(basket.$items.row("a")))?.price).toBe(1);
    expect(Schema.encodeSync(Basket)(basket)).toEqual(wire);
    update(realm, (_read, write) => {
      write(basket.$size, 3);
      write.upsert(basket.$items, Item.make({ id: "b", price: 4, realm }));
    });
    expect(Schema.encodeSync(Basket)(basket)).toEqual({
      size: 3,
      items: [
        { id: "b", price: 4 },
        { id: "a", price: 1 },
      ],
    });
  });

  test("fails to decode or encode a box field in any schema but a SchemaModel", () => {
    const realm = createRealm();
    const Holder = Schema.Struct({ $size: BoxField(Schema.Number) });
    expect(() => decode(realm, Holder)({ $size: 5 })).toThrow(
      "pinna: BoxField is a SchemaModel field; declare it in SchemaModel(...)",
    );
    // The field's make type is its wire value; only a SchemaModel turns that into a box.
    const held = Holder.make({ $size: box(realm, 5) as never });
    expect(() => Schema.encodeSync(Holder)(held)).toThrow(
      "pinna: BoxField is a SchemaModel field; declare it in SchemaModel(...)",
    );
    const Rows = Schema.Array(CollectionField(Schema.String, { keyOf: (value) => value }));
    expect(() => decode(realm, Rows)([["a"]])).toThrow(
      "pinna: CollectionField is a SchemaModel field; declare it in SchemaModel(...)",
    );
  });
});
