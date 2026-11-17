/**
 * Hooks benchmark: `hooks-model.ts` on Bun, in this process, then on
 * Hermes, compiled the way a React Native release build compiles it
 * (`hermes-toolchain.ts`), each subject in its own Hermes process. Hermes
 * counts every byte it allocates, garbage included.
 *
 * bun bench/hermes-hooks.ts <hermes-ios destroot>
 */
import { join } from "node:path";
import type { Measured } from "./graph-model.ts";
import { hermesFrom, lowerForHermes, runOnHermes } from "./hermes-toolchain.ts";
import { measure, type SubjectName, subjects } from "./hooks-model.ts";

const destroot = hermesFrom("bun bench/hermes-hooks.ts <hermes-ios destroot>");
const names = Object.keys(subjects) as Array<SubjectName>;

const table = (
  title: string,
  results: Record<SubjectName, Record<string, Measured>>,
  cell: (measured: Measured) => string,
): string => {
  const header = ["", ...names];
  const lines = [
    title,
    "",
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
  ];
  for (const scenario of Object.keys(results[names[0] as SubjectName])) {
    const cells = names.map((name) => {
      const measured = results[name][scenario];
      return measured === undefined ? "" : cell(measured);
    });
    lines.push(`| ${scenario} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
};

const time = (measured: Measured): string =>
  `${measured.minimum.toFixed(2)} / ${measured.median.toFixed(2)}`;

const onBun = Object.fromEntries(
  names.map((name) => [
    name,
    measure(name, { now: () => performance.now(), collect: () => Bun.gc(true) }),
  ]),
) as Record<SubjectName, Record<string, Measured>>;
console.log(table(`Bun ${Bun.version}: minimum / median ms of 9 runs`, onBun, time), "\n");

const lowered = await lowerForHermes(join(import.meta.dir, "hermes-hooks-entry.ts"));
const onHermes = Object.fromEntries(
  names.map((name) => [
    name,
    JSON.parse(runOnHermes(destroot, lowered, name)) as Record<string, Measured>,
  ]),
) as Record<SubjectName, Record<string, Measured>>;
console.log(table(`Hermes (${destroot}): minimum / median ms of 9 runs`, onHermes, time), "\n");
console.log(
  table("Hermes: KB allocated by one run, median", onHermes, (measured) =>
    ((measured.bytes ?? 0) / 1024).toFixed(0),
  ),
);
