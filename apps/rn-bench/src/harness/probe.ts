/**
 * Counts renders and finds when the screen settles. Every row, cell, and
 * details render calls `mark`; React's Profiler does not run in a Release
 * build, so the views count themselves.
 */
let renders = 0;

export const mark = (): void => {
  renders++;
};

export const renderCount = (): number => renders;

export interface Settled {
  /** When the first frame after the last render ran. */
  readonly at: number;
  readonly renders: number;
}

const quietFrames = 3;

/**
 * Resolves on the first frame after the last render, once `quietFrames`
 * frames in a row have rendered nothing. A frame that renders starts the
 * count again.
 */
export const settled = (): Promise<Settled> =>
  new Promise((resolve) => {
    let seen = renders;
    let firstQuiet = 0;
    let quiet = 0;
    const frame = (): void => {
      if (renders !== seen) {
        seen = renders;
        quiet = 0;
      } else if (quiet === 0) {
        firstQuiet = performance.now();
        quiet = 1;
      } else {
        quiet++;
      }
      if (quiet >= quietFrames) {
        resolve({ at: firstQuiet, renders: seen });
        return;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
