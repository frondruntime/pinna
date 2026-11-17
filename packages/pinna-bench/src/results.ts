/**
 * The results file: everything a published number rests on. Raw samples are
 * kept, so a table can be recomputed and a reader can check the statistics.
 * The command line writes it; nothing in the workers reads it.
 */
import { Schema } from "effect";

export const Tier = Schema.Literals(["rough", "publish"]);
export type Tier = typeof Tier.Type;

export const RuntimeName = Schema.Literals(["node", "hermes"]);
export type RuntimeName = typeof RuntimeName.Type;

/** What one worker process printed: a cell's samples, or why it stopped. */
export const Response = Schema.Union([
  Schema.TaggedStruct("Measured", {
    /** Milliseconds per sample, warm-up first. */
    times: Schema.Array(Schema.Number),
    /**
     * Bytes allocated per sample, warm-up first, where the runtime counts
     * them. On Node they come from a launch of their own with
     * --no-inline-new, so there can be fewer of them than of `times`.
     */
    bytes: Schema.optionalKey(Schema.Array(Schema.Number)),
    /** How many of `times` are warm-up. */
    warmup: Schema.Number,
  }),
  Schema.TaggedStruct("Failed", { failure: Schema.String }),
]);
export type Response = typeof Response.Type;

export const Launch = Response.members[0];
export type Launch = typeof Launch.Type;

/** What a table prints for a cell, computed from its launches. */
export const Summary = Schema.Struct({
  /** The fastest sample, warm-up excluded. */
  minimum: Schema.Number,
  /** The median of the launches' medians. */
  median: Schema.Number,
  low: Schema.Number,
  high: Schema.Number,
  /**
   * Where `low` and `high` come from: the range of the launches' medians
   * when there are several, the order-statistic interval of one launch's
   * median otherwise. Only the first says anything about noise between
   * processes.
   */
  interval: Schema.Literals(["across launches", "within one launch"]),
  /** Samples measured across launches, warm-up excluded. */
  samples: Schema.Number,
  /** Median bytes allocated per sample, where the runtime counts them. */
  bytes: Schema.optionalKey(Schema.Number),
});
export type Summary = typeof Summary.Type;

export const Cell = Schema.Struct({
  runtime: RuntimeName,
  library: Schema.String,
  scenario: Schema.String,
  outcome: Schema.Union([
    Schema.TaggedStruct("Measured", { launches: Schema.Array(Launch), summary: Summary }),
    Schema.TaggedStruct("Failed", { failure: Schema.String }),
  ]),
});
export type Cell = typeof Cell.Type;

export const Results = Schema.Struct({
  /** The commit measured, and whether the working tree differed from it. */
  commit: Schema.String,
  dirty: Schema.Boolean,
  /** When the run started, ISO 8601. */
  date: Schema.String,
  tier: Tier,
  /**
   * The profiler a run had on, if any. A profiled run samples longer and
   * slower than its tier says: its figures are for diagnosis, never a table.
   */
  profile: Schema.optionalKey(Schema.Literals(["cpu", "heap"])),
  /** What each launch asked of the workers; each launch records its own warm-up. */
  parameters: Schema.Struct({
    launches: Schema.Number,
    minimum: Schema.Number,
    maximum: Schema.Number,
    budget: Schema.Number,
    precision: Schema.Number,
  }),
  machine: Schema.Struct({
    platform: Schema.String,
    architecture: Schema.String,
    cpu: Schema.String,
    cores: Schema.Number,
    memory: Schema.Number,
  }),
  /** The one-minute load average before and after: a busy machine shows here. */
  load: Schema.Struct({ before: Schema.Number, after: Schema.Number }),
  /** Version of each runtime measured, by name. */
  runtimes: Schema.Record(Schema.String, Schema.String),
  /** Version of each library measured, by name. */
  libraries: Schema.Record(Schema.String, Schema.String),
  /** Wall time of the whole run, in seconds. */
  seconds: Schema.Number,
  cells: Schema.Array(Cell),
});
export type Results = typeof Results.Type;
