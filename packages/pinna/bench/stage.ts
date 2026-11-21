/**
 * Stage benchmark on Bun: what a stage costs over the update it replaces.
 * A refetch of `rows` rows lands through `update` once, and through a stage
 * twice, staged and replayed; a refetch of `SchemaModel` rows merges into
 * the held instances in both passes. A computed value read through a stage
 * runs outside the graph, cached until the stage or the realm changes.
 * Times are medians of `runs` runs, in milliseconds; no ceilings, so it
 * reports and never fails.
 *
 * bun run bench:stage
 */
import { BoxField, CollectionField, decode, SchemaModel } from "@frondruntime/pinna-effect";
import { Schema } from "effect";
import {
  applyStage,
  box,
  collection,
  computed,
  createRealm,
  openStage,
  stageRead,
  stageUpdate,
  untracked,
  update,
} from "../src/index.ts";

const rows = 10_000;
const runs = 15;

const median = (samples: ReadonlyArray<number>): number => {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] as number;
};

/** The median time of `measure`, after `prepare` builds a fresh state for each run. */
const time = <State>(prepare: () => State, measure: (state: State) => void): number => {
  const samples: Array<number> = [];
  for (let run = 0; run < runs + 2; run++) {
    const state = prepare();
    const start = performance.now();
    measure(state);
    const elapsed = performance.now() - start;
    // The first two runs warm the JIT.
    if (run >= 2) {
      samples.push(elapsed);
    }
  }
  return median(samples);
};

interface Row {
  readonly id: number;
  readonly price: number;
}

const plainRows = (offset: number): ReadonlyArray<Row> =>
  Array.from({ length: rows }, (_, index) => ({ id: index, price: index + offset }));

const plainState = () => {
  const realm = createRealm();
  const $rows = collection<number, Row>(realm, { keyOf: (row) => row.id, name: "rows" });
  update(realm, (_read, write) => {
    write.replaceAll($rows, plainRows(0));
  });
  return { realm, $rows, next: plainRows(1) };
};

class Quote extends SchemaModel<Quote>("Quote")({
  id: Schema.Number,
  symbol: Schema.String,
  $price: BoxField(Schema.Number),
}) {}

class Book extends SchemaModel<Book>("Book")({
  $quotes: CollectionField(Quote, { keyOf: (quote) => quote.id, name: "quotes" }),
}) {}

const quotesJson = (offset: number) =>
  Array.from({ length: rows }, (_, id) => ({ id, symbol: `S${id}`, price: id + offset }));

const schemaState = () => {
  const realm = createRealm();
  const book = decode(realm, Book)({ quotes: quotesJson(0) });
  // Decoded before the stage: a recipe that decodes would make the instances twice.
  const fresh = decode(realm, Book)({ quotes: quotesJson(1) });
  const next = untracked(realm, (read) => read(fresh.$quotes.rows));
  return { realm, book, next };
};

const results: Array<readonly [string, number]> = [];

results.push([
  `replaceAll of ${rows} rows, update`,
  time(plainState, ({ realm, $rows, next }) => {
    update(realm, (_read, write) => {
      write.replaceAll($rows, next);
    });
  }),
]);

results.push([
  `replaceAll of ${rows} rows, stage and apply`,
  time(plainState, ({ realm, $rows, next }) => {
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write.replaceAll($rows, next);
    });
    applyStage(stage);
  }),
]);

results.push([
  `refetch of ${rows} SchemaModel rows, update (merge)`,
  time(schemaState, ({ realm, book, next }) => {
    update(realm, (_read, write) => {
      write.replaceAll(book.$quotes, next);
    });
  }),
]);

results.push([
  `refetch of ${rows} SchemaModel rows, stage and apply (merge twice)`,
  time(schemaState, ({ realm, book, next }) => {
    const stage = openStage(realm);
    stageUpdate(stage, (_read, write) => {
      write.replaceAll(book.$quotes, next);
    });
    applyStage(stage);
  }),
]);

const sumState = () => {
  const state = plainState();
  const $sum = computed(state.realm, (read) =>
    read(state.$rows.rows).reduce((total, row) => total + row.price, 0),
  );
  const $tax = box(state.realm, 0);
  return { ...state, $sum, $tax };
};

results.push([
  `computed sum over ${rows} rows, read 100 times through a stage (cached)`,
  time(sumState, ({ realm, $sum }) => {
    const stage = openStage(realm);
    for (let read = 0; read < 100; read++) {
      stageRead(stage, (stagedRead) => stagedRead($sum));
    }
  }),
]);

results.push([
  `computed sum over ${rows} rows, 100 writes each followed by a read through a stage`,
  time(sumState, ({ realm, $sum, $tax }) => {
    const stage = openStage(realm);
    for (let round = 0; round < 100; round++) {
      stageUpdate(stage, (_read, write) => {
        write($tax, round);
      });
      stageRead(stage, (stagedRead) => stagedRead($sum));
    }
  }),
]);

console.log("| Scenario | Median, ms |");
console.log("| --- | --- |");
for (const [scenario, milliseconds] of results) {
  console.log(`| ${scenario} | ${milliseconds.toFixed(2)} |`);
}
