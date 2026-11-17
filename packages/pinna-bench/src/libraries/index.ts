import type { Adapter, CheckedAdapter, Library, LibraryName } from "../adapter.ts";
import { alien } from "./alien.ts";
import { legend } from "./legend.ts";
import { mobx } from "./mobx.ts";
import { pinna } from "./pinna.ts";

/** Every library the scenarios run, by name, in the order tables list them. */
export const libraries: Readonly<Record<LibraryName, Library<Adapter>>> = {
  pinna,
  "alien-signals": alien,
  mobx,
  legend,
};

export const libraryNames = Object.keys(libraries) as ReadonlyArray<LibraryName>;

/** The libraries the conformance cases check. */
export const checked: ReadonlyArray<Library<CheckedAdapter>> = [pinna, alien, mobx];
