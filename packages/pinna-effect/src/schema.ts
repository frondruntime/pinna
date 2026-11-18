/**
 * What a schema says about a box: the check a write runs, and the equality
 * a write compares with. Both are built once per schema and shared by every
 * box of it.
 */

import type { Equals } from "@frondruntime/pinna";
import { acceptAll, type Check, type Rejection } from "@frondruntime/pinna/internal";
import { Schema, SchemaAST } from "effect";

const wholeCheckOf = (schema: Schema.Top): ((value: unknown) => Rejection | undefined) => {
  const is = Schema.is(schema);
  const decode = Schema.decodeUnknownResult(Schema.toType(schema));
  return (value) => {
    if (is(value)) {
      return undefined;
    }
    const result = decode(value);
    return result._tag === "Failure"
      ? { message: result.failure.message, cause: result.failure }
      : { message: "rejected", cause: undefined };
  };
};

/**
 * The element schema of a plain `Schema.Array(element)`: no fixed elements,
 * no check on the array itself. Any other array is checked whole.
 */
const elementOf = (schema: Schema.Top): Schema.Top | undefined => {
  const ast = SchemaAST.toType(schema.ast);
  if (
    !SchemaAST.isArrays(ast) ||
    ast.elements.length > 0 ||
    ast.rest.length !== 1 ||
    ast.checks !== undefined
  ) {
    return undefined;
  }
  return Schema.make(ast.rest[0] as SchemaAST.AST);
};

/**
 * How far `value` moved against `previous`: `k` when it dropped `k` elements
 * from the front, `-k` when it added `k` there, `0` otherwise. A repeated
 * element can mislead it, so the check also skips an element still at its
 * own index: it never checks more than it would without the shift.
 */
const shiftOf = (value: ReadonlyArray<unknown>, previous: ReadonlyArray<unknown>): number => {
  if (value.length === 0 || previous.length === 0 || value[0] === previous[0]) {
    return 0;
  }
  const dropped = previous.indexOf(value[0]);
  if (dropped > 0) {
    return dropped;
  }
  const added = value.indexOf(previous[0]);
  return added > 0 ? -added : 0;
};

/**
 * Values are never changed in place, so an element still in a value the
 * check accepted was checked when it landed. An array box checks only the
 * elements a write put there: a push onto 10,000 rows checks one, and so
 * does dropping the oldest row of a capped list to append one.
 */
export const checkOf = (schema: Schema.Top): Check => {
  let check = checks.get(schema);
  if (check === undefined) {
    check = buildCheck(schema);
    checks.set(schema, check);
  }
  return check;
};

/**
 * The checks `checkOf` built, one per schema. A check keeps no state of its
 * own, so every box of one schema shares it: `box` builds none.
 */
const checks = new WeakMap<Schema.Top, Check>();

const buildCheck = (schema: Schema.Top): Check => {
  const ast = SchemaAST.toType(schema.ast);
  if ((ast._tag === "Unknown" || ast._tag === "Any") && ast.checks === undefined) {
    return acceptAll;
  }
  const whole = wholeCheckOf(schema);
  const element = elementOf(schema);
  if (element === undefined) {
    return whole;
  }
  const checkElement = wholeCheckOf(element);
  return (value, previous) => {
    if (!Array.isArray(value) || !Array.isArray(previous)) {
      return whole(value);
    }
    const shift = shiftOf(value, previous);
    for (let index = 0; index < value.length; index++) {
      const item: unknown = value[index];
      const was = index + shift;
      if (was >= 0 && was < previous.length && Object.is(item, previous[was])) {
        continue;
      }
      if (shift !== 0 && index < previous.length && Object.is(item, previous[index])) {
        continue;
      }
      const problem = checkElement(item);
      if (problem !== undefined) {
        return { message: `at [${index}]: ${problem.message}`, cause: problem.cause };
      }
    }
    return undefined;
  };
};

/** The schema types whose values are all primitives. */
const primitiveTags: ReadonlySet<string> = new Set([
  "Null",
  "Undefined",
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "Symbol",
  "UniqueSymbol",
  "Literal",
  "Enum",
  "TemplateLiteral",
]);

/**
 * `Equal.equals` on two primitives: the same value, or both NaN. It takes
 * no `arguments`, which Hermes allocates on every call.
 */
const samePrimitive = (self: unknown, that: unknown): boolean =>
  self === that ||
  (typeof self === "number" &&
    typeof that === "number" &&
    Number.isNaN(self) &&
    Number.isNaN(that));

/**
 * `Equal.equals` on two Dates: the same time, or both invalid. `Equal.equals`
 * hashes both through their ISO strings and caches the pair in a WeakMap,
 * which costs microseconds on a Date the decode or the write just made.
 */
const sameDate = (self: unknown, that: unknown): boolean => {
  if (self === that) {
    return true;
  }
  if (!(self instanceof Date) || !(that instanceof Date)) {
    return false;
  }
  const selfTime = self.getTime();
  const thatTime = that.getTime();
  return selfTime === thatTime || (Number.isNaN(selfTime) && Number.isNaN(thatTime));
};

type Equivalence = (self: unknown, that: unknown) => boolean;

/** The equivalences `equivalenceOf` built, one per type-side AST node. */
const equivalences = new WeakMap<SchemaAST.AST, Equivalence>();

/**
 * Effect's `Schema.toEquivalence`, with the same answers, built so that the
 * leaves a row is made of skip `Equal.equals`: a Date compares its times, a
 * primitive its values. Arrays and structs walk their parts as Effect does,
 * and a declaration's own equivalence, such as a class's, gets these for its
 * type parameters. Anything else is Effect's.
 */
const equivalenceOf = (ast: SchemaAST.AST): Equivalence => {
  let equivalence = equivalences.get(ast);
  if (equivalence === undefined) {
    equivalence = buildEquivalence(ast);
    equivalences.set(ast, equivalence);
  }
  return equivalence;
};

const effectEquivalence = (ast: SchemaAST.AST): Equivalence =>
  Schema.toEquivalence(Schema.make(ast) as Schema.Schema<unknown>);

const buildEquivalence = (ast: SchemaAST.AST): Equivalence => {
  const own = SchemaAST.resolve(ast)?.["toEquivalence"] as
    | ((parameters: ReadonlyArray<Equivalence>) => Equivalence)
    | undefined;
  if (own !== undefined) {
    const equivalence = own(
      SchemaAST.isDeclaration(ast) ? ast.typeParameters.map(equivalenceOf) : [],
    );
    // An equivalence is reflexive, so the same value needs no walk.
    return (self, that) => self === that || equivalence(self, that);
  }
  if (primitiveTags.has(ast._tag)) {
    return samePrimitive;
  }
  switch (ast._tag) {
    case "Declaration": {
      const representation = (
        ast.annotations as { readonly representation?: { readonly id?: unknown } } | undefined
      )?.representation;
      return representation?.id === "effect/schema/Date" ? sameDate : effectEquivalence(ast);
    }
    case "Arrays": {
      if (ast.elements.length > 0 || ast.rest.length !== 1) {
        return effectEquivalence(ast);
      }
      const element = equivalenceOf(ast.rest[0] as SchemaAST.AST);
      return (self, that) => {
        if (self === that && Array.isArray(self)) {
          return true;
        }
        if (!Array.isArray(self) || !Array.isArray(that) || self.length !== that.length) {
          return false;
        }
        for (let index = 0; index < self.length; index++) {
          if (!element(self[index], that[index])) {
            return false;
          }
        }
        return true;
      };
    }
    case "Objects": {
      if (ast.propertySignatures.length === 0 || ast.indexSignatures.length > 0) {
        return effectEquivalence(ast);
      }
      // Parallel arrays and an index loop: Hermes runs `for...of` through an iterator.
      const names = ast.propertySignatures.map((property) => property.name);
      const optional = ast.propertySignatures.map((property) =>
        SchemaAST.isOptional(property.type),
      );
      const fields = ast.propertySignatures.map((property) => equivalenceOf(property.type));
      const count = names.length;
      return (self, that) => {
        if (!isObjectLike(self) || !isObjectLike(that)) {
          return false;
        }
        if (self === that) {
          return true;
        }
        for (let index = 0; index < count; index++) {
          const name = names[index] as PropertyKey;
          const selfHas = Object.hasOwn(self, name);
          const thatHas = Object.hasOwn(that, name);
          if (optional[index] === true && selfHas !== thatHas) {
            return false;
          }
          if (
            selfHas &&
            thatHas &&
            !(fields[index] as Equivalence)(
              (self as Record<PropertyKey, unknown>)[name],
              (that as Record<PropertyKey, unknown>)[name],
            )
          ) {
            return false;
          }
        }
        return true;
      };
    }
    default:
      return effectEquivalence(ast);
  }
};

/** Effect's `Predicate.isObjectKeyword`, an object or a function, written out so Hermes pays no call. */
const isObjectLike = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function";

/**
 * The default equality of a box: what its schema counts as the same value.
 * A schema that says nothing of the value's shape (`Schema.Unknown`,
 * `Schema.Any`, `Schema.ObjectKeyword`) compares by identity: Effect's
 * structural fallback would hash the whole value on every write. Any other schema
 * compares as `Schema.toEquivalence` does, without its `Equal.equals` on
 * Dates and primitives; see `equivalenceOf`.
 */
export const equalsOf = <Value>(schema: Schema.Top): Equals<Value> => {
  let equals = equalities.get(schema);
  if (equals === undefined) {
    const ast = SchemaAST.toType(schema.ast);
    equals =
      ast._tag === "Unknown" || ast._tag === "Any" || ast._tag === "ObjectKeyword"
        ? Object.is
        : equivalenceOf(ast);
    equalities.set(schema, equals);
  }
  return equals;
};

/** The equivalences `equalsOf` returned, one per schema, so a box skips the AST walk. */
const equalities = new WeakMap<Schema.Top, Equivalence>();
