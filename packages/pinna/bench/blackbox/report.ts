/** The black-box results as one table. */
import type { Result } from "./harness.ts";

const fixed = (value: number | undefined, digits: number): string =>
  value === undefined ? "–" : value.toFixed(digits);

export const report = (results: ReadonlyArray<Result>, title: string): string => {
  const lines = [
    `## ${title}`,
    "",
    "| Scenario | Steps | Build ms | Median ms | Quarter medians ms | p99 ms | Max ms | B/step | Live KB (build, 25/50/75/100%) | Growth KB/1k | After dispose KB | GCs (ms) |",
    "| --- | --: | --: | --: | --- | --: | --: | --: | --- | --: | --: | --: |",
  ];
  for (const result of results) {
    lines.push(
      `| ${result.name} | ${result.steps} | ${fixed(result.buildMs, 1)} | ${fixed(result.medianMs, 3)} | ${result.quarterMedianMs.map((value) => fixed(value, 3)).join(" / ")} | ${fixed(result.p99Ms, 3)} | ${fixed(result.maxMs, 2)} | ${result.bytesPerStep ?? "–"} | ${result.liveKB.join(" / ")} | ${result.growthPer1kKB} | ${result.afterDisposeKB} | ${result.collections === undefined ? "–" : `${result.collections.count} (${result.collections.totalMs})`} |`,
    );
  }
  return lines.join("\n");
};
