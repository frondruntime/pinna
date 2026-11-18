/**
 * `SchemaModel`: an Effect `Schema.Class` whose fields are plain, `readonly`
 * data. A field named `$name` must be a `BoxField` or a `CollectionField`: it
 * holds a box or a keyed collection, and its wire key is `name`. No other
 * field may hold one.
 *
 * Every instance has a `realm` field: the realm its boxes and computed
 * values belong to. `decode` fills it, and `make` takes it by hand. It
 * is never on the wire, so field initializers can use `this.realm`.
 *
 * One key space: a caller writes wire keys (`done` for `$done`), and the
 * instance alone has `$` keys. `decode` takes the wire value and the realm
 * from `RealmService`; `make` and `new` take each `$` field's starting value
 * under its wire key, never a box, and the realm; encoding gives wire keys.
 * A model nested in another schema's `make` takes an instance. Each path
 * builds the boxes in the instance's realm, so an instance never holds
 * another realm's box or another instance's.
 */

import type { Box, Collection, Realm } from "@frondruntime/pinna";
import {
  BoxCell,
  type ClassInstance,
  KeyedCollection,
  ObservableRealm,
  peekCell,
  repeatedKey,
  repeatedKeyMessage,
} from "@frondruntime/pinna/internal";
import {
  Effect,
  Equal,
  type Equivalence,
  Schema,
  SchemaAST,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import { RealmService } from "./decode.ts";
import { type MergeWrites, mergeKey, planMerge, realmOfMergeable } from "./merge.ts";
import { checkOf, equalsOf } from "./schema.ts";

/** How a `BoxField` or `CollectionField` goes to and from its wire value. */
interface FieldCodec {
  /** The schema of the wire value; its type side is the value `make` takes. */
  readonly wire: Schema.Top;
  /** Builds the box from a value its schema decoded or made, and checked. */
  readonly make: (realm: ObservableRealm, value: unknown) => unknown;
  /** The box's value, for its schema to encode. */
  readonly read: (box: unknown) => unknown;
  /**
   * The writes that bring the `held` box to the value of the `fresh` one,
   * or `undefined` when it holds an equal value already. Plans, writes nothing.
   */
  readonly merge: (held: unknown, fresh: unknown) => MergeWrites;
}

/**
 * The field schemas `BoxField` and `CollectionField` made, so `SchemaModel`
 * can require one under every `$` key, and build the boxes once it has the
 * realm.
 */
const fieldCodecs = new WeakMap<object, FieldCodec>();

/**
 * A field schema whose `make` takes `Value`, the value its box starts at: the
 * model's constructor builds the box, so the types never ask for one.
 */
type MadeFrom<Field extends Schema.Top, Value> = Omit<Field, "~type.make"> & {
  readonly "~type.make": Value;
};

/**
 * A field schema whose type side is a box. Only `SchemaModel` decodes and
 * encodes it, through `codec`, under the wire key without `$`. In any other
 * schema the field's own decode and encode fail: they would put the `$` key
 * on the wire.
 */
const codecFieldSchema = <Wire extends Schema.Top, Value>(
  kind: "BoxField" | "CollectionField",
  codec: FieldCodec & { readonly wire: Wire },
  isHeld: (input: unknown) => input is Value,
) => {
  const outsideModel = (input: unknown) =>
    Effect.fail(
      new SchemaIssue.InvalidValue(
        {
          message: `pinna: ${kind} is a SchemaModel field; declare it in SchemaModel(...), never in another schema`,
        },
        input,
      ),
    );
  const field = codec.wire.pipe(
    Schema.decodeTo(
      Schema.declare(isHeld),
      SchemaTransformation.transformEffect<Value, Wire["Type"]>({
        decode: outsideModel,
        encode: outsideModel,
      }),
    ),
  );
  fieldCodecs.set(field, codec);
  return field as MadeFrom<typeof field, Wire["~type.make"]>;
};

/**
 * A `SchemaModel` field that holds a box of `schema`'s values. Decoding puts the decoded
 * value in a new box of the decoding realm, and `make` the value it is given;
 * encoding writes the box's current value. The box checks every write against
 * `schema` and compares values with its equivalence.
 */
export const BoxField = <S extends Schema.Top>(schema: S) => {
  const check = checkOf(schema);
  const equals = equalsOf<S["Type"]>(schema);
  return codecFieldSchema(
    "BoxField",
    {
      wire: schema,
      // The decode or make before this one checked `value` against `schema`.
      make: (realm, value) => new BoxCell(realm, check, value as S["Type"], equals, true),
      read: (box) => peekCell((box as BoxCell<S["Type"]>).source),
      merge: (held, fresh) => {
        const target = held as BoxCell<S["Type"]>;
        const value = peekCell((fresh as BoxCell<S["Type"]>).source);
        return equals(peekCell(target.source), value)
          ? undefined
          : () => {
              target.write(value);
            };
      },
    },
    (input: unknown): input is Box<S["Type"]> => input instanceof BoxCell,
  );
};

/**
 * Whether `replaceRows(fresh)` would change nothing: the same keys in the
 * same order, and each row the same, equal, or a model whose merge writes
 * nothing.
 */
const sameRows = <Key, Value>(
  held: ReadonlyArray<Value>,
  fresh: ReadonlyArray<Value>,
  keyOf: (value: Value) => Key,
  equals: (self: Value, that: Value) => boolean,
): boolean => {
  if (held.length !== fresh.length) {
    return false;
  }
  for (let index = 0; index < held.length; index++) {
    const row = held[index] as Value;
    const next = fresh[index] as Value;
    if (Object.is(row, next)) {
      continue;
    }
    if (!Object.is(keyOf(row), keyOf(next))) {
      return false;
    }
    const writes = planMerge(row, next);
    if (
      writes === false
        ? realmOfMergeable(row) !== undefined || !equals(row, next)
        : writes !== undefined
    ) {
      return false;
    }
  }
  return true;
};

const realmOfService = (realm: unknown): ObservableRealm => {
  if (!(realm instanceof ObservableRealm)) {
    throw new Error("pinna: expected a realm made by createRealm()");
  }
  return realm;
};

/**
 * A `SchemaModel` field that holds a keyed collection of `schema`'s values, one cell per
 * key. On the wire, and in `make`, it is a plain array in key order; a key
 * that appears twice fails the decode or the make. Rows are checked against
 * `schema` and compare with its equivalence.
 */
export const CollectionField = <S extends Schema.Top, Key>(
  schema: S,
  options: { readonly keyOf: (value: S["Type"]) => Key },
) => {
  const check = checkOf(schema);
  const equals = equalsOf<S["Type"]>(schema);
  const { keyOf } = options;
  const noRepeatedKey = Schema.makeFilter((values: ReadonlyArray<S["Type"]>) => {
    const repeated = repeatedKey(values.map(keyOf));
    return repeated === undefined ? undefined : repeatedKeyMessage(repeated.key);
  });
  return codecFieldSchema(
    "CollectionField",
    {
      wire: Schema.Array(schema).check(noRepeatedKey),
      make: (realm, values) =>
        new KeyedCollection<Key, S["Type"]>(
          realm,
          check,
          equals,
          keyOf,
          values as ReadonlyArray<S["Type"]>,
          planMerge,
        ),
      read: (collection) => (collection as KeyedCollection<Key, S["Type"]>).values(),
      merge: (held, fresh) => {
        const target = held as KeyedCollection<Key, S["Type"]>;
        const rows = (fresh as KeyedCollection<Key, S["Type"]>).values();
        return sameRows(target.values(), rows, keyOf, equals)
          ? undefined
          : () => {
              target.replaceRows(rows);
            };
      },
    },
    (input: unknown): input is Collection<Key, S["Type"]> => input instanceof KeyedCollection,
  );
};

/**
 * The `realm` field. Its decoding needs `RealmService` in the types, so a
 * decode that no realm is provided to fails to compile.
 */
const realmField = Schema.declare(
  (input: unknown): input is Realm => input instanceof ObservableRealm,
) as unknown as Schema.Codec<Realm, Realm, RealmService>;

/** The wire side of a class: an object; the class's own fields check the rest. */
const wireObject = Schema.declare(
  (input: unknown): input is Readonly<Record<string, unknown>> =>
    typeof input === "object" && input !== null,
);

/** Fails a wire object that carries a realm, before the wire struct drops unknown keys. */
const noRealm = SchemaTransformation.transformEffect<
  Readonly<Record<string, unknown>>,
  Readonly<Record<string, unknown>>
>({
  decode: (input) =>
    "realm" in input
      ? Effect.fail(
          new SchemaIssue.InvalidValue({ message: "the realm is never on the wire" }, input),
        )
      : Effect.succeed(input),
  encode: Effect.succeed,
});

const isBoxKey = (key: string): boolean => key.startsWith("$");

/**
 * An instance that defines `[Equal.symbol]` decides its own equality; one
 * that does not compares its fields: plain fields by value, boxes and the
 * realm by identity. The method is called directly, not through
 * `Equal.equals`, whose cached results would go stale when it reads a box.
 */
const ownEqualOr =
  ([fields]: readonly [Equivalence.Equivalence<never>]): Equivalence.Equivalence<unknown> =>
  (self, that) =>
    Equal.isEqual(self)
      ? self[Equal.symbol](that as Equal.Equal)
      : fields(self as never, that as never);

export const SchemaModel =
  <Self = never>(identifier: string) =>
  <const Fields extends Schema.Struct.Fields>(fields: Fields) => {
    const keys = Object.keys(fields);
    const wireKeys = keys.map((key) => (isBoxKey(key) ? key.slice(1) : key));
    // Each field reads its own wire key: two on one key would leave one field's schema unchecked.
    const fieldOfWireKey = new Map<string, string>();
    for (const [index, key] of keys.entries()) {
      const wireKey = wireKeys[index] as string;
      if (wireKey === "realm") {
        throw new Error(
          `pinna: ${identifier}.${key} reads "realm", the realm the instance belongs to; rename the field`,
        );
      }
      const other = fieldOfWireKey.get(wireKey);
      if (other !== undefined) {
        throw new Error(
          `pinna: ${identifier}.${other} and ${identifier}.${key} both read "${wireKey}"; rename one`,
        );
      }
      fieldOfWireKey.set(wireKey, key);
      const holdsBox = fieldCodecs.has(fields[key] as Schema.Top);
      if (isBoxKey(key) && !holdsBox) {
        throw new Error(
          `pinna: ${identifier}.${key} is named as a box; declare it BoxField(...) or CollectionField(...)`,
        );
      }
      if (!isBoxKey(key) && holdsBox) {
        throw new Error(`pinna: ${identifier}.${key} holds a box; name it $${key}`);
      }
    }
    /**
     * The values this model's decode built, boxes and realm included. Effect
     * builds an instance from such a value without `make`'s pass; the
     * constructor takes no other value that way, and no other model's.
     */
    const builtFromWire = new WeakSet<object>();
    const takesAnInstance = `pinna: a ${identifier} field of another schema takes an instance; build it with ${identifier}.make or decode`;
    /**
     * What another schema's `make` does with a value in place of an instance:
     * fails, before Effect checks it against the struct under `$` keys, whose
     * error would ask for a box.
     */
    const notAnInstance = SchemaTransformation.transformEffect<unknown, unknown>({
      decode: (input) =>
        Effect.fail(new SchemaIssue.InvalidValue({ message: takesAnInstance }, input)),
      encode: Effect.succeed,
    });
    // A box field's wire value is decoded in the wire struct; `fromWire` builds the box.
    const codecOf = keys.map((key) => fieldCodecs.get(fields[key] as Schema.Top));
    const wireFields: Record<string, Schema.Top> = {};
    for (let index = 0; index < keys.length; index++) {
      wireFields[wireKeys[index] as string] =
        codecOf[index]?.wire ?? (fields[keys[index] as string] as Schema.Top);
    }
    /**
     * Moves the decoded fields to their own keys, builds the boxes, and adds
     * the realm; encoding reads the boxes and drops the realm.
     */
    const fromWire = SchemaTransformation.transformEffect<
      Readonly<Record<string, unknown>>,
      Readonly<Record<string, unknown>>,
      RealmService
    >({
      decode: (wire) =>
        Effect.map(RealmService, (realm) => {
          const value: Record<string, unknown> & { realm?: Realm } = {};
          for (let index = 0; index < keys.length; index++) {
            const wireKey = wireKeys[index] as string;
            if (Object.hasOwn(wire, wireKey)) {
              const codec = codecOf[index];
              value[keys[index] as string] =
                codec === undefined
                  ? wire[wireKey]
                  : codec.make(realmOfService(realm), wire[wireKey]);
            }
          }
          value.realm = realm;
          builtFromWire.add(value);
          return value;
        }),
      encode: (value) => {
        const wire: Record<string, unknown> = {};
        for (let index = 0; index < keys.length; index++) {
          const key = keys[index] as string;
          if (Object.hasOwn(value, key)) {
            const codec = codecOf[index];
            wire[wireKeys[index] as string] =
              codec === undefined ? value[key] : codec.read(value[key]);
          }
        }
        return Effect.succeed(wire);
      },
    });
    const heldKeys = keys.filter((_key, index) => codecOf[index] !== undefined);
    const heldWireKeys = heldKeys.map((key) => key.slice(1));
    const heldCodecs = codecOf.filter((codec) => codec !== undefined);
    // What `make` checks before it builds the boxes: each `$` field's value under its wire key, and the realm.
    const madeValueFields: Record<string, Schema.Top> = { realm: realmField };
    for (const [index, wireKey] of heldWireKeys.entries()) {
      madeValueFields[wireKey] = (heldCodecs[index] as FieldCodec).wire;
    }
    const madeValues = Schema.Struct(madeValueFields);
    // What a merge compares: the plain fields alone, not the boxes or the realm.
    const plainFields: Record<string, Schema.Top> = {};
    for (const [index, key] of keys.entries()) {
      if (codecOf[index] === undefined) {
        plainFields[key] = fields[key] as Schema.Top;
      }
    }
    const samePlainFields: (self: unknown, that: unknown) => boolean =
      Object.keys(plainFields).length === 0 ? () => true : equalsOf(Schema.Struct(plainFields));
    const allFields = { ...fields, realm: realmField };
    // The fields' equivalence compares the struct type, and Self extends it.
    const baseFields = Schema.Struct(allFields);
    const makeBase = () =>
      Schema.Class<Self>(identifier)(baseFields, {
        toEquivalence: ownEqualOr as never,
      });
    const Base = makeBase();
    // Replaces Effect's class schema to decode from the wire keys and add the realm; see docs/design.md, known limits.
    const baseAst = (self: object): Schema.Top["ast"] => {
      // Effect also caches one AST per Schema.Class factory, capturing its first receiver.
      const getter = Object.getOwnPropertyDescriptor(makeBase(), "ast")?.get;
      if (getter === undefined) {
        throw new Error("pinna: Schema.Class no longer exposes its ast as a getter");
      }
      return getter.call(self);
    };
    const astsByConstructor = new WeakMap<object, Schema.Top["ast"]>();
    const BaseConstructor = Base as unknown as new (
      input: unknown,
      options?: Schema.MakeOptions,
    ) => Record<string, unknown>;
    const sealed = (name: string, instead: string): never => {
      throw new Error(`pinna: ${identifier}.${name} is not supported; ${instead}`);
    };
    const anotherModel = "declare another SchemaModel with every field it needs";
    const makeInstead = "call make, which throws the schema error, or decode";
    class PinnaClass extends BaseConstructor {
      constructor(input?: Readonly<Record<string, unknown>>, options?: Schema.MakeOptions) {
        // Effect marks the value it already checked with an option its types leave out.
        const payload = (
          options as { readonly "~payload"?: { readonly value: unknown } } | undefined
        )?.["~payload"];
        if (payload !== undefined) {
          // Decode passes the value `fromWire` built. Another schema's `make` passes the plain object it was given, whose boxes are another instance's or none.
          if (!builtFromWire.has(payload.value as object)) {
            throw new Error(takesAnInstance);
          }
          super(input, options);
        } else {
          // `make`: check each `$` field's value, taken under its wire key, then build its box in the model's realm.
          const given = input ?? {};
          const picked: Record<string, unknown> = { realm: given["realm"] };
          const built: Record<string, unknown> = { ...given };
          for (const [index, key] of heldKeys.entries()) {
            const wireKey = heldWireKeys[index] as string;
            // A box passed in, or spread from another instance, would be shared with its owner.
            if (Object.hasOwn(given, key)) {
              throw new Error(
                `pinna: ${identifier}.make takes the value of ${key} under "${wireKey}", never a box under "${key}"`,
              );
            }
            if (Object.hasOwn(given, wireKey)) {
              picked[wireKey] = given[wireKey];
              delete built[wireKey];
            }
          }
          // `disableChecks` skips Effect's checks of plain fields, never the first value of a box, which checks every value it holds.
          const values = madeValues.make(
            picked,
            options === undefined ? undefined : { ...options, disableChecks: false },
          ) as Readonly<Record<string, unknown>>;
          const realm = realmOfService(values["realm"]);
          for (const [index, key] of heldKeys.entries()) {
            built[key] = (heldCodecs[index] as FieldCodec).make(
              realm,
              values[heldWireKeys[index] as string],
            );
          }
          super(built, options);
        }
        // Both branches built every box in the instance's realm, so none is another realm's or another instance's.
        for (const key of heldKeys) {
          // A `$` field is the box itself: replacing it would leave its readers on the old one.
          Object.defineProperty(this, key, { writable: false, configurable: false });
        }
      }
      /**
       * Plans the merge of `fresh`, a refetch of this instance: `false` when
       * `fresh` is another class's or another realm's, or differs in a plain
       * field (or `[Equal.symbol]` says it differs); otherwise the writes
       * that bring each box here to its value in `fresh`.
       */
      [mergeKey](fresh: unknown): MergeWrites | false {
        if (
          typeof fresh !== "object" ||
          fresh === null ||
          fresh.constructor !== this.constructor ||
          (fresh as Record<string, unknown>)["realm"] !== this["realm"]
        ) {
          return false;
        }
        const keep = Equal.isEqual(this)
          ? this[Equal.symbol](fresh as Equal.Equal)
          : samePlainFields(this, fresh);
        if (!keep) {
          return false;
        }
        let writes: Array<() => void> | undefined;
        for (const [index, key] of heldKeys.entries()) {
          const write = (heldCodecs[index] as FieldCodec).merge(
            this[key],
            (fresh as Record<string, unknown>)[key],
          );
          if (write !== undefined) {
            writes ??= [];
            writes.push(write);
          }
        }
        if (writes === undefined) {
          return undefined;
        }
        const all = writes;
        return () => {
          for (const write of all) {
            write();
          }
        };
      }
      static make(input?: Readonly<Record<string, unknown>>, options?: Schema.MakeOptions): object {
        // biome-ignore lint/complexity/noThisInStatic: `this` is the subclass the application declared, which make builds.
        return input instanceof this ? input : new this(input, options);
      }
      static extend(): never {
        return sealed("extend", anotherModel);
      }
      static mapFields(): never {
        return sealed("mapFields", anotherModel);
      }
      static makeOption(): never {
        return sealed("makeOption", makeInstead);
      }
      static makeEffect(): never {
        return sealed("makeEffect", makeInstead);
      }
      static get ast(): Schema.Top["ast"] {
        // biome-ignore lint/complexity/noThisInStatic: `this` is the subclass the application declared.
        let ast = astsByConstructor.get(this);
        if (ast === undefined) {
          // biome-ignore lint/complexity/noThisInStatic: `this` is the subclass whose schema is being built.
          const base = baseAst(this);
          // Effect's class schema decodes its struct, then builds the instance without checking it again.
          const trusted = base.encoding?.[0]?.transformation;
          if (base.encoding?.length !== 1 || !SchemaTransformation.isTransformation(trusted)) {
            throw new Error(
              "pinna: Schema.Class no longer builds its instance in one transformation",
            );
          }
          // The class declaration alone: decoding into it checks the instance and parses nothing.
          // Another schema's `make` keeps an instance and fails anything else with `takesAnInstance`.
          const instance = Schema.make<Schema.Top>(SchemaAST.toType(base)).annotate({
            // Effect's key, left out of its types, for how `make` builds a class it is handed fields for.
            "~constructor": () => ({
              // biome-ignore lint/complexity/noThisInStatic: `this` is the subclass the application declared.
              isConstructed: (input: unknown) => input instanceof this,
              link: new SchemaAST.Link(SchemaAST.unknown, notAnInstance),
            }),
          } as never);
          ast = wireObject
            .pipe(Schema.decodeTo(Schema.Struct(wireFields), noRealm as never))
            .pipe(Schema.decodeTo(wireObject, fromWire as never))
            .pipe(Schema.decodeTo(instance, trusted as never)).ast;
          // biome-ignore lint/complexity/noThisInStatic: the cache is keyed by the subclass the application declared.
          astsByConstructor.set(this, ast);
        }
        return ast;
      }
    }
    // The instance type carries ClassInstance, so a draft leaves its fields read-only.
    return PinnaClass as unknown as Schema.Class<
      Self,
      ClassStruct<typeof allFields, Fields>,
      ClassInstance
    > &
      Sealed;
  };

/**
 * The statics a model does not have: `extend` and `mapFields` would declare
 * fields without the checks above, and `makeOption` and `makeEffect` would
 * take boxes where `make` takes values.
 */
interface Sealed {
  readonly extend: never;
  readonly mapFields: never;
  readonly makeOption: never;
  readonly makeEffect: never;
}

/** The fields under their wire keys: `$name` becomes `name`. */
type WireFields<Fields extends Schema.Struct.Fields> = {
  readonly [Key in keyof Fields as Key extends `$${infer Name}` ? Name : Key]: Fields[Key];
};

/**
 * The class's struct, with the encoded type that is on the wire (wire keys,
 * and no `realm`), and the input `make` takes: wire keys, and the realm.
 */
type ClassStruct<
  AllFields extends Schema.Struct.Fields,
  Fields extends Schema.Struct.Fields,
> = Omit<Schema.Struct<AllFields>, "Encoded" | "~type.make.in"> & {
  readonly Encoded: Schema.Struct.Encoded<WireFields<Fields>>;
  readonly "~type.make.in": Schema.Struct.MakeIn<WireFields<Fields>> & { readonly realm: Realm };
};
