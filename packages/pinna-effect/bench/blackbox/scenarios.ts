/** Every black-box scenario, by name. */
import { appScenarios } from "./app.ts";
import type { Scenario } from "./harness.ts";
import { leakScenarios } from "./leaks.ts";
import { shapeScenarios } from "./shapes.ts";

export const scenarios: ReadonlyArray<Scenario> = [
  ...leakScenarios,
  ...appScenarios,
  ...shapeScenarios,
];

export const scenarioNamed = (name: string): Scenario => {
  const scenario = scenarios.find((candidate) => candidate.name === name);
  if (scenario === undefined) {
    throw new Error(`blackbox: no scenario named ${name}`);
  }
  return scenario;
};
