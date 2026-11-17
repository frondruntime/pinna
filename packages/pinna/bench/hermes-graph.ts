/**
 * Graph benchmark on Hermes: the scenarios in `graph-model.ts`, compiled the
 * way a React Native release build compiles them (`hermes-toolchain.ts`),
 * each library in its own Hermes process. Hermes counts every byte it
 * allocates, garbage included, so this table also has allocation. No
 * ceilings yet.
 *
 * bun bench/hermes-graph.ts <hermes-ios destroot>
 */
import { join } from "node:path";
import {
  type LibraryName,
  libraries,
  type Measured,
  type Measurement,
  measureAll,
  report,
} from "./graph-model.ts";
import { hermesFrom, lowerForHermes, runOnHermes } from "./hermes-toolchain.ts";

const destroot = hermesFrom("bun bench/hermes-graph.ts <hermes-ios destroot>");
const lowered = await lowerForHermes(join(import.meta.dir, "hermes-graph-entry.ts"));

const names = Object.keys(libraries) as Array<LibraryName>;
const results = Object.fromEntries(
  names.map((name) => [
    name,
    measureAll(
      (from) => JSON.parse(runOnHermes(destroot, lowered, `${name}@${from}`)) as Measurement,
    ),
  ]),
) as Record<LibraryName, Record<string, Measured>>;

console.log(report(results, `Hermes (${destroot})`));
