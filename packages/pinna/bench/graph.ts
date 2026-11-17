/**
 * Graph benchmark on Bun: the scenarios in `graph-model.ts`, each library in
 * its own process so JIT state does not leak between them. No ceilings: the
 * table is read next to Hermes's (`hermes-graph.ts`).
 *
 * bun bench/graph.ts
 */
import {
  type Host,
  type LibraryName,
  libraries,
  type Measured,
  type Measurement,
  measure,
  measureAll,
  report,
} from "./graph-model.ts";

const bun: Host = {
  now: () => performance.now(),
  collect: () => Bun.gc(true),
};

const requested = process.argv[2];

if (requested === undefined) {
  const names = Object.keys(libraries) as Array<LibraryName>;
  const results = Object.fromEntries(
    names.map((name) => [
      name,
      measureAll((from) => {
        const child = Bun.spawnSync([
          process.execPath,
          ...process.execArgv,
          import.meta.path,
          name,
          String(from),
        ]);
        if (child.exitCode !== 0) {
          throw new Error(`${name} failed:\n${child.stderr.toString()}`);
        }
        return JSON.parse(child.stdout.toString()) as Measurement;
      }),
    ]),
  ) as Record<LibraryName, Record<string, Measured>>;
  console.log(report(results, `Bun ${Bun.version}`));
} else {
  const make = libraries[requested as LibraryName];
  if (make === undefined) {
    throw new Error(`bench: no library ${requested}`);
  }
  console.log(JSON.stringify(measure(make, bun, Number(process.argv[3] ?? 0))));
}
