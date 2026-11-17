/** Runs `run` and returns the errors it reported through `reportError`. */
export const captureReports = (run: () => void): ReadonlyArray<unknown> => {
  const reports: Array<unknown> = [];
  const original = globalThis.reportError;
  globalThis.reportError = (error: unknown) => {
    reports.push(error);
  };
  try {
    run();
  } finally {
    globalThis.reportError = original;
  }
  return reports;
};
