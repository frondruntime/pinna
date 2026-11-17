/**
 * What a variant gives the harness: its state behind one interface, and the
 * screen that renders it. Every store takes the plain rows the harness
 * converted from the wire, timed apart from it, so the store column is the
 * library's write alone.
 */
import type { ComponentType } from "react";
import type { DetailsTexts, RowTexts } from "../data/format.ts";
import type { PlainRow, PlainTick } from "../data/plain.ts";

export interface Store {
  /** The first fetch: hold the rows. */
  readonly load: (rows: ReadonlyArray<PlainRow>) => void;
  /** A socket tick: new price, change, and time for some rows. */
  readonly tick: (updates: ReadonlyArray<PlainTick>) => void;
  /** A refetch swapped in whole: every row is new. */
  readonly replace: (rows: ReadonlyArray<PlainRow>) => void;
  /**
   * A refetch merged into the rows already held: a row whose other fields
   * did not change stays the same row, with its tick fields written, and any
   * other row is new.
   */
  readonly merge: (rows: ReadonlyArray<PlainRow>) => void;
  /** New rows at the top, in one change to the list. */
  readonly insert: (rows: ReadonlyArray<PlainRow>) => void;
  /** Rows gone, in one change to the list. */
  readonly remove: (ids: ReadonlyArray<string>) => void;
  /** New rows at the top, one call per row. */
  readonly insertEach?: (rows: ReadonlyArray<PlainRow>) => void;
  /** Rows gone, one call per row. */
  readonly removeEach?: (ids: ReadonlyArray<string>) => void;
  /** Opens the details of a row, or closes them with `undefined`. */
  readonly select: (id: string | undefined) => void;
  readonly size: () => number;
  readonly idAt: (index: number) => string;
  /**
   * What the row shows, read the way its components read it; `undefined`
   * once the row is gone. The conformance test compares it across stores.
   */
  readonly shownRow: (id: string) => RowTexts | undefined;
  /** What the details screen shows for a row. */
  readonly shownDetails: (id: string) => DetailsTexts | undefined;
}

export interface Variant {
  readonly name: string;
  readonly make: () => { readonly store: Store; readonly Screen: ComponentType };
}
