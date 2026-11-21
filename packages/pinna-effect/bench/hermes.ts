/**
 * Data benchmark on Hermes: the subjects in `data-model.ts`, compiled the way
 * a React Native release build compiles them (`hermes-toolchain.ts`), each
 * subject in its own Hermes process. Nothing here fails on a ratio yet: the
 * table is read next to Bun's.
 *
 * bun bench/hermes.ts <hermes-ios destroot>
 */
import { join } from "node:path";
import { hermesFrom, lowerForHermes, runOnHermes } from "../../pinna/bench/hermes-toolchain.ts";
import { subjects } from "./data-model.ts";

const destroot = hermesFrom("bun bench/hermes.ts <hermes-ios destroot>");
const lowered = await lowerForHermes(join(import.meta.dir, "hermes-entry.ts"));

const names = Object.keys(subjects) as Array<keyof typeof subjects>;
const results = Object.fromEntries(
  names.map((name) => [
    name,
    JSON.parse(runOnHermes(destroot, lowered, name)) as Record<string, string>,
  ]),
) as Record<keyof typeof subjects, Record<string, string>>;

const ratio = (
  over: keyof typeof subjects,
  under: keyof typeof subjects,
  scenario: string,
): string => {
  const value =
    Number.parseFloat(results[over][scenario] ?? "") /
    Number.parseFloat(results[under][scenario] ?? "");
  return Number.isFinite(value) ? `${value.toFixed(2)}×` : "";
};

const header = ["", "MobX", "Pinna, bare", "Pinna, Effect Schema", "bare ÷ MobX", "schema ÷ bare"];
console.log(`| ${header.join(" | ")} |`);
console.log(`| ${header.map(() => "---").join(" | ")} |`);
for (const scenario of Object.keys(results.mobx)) {
  const cells = names.map((name) => results[name][scenario]);
  const ratios = [
    ratio("pinna-bare", "mobx", scenario),
    ratio("pinna-schema", "pinna-bare", scenario),
  ];
  console.log(`| ${scenario} | ${[...cells, ...ratios].join(" | ")} |`);
}
