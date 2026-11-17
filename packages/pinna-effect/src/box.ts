import type { Box, Options, Realm } from "@frondruntime/pinna";
import { makeBox } from "@frondruntime/pinna/internal";
import type { Schema } from "effect";
import { checkOf, equalsOf } from "./schema.ts";

/**
 * A box of values `schema` accepts, starting at `initial`. A write the schema
 * rejects throws and rolls its update back; values compare with the schema's
 * equivalence unless `options.equals` says otherwise.
 */
export const schemaBox = <S extends Schema.Top>(
  realm: Realm,
  schema: S,
  initial: S["Type"],
  options?: Options<S["Type"]>,
): Box<S["Type"]> =>
  makeBox(realm, checkOf(schema), options?.equals ?? equalsOf(schema), initial, options?.name);
