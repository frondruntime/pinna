/** pinna's `Box` module, with `Box.schema`, a box that checks a schema. */
import { Box as PlainBox, type BoxModule as PlainBoxModule } from "@frondruntime/pinna";
import { schemaBox } from "../box.ts";

/** A box: one value that `read` tracks and `write` replaces. */
export type Box<Value> = PlainBox<Value>;

export interface BoxModule extends PlainBoxModule {
  /** Makes a box that holds only values `schema` accepts. */
  readonly schema: typeof schemaBox;
}

export const Box: BoxModule = { ...PlainBox, schema: schemaBox };
