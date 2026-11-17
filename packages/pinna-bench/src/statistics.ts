/**
 * The statistics the workers stop on and the command line reports. Order
 * statistics only: a timing distribution is skewed and has a long tail, so
 * nothing here assumes a shape.
 *
 * Plain code, bundled into the workers: no `effect`.
 */
import type { Summary } from "./results.ts";

const sorted = (values: ReadonlyArray<number>): Array<number> =>
  [...values].sort((left, right) => left - right);

/** The median and its 95% interval from order statistics. */
export interface MedianInterval {
  readonly low: number;
  readonly median: number;
  readonly high: number;
}

/**
 * The median and the order statistics around it that cover the population
 * median 95% of the time: ranks n/2 ± 0.98√n, the normal approximation of
 * the binomial. `values` must not be empty.
 */
export const medianInterval = (values: ReadonlyArray<number>): MedianInterval => {
  const ordered = sorted(values);
  const count = ordered.length;
  const spread = 0.98 * Math.sqrt(count);
  return {
    low: ordered[Math.max(0, Math.floor(count / 2 - spread))] as number,
    median: median(ordered),
    high: ordered[Math.min(count - 1, Math.ceil(count / 2 + spread))] as number,
  };
};

/** Half the median's 95% interval as a fraction of the median. */
export const relativeWidth = (values: ReadonlyArray<number>): number => {
  const { low, median, high } = medianInterval(values);
  return median === 0 ? 0 : (high - low) / 2 / median;
};

/** The median of `values`, the mean of the middle two when the count is even. */
export const median = (values: ReadonlyArray<number>): number => {
  const ordered = sorted(values);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? (ordered[middle] as number)
    : ((ordered[middle - 1] as number) + (ordered[middle] as number)) / 2;
};

/** What `summarize` reads of a launch. */
interface Sampled {
  readonly times: ReadonlyArray<number>;
  readonly bytes?: ReadonlyArray<number>;
  readonly warmup: number;
}

/**
 * A cell's summary from its launches, warm-up dropped. The median is the
 * median of the launches' medians, so one noisy process moves it little.
 * With several launches the interval is the range of their medians, the
 * noise a reader would see between runs; with one, it is that launch's
 * order-statistic interval, which says nothing about noise between
 * processes.
 */
export const summarize = (launches: ReadonlyArray<Sampled>): Summary => {
  const measured = launches.map((launch) => launch.times.slice(launch.warmup));
  const medians = measured.map(median);
  const samples = measured.flat();
  // The median: a sample now and then pays for a tier-up or a collection.
  const bytes = launches.flatMap((launch) => launch.bytes?.slice(launch.warmup) ?? []);
  const [only] = measured;
  const range =
    launches.length === 1 && only !== undefined
      ? { ...medianInterval(only), interval: "within one launch" as const }
      : {
          low: Math.min(...medians),
          high: Math.max(...medians),
          interval: "across launches" as const,
        };
  return {
    minimum: Math.min(...samples),
    median: median(medians),
    low: range.low,
    high: range.high,
    interval: range.interval,
    samples: samples.length,
    ...(bytes.length === 0 ? {} : { bytes: median(bytes) }),
  };
};
