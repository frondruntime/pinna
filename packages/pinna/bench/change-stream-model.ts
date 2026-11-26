/**
 * What the change stream costs, on any engine: one write per update to a
 * box, one row upsert per update into a collection of 10,000 rows, and one
 * replaceAll of 1,000 rows, each with no `Realm.onUpdate` listener and with
 * one. `change-stream.ts` runs it on Bun, `hermes-changes.ts` on Hermes.
 *
 * The listener counts records and keeps none, so the listener column less
 * the plain column bounds from above what building and freezing the records
 * costs: it also holds the call to the listener.
 */
import { Box, Collection, Realm } from "../src/index.ts";
import type { Host } from "./graph-model.ts";

interface Row {
  readonly id: number;
  readonly value: number;
}

/** One scenario at one setting: nanoseconds and, where the host counts them, bytes per update. */
export interface PerUpdate {
  readonly nanoseconds: number;
  readonly bytes?: number;
}

/** The scenarios of the change stream, each run with no listener and with one. */
export const scenarioNames = [
  "box write",
  "row upsert, 10,000 rows",
  "replaceAll, 1,000 rows",
] as const;

export type ScenarioName = (typeof scenarioNames)[number];

const rounds = 7;

const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] as number;
};

const time = (host: Host, count: number, run: (index: number) => void): PerUpdate => {
  const nanoseconds: Array<number> = [];
  const bytes: Array<number> = [];
  for (let round = 0; round < rounds; round++) {
    host.collect();
    const allocatedBefore = host.allocated?.() ?? 0;
    const start = host.now();
    for (let index = 0; index < count; index++) run(index);
    nanoseconds.push(((host.now() - start) * 1e6) / count);
    if (host.allocated !== undefined) bytes.push((host.allocated() - allocatedBefore) / count);
  }
  return bytes.length === 0
    ? { nanoseconds: median(nanoseconds) }
    : { nanoseconds: median(nanoseconds), bytes: median(bytes) };
};

const scenarios: Record<ScenarioName, (host: Host, listening: boolean) => PerUpdate> = {
  "box write": (host, listening) => {
    const realm = Realm.make();
    const $count = Box.make(realm, 0);
    let records = 0;
    if (listening) Realm.onUpdate(realm, () => void records++);
    return time(host, 200_000, (index) => {
      Realm.update(realm, (_read, write) => write($count, index + 1));
    });
  },
  "row upsert, 10,000 rows": (host, listening) => {
    const realm = Realm.make();
    const rows = Collection.make(realm, { keyOf: (row: Row) => row.id });
    Realm.update(realm, (_read, write) =>
      write.replaceAll(
        rows,
        Array.from({ length: 10_000 }, (_, id) => ({ id, value: 0 })),
      ),
    );
    let records = 0;
    if (listening) Realm.onUpdate(realm, () => void records++);
    return time(host, 50_000, (index) => {
      Realm.update(realm, (_read, write) =>
        write.upsert(rows, { id: index % 10_000, value: index + 1 }),
      );
    });
  },
  "replaceAll, 1,000 rows": (host, listening) => {
    const realm = Realm.make();
    const rows = Collection.make(realm, { keyOf: (row: Row) => row.id });
    let records = 0;
    if (listening) Realm.onUpdate(realm, () => void records++);
    return time(host, 500, (index) => {
      Realm.update(realm, (_read, write) =>
        write.replaceAll(
          rows,
          Array.from({ length: 1_000 }, (_, id) => ({ id, value: index })),
        ),
      );
    });
  },
};

/** One scenario with no listener and with one, after a warmup run of each. */
export const measure = (
  name: ScenarioName,
  host: Host,
): { readonly plain: PerUpdate; readonly listened: PerUpdate } => {
  const run = scenarios[name];
  run(host, false);
  run(host, true);
  return { plain: run(host, false), listened: run(host, true) };
};

/** The table both runners print. */
export const report = (
  title: string,
  results: Record<ScenarioName, { readonly plain: PerUpdate; readonly listened: PerUpdate }>,
): string => {
  const counted = Object.values(results).some((result) => result.plain.bytes !== undefined);
  const header = counted
    ? "| Scenario | No listener (ns/update) | One listener (ns/update) | No listener (bytes/update) | One listener (bytes/update) |"
    : "| Scenario | No listener (ns/update) | One listener (ns/update) |";
  const lines = [
    title,
    "",
    header,
    counted ? "| --- | --- | --- | --- | --- |" : "| --- | --- | --- |",
  ];
  for (const name of scenarioNames) {
    const { plain, listened } = results[name];
    const cells = [name, plain.nanoseconds.toFixed(0), listened.nanoseconds.toFixed(0)];
    if (counted) cells.push((plain.bytes ?? 0).toFixed(0), (listened.bytes ?? 0).toFixed(0));
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
};
